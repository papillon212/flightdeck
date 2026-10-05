// 서버 서명 이벤트 요청 처리 (설계 §3.1, §4.2, §12 "서명 요청").
// 제품 레포의 서버 쪽 사본(bare)에서 메타 브랜치를 받아 reducer로 현재 상태를 계산하고,
// 요청자·차례·관문·artifact_hash를 확인한 뒤 author=요청자로 서명해 메타 브랜치에 push한다.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { artifactHash, checkImplLog, checkSections, configHash, configVersionOf, nowIso, reduce, reviewOf, signEvent, ulid, writerOf } from "@flightdeck/core";
import { git, GitEngine, GitError, RemoteEventStore } from "@flightdeck/git";
import { Event as EventSchema, GateCommands, parsePipeline, PHASE_ARTIFACT, type EditMemo, type EditRecord, type Event, type Phase, type Trust } from "@flightdeck/schema";
import { parseUpload, serverBlame } from "./editlog.ts";
import { BUILTIN_REPO, type GitHost } from "./githost.ts";
import { landEpic, type LandDeps } from "./landing.ts";
import type { Member, ServerStore } from "./store.ts";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface EventRequest {
  product: string;
  epic: string;
  type: string;
  data: Record<string, unknown>;
}

export const SERVER_IDENTITY = { name: "flightdeck-server", email: "flightdeck-server@localhost" };

export interface LandJob {
  id: string;
  product: string;
  epic: string;
  status: "queued" | "running" | "landed" | "rejected" | "error" | "skipped";
  at: string;
  /** landed: main 커밋 */
  main_commit?: string;
  /** rejected: 거부 이유 (conflict | needs_report | invalid) */
  reason?: string;
  message?: string;
}

export class EventSigner {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private deps: { store: ServerStore; dataDir: string; privateKeyPem: string; publicKey: string; githost?: GitHost },
  ) {}

  /**
   * 제품 레포의 서버 쪽 사본. 없으면 만든다.
   * 내장 git(`repo: builtin`)이면 원격이 내장 레포(로컬 경로)다. 서명·반영 코드는 두 방식에서 같다 (M5.5 Z2)
   */
  async mirror(product: string): Promise<{ dir: string; target: string }> {
    const cfg = await this.deps.store.currentConfig(product);
    if (!cfg) throw new RequestError(404, `설정이 없는 제품: ${product}`);
    const pipeline = parsePipeline(cfg.pipeline_yaml);
    let source = pipeline.repo;
    if (source === BUILTIN_REPO) {
      if (!this.deps.githost) throw new RequestError(503, "내장 git 서버가 꺼져 있다");
      source = this.deps.githost.repoDir(product);
      // 내장 레포는 어드민이 가져오거나 만든다. 여기서 만들면 설정을 바꾼 직후의 스캔이 빈 레포를 먼저 만들어 가져오기를 막는다 (M5.5 Z8)
      if (!existsSync(source)) throw new RequestError(503, `내장 레포가 아직 없다: ${product}. 어드민 화면(제품 → git 레포)에서 가져오거나 만드세요`);
    }
    const dir = path.join(this.deps.dataDir, "repos", `${product}.git`);
    if (!existsSync(dir)) {
      await mkdir(path.dirname(dir), { recursive: true });
      await git(["clone", "-q", "--bare", "--no-tags", source, dir], { cwd: this.deps.dataDir });
      for (const [k, v] of [["user.name", SERVER_IDENTITY.name], ["user.email", SERVER_IDENTITY.email]]) await git(["config", k!, v!], { cwd: dir });
    } else if ((await git(["config", "remote.origin.url"], { cwd: dir }).catch(() => "")).trim() !== source) {
      await git(["remote", "set-url", "origin", source], { cwd: dir }); // 방식을 바꿨다 (진행 중 에픽이 없을 때만, Z1)
    }
    return { dir, target: pipeline.landing.target };
  }

  /** 내장 git 제품의 외부 미러를 맞춘다 (Z5). 미러가 없거나 외부 방식이면 아무것도 안 한다 */
  async syncMirror(product: string): Promise<{ pushed: string[]; problems: string[] } | null> {
    const cfg = await this.deps.store.currentConfig(product);
    const pipeline = cfg ? parsePipeline(cfg.pipeline_yaml) : null;
    if (!pipeline?.mirror || pipeline.repo !== BUILTIN_REPO || !this.deps.githost) return null;
    const refs = pipeline.mirror.refs.map((r) => (r === "main" ? pipeline.landing.target : r));
    const r = await this.deps.githost.syncMirror(product, { url: pipeline.mirror.url, refs });
    for (const p of r.problems) console.error(`[mirror ${product}] ${p}`);
    this.mirrorState.set(product, { at: nowIso(), ...r });
    return r;
  }

  /** 제품별 마지막 미러 결과 (어드민 화면) */
  readonly mirrorState = new Map<string, { at: string; pushed: string[]; problems: string[]; error?: string }>();

  async trust(): Promise<Trust> {
    const deactivated: Record<string, string> = {};
    for (const m of await this.deps.store.listMembers()) if (m.deactivated_at) deactivated[m.id] = m.deactivated_at;
    return { mode: "server", serverKey: this.deps.publicKey, deactivated };
  }

  /** 제품별로 한 번에 하나씩 처리한다 (같은 사본·메타 브랜치를 쓰므로) */
  private enqueue<T>(product: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(product) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.queues.set(product, run);
    return run;
  }

  request(member: Member, req: EventRequest): Promise<{ event: Event; pushed: boolean }> {
    return this.enqueue(req.product, () => this.handle(member, req));
  }

  // ---- 반영 (§11, M5 Y5·Y6·Y7·Y9) ----

  private jobs = new Map<string, LandJob>();

  /** 반영 작업 등록. 같은 에픽의 작업이 대기·진행 중이면 그것을 돌려준다 */
  land(product: string, epic: string): LandJob {
    const running = [...this.jobs.values()].find((j) => j.product === product && j.epic === epic && (j.status === "queued" || j.status === "running"));
    if (running) return running;
    const job: LandJob = { id: ulid(), product, epic, status: "queued", at: nowIso() };
    this.jobs.set(job.id, job);
    void this.enqueue(product, async () => {
      job.status = "running";
      try {
        Object.assign(job, await landEpic(this.landDeps(), product, epic));
      } catch (e) {
        Object.assign(job, { status: "error", message: e instanceof Error ? e.message : String(e) });
      }
      if ((job as LandJob).status === "landed") await this.mirrorQuietly(product);
    });
    return job;
  }

  private async mirrorQuietly(product: string): Promise<void> {
    await this.syncMirror(product).catch((e) => {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[mirror ${product}] ${error}`);
      this.mirrorState.set(product, { at: nowIso(), pushed: [], problems: [], error });
    });
  }

  job(id: string): LandJob | undefined {
    return this.jobs.get(id);
  }

  /** 재시작 복구·누락 대비 (§11.1 보조 경로): 반영 대기(pending)인 에픽을 찾아 작업을 등록한다 */
  async scanLanding(): Promise<LandJob[]> {
    const out: LandJob[] = [];
    for (const { product } of await this.deps.store.listProducts()) {
      // 서버 사본·메타 브랜치를 서명 요청과 함께 쓰므로 제품 대기열 안에서 돈다 (밖에서 돌면 같은 추적 ref를 동시에 갱신해 요청이 실패한다, M5.5 시나리오)
      const pending = await this.enqueue(product, async () => {
        await this.mirrorQuietly(product); // 미러 실패분 재시도 (Z5)
        const ctx = await this.loadProduct(product).catch(() => null);
        const epics: string[] = [];
        for (const epic of ctx ? await ctx.store.listEpics() : []) {
          const s = await ctx!.state(epic);
          if (s.phase === "LANDING" && s.landing?.status === "pending") epics.push(epic);
        }
        return epics;
      });
      for (const epic of pending) out.push(this.land(product, epic));
    }
    return out;
  }

  /** 제품의 서버 쪽 사본·메타 브랜치·신뢰 기준을 맞추고, 에픽 상태 계산기를 돌려준다 */
  private async loadProduct(product: string) {
    const { dir, target } = await this.mirror(product);
    const store = new RemoteEventStore(dir, "origin", { author: SERVER_IDENTITY });
    await store.sync();
    const trust = await this.trust();
    const state = async (epic: string) => {
      const events = await store.list(epic);
      const version = configVersionOf(events, epic);
      const cv = version ? await this.deps.store.getConfigVersion(product, version) : null;
      const pipeline = cv ? parsePipeline(cv.pipeline_yaml) : undefined;
      return Object.assign(reduce(epic, events, trust, { pipelines: () => pipeline, configHash: () => (cv ? configHash(cv) : undefined) }), { events });
    };
    return { dir, target, store, trust, state };
  }

  private landDeps(): LandDeps {
    return {
      load: (product) => this.loadProduct(product),
      sign: (e) => signEvent(e, this.deps.privateKeyPem),
      config: (product, version) => this.deps.store.getConfigVersion(product, version),
      editlog: async (product, epic) => ({ records: await this.deps.store.editlog(product, epic), memos: await this.deps.store.memos(product, epic) }),
    };
  }

  // ---- 편집 기록 (서버 ③, M7) ----

  /** 업로드 권한 확인용 담당자 캐시: 업로드는 몇 초마다 오므로 매번 메타 브랜치를 받지 않는다 (조종수 바뀜은 M8) */
  private writers = new Map<string, { writer: string | null; at: number }>();

  private async writerOf(product: string, epic: string, fresh = false): Promise<string | null> {
    const key = `${product}\0${epic}`;
    const hit = this.writers.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.writer;
    const s = await this.enqueue(product, async () => (await this.loadProduct(product)).state(epic));
    const writer = writerOf(s);
    this.writers.set(key, { writer, at: Date.now() });
    return writer;
  }

  /** 편집 기록 올리기 (E1·E4·E8). seq가 이어지지 않으면 409와 서버의 마지막 seq */
  async uploadEditlog(member: Member, product: string, body: unknown): Promise<{ last: number }> {
    const u = parseUpload(body);
    let writer = await this.writerOf(product, u.epic);
    if (writer !== member.id) writer = await this.writerOf(product, u.epic, true);
    if (writer !== member.id) throw new RequestError(403, `편집 기록은 조종수(@${writer ?? "없음"})만 올린다`);
    if (u.records.length && !(await this.deps.store.appendEditlog(product, u.epic, u.records))) {
      throw new RequestError(409, JSON.stringify({ last: await this.deps.store.editlogLast(product, u.epic) }));
    }
    if (u.memos) await this.deps.store.setMemos(product, u.epic, u.memos);
    return { last: await this.deps.store.editlogLast(product, u.epic) };
  }

  async getEditlog(product: string, epic: string, from = 1): Promise<{ records: EditRecord[]; memos: EditMemo[]; last: number }> {
    return { records: await this.deps.store.editlog(product, epic, from), memos: await this.deps.store.memos(product, epic), last: await this.deps.store.editlogLast(product, epic) };
  }

  /** 줄 단위 출처 (E6): rev(리뷰 커밋 등)의 편집 기록 위치까지 */
  async blame(product: string, epic: string, file: string, rev: string) {
    if (!/^[0-9a-f]{40}$/.test(rev)) throw new RequestError(400, "rev는 커밋 sha");
    return this.enqueue(product, async () => {
      const ctx = await this.loadProduct(product);
      const s = await ctx.state(epic);
      if (!s.base_sha) throw new RequestError(404, "시작하지 않은 에픽");
      const has = await git(["cat-file", "-e", `${rev}^{commit}`], { cwd: ctx.dir }).then(() => true, () => false);
      if (!has) await new GitEngine(ctx.dir).fetchEpicBranch(epic).catch(() => null);
      return serverBlame({ dir: ctx.dir, base: s.base_sha, rev, file, records: await this.deps.store.editlog(product, epic), memos: await this.deps.store.memos(product, epic) });
    });
  }

  private async handle(member: Member, req: EventRequest): Promise<{ event: Event; pushed: boolean }> {
    if (!member.active) throw new RequestError(403, `비활성 멤버: ${member.id}`);
    const { dir, target } = await this.mirror(req.product);
    const store = new RemoteEventStore(dir, "origin", { author: SERVER_IDENTITY });
    try {
      await store.sync();
    } catch (e) {
      throw new RequestError(503, `메타 브랜치를 받지 못함: ${e instanceof Error ? e.message : e}`);
    }
    const trust = await this.trust();
    const events = await store.list(req.epic);
    // 에픽에 고정된 설정 버전의 파이프라인 (티어 리뷰 판정, §2.5 버전 고정)
    const version = configVersionOf(events, req.epic);
    const cv = version ? await this.deps.store.getConfigVersion(req.product, version) : null;
    const pipeline = cv ? parsePipeline(cv.pipeline_yaml) : undefined;
    const opts = { pipelines: () => pipeline, configHash: () => (cv ? configHash(cv) : undefined) };
    const state = reduce(req.epic, events, trust, opts);
    if (state.config_mismatch) {
      // 같은 버전 ID에 다른 내용 (서버 DB 교체·이전 등, M5.5 Z9). 다른 규칙으로 서명하지 않는다
      throw new RequestError(409, `설정 불일치: 이 에픽은 ${state.config_mismatch.version}(${state.config_mismatch.signed.slice(7, 19)})로 시작했는데 서버의 ${state.config_mismatch.version} 내용이 다르다(${state.config_mismatch.actual.slice(7, 19)}). 관리자가 원래 설정을 복구해야 한다`);
    }
    const eng = new GitEngine(dir);

    /** 원격 에픽 브랜치의 단계 산출물: 형식 검사(§6.3) 후 해시 */
    const remoteArtifact = async (phase: Phase) => {
      if (phase === "VERIFICATION") {
        // 검증 단계의 산출물 = 에픽 브랜치 전체 (§4.2: tree 해시). 테스트 통과 보고는 reducer가 본다 (M5 Y1)
        const head = await remoteHead();
        return { file: "에픽 브랜치", head, hash: `tree:${(await git(["rev-parse", `${head}^{tree}`], { cwd: dir })).trim()}` };
      }
      const artifact = PHASE_ARTIFACT[phase as keyof typeof PHASE_ARTIFACT];
      if (!artifact) throw new RequestError(400, `산출물이 없는 단계: ${phase}`);
      const head = await eng.fetchEpicBranch(req.epic).catch((e) => {
        throw new RequestError(503, `에픽 브랜치를 받지 못함: ${e instanceof Error ? e.message : e}`);
      });
      if (!head) throw new RequestError(409, "에픽 브랜치가 원격에 없음. 산출물을 먼저 공유해야 한다");
      const text = await git(["show", `${head}:.flightdeck/epics/${req.epic}/${artifact.file}`], { cwd: dir }).catch(() => null);
      if (text === null) throw new RequestError(409, `에픽 브랜치에 ${artifact.file}가 없음`);
      const sections = checkSections(text, artifact.sections);
      if (!sections.ok) throw new RequestError(409, `${artifact.file} 형식 문제: ${JSON.stringify({ missing: sections.missing, outOfOrder: sections.outOfOrder, empty: sections.empty })}`);
      return { file: artifact.file, head, hash: artifactHash(text) };
    };

    const remoteHead = async () => {
      const head = await eng.fetchEpicBranch(req.epic).catch((e) => {
        throw new RequestError(503, `에픽 브랜치를 받지 못함: ${e instanceof Error ? e.message : e}`);
      });
      if (!head) throw new RequestError(409, "에픽 브랜치가 원격에 없음. 먼저 공유해야 한다");
      return head;
    };

    let data: Record<string, unknown>;
    switch (req.type) {
      case "epic.started": {
        const cfg = (await this.deps.store.currentConfig(req.product))!;
        const base = String(req.data.base_sha ?? "");
        await git(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], { cwd: dir });
        if (!/^[0-9a-f]{40}$/.test(base) || !(await isAncestor(dir, base, `refs/remotes/origin/${target}`))) {
          throw new RequestError(409, `base_sha가 원격 ${target}에 없음: ${base || "(없음)"}`);
        }
        data = { tracker_ref: String(req.data.tracker_ref ?? req.epic), owner: member.id, base_sha: base, config_version: cfg.version, config_hash: configHash(cfg) };
        break;
      }
      case "gate.reported": {
        // 테스트 결과 보고 (§7.5, M4 제안 X5): 보고한 커밋이 원격 에픽 브랜치에 있어야 한다. 테스트를 다시 돌리지는 않는다
        const commit = String(req.data.commit ?? "");
        const commands = GateCommands.safeParse(req.data.commands);
        if (!commands.success) throw new RequestError(400, `commands 형식 문제: ${commands.error.message}`);
        const head = await remoteHead();
        if (!/^[0-9a-f]{40}$/.test(commit) || !(await isAncestor(dir, commit, head))) throw new RequestError(409, `보고한 커밋이 원격 에픽 브랜치에 없음: ${commit || "(없음)"}`);
        data = { commit, commands: commands.data };
        break;
      }
      case "phase.completed":
        if (state.phase === "IMPLEMENTATION" && req.data.phase === "IMPLEMENTATION") {
          // 구현 완료 (§4.1, X5): 원격 에픽 브랜치 끝 = 검사한 커밋. impl-log 형식을 보고, 통과 보고는 reducer가 본다
          const head = await remoteHead();
          if (req.data.commit !== undefined && req.data.commit !== head) throw new RequestError(409, `원격 에픽 브랜치 끝(${head.slice(0, 10)})이 검사한 커밋과 다름. 먼저 공유해야 한다`);
          const show = (f: string) => git(["show", `${head}:.flightdeck/epics/${req.epic}/${f}`], { cwd: dir }).catch(() => null);
          const problems = checkImplLog(await show("impl-log.md"), await show("design.md"));
          if (problems.length) throw new RequestError(409, `impl-log 형식 문제: ${problems.join("; ")}`);
          const tree = (await git(["rev-parse", `${head}^{tree}`], { cwd: dir })).trim();
          data = { phase: "IMPLEMENTATION", artifact_hash: `tree:${tree}`, commit: head };
          break;
        }
      // falls through
      case "review.requested": {
        const phase = String(req.data.phase ?? "") as Phase;
        const a = await remoteArtifact(phase);
        if (req.data.artifact_hash !== undefined && req.data.artifact_hash !== a.hash) {
          throw new RequestError(409, `에픽 브랜치에 올라간 ${a.file}가 요청한 내용과 다름. 먼저 공유해야 한다`);
        }
        data = req.type === "review.requested" ? { phase, artifact_hash: a.hash, commit: a.head } : { phase, artifact_hash: a.hash };
        break;
      }
      case "review.approved": {
        // 승인하는 것 = 마지막 리뷰 요청의 문서 (§4.2). 요청 뒤 원격 문서가 바뀌었으면 다시 요청을 기다린다
        const phase = String(req.data.phase ?? state.phase) as Phase;
        const requested = state.review.requested;
        if (!requested) throw new RequestError(409, "리뷰 요청 전");
        const a = await remoteArtifact(phase);
        if (a.hash !== requested.hash) throw new RequestError(409, `담당자가 리뷰 요청 뒤 ${a.file}를 고쳤다. 다시 요청할 때까지 승인할 수 없다`);
        if (req.data.artifact_hash !== undefined && req.data.artifact_hash !== requested.hash) throw new RequestError(409, "승인하려는 문서가 리뷰 요청된 문서와 다름 (창을 새로 고쳐 주세요)");
        const tier = reviewOf(state)?.current?.name;
        if (!tier) throw new RequestError(409, "승인할 차례의 티어가 없음");
        if (req.data.tier !== undefined && req.data.tier !== tier) throw new RequestError(409, `현재 차례는 ${tier} 티어`);
        data = { phase, tier, artifact_hash: requested.hash };
        break;
      }
      default:
        throw new RequestError(400, `서버 서명을 지원하지 않는 이벤트: ${req.type}`);
    }

    const unsigned = EventSchema.parse({ v: 1, id: ulid(), type: req.type, epic: req.epic, author: member.id, at: nowIso(), data }) as Event;
    const event = signEvent(unsigned, this.deps.privateKeyPem);
    const after = reduce(req.epic, [...events, event], trust, opts);
    const ignored = after.ignored.find((i) => i.event === event.id);
    if (ignored) throw new RequestError(409, `${req.type} 거부: ${ignored.reason} (요청자: ${member.id}, 현재 단계: ${state.phase})`);

    await store.append(event); // 로컬 커밋 후 push. push 실패분은 다음 요청·주기에 다시 보낸다
    const r = await store.sync().catch(() => ({ pending: 1 }));
    // 마지막 검증 승인, 또는 main 이동 뒤 재보고로 반영 대기가 되면 바로 반영 작업을 건다 (Y5). 이 처리 뒤 차례로 돈다
    if (after.phase === "LANDING" && after.landing?.status === "pending" && (state.phase !== "LANDING" || state.landing?.status !== "pending")) this.land(req.product, req.epic);
    return { event, pushed: r.pending === 0 };
  }
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", a, b], { cwd });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

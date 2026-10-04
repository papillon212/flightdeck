// 에픽 워크플로 (설계 §9.1 진입 흐름, §4 단계, §3 쓰레드). VS Code API를 쓰지 않는 순수 Node 모듈이다.
// 확장(extension.ts)은 이 모듈을 화면에 연결만 한다. 테스트·스크립트에서도 그대로 쓴다.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTextEdit, artifactHash, checkSections, diffToEdits, ensureParagraphIds, myOpenThreads, needsServerSignature, nowIso, reduce, renderThreads, replay, restoreParagraphIds, sha256, stripThreads, threadIdFrom, trustFromConfig, ulid, type ConfigPayload, type EpicState, type Thread } from "@flightdeck/core";
import { git, GitEngine, LocalEventStore, MetaRewriteError, RemoteEventStore } from "@flightdeck/git";
import { DEV_TRUST, HANDOFF_SECTIONS, parsePipeline, PHASE_ARTIFACT, type Anchor, type EditRecord, type EditSource, type Event, type EventOf, type EventType, type LocalEpicState, type Phase, type Trust } from "@flightdeck/schema";
import type { AgentAdapter } from "@flightdeck/agent";
import type { TrackerAdapter, TrackerEpic } from "@flightdeck/tracker";
import { appendEditRecords, readEditLog, readState, statePath, writeState } from "@flightdeck/hook";
import type { ServerClient } from "./server-client.ts";

/** 서버 모드 (M2 원격 협업). 없으면 개발 모드: 로컬 설정 폴더, 로컬 메타 브랜치, 서명 없음 */
export interface RemoteConfig {
  server: ServerClient;
  product: string;
  /** 검증한 설정 (§2.5). 신뢰 기준·단계 룰·일감 상태 대응·멤버의 일감 도구 ID를 여기서 얻는다 */
  config: ConfigPayload;
  /** 제품 레포의 git 원격 이름 */
  gitRemote?: string;
  tracker?: TrackerAdapter;
  /** 일감 멘션에 넣을 링크 (§3.7). 확장의 URI 처리기 주소 */
  linkFor?: (epic: string, thread?: string) => string;
}

export interface WorkflowConfig {
  /** 제품 레포 main worktree */
  repo: string;
  /** 이 PC의 사용자 */
  member: string;
  /** 단계 룰 폴더 (rules/). 서버 모드에서는 받은 설정의 캐시 폴더 */
  configDir: string;
  /** dist/flightdeck-hook.mjs, dist/flightdeck-mcp.mjs가 있는 폴더 */
  distDir: string;
  adapter: AgentAdapter;
  model?: string;
  maxTurns?: number;
  excludeSecrets?: string[];
  /** 서버 서명 검증 기준 (§12). 없으면 서버 모드는 받은 설정에서, 개발 모드는 서명을 보지 않는다 */
  trust?: Trust;
  remote?: RemoteConfig;
}

/** 받은 질문 (§3.7, §9.2 내 할 일) */
export interface InboxItem {
  epic: string;
  thread: Thread;
  /** 질문이 달린 문서의 공유 커밋 (thread.created.commit) */
  commit?: string;
}

export const ARTIFACT_FILES = ["analysis.md", "design.md"] as const;

export interface RenderReport {
  file: string;
  /** 편집 기록에 없던 변경이 있었다 (셸·다른 에디터 등, §7.4) */
  external: boolean;
  /** 복원한 문단 ID 수 */
  restoredIds: number;
  changed: boolean;
}

export class EpicWorkflow {
  readonly eng: GitEngine;
  readonly store: LocalEventStore;

  constructor(readonly cfg: WorkflowConfig) {
    this.eng = new GitEngine(cfg.repo, { excludeSecrets: cfg.excludeSecrets });
    this.store = cfg.remote ? new RemoteEventStore(cfg.repo, this.gitRemote) : new LocalEventStore(cfg.repo);
  }

  get trust(): Trust {
    return this.cfg.trust ?? (this.cfg.remote ? trustFromConfig(this.cfg.remote.config) : DEV_TRUST);
  }

  get gitRemote(): string {
    return this.cfg.remote?.gitRemote ?? "origin";
  }

  /** 멘션 등 부가 동작에서 난 경고 (본 동작은 성공). 확장이 사용자에게 보여 준다 */
  warnings: string[] = [];

  /** 원격과 메타 브랜치를 맞춘다 (서버 모드). 원격에 닿지 못해도 로컬 작업은 계속한다 */
  async pull(): Promise<void> {
    if (!(this.store instanceof RemoteEventStore)) return;
    try {
      await this.store.sync();
    } catch (e) {
      if (e instanceof MetaRewriteError) throw e; // 이력 재작성은 받아들이지 않고 알린다 (§2.1)
      this.warnings.push(`원격과 맞추지 못했다: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 단계 통과 이벤트: 서버 모드는 서버에 요청(서버가 검증·서명·push), 개발 모드는 로컬에 쓴다 (§12) */
  private async passEvent<T extends EventType>(epic: string, type: T, data: Record<string, unknown>): Promise<Event> {
    const r = this.cfg.remote;
    if (!r) return this.emit(epic, type, data as EventOf<T>["data"]) as Promise<Event>;
    const e = await r.server.requestEvent(r.product, epic, type, data);
    await this.pull();
    return e;
  }

  private statusMap(): Partial<Record<Phase, string>> {
    const c = this.cfg.remote?.config;
    if (!c) return {};
    const t = parsePipeline(c.pipeline_yaml).tracker as { clickup?: { status_map?: Partial<Record<Phase, string>> } };
    return t.clickup?.status_map ?? {};
  }

  /** 일감 상태를 단계에 맞춘다 (§1.4: 단계 전환을 일으킨 사람의 확장이 한다). 실패해도 본 동작은 성공 */
  private async trackerPhase(epic: string, phase: Phase): Promise<void> {
    const t = this.cfg.remote?.tracker;
    const ref = (await this.epicState(epic)).tracker_ref;
    if (!t || !ref || !this.statusMap()[phase]) return;
    await t.setPhase(ref, phase).catch((e) => this.warnings.push(`일감 상태를 바꾸지 못했다: ${e instanceof Error ? e.message : e}`));
  }

  epicDir(worktree: string, epic: string) {
    return path.join(worktree, ".flightdeck", "epics", epic);
  }

  /** 훅 명령 (worktree의 settings.local.json에 들어간다, §6.1) */
  hookCommand(epic: string): string {
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    return `node ${q(path.join(this.cfg.distDir, "flightdeck-hook.mjs"))} ${this.cfg.adapter.id} --repo ${q(this.cfg.repo)} --epic ${q(epic)}`;
  }

  private async emit<T extends EventType>(epic: string, type: T, data: EventOf<T>["data"], author = this.cfg.member, id = ulid()): Promise<EventOf<T>> {
    if (this.cfg.remote && needsServerSignature({ type })) throw new Error(`${type}는 서버에 요청해야 하는 단계 통과 이벤트다 (§12)`);
    const e = { v: 1, id, type, epic, author, at: nowIso(), data } as EventOf<T>;
    // 메타 브랜치는 append-only라 한번 쓰면 지울 수 없다. reducer가 무시할 이벤트(권한·관문)는 쓰기 전에 막고 이유를 알린다
    const events = await this.store.list(epic);
    const ignored = reduce(epic, [...events, e as Event], this.trust).ignored.find((i) => i.event === e.id);
    if (ignored) throw new Error(`${type} 거부: ${ignored.reason}${ignored.reason.includes("권한") ? ` (나: ${author})` : ""}`);
    await this.store.append(e as Event);
    return e;
  }

  /** 원격의 반영 대상 브랜치(main)를 받아 그 끝을 돌려준다. 에픽은 여기서 갈라진다 (서버가 base_sha를 확인한다) */
  private async remoteBase(): Promise<string> {
    const target = parsePipeline(this.cfg.remote!.config.pipeline_yaml).landing.target;
    const ref = `refs/remotes/${this.gitRemote}/${target}`;
    await git(["fetch", "-q", "--no-tags", this.gitRemote, `+refs/heads/${target}:${ref}`], { cwd: this.cfg.repo });
    return this.eng.revParse(ref);
  }

  /**
   * 에픽 시작 (§9.1): 작업 폴더 → epic.md 커밋 → epic.started → 로컬 상태 → 에이전트 설정 설치.
   * 서버 모드: 서버에 epic.started를 요청(담당자 = 나, 설정 버전 고정)하고, epic.md를 에픽 브랜치에 올려 공유한다.
   * 개발 모드: 제목·본문을 직접 받아 로컬에만 쓴다.
   */
  async start(epic: string, title: string, body: string, opts: { trackerRef?: string; url?: string } = {}): Promise<{ worktree: string; state: EpicState }> {
    const remote = this.cfg.remote;
    let created: { path: string; baseSha: string };
    if (remote) {
      await this.pull();
      let s = await this.epicState(epic);
      if (s.owner === null) {
        await this.passEvent(epic, "epic.started", { tracker_ref: opts.trackerRef ?? epic, base_sha: await this.remoteBase() });
        s = await this.epicState(epic);
      }
      if (s.owner !== this.cfg.member) throw new Error(`이미 @${s.owner}이(가) 담당한 에픽이다. 질문을 받았다면 "받은 질문"에서 연다`);
      created = await this.eng.createEpicWorktree(epic, s.base_sha!);
    } else {
      created = await this.eng.createEpicWorktree(epic);
    }
    const worktree = created.path;
    const dir = this.epicDir(worktree, epic);
    await mkdir(dir, { recursive: true });
    const epicMd = path.join(dir, "epic.md");
    if (!existsSync(epicMd)) {
      await writeFile(epicMd, `# ${epic} · ${title}\n\n${opts.url ? `일감: ${opts.url}\n\n` : ""}${body.trim()}\n`);
      await this.eng.commit(worktree, [path.relative(worktree, epicMd)], `${epic}: 에픽 시작`, { "Flightdeck-Epic": epic });
    }
    if (remote) await this.eng.pushEpicBranch(epic, this.gitRemote);
    else if (!(await this.store.list(epic)).some((e) => e.type === "epic.started")) {
      await this.emit(epic, "epic.started", { tracker_ref: opts.trackerRef ?? epic, owner: this.cfg.member, base_sha: created.baseSha, config_version: "local" });
    }
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic))) {
      const s: LocalEpicState = {
        epic,
        repo: this.cfg.repo,
        worktree,
        member: this.cfg.member,
        role: "owner",
        ...(remote ? { product: remote.product } : {}),
        phase: "ANALYSIS",
        configDir: this.cfg.configDir,
        trust: this.trust,
        excludeSecrets: this.eng.excludeSecrets,
        runs: {},
      };
      await writeState(dataDir, s);
    }
    await this.cfg.adapter.installConfig(
      worktree,
      this.hookCommand(epic),
      { name: "flightdeck", command: "node", args: [path.join(this.cfg.distDir, "flightdeck-mcp.mjs"), "--repo", this.cfg.repo, "--epic", epic] },
      { model: this.cfg.model },
    );
    const state = await this.sync(epic);
    if (remote) await this.trackerPhase(epic, state.phase);
    return { worktree, state };
  }

  /** "내 일감"에서 시작 (§1.4 listAssignedEpics → §9.1) */
  startFromTracker(t: TrackerEpic): Promise<{ worktree: string; state: EpicState }> {
    return this.start(t.epicId, t.title, t.body, { trackerRef: t.ref, url: t.url });
  }

  /** 나에게 배정된 일감 중 아직 아무도 시작하지 않은 것 */
  async assignedEpics(): Promise<TrackerEpic[]> {
    const t = this.cfg.remote?.tracker;
    if (!t) return [];
    await this.pull();
    const started = new Set(await this.store.listEpics());
    return (await t.listAssignedEpics(await t.me())).filter((e) => !started.has(e.epicId));
  }

  /** 받은 질문 (§3.7): 모든 에픽에서 나에게 온 열린 쓰레드 중 내가 마지막으로 답하지 않은 것 */
  async inbox(): Promise<InboxItem[]> {
    await this.pull();
    const out: InboxItem[] = [];
    for (const epic of await this.store.listEpics()) {
      const events = await this.store.list(epic);
      const s = reduce(epic, events, this.trust);
      if (s.owner === this.cfg.member) continue; // 내 에픽은 내 작업 폴더에서 본다
      for (const t of myOpenThreads(s, this.cfg.member).filter((x) => x.to.includes(this.cfg.member))) {
        const created = events.find((e) => e.type === "thread.created" && e.data.thread === t.id) as EventOf<"thread.created"> | undefined;
        out.push({ epic, thread: t, ...(created?.data.commit ? { commit: created.data.commit } : {}) });
      }
    }
    return out;
  }

  /**
   * 질문 대상의 읽기 전용 창 (§2.4): 에픽 브랜치의 공유 커밋(없으면 원격 끝)을 열고 쓰레드를 그린다.
   * 에이전트 설정은 넣지 않는다. 다시 부르면 최신 공유 커밋으로 옮긴다.
   */
  async openAsViewer(epic: string, commit?: string): Promise<{ worktree: string; state: EpicState }> {
    await this.pull();
    const s0 = await this.epicState(epic);
    if (s0.owner === null) throw new Error(`시작되지 않은 에픽: ${epic}`);
    if (s0.owner === this.cfg.member) throw new Error("내가 담당한 에픽은 작업 폴더에서 연다");
    const v = await this.eng.openViewWorktree(epic, commit, this.gitRemote);
    const dataDir = await this.eng.dataDir();
    await writeState(dataDir, {
      epic,
      repo: this.cfg.repo,
      worktree: v.path,
      member: this.cfg.member,
      role: "viewer",
      ...(this.cfg.remote ? { product: this.cfg.remote.product } : {}),
      phase: s0.phase,
      configDir: this.cfg.configDir,
      trust: this.trust,
      excludeSecrets: this.eng.excludeSecrets,
      runs: {},
    });
    return { worktree: v.path, state: await this.sync(epic) };
  }

  async role(epic: string): Promise<"owner" | "viewer"> {
    return (await readState(await this.eng.dataDir(), epic)).role;
  }

  async worktree(epic: string): Promise<string> {
    return (await readState(await this.eng.dataDir(), epic)).worktree;
  }

  async epicState(epic: string): Promise<EpicState> {
    return reduce(epic, await this.store.list(epic), this.trust);
  }

  /** 이벤트로 상태를 다시 계산해 로컬 상태 파일(훅이 읽음)의 단계를 맞추고, 문서를 다시 그린다 */
  async sync(epic: string): Promise<EpicState> {
    await this.pull();
    const s = await this.epicState(epic);
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic))) return s; // 이 PC에 작업 폴더·읽기 전용 창이 없는 에픽
    const local = await readState(dataDir, epic);
    if (local.phase !== s.phase) await writeState(dataDir, { ...(await readState(dataDir, epic)), phase: s.phase });
    await this.renderDocs(epic, s);
    return s;
  }

  /** 마지막 renderDocs 결과 (확장이 "Flightdeck 밖에서 수정됨" 알림에 쓴다, §7.4) */
  lastRender: RenderReport[] = [];

  /**
   * 산출물을 점검하고 다시 그린다 (§3.2, §7.4). 바뀐 파일 목록을 돌려준다.
   * 1. 편집 기록 재적용 결과 ≠ 디스크면, 그 차이는 기록되지 않은 변경(셸·다른 에디터·git 등)이다 → external로 기록 (설계 제안 T8)
   * 2. 재적용 결과(마지막으로 확인된 내용)와 비교해 지워지거나 바뀐 문단 ID를 원래 ID로 복원한다. 새 ID로 덮지 않는다
   * 3. 새 블록에 ID를 붙이고 쓰레드 블록을 그린다
   * 2·3의 변경도 편집 기록에 남긴다(출처 flightdeck, 설계 제안 T4). 그래서 편집 기록 재적용 = 디스크가 항상 유지된다.
   */
  async renderDocs(epic: string, s?: EpicState): Promise<string[]> {
    const state = s ?? (await this.epicState(epic));
    const wt = await this.worktree(epic);
    const dataDir = await this.eng.dataDir();
    if ((await readState(dataDir, epic)).role === "viewer") {
      // 읽기 전용 창: 공유 커밋 내용 위에 쓰레드만 그린다. 편집 기록에 남기지 않는다 (§2.4)
      const changed: string[] = [];
      for (const name of ARTIFACT_FILES) {
        const file = path.join(this.epicDir(wt, epic), name);
        if (!existsSync(file)) continue;
        const disk = await readFile(file, "utf8");
        const next = renderThreads(stripThreads(disk), name, state.threads.values());
        if (next !== disk) {
          await writeFile(file, next);
          changed.push(name);
        }
      }
      this.lastRender = [];
      return changed;
    }
    const log = await readEditLog(dataDir, epic);
    const report: RenderReport[] = [];
    for (const name of ARTIFACT_FILES) {
      const file = path.join(this.epicDir(wt, epic), name);
      if (!existsSync(file)) continue;
      const rel = path.relative(wt, file).split(path.sep).join("/");
      const disk = await readFile(file, "utf8");
      const fileLog = log.filter((r) => r.file === rel);
      const expected = fileLog.length ? (replay(new Map([[rel, null]]), fileLog).files.get(rel) ?? null) : null;
      const external = expected !== disk;
      if (external) await this.recordDiff(epic, rel, expected, disk, { kind: "external" });

      const restored = expected === null ? { text: stripThreads(disk), restored: [] } : restoreParagraphIds(stripThreads(expected), stripThreads(disk));
      const withIds = ensureParagraphIds(restored.text).text;
      const next = renderThreads(withIds, name, state.threads.values());
      if (next !== disk) {
        await writeFile(file, next);
        const reason = withIds === stripThreads(disk) ? "thread_render" : "paragraph_ids";
        await this.recordDiff(epic, rel, disk, next, { kind: "flightdeck", member: this.cfg.member, reason });
      }
      if (external || next !== disk) report.push({ file: name, external, restoredIds: restored.restored.length, changed: next !== disk });
    }
    this.lastRender = report;
    return report.filter((r) => r.changed).map((r) => r.file);
  }

  /** 변경 전후를 편집 기록으로 남긴다 (before null = 새 파일, after null = 삭제) */
  private async recordDiff(epic: string, file: string, before: string | null, after: string | null, source: EditSource): Promise<void> {
    if (before === after) return;
    const ts = nowIso();
    let records: Omit<EditRecord, "seq">[];
    if (after === null) {
      records = [{ epic, file, base_hash: sha256(before), range: [0, 0], insert: "", delete_file: true, source, ts }];
    } else {
      let base: string | null = before;
      records = diffToEdits(before ?? "", after).map((e) => {
        const r = { epic, file, base_hash: sha256(base), range: e.range, insert: e.insert, source, ts };
        base = applyTextEdit(base ?? "", e);
        return r;
      });
    }
    await appendEditRecords(await this.eng.dataDir(), epic, records);
  }

  // ---- 쓰레드 (§3.4) ----

  /**
   * 문서 공유 커밋 (§3.1 thread.created.commit, §2.4): 산출물을 다시 그려 에픽 브랜치에 커밋하고 원격에 올린다.
   * 질문 대상은 이 커밋으로 질문이 달린 문서를 본다. 서버 모드에서만 올린다
   */
  async share(epic: string, message: string): Promise<string> {
    const wt = await this.worktree(epic);
    await this.renderDocs(epic);
    const rel = path.relative(wt, this.epicDir(wt, epic));
    await this.eng.commit(wt, [rel], message, { "Flightdeck-Epic": epic });
    if (this.cfg.remote) return this.eng.pushEpicBranch(epic, this.gitRemote);
    return this.eng.revParse("HEAD", wt);
  }

  async createThread(epic: string, t: { file: string; pid: string; kind: "question" | "change_request" | "note"; to: string[]; body: string }): Promise<string> {
    const s = await this.epicState(epic);
    if ((await this.role(epic)) === "viewer") throw new Error("읽기 전용 창에서는 쓰레드를 만들 수 없다. 받은 질문에 답글만 단다");
    const unknown = this.cfg.remote ? t.to.filter((m) => !this.cfg.remote!.config.members.some((x) => x.id === m && x.active)) : [];
    if (unknown.length) throw new Error(`등록되지 않았거나 비활성인 멤버: ${unknown.map((m) => "@" + m).join(", ")}`);
    const id = ulid();
    const thread = threadIdFrom(id);
    const anchor: Anchor = { type: "paragraph", pid: t.pid };
    const commit = this.cfg.remote ? await this.share(epic, `${epic}: 질문 공유 (${thread})`) : undefined;
    await this.emit(epic, "thread.created", { thread, phase: s.phase, file: t.file, anchor, kind: t.kind, to: t.to, body: t.body, ...(commit ? { commit } : {}) }, this.cfg.member, id);
    await this.sync(epic);
    await this.mention(epic, t.to, `${t.kind === "question" ? "질문" : t.kind === "change_request" ? "수정 요청" : "메모"} 1건 · ${t.file}`, thread);
    return thread;
  }

  /** 일감 멘션 (§3.7: 새 질문의 대상·리뷰 차례에만. 내용은 넣지 않는다). 실패해도 본 동작은 성공 */
  private async mention(epic: string, to: string[], text: string, thread?: string): Promise<void> {
    const r = this.cfg.remote;
    const ref = (await this.epicState(epic)).tracker_ref;
    if (!r?.tracker || !ref || !to.length) return;
    const users = to.flatMap((m) => {
      const tid = r.config.members.find((x) => x.id === m)?.tracker_id;
      if (!tid) this.warnings.push(`@${m}의 일감 도구 ID가 없어 멘션하지 못했다 (어드민의 멤버 목록)`);
      return tid ? [{ id: tid }] : [];
    });
    if (!users.length) return;
    await r.tracker.notifyMention(ref, users, `${text} · ${epic}`, r.linkFor?.(epic, thread) ?? epic).catch((e) => this.warnings.push(`일감 멘션 실패: ${e instanceof Error ? e.message : e}`));
  }

  async reply(epic: string, thread: string, body: string, opts: { author?: string; source?: "human" | "agent" | "session" } = {}): Promise<void> {
    await this.emit(epic, "thread.replied", { thread, body, source: opts.source ?? "human" }, opts.author);
    await this.sync(epic);
  }

  async setThreadStatus(epic: string, thread: string, resolved: boolean, author?: string): Promise<void> {
    await this.emit(epic, resolved ? "thread.resolved" : "thread.reopened", { thread }, author);
    await this.sync(epic);
  }

  // ---- 단계 (§4) ----

  /** 현재 단계 산출물의 형식·관문을 검사한다. 통과하지 못하면 이유 목록을 돌려준다 */
  async checkPhase(epic: string): Promise<{ phase: Phase; problems: string[] }> {
    const s = await this.epicState(epic);
    const problems: string[] = [];
    if (s.owner !== this.cfg.member) problems.push(`담당자(@${s.owner})만 단계를 완료할 수 있습니다 (나: @${this.cfg.member})`);
    const a = PHASE_ARTIFACT[s.phase as keyof typeof PHASE_ARTIFACT];
    if (!a) return { phase: s.phase, problems: [`${s.phase} 단계 완료는 M1 범위 밖입니다`] };
    const wt = await this.worktree(epic);
    const file = path.join(this.epicDir(wt, epic), a.file);
    if (!existsSync(file)) problems.push(`${a.file}이 없습니다`);
    else {
      const c = checkSections(await readFile(file, "utf8"), a.sections);
      if (c.missing.length) problems.push(`빠진 섹션: ${c.missing.join(", ")}`);
      if (c.outOfOrder) problems.push(`섹션 순서가 다릅니다 (${a.sections.join(" → ")})`);
      if (c.empty.length) problems.push(`빈 섹션: ${c.empty.join(", ")}`);
    }
    const open = [...s.threads.values()].filter((t) => t.phase === s.phase && t.status === "open");
    if (open.length) problems.push(`열린 쓰레드 ${open.length}개: ${open.map((t) => t.id).join(", ")}`);
    // 이번 단계 실행의 인수인계 기록 형식 (§6.4)
    for (const run of [...s.runs.values()].filter((r) => r.phase === s.phase)) {
      const h = path.join(this.epicDir(wt, epic), "runs", run.run_id, "handoff.md");
      if (!existsSync(h)) continue;
      const c = checkSections(await readFile(h, "utf8"), HANDOFF_SECTIONS);
      if (c.missing.length) problems.push(`인수인계 기록(runs/${run.run_id}) 빠진 섹션: ${c.missing.join(", ")}`);
    }
    return { phase: s.phase, problems };
  }

  /** 단계 완료 (§4.1): 검사 → 산출물·인수인계 커밋 → phase.completed → 동기화 */
  async completePhase(epic: string): Promise<{ ok: true; commit: string | null; phase: Phase } | { ok: false; problems: string[] }> {
    const { phase, problems } = await this.checkPhase(epic);
    if (problems.length) return { ok: false, problems };
    const wt = await this.worktree(epic);
    await this.renderDocs(epic);
    const rel = path.relative(wt, this.epicDir(wt, epic));
    const commit = await this.eng.commit(wt, [rel], `${epic}: ${phase} 완료`, { "Flightdeck-Epic": epic, "Flightdeck-Phase": phase });
    if (this.cfg.remote) {
      // 서버는 원격 에픽 브랜치의 산출물로 형식·해시를 확인한다 (§4.2). 올린 그대로의 바이트로 해시를 낸다
      const head = await this.eng.pushEpicBranch(epic, this.gitRemote);
      const a = PHASE_ARTIFACT[phase as keyof typeof PHASE_ARTIFACT];
      const text = await git(["show", `${head}:.flightdeck/epics/${epic}/${a.file}`], { cwd: wt });
      await this.passEvent(epic, "phase.completed", { phase, artifact_hash: artifactHash(text) });
    } else {
      await this.emit(epic, "phase.completed", { phase });
    }
    const s = await this.sync(epic);
    if (this.cfg.remote) await this.trackerPhase(epic, s.phase);
    return { ok: true, commit, phase: s.phase };
  }

  /** 자동 초안 (§6.1 headless): 백그라운드 claude -p. 끝나면 세션 ID로 이어서 작업(resume)한다 */
  async draft(epic: string, extra = ""): Promise<{ sessionId: string; result: string }> {
    const adapter = this.cfg.adapter;
    if (!adapter.headless) throw new Error(`${adapter.id}는 headless 실행을 지원하지 않습니다`);
    const s = await this.epicState(epic);
    const a = PHASE_ARTIFACT[s.phase as keyof typeof PHASE_ARTIFACT];
    if (!a) throw new Error(`${s.phase} 단계는 자동 초안 대상이 아닙니다`);
    const prompt = [
      `Flightdeck ${s.phase} 단계의 초안을 작성하세요.`,
      `세션 맥락에 있는 단계 룰과 산출물 형식(필수 섹션)을 따라 .flightdeck/epics/${epic}/${a.file}를 쓰고, 끝나기 전에 인수인계 기록(handoff.md)도 쓰세요.`,
      extra,
    ]
      .filter(Boolean)
      .join("\n");
    const r = await adapter.headless(prompt, {
      cwd: await this.worktree(epic),
      model: this.cfg.model,
      maxTurns: this.cfg.maxTurns ?? 40,
      allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash", "mcp__flightdeck"],
    });
    const dataDir = await this.eng.dataDir();
    await writeState(dataDir, { ...(await readState(dataDir, epic)), draft_session: r.sessionId });
    await this.sync(epic);
    return { sessionId: r.sessionId, result: r.result };
  }
}

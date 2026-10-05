// 에픽 워크플로 (설계 §9.1 진입 흐름, §4 단계, §3 쓰레드). VS Code API를 쓰지 않는 순수 Node 모듈이다.
// 확장(extension.ts)은 이 모듈을 화면에 연결만 한다. 테스트·스크립트에서도 그대로 쓴다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { anchoringPrompt, applyTextEdit, artifactHash, auditMain, blame, checkSections, configHash, moveLines, parseAnchoring, parseSessionDraft, renderSessionDraft, renderSessionSummary, sessionReplyText, writerOf, type BlameEntry, type SessionItem, configVersionOf, diffRecords, diffToEdits, draftText, ensureParagraphIds, insertDrafts, linesLabel, mapLines, myOpenThreads, type AuditFinding, type MainCommit, needsServerSignature, nowIso, parseDrafts, parseImplLog, pipelineFromDir, reduce, removeDrafts, renderThreads, replay, restoreParagraphIds, reviewOf, sha256, stripThreads, threadIdFrom, trustFromConfig, ulid, type ConfigPayload, type CoverageReport, type Draft, type EpicState, type MemoGroup, type Thread } from "@flightdeck/core";
import { git, gitBuffer, GitEngine, LocalEventStore, MetaRewriteError, RAW_ARGS, RAW_ENV, RemoteEventStore, RunStore, seqTrailer } from "@flightdeck/git";
import { DEV_TRUST, HANDOFF_SECTIONS, parsePipeline, PHASE_ARTIFACT, type Anchor, type EditMemo, type EditRecord, type EditSource, type Event, type EventOf, type EventType, type LocalEpicStateInput, type Phase, type Pipeline, type Trust } from "@flightdeck/schema";
import type { AgentAdapter } from "@flightdeck/agent";
import type { TrackerAdapter, TrackerEpic } from "@flightdeck/tracker";
import { appendEditRecords, appendMemo, baseContent, checkImplLogFile, computeCoverage, implLogRel, lastSeq, readEditLog, readMemos, readState, recordDrift, renderMemos, queueOpinion, replaceEditLog, statePath, toolInProgress, writeState, type ImplContext, type Opinion } from "@flightdeck/hook";
import { applyRecords } from "./live.ts";
import { waitForNotes, type CollectedNotes, type MeetAdapter, type MeetSpace } from "./meet.ts";
import { cacheConfig, configCacheDir, loadCachedConfig, ServerRequestError, type ServerClient } from "./server-client.ts";

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
  /** 내가 담당한 에픽 (리뷰어가 단 쓰레드). 읽기 전용 창이 아니라 내 작업 폴더에서 연다 */
  mine?: boolean;
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
    // 서버가 판정에 편집 기록을 쓸 수 있게 먼저 올린다 (M7: 반영 coverage)
    await this.syncEditlog(epic).catch((err) => this.warnings.push(`편집 기록을 서버에 올리지 못했다: ${err instanceof Error ? err.message : err}`));
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

  private pipelineCache = new Map<string, { pipeline: Pipeline; hash?: string }>();

  /**
   * 에픽에 고정된 설정 버전의 파이프라인 (§2.5 버전 고정, 티어 리뷰 판정).
   * 개발 모드는 설정 폴더, 서버 모드는 받은 설정 → 캐시 → 서버 순으로 찾는다
   */
  async pipelineFor(version: string | null): Promise<Pipeline | undefined> {
    return (await this.configFor(version))?.pipeline;
  }

  /**
   * 설정 버전의 파이프라인과 내용 해시 (M5.5 Z9).
   * 받은 설정 → 캐시 → 서버 순으로 보고, want(에픽 시작 때 서명된 해시)가 있으면 해시가 맞는 것을 고른다.
   * 맞는 것이 없으면 처음 찾은 것을 돌려주고, reducer가 설정 불일치로 표시한다
   */
  async configFor(version: string | null, want?: string): Promise<{ pipeline: Pipeline; hash?: string } | undefined> {
    if (!version) return undefined;
    const key = `${version}\0${want ?? ""}`;
    if (this.pipelineCache.has(key)) return this.pipelineCache.get(key);
    const r = this.cfg.remote;
    let found: { pipeline: Pipeline; hash?: string } | undefined;
    if (!r) {
      const p = pipelineFromDir(this.cfg.configDir);
      found = p ? { pipeline: p } : undefined;
    } else {
      const dataDir = await this.eng.dataDir();
      const tries: (() => Promise<ConfigPayload | null>)[] = [
        async () => (version === r.config.version ? r.config : null),
        () => loadCachedConfig(dataDir, r.product, version),
        async () => {
          const c = await r.server.config(r.product, version).catch(() => null);
          if (c) await cacheConfig(dataDir, c);
          return c;
        },
      ];
      for (const t of tries) {
        const c = await t();
        if (!c) continue;
        const cand = { pipeline: parsePipeline(c.pipeline_yaml), hash: configHash(c) };
        found ??= cand;
        if (!want || cand.hash === want) {
          found = cand;
          break;
        }
      }
    }
    if (found) this.pipelineCache.set(key, found);
    return found;
  }

  /** 이벤트로 에픽 상태를 계산한다 (신뢰 기준 + 에픽의 파이프라인, 설정 내용 해시 확인) */
  async reduceEvents(epic: string, events: Event[]): Promise<EpicState> {
    const started = events.find((e) => e.epic === epic && e.type === "epic.started") as EventOf<"epic.started"> | undefined;
    const c = await this.configFor(configVersionOf(events, epic), started?.data.config_hash);
    return reduce(epic, events, this.trust, { pipelines: () => c?.pipeline, configHash: () => c?.hash });
  }

  private async emit<T extends EventType>(epic: string, type: T, data: EventOf<T>["data"], author = this.cfg.member, id = ulid()): Promise<EventOf<T>> {
    if (this.cfg.remote && needsServerSignature({ type })) throw new Error(`${type}는 서버에 요청해야 하는 단계 통과 이벤트다 (§12)`);
    const e = { v: 1, id, type, epic, author, at: nowIso(), data } as EventOf<T>;
    // 메타 브랜치는 append-only라 한번 쓰면 지울 수 없다. reducer가 무시할 이벤트(권한·관문)는 쓰기 전에 막고 이유를 알린다
    const events = await this.store.list(epic);
    const ignored = (await this.reduceEvents(epic, [...events, e as Event])).ignored.find((i) => i.event === e.id);
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
      const s: LocalEpicStateInput = {
        epic,
        repo: this.cfg.repo,
        worktree,
        member: this.cfg.member,
        role: "owner",
        ...(remote ? { product: remote.product, gitRemote: this.gitRemote } : {}),
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
      const s = await this.reduceEvents(epic, events);
      // 나에게 온 열린 쓰레드 중 내가 마지막으로 답하지 않은 것. 내 에픽이면 리뷰어가 담당자에게 단 수정 요청·질문이다(내 작업 폴더에서 연다)
      for (const t of myOpenThreads(s, this.cfg.member).filter((x) => x.to.includes(this.cfg.member) && x.author !== this.cfg.member)) {
        const created = events.find((e) => e.type === "thread.created" && e.data.thread === t.id) as EventOf<"thread.created"> | undefined;
        out.push({ epic, thread: t, ...(created?.data.commit ? { commit: created.data.commit } : {}), ...(writerOf(s) === this.cfg.member ? { mine: true } : {}) });
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
    if (writerOf(s0) === this.cfg.member) throw new Error("내가 조종하는 에픽은 작업 폴더에서 연다");
    const dataDir = await this.eng.dataDir();
    // 올리지 않은 쓰레드 초안은 커밋을 옮겨도 남긴다 (리뷰어의 에이전트가 쓴 것, §3.2)
    const kept = new Map<string, { draft: Draft; text: string }[]>();
    const prevWt = this.eng.worktreePath(epic);
    for (const name of ARTIFACT_FILES) {
      const f = path.join(this.epicDir(prevWt, epic), name);
      if (!existsSync(f)) continue;
      const md = await readFile(f, "utf8");
      const ds = parseDrafts(md).map((d) => ({ draft: d, text: draftText(md, d) }));
      if (ds.length) kept.set(name, ds);
    }
    // 검증 단계 리뷰어의 창은 쓰기 가능한 리뷰 사본이다 (M5 Y3). 아직 제안하지 않은 고친 내용은 새 커밋으로 옮겨도 남긴다
    const role = s0.phase === "VERIFICATION" ? "review" : "viewer";
    const prevState = existsSync(statePath(dataDir, epic)) ? await readState(dataDir, epic).catch(() => null) : null;
    const carry = prevState?.role === "review" && existsSync(prevWt) ? await this.copyDiff(prevWt) : "";
    // 리뷰 중이면 리뷰 요청된 커밋을 본다 (요청 뒤 담당자가 고친 것은 다시 요청할 때까지 보지 않는다, §4.2)
    const v = await this.eng.openViewWorktree(epic, commit ?? s0.review.requested?.commit, this.gitRemote);
    if (role === "review") await git(["clean", "-fdq", "-e", ".flightdeck/.runtime"], { cwd: v.path }).catch(() => undefined);
    for (const [name, ds] of kept) {
      const f = path.join(this.epicDir(v.path, epic), name);
      if (existsSync(f)) await writeFile(f, insertDrafts(await readFile(f, "utf8"), ds));
    }
    if (carry) {
      await git(["apply", "--whitespace=nowarn", "-"], { cwd: v.path, input: carry }).catch(async () => {
        const keep = path.join(dataDir, `review-${epic}.patch`);
        await writeFile(keep, carry);
        this.warnings.push(`리뷰 사본에서 고친 내용이 새 리뷰 커밋에 맞지 않아 옮기지 못했다. ${keep}에 남겼다`);
      });
    }
    // 단계 룰·파이프라인은 에픽에 고정된 설정 버전 (훅·MCP가 읽는다)
    const version = s0.config_version;
    const configDir = this.cfg.remote && version && (await this.pipelineFor(version)) ? configCacheDir(dataDir, this.cfg.remote.product, version) : this.cfg.configDir;
    await writeState(dataDir, {
      epic,
      repo: this.cfg.repo,
      worktree: v.path,
      member: this.cfg.member,
      role,
      ...(this.cfg.remote ? { product: this.cfg.remote.product, gitRemote: this.gitRemote } : {}),
      phase: s0.phase,
      configDir,
      trust: this.trust,
      excludeSecrets: this.eng.excludeSecrets,
      runs: {},
    });
    // 에이전트 설정: 리뷰 정책 훅 + MCP (§3.6, §6.2 v0.13). 기록은 남기지 않는다
    await this.cfg.adapter.installConfig(
      v.path,
      this.hookCommand(epic),
      { name: "flightdeck", command: "node", args: [path.join(this.cfg.distDir, "flightdeck-mcp.mjs"), "--repo", this.cfg.repo, "--epic", epic] },
      { model: this.cfg.model },
    );
    return { worktree: v.path, state: await this.sync(epic) };
  }

  async role(epic: string): Promise<"owner" | "viewer" | "review" | "live"> {
    return (await readState(await this.eng.dataDir(), epic)).role;
  }

  // ---- 조종수 모델 (§8.2~8.5, M8) ----

  /**
   * 관찰 시작 (§8.3, L8): 조종수의 마지막 체크포인트로 `<epic>@live`를 열고, 그 뒤의 서버 편집 기록을 적용한다.
   * 다시 부르면 처음부터 다시 맞춘다. 실시간 편집은 LiveFollower가 이어서 적용한다
   */
  async openLive(epic: string): Promise<{ worktree: string; seq: number; pilot: string; mismatch: number | null }> {
    const r = this.cfg.remote;
    if (!r) throw new Error("관찰은 서버 모드에서만");
    await this.pull();
    const s = await this.epicState(epic);
    const pilot = writerOf(s);
    if (!pilot) throw new Error(`시작되지 않은 에픽: ${epic}`);
    if (pilot === this.cfg.member) throw new Error("내가 조종하는 에픽입니다");
    const ckpt = await this.eng.fetchCheckpoint(epic, pilot, this.gitRemote);
    if (!ckpt) throw new Error(`조종수 @${pilot}의 체크포인트가 아직 없습니다 (조종수가 작업을 시작하면 생깁니다)`);
    const seq = seqTrailer(await git(["log", "-1", "--format=%B", ckpt], { cwd: this.cfg.repo })) ?? 0;
    const wt = await this.eng.openLiveWorktree(epic, ckpt);
    const { records } = await r.server.editlog(r.product, epic, seq + 1);
    const a = await applyRecords(wt, records);
    return { worktree: wt, seq: a.applied || seq, pilot, mismatch: a.mismatch };
  }

  /**
   * 조종 넘기기 (§8.5, L4): 외부 변경 기록 → 체크포인트 → push → 편집 기록 올리기 → pilot.changed.
   * 내 작업 폴더는 그 뒤 읽기 전용(관찰자)이 된다. 새 조종수는 adoptPilot으로 이어받는다
   */
  async handOff(epic: string, to: string, reason: "handoff" | "request"): Promise<EpicState> {
    const s = await this.epicState(epic);
    if (writerOf(s) !== this.cfg.member || (await this.role(epic)) !== "owner") throw new Error("조종수의 작업 폴더에서만 넘길 수 있습니다");
    if (to === this.cfg.member) throw new Error("자기 자신에게 넘길 수 없습니다");
    const dataDir = await this.eng.dataDir();
    if ((await this.recordExternal(epic)) === null) throw new Error("에이전트 도구가 실행 중입니다. 끝난 뒤 넘기세요");
    const wt = await this.worktree(epic);
    const seq = await lastSeq(dataDir, epic);
    const ckpt = await this.eng.checkpoint(wt, { epic, member: this.cfg.member, message: `조종 넘기기 → @${to}`, trailers: { "Flightdeck-Source": "handoff", "Flightdeck-Seq": String(seq) } });
    if (this.cfg.remote) {
      await this.eng.pushCheckpoint(epic, this.cfg.member, this.gitRemote);
      const up = await this.syncEditlog(epic);
      if (up !== seq) throw new Error(`편집 기록을 서버에 다 올리지 못했습니다 (서버 ${up}, 로컬 ${seq}). 넘기지 않았습니다`);
    }
    await this.emit(epic, "pilot.changed", { from: this.cfg.member, to, reason, ckpt });
    const { updateState } = await import("@flightdeck/hook");
    await updateState(dataDir, epic, (st) => {
      st.role = "viewer"; // 이제 관찰자: 훅이 쓰기를 막는다
    });
    return this.sync(epic);
  }

  /**
   * 조종을 넘겨받는다 (§8.5, L4·L5): 이전 조종수의 체크포인트로 내 작업 폴더를 만들고, 서버 편집 기록·메모를 이 PC의 기록으로 둔다.
   * takeover: 담당자의 강제 인수(조종수 이탈). pilot.changed(takeover)를 먼저 쓴다
   */
  async adoptPilot(epic: string, opts: { takeover?: boolean } = {}): Promise<{ worktree: string; state: EpicState; applied: number }> {
    const r = this.cfg.remote;
    if (!r) throw new Error("조종 넘겨받기는 서버 모드에서만");
    await this.pull();
    let s = await this.epicState(epic);
    if (opts.takeover) {
      const prev = writerOf(s);
      if (s.owner !== this.cfg.member) throw new Error("강제 인수는 담당자만 할 수 있습니다");
      if (!prev || prev === this.cfg.member) throw new Error("이미 내가 조종수입니다");
      const ckpt = await this.eng.fetchCheckpoint(epic, prev, this.gitRemote);
      await this.emit(epic, "pilot.changed", { from: prev, to: this.cfg.member, reason: "takeover", ...(ckpt ? { ckpt } : {}) });
      s = await this.sync(epic);
    }
    if (writerOf(s) !== this.cfg.member) throw new Error(`조종수는 @${writerOf(s)}입니다`);
    const last = s.pilotHistory.at(-1);
    if (!last) throw new Error("넘겨받은 기록(pilot.changed)이 없습니다");
    // 이전 조종수의 체크포인트 ref를 받으면 넘길 때 적은 체크포인트(그 체인의 일부)도 함께 온다
    const latest = await this.eng.fetchCheckpoint(epic, last.from, this.gitRemote);
    const ckpt = last.ckpt ?? latest;
    const head = await this.eng.fetchEpicBranch(epic, this.gitRemote);
    if (!head || !ckpt) throw new Error("에픽 브랜치나 이전 조종수의 체크포인트를 받지 못했습니다");
    const dataDir = await this.eng.dataDir();
    const wt = await this.eng.adoptEpicWorktree(epic, head, ckpt);
    const ckptSeq = seqTrailer(await git(["log", "-1", "--format=%B", ckpt], { cwd: this.cfg.repo })) ?? 0;
    const log = await r.server.editlog(r.product, epic, 1);
    await replaceEditLog(dataDir, epic, log.records, log.memos);
    // 세션 원본·테스트 로그 ref도 이어받는다. 받지 않으면 내가 처음 쓰는 기록이 원격과 갈라져 push가 거절된다 (M8 시나리오)
    await new RunStore(this.cfg.repo).fetch(epic, this.gitRemote).catch(() => false);
    const a = await applyRecords(wt, log.records.filter((x) => x.seq > ckptSeq));
    if (a.mismatch !== null) this.warnings.push(`편집 기록 ${a.mismatch}가 체크포인트 내용과 맞지 않아 그 뒤를 적용하지 못했습니다`);
    const implLog = path.join(wt, implLogRel(epic));
    const steps = existsSync(implLog) ? parseImplLog(await readFile(implLog, "utf8")).steps.map((x) => x.n) : [];
    const version = s.config_version;
    const configDir = version && (await this.pipelineFor(version)) ? configCacheDir(dataDir, r.product, version) : this.cfg.configDir;
    await writeState(dataDir, {
      epic,
      repo: this.cfg.repo,
      worktree: wt,
      member: this.cfg.member,
      role: "owner",
      product: r.product,
      gitRemote: this.gitRemote,
      phase: s.phase,
      configDir,
      trust: this.trust,
      excludeSecrets: this.eng.excludeSecrets,
      impl_step: steps.length ? Math.max(...steps) : 0,
      runs: {},
    });
    await this.cfg.adapter.installConfig(wt, this.hookCommand(epic), { name: "flightdeck", command: "node", args: [path.join(this.cfg.distDir, "flightdeck-mcp.mjs"), "--repo", this.cfg.repo, "--epic", epic] }, { model: this.cfg.model });
    this.uploaded.set(epic, { last: log.last, memos: sha256(JSON.stringify(log.memos))! });
    return { worktree: wt, state: await this.sync(epic), applied: a.applied };
  }

  /**
   * 관찰의 시작점 (L8): 조종수의 체크포인트가 원격에 없으면 지금 상태로 하나 만들어 올린다.
   * 바뀐 것이 없으면 체크포인트를 만들지 않으므로, 시작 직후에는 관찰자가 붙을 곳이 없다(M8 시나리오 1차)
   */
  async ensureCheckpoint(epic: string): Promise<string | null> {
    if (!this.cfg.remote || (await this.role(epic)) !== "owner") return null;
    const ref = GitEngine.checkpointRef(epic, this.cfg.member);
    const remote = await git(["ls-remote", this.gitRemote, ref], { cwd: this.cfg.repo }).catch(() => "");
    if (remote.trim()) return remote.split("\t")[0]!;
    const dataDir = await this.eng.dataDir();
    const sha = await this.eng.checkpoint(await this.worktree(epic), { epic, member: this.cfg.member, message: "관찰 시작점", trailers: { "Flightdeck-Source": "human", "Flightdeck-Seq": String(await lastSeq(dataDir, epic)) } });
    await this.eng.pushCheckpoint(epic, this.cfg.member, this.gitRemote);
    await this.syncEditlog(epic).catch(() => undefined);
    return sha;
  }

  // ---- 회의 (§10, M6) ----

  /** 회의 시작 (§10.1 ①②): Meet 공간을 만들고(회의록·전사 자동 생성 요청) session.started */
  async startSession(epic: string, title: string, meet: MeetAdapter): Promise<{ sid: string; space: MeetSpace }> {
    const space = await meet.createSpace();
    const sid = `s-${ulid().slice(-8)}`;
    await this.emit(epic, "session.started", { sid, title, space: { name: space.name, uri: space.uri, ...(space.code ? { code: space.code } : {}) }, ...(space.artifacts ? { artifacts: space.artifacts } : {}) });
    await this.sync(epic);
    return { sid, space };
  }

  async endSession(epic: string, sid: string): Promise<void> {
    await this.emit(epic, "session.ended", { sid });
    await this.sync(epic);
  }

  /** 회의 중 내 포커스 (§10.1 ③, G1): 회의가 끝나면 한 번 올린다 */
  async postFocus(epic: string, sid: string, entries: { ts: string; file: string; range: [number, number] }[]): Promise<void> {
    await this.emit(epic, "session.focus", { sid, entries: entries.slice(-1000) });
  }

  /** 회의 초안 위치: <git 공용 폴더>/flightdeck/sessions/<sid>.md (주최자만 보는 검토 문서, G3) */
  async sessionDraftPath(sid: string): Promise<string> {
    return path.join(await this.eng.dataDir(), "sessions", `${sid}.md`);
  }

  /**
   * 회의 요약 초안 (§10.1 ⑤⑥, G3·G6): 회의록을 기다려 가져오고, 주최자의 에이전트로 쓰레드·코드 위치·에픽에 앵커링해 검토 초안을 쓴다.
   * 회의록이 없으면(꺼짐·30분 초과) 포커스와 전사만으로
   */
  async collectSession(epic: string, sid: string, meet: MeetAdapter, opts: { intervalMs?: number; timeoutMs?: number; onWait?: (m: string) => void; model?: string } = {}): Promise<{ draft: string; items: SessionItem[]; notes: CollectedNotes }> {
    await this.pull();
    const s = await this.epicState(epic);
    const ss = s.sessions.get(sid);
    if (!ss) throw new Error(`없는 회의: ${sid}`);
    if (ss.host !== this.cfg.member) throw new Error(`주최자(@${ss.host})만 회의 요약을 만든다`);
    if (!ss.ended_at) throw new Error("회의가 아직 끝나지 않았습니다");
    const notes = await waitForNotes(meet, ss.space?.name ?? "", opts);
    const threads = [...s.threads.values()].map((t) => ({
      id: t.id,
      file: t.file,
      where: t.anchor.type === "paragraph" ? t.anchor.pid : t.anchor.type === "code" ? `${t.anchor.file}:${t.anchor.range[0]}-${t.anchor.range[1]}` : "",
      status: t.status,
      body: t.body,
      ...(t.replies.at(-1) ? { last: t.replies.at(-1)!.body } : {}),
    }));
    const focus = ss.focus.flatMap((f) => f.entries.map((x) => ({ member: f.member, ...x })));
    const prompt = anchoringPrompt({ epic, title: ss.title, notes: notes.notes, transcript: notes.transcript, focus, threads });
    if (!this.cfg.adapter.headless) throw new Error(`${this.cfg.adapter.id}는 headless 실행을 지원하지 않습니다`);
    const cwd = existsSync(statePath(await this.eng.dataDir(), epic)) ? await this.worktree(epic) : this.cfg.repo;
    const r = await this.cfg.adapter.headless(prompt, { cwd, ...(opts.model ?? this.cfg.model ? { model: opts.model ?? this.cfg.model } : {}), maxTurns: 3, allowedTools: [] });
    const items = parseAnchoring(r.result, new Set(threads.map((t) => t.id)));
    const notesUrl = notes.notesDoc && !notes.notesDoc.startsWith("fixture") ? `https://docs.google.com/document/d/${notes.notesDoc}` : undefined;
    const draft = await this.sessionDraftPath(sid);
    await mkdir(path.dirname(draft), { recursive: true });
    await writeFile(draft, renderSessionDraft(sid, ss.title, items, notesUrl));
    return { draft, items, notes };
  }

  /** 게시 (§10.1 ⑧, G4): 검토 초안을 읽어 쓰레드 답글·새 코드 쓰레드·session.published(sessions/<sid>.md 내용) */
  async publishSession(epic: string, sid: string): Promise<{ replies: number; created: number; epicItems: number }> {
    const s = await this.epicState(epic);
    const ss = s.sessions.get(sid);
    if (!ss) throw new Error(`없는 회의: ${sid}`);
    const md = await readFile(await this.sessionDraftPath(sid), "utf8");
    const { items, problems } = parseSessionDraft(md);
    if (problems.length) throw new Error(`초안 문제: ${problems.join("; ")}`);
    const notesUrl = /^회의록: (\S+)$/m.exec(md)?.[1];
    let replies = 0;
    let created = 0;
    for (const i of items) {
      if ("thread" in i.target) {
        await this.emit(epic, "thread.replied", { thread: i.target.thread, body: sessionReplyText(i), source: "session", sid });
        replies++;
      } else if ("file" in i.target) {
        await this.createCodeThread(epic, { file: i.target.file, range: i.target.lines, kind: "note", to: [], body: `🎙 회의 ${sid}\n${sessionReplyText(i)}`, session: sid });
        created++;
      }
    }
    const summary = renderSessionSummary({ sid, title: ss.title, host: ss.host, started_at: ss.started_at, ...(ss.ended_at ? { ended_at: ss.ended_at } : {}), ...(notesUrl ? { notesUrl } : {}), items });
    await this.emit(epic, "session.published", { sid, items: items.length, summary, ...(notesUrl ? { notes_url: notesUrl } : {}) });
    await this.sync(epic);
    await this.commitSessionSummaries(epic).catch((e) => this.warnings.push(`회의 요약 파일을 커밋하지 못했다: ${e instanceof Error ? e.message : e}`));
    return { replies, created, epicItems: items.filter((i) => "epic" in i.target).length };
  }

  /** 게시된 회의의 sessions/<sid>.md를 에픽 브랜치에 커밋한다 (G4: 조종수의 작업 폴더에서만). 커밋한 파일 */
  async commitSessionSummaries(epic: string): Promise<string[]> {
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic)) || (await this.role(epic)) !== "owner") return [];
    const s = await this.epicState(epic);
    if (writerOf(s) !== this.cfg.member) return [];
    const wt = await this.worktree(epic);
    const done: string[] = [];
    for (const ss of s.sessions.values()) {
      if (!ss.published) continue;
      const rel = `.flightdeck/epics/${epic}/sessions/${ss.sid}.md`;
      if (existsSync(path.join(wt, rel))) continue;
      await mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
      await writeFile(path.join(wt, rel), ss.published.summary);
      // Flightdeck 렌더링으로 기록해 coverage가 설명을 요구하지 않게 한다
      await appendEditRecords(dataDir, epic, diffRecords(epic, rel, null, ss.published.summary, { kind: "flightdeck", member: this.cfg.member, reason: "thread_render" }, nowIso()));
      done.push(rel);
    }
    if (done.length) {
      await this.eng.commit(wt, done, `${epic}: 회의 요약 ${done.length}건`, { "Flightdeck-Epic": epic });
      if (this.cfg.remote) await this.eng.pushEpicBranch(epic, this.gitRemote);
    }
    return done;
  }

  /** 조종수가 고른 관찰자 의견을 에이전트 전달 대기열에 넣는다 (§8.4, L7) */
  async deliverOpinion(epic: string, o: Opinion): Promise<void> {
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic)) || (await this.role(epic)) !== "owner") throw new Error("조종수의 작업 폴더에서만 에이전트에 전달합니다");
    await queueOpinion(await this.eng.dataDir(), epic, o);
  }

  async worktree(epic: string): Promise<string> {
    return (await readState(await this.eng.dataDir(), epic)).worktree;
  }

  async epicState(epic: string): Promise<EpicState> {
    return this.reduceEvents(epic, await this.store.list(epic));
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
    if (local.role === "owner") await this.reconcileTracker(epic, s);
    return s;
  }

  /** 단계별로 한 번만 일감 상태를 확인한다 (에픽 → 마지막으로 맞춘 단계) */
  private reconciled = new Map<string, Phase>();

  /**
   * 조정 (§1.4 reconcile): reducer 단계 ≠ 일감 상태이면 맞춘다. 단계 전환을 일으킨 사람이 일감 도구 토큰이 없어
   * 바꾸지 못한 경우를 담당자의 확장이 메운다 (M3 실측: architect 승인 뒤 일감이 '설계'에 머묾)
   */
  private async reconcileTracker(epic: string, s: EpicState): Promise<void> {
    const t = this.cfg.remote?.tracker;
    if (!t || !s.tracker_ref || this.reconciled.get(epic) === s.phase) return;
    const want = this.statusMap()[s.phase];
    try {
      if (want && (await t.getEpic(s.tracker_ref)).status.toLowerCase() !== want.toLowerCase()) await t.setPhase(s.tracker_ref, s.phase);
      this.reconciled.set(epic, s.phase);
    } catch (e) {
      this.warnings.push(`일감 상태를 맞추지 못했다: ${e instanceof Error ? e.message : e}`);
    }
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
  renderDocs(epic: string, _s?: EpicState): Promise<string[]> {
    // 한 번에 하나씩 (M2 실측: 질문 공유와 파일 감시·원격 감시의 새로 고침이 겹쳐 같은 렌더링이 편집 기록에 두 번 남았다).
    // 읽기(재적용) → 디스크 쓰기 → 기록이 한 묶음이어야 편집 기록 재적용 = 디스크가 유지된다. 상태는 차례가 왔을 때 다시 계산한다
    const run = this.renderQueue.then(() => this.renderDocsNow(epic));
    this.renderQueue = run.catch(() => undefined);
    return run;
  }

  private renderQueue: Promise<unknown> = Promise.resolve();

  private async renderDocsNow(epic: string): Promise<string[]> {
    const state = await this.epicState(epic);
    const wt = await this.worktree(epic);
    const dataDir = await this.eng.dataDir();
    if ((await readState(dataDir, epic)).role !== "owner") {
      // 읽기 전용 창 (§2.4, §6.2 v0.13): 공유 커밋 내용 위에 쓰레드를 그리고, 쓰레드 초안만 남긴다.
      // 초안 밖의 변경(에이전트·사람)은 버린다. 편집 기록에 남기지 않는다
      const changed: string[] = [];
      const report: RenderReport[] = [];
      for (const name of ARTIFACT_FILES) {
        const file = path.join(this.epicDir(wt, epic), name);
        const rel = path.relative(wt, file).split(path.sep).join("/");
        const shared = await git(["show", `HEAD:${rel}`], { cwd: wt }).catch(() => null);
        if (shared === null || !existsSync(file)) continue;
        const disk = await readFile(file, "utf8");
        const drafts = parseDrafts(disk).map((d) => ({ draft: d, text: draftText(disk, d) }));
        const rendered = renderThreads(stripThreads(shared), name, state.threads.values());
        const next = insertDrafts(rendered, drafts);
        if (next !== disk) {
          await writeFile(file, next);
          changed.push(name);
          // 초안·쓰레드 블록을 빼고도 다르면 문서 내용을 고친 것 → 되돌렸다고 알린다
          if (stripThreads(removeDrafts(disk)) !== stripThreads(removeDrafts(next))) report.push({ file: name, external: true, restoredIds: 0, changed: true });
        }
      }
      this.lastRender = report;
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
    // 올리지 않은 쓰레드 초안은 개인 것이다. 공유 커밋에 들어가면 리뷰어·질문 대상에게 보인다 (§3.2)
    const pending = (await this.drafts(epic)).length;
    if (pending) throw new Error(`올리지 않은 쓰레드 초안이 ${pending}개 있습니다. 먼저 올리거나 지운 뒤 공유하세요`);
    const rel = path.relative(wt, this.epicDir(wt, epic));
    await this.eng.commit(wt, [rel], message, { "Flightdeck-Epic": epic });
    if (this.cfg.remote) return this.eng.pushEpicBranch(epic, this.gitRemote);
    return this.eng.revParse("HEAD", wt);
  }

  async createThread(epic: string, t: { file: string; pid: string; kind: "question" | "change_request" | "note"; to: string[]; body: string; source?: "human" | "agent" }): Promise<string> {
    const s = await this.epicState(epic);
    const viewer = (await this.role(epic)) !== "owner";
    const unknown = this.cfg.remote ? t.to.filter((m) => !this.cfg.remote!.config.members.some((x) => x.id === m && x.active)) : [];
    if (unknown.length) throw new Error(`등록되지 않았거나 비활성인 멤버: ${unknown.map((m) => "@" + m).join(", ")}`);
    const id = ulid();
    const thread = threadIdFrom(id);
    const anchor: Anchor = { type: "paragraph", pid: t.pid };
    // 담당자는 문서를 공유하고 그 커밋을 남긴다. 리뷰어(읽기 전용 창)는 지금 보고 있는 커밋을 남긴다 (리뷰어는 에픽 브랜치에 쓰지 않는다)
    const commit = viewer ? await this.eng.revParse("HEAD", await this.worktree(epic)) : this.cfg.remote ? await this.share(epic, `${epic}: 질문 공유 (${thread})`) : undefined;
    const data = { thread, phase: s.phase, file: t.file, anchor, kind: t.kind, to: t.to, body: t.body, ...(commit ? { commit } : {}), ...(t.source === "agent" ? { source: "agent" as const } : {}) };
    await this.emit(epic, "thread.created", data, this.cfg.member, id);
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

  // ---- 쓰레드 초안 (§3.2 v0.13): 에이전트가 문서에 쓰고, 사람이 확인해 올린다 ----

  /** 이 창의 산출물에 있는 쓰레드 초안 */
  async drafts(epic: string): Promise<{ file: string; draft: Draft }[]> {
    const wt = await this.worktree(epic);
    const out: { file: string; draft: Draft }[] = [];
    for (const name of ARTIFACT_FILES) {
      const f = path.join(this.epicDir(wt, epic), name);
      if (existsSync(f)) for (const d of parseDrafts(await readFile(f, "utf8"))) out.push({ file: name, draft: d });
    }
    return out;
  }

  /** 초안을 문서에서 지운다 (담당자 창은 편집 기록에 flightdeck/draft_posted로 남긴다). 지우기 전 내용을 돌려준다 */
  private async takeDraft(epic: string, file: string, key: string): Promise<{ before: string; draft: Draft }> {
    const wt = await this.worktree(epic);
    const f = path.join(this.epicDir(wt, epic), file);
    const before = await readFile(f, "utf8");
    const draft = parseDrafts(before).find((d) => d.key === key);
    if (!draft) throw new Error("초안을 찾지 못했다 (이미 올렸거나 바뀌었다). 새로 고쳐 주세요");
    const after = removeDrafts(before, [key]);
    await writeFile(f, after);
    if ((await this.role(epic)) === "owner") {
      const rel = path.relative(wt, f).split(path.sep).join("/");
      await this.recordDiff(epic, rel, before, after, { kind: "flightdeck", member: this.cfg.member, reason: "draft_posted" });
    }
    return { before, draft };
  }

  /** 초안을 올린다: 새 쓰레드 또는 답글 (source: agent). 실패하면 초안을 되살린다 */
  async postDraft(epic: string, file: string, key: string): Promise<string> {
    const { before, draft: d } = await this.takeDraft(epic, file, key);
    try {
      if (d.error) throw new Error(d.error);
      if (d.reply) {
        await this.reply(epic, d.reply, d.body, { source: "agent" });
        return d.reply;
      }
      return await this.createThread(epic, { file, pid: d.anchor!, kind: d.kind!, to: d.to, body: d.body, source: "agent" });
    } catch (e) {
      const wt = await this.worktree(epic);
      const f = path.join(this.epicDir(wt, epic), file);
      if ((await this.role(epic)) === "owner") await this.recordDiff(epic, path.relative(wt, f).split(path.sep).join("/"), await readFile(f, "utf8"), before, { kind: "flightdeck", member: this.cfg.member, reason: "draft_posted" });
      await writeFile(f, before);
      throw e;
    }
  }

  /** 초안을 버린다 */
  async discardDraft(epic: string, file: string, key: string): Promise<void> {
    await this.takeDraft(epic, file, key);
    await this.sync(epic);
  }

  // ---- 티어 리뷰 (§4.2 v0.13) ----

  /** 리뷰 요청: 산출물 형식 확인 → 공유 → 서버에 review.requested → 현재 티어 리뷰어에게 일감 멘션 */
  async requestReview(epic: string): Promise<{ ok: true; state: EpicState } | { ok: false; problems: string[] }> {
    const s0 = await this.epicState(epic);
    const problems: string[] = [];
    if (writerOf(s0) !== this.cfg.member) problems.push(`조종수(@${writerOf(s0)})만 리뷰를 요청할 수 있습니다`);
    const a = PHASE_ARTIFACT[s0.phase as keyof typeof PHASE_ARTIFACT];
    if (!a || !reviewOf(s0)) problems.push(`${s0.phase} 단계는 티어 리뷰가 없습니다`);
    const wt = await this.worktree(epic);
    if (a) {
      const file = path.join(this.epicDir(wt, epic), a.file);
      if (!existsSync(file)) problems.push(`${a.file}이 없습니다`);
      else {
        const c = checkSections(await readFile(file, "utf8"), a.sections);
        if (c.missing.length) problems.push(`빠진 섹션: ${c.missing.join(", ")}`);
        if (c.outOfOrder) problems.push(`섹션 순서가 다릅니다 (${a.sections.join(" → ")})`);
        if (c.empty.length) problems.push(`빈 섹션: ${c.empty.join(", ")}`);
      }
    }
    if (problems.length) return { ok: false, problems };
    const head = await this.share(epic, `${epic}: ${s0.phase} 리뷰 요청`);
    const text = await git(["show", `${head}:.flightdeck/epics/${epic}/${a!.file}`], { cwd: wt });
    await this.passEvent(epic, "review.requested", { phase: s0.phase, artifact_hash: artifactHash(text) });
    const s = await this.sync(epic);
    await this.mentionReviewTurn(epic, s);
    return { ok: true, state: s };
  }

  /** 리뷰 차례 멘션 (§3.7, §4.2): 현재 티어 리뷰어 중 아직 승인하지 않은 사람 */
  private async mentionReviewTurn(epic: string, s: EpicState): Promise<void> {
    const cur = reviewOf(s)?.current;
    if (!cur || (s.phase !== "DESIGN" && s.phase !== "VERIFICATION")) return;
    const what = s.phase === "DESIGN" ? PHASE_ARTIFACT.DESIGN.file : "구현 검증";
    const to = cur.reviewers.filter((m) => m !== this.cfg.member && !cur.approvedBy.includes(m));
    await this.mention(epic, to, `리뷰 차례(${cur.name}) · ${what}`);
  }

  /** 내 리뷰 차례: 리뷰 요청된 에픽 중 현재 티어 리뷰어인데 아직 승인하지 않은 것 */
  async reviewInbox(): Promise<{ epic: string; tier: string; commit: string; phase: Phase }[]> {
    await this.pull();
    const out: { epic: string; tier: string; commit: string; phase: Phase }[] = [];
    for (const epic of await this.store.listEpics()) {
      const s = await this.reduceEvents(epic, await this.store.list(epic));
      const cur = reviewOf(s)?.current;
      if (!s.review.requested || !cur || s.owner === this.cfg.member) continue;
      if (cur.reviewers.includes(this.cfg.member) && !cur.approvedBy.includes(this.cfg.member)) out.push({ epic, tier: cur.name, commit: s.review.requested.commit, phase: s.phase });
    }
    return out;
  }

  /** 승인 (서버가 리뷰어 자격·차례·해시를 확인해 서명). 단계가 넘어가면 일감 상태를, 아니면 다음 티어 리뷰어에게 멘션 */
  async approve(epic: string): Promise<EpicState> {
    const s0 = await this.epicState(epic);
    if (!s0.review.requested) throw new Error("리뷰 요청 전입니다");
    const before = reviewOf(s0)?.current?.name;
    await this.passEvent(epic, "review.approved", { phase: s0.phase, artifact_hash: s0.review.requested.hash });
    const s = await this.sync(epic);
    if (s.phase !== s0.phase) await this.trackerPhase(epic, s.phase);
    else if (reviewOf(s)?.current?.name !== before) await this.mentionReviewTurn(epic, s);
    return s;
  }

  // ---- 단계 (§4) ----

  /** 현재 단계 산출물의 형식·관문을 검사한다. 통과하지 못하면 이유 목록을 돌려준다 */
  async checkPhase(epic: string): Promise<{ phase: Phase; problems: string[] }> {
    const s = await this.epicState(epic);
    const problems: string[] = [];
    if (writerOf(s) !== this.cfg.member) problems.push(`조종수(@${writerOf(s)})만 단계를 완료할 수 있습니다 (나: @${this.cfg.member})`);
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
  async completePhase(epic: string, opts: { onOutput?: (s: string) => void } = {}): Promise<{ ok: true; commit: string | null; phase: Phase } | { ok: false; problems: string[]; coverage?: CoverageReport }> {
    if ((await this.epicState(epic)).phase === "IMPLEMENTATION") return this.submitImplementation(epic, opts);
    const { phase, problems } = await this.checkPhase(epic);
    if (reviewOf(await this.epicState(epic))) return { ok: false, problems: [`${phase} 단계는 "리뷰 요청" 후 티어 승인으로 넘어갑니다 (§4.2)`] };
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

  // ---- 구현 (§7, §8.1, M4) ----

  /** 구현 단계 공통 맥락: 로컬 상태 + 에픽의 base + coverage_ignore */
  async implContext(epic: string): Promise<ImplContext> {
    const s = await this.epicState(epic);
    if (!s.base_sha) throw new Error(`시작되지 않은 에픽: ${epic}`);
    const dataDir = await this.eng.dataDir();
    const p = await this.pipelineFor(s.config_version);
    return { state: await readState(dataDir, epic), dataDir, baseSha: s.base_sha, coverageIgnore: p?.phases.implementation.gate.coverage_ignore ?? [] };
  }

  /**
   * 구현 관문 검사 (§7.3, X3): 편집 기록에 없는 변경을 external로 먼저 기록하고 coverage·impl-log 형식을 계산한다.
   * 확장은 저장하지 않은 편집을 먼저 저장하고 부른다
   */
  async implementationStatus(epic: string): Promise<{ coverage: CoverageReport; implLog: string[]; drift: string[]; threshold: number; step: number }> {
    const ctx = await this.implContext(epic);
    const drift = await recordDrift(ctx);
    const coverage = await computeCoverage(ctx);
    const p = await this.pipelineFor((await this.epicState(epic)).config_version);
    return { coverage, implLog: await checkImplLogFile(ctx.state), drift, threshold: p?.phases.implementation.gate.coverage ?? 1, step: ctx.state.impl_step };
  }

  /** 메모 (§7.4, X4): 수정 묶음에 메모를 붙이고 impl-log의 "직접 수정 메모"에 그린다 */
  async addMemo(epic: string, group: MemoGroup, memo: string): Promise<void> {
    if (!memo.trim()) throw new Error("메모가 비었습니다");
    const ctx = await this.implContext(epic);
    await appendMemo(ctx.dataDir, { epic, file: group.file, seqs: group.seqs, memo: memo.trim(), member: this.cfg.member, at: nowIso() });
    // 줄 범위: 이번 묶음은 지금 계산한 것, 앞서 단 메모는 impl-log에 이미 그린 것
    const implLog = path.join(ctx.state.worktree, implLogRel(epic));
    const prev = existsSync(implLog) ? parseImplLog(await readFile(implLog, "utf8")).memos : [];
    const same = (m: EditMemo) => m.file === group.file && m.seqs[0] === group.seqs[0] && m.seqs[1] === group.seqs[1];
    await renderMemos(
      ctx,
      await readMemos(ctx.dataDir, epic),
      (m) => (same(m) ? linesLabel(group.lines) : (prev.find((p) => p.file === m.file && p.memo === m.memo)?.lines ?? `편집 ${m.seqs[0]}-${m.seqs[1]}`)),
      (m) => `@${m.member}`,
    );
  }

  /** 체크포인트 (§8.1): 마지막 체크포인트와 다르면 만들고 원격에 올린다(서버 모드). 사람 저장·유휴 시 확장이 부른다 */
  async checkpoint(epic: string, why: string, source: "human" | "agent" = "human"): Promise<string | null> {
    const ctx = await this.implContext(epic);
    if (ctx.state.role !== "owner") return null;
    await recordDrift(ctx);
    const log = await readEditLog(ctx.dataDir, epic);
    const sha = await this.eng.checkpointIfChanged(ctx.state.worktree, {
      epic,
      member: this.cfg.member,
      message: `체크포인트 (${why})`,
      trailers: { "Flightdeck-Source": source, ...(ctx.state.phase === "IMPLEMENTATION" ? { "Flightdeck-Step": String(ctx.state.impl_step + 1) } : {}), "Flightdeck-Seq": String(log.at(-1)?.seq ?? 0) },
    });
    if (sha && this.cfg.remote) await this.eng.pushCheckpoint(epic, this.cfg.member, this.gitRemote).catch((e) => this.warnings.push(`체크포인트를 올리지 못했다: ${e instanceof Error ? e.message : e}`));
    return sha;
  }

  async checkpoints(epic: string) {
    return this.eng.listCheckpoints(epic, this.cfg.member);
  }

  /**
   * 이 시점으로 복원 (§8.1, X8): 복원 직전 상태를 체크포인트로 남기고 작업 트리를 되돌린다.
   * 바뀐 파일마다 파일 전체 교체를 편집 기록(출처 restore, 그 체크포인트의 seq)으로 남긴다
   */
  async restore(epic: string, target: string): Promise<{ before: string; files: string[] }> {
    const ctx = await this.implContext(epic);
    if (ctx.state.role !== "owner") throw new Error("읽기 전용 창에서는 복원할 수 없습니다");
    await recordDrift(ctx);
    const info = (await this.checkpoints(epic)).find((c) => c.sha === target);
    const seq = Number(info?.trailers["Flightdeck-Seq"] ?? 0);
    const wt = ctx.state.worktree;
    const { before } = await this.eng.restoreCheckpoint(wt, target, { epic, member: this.cfg.member });
    const changed = (await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", before, target], { cwd: wt })).split("\0").filter(Boolean);
    const source = { kind: "restore" as const, member: this.cfg.member, ckpt: target, seq };
    const ts = nowIso();
    const records: Omit<EditRecord, "seq">[] = [];
    for (const file of changed) {
      const prev = await git([...RAW_ARGS, "cat-file", "blob", `${before}:${file}`], { cwd: wt, env: RAW_ENV }).catch(() => null);
      const abs = path.join(wt, file);
      // Flightdeck 기록(impl-log·trace·handoff)은 되돌리지 않는다. Step 체크포인트는 그 Step 기록보다 먼저 만들어지므로
      // 되돌리면 그 Step의 기록이 사라진다 (M4 구현 중 발견)
      if (file.startsWith(".flightdeck/")) {
        if (prev === null) await rm(abs, { force: true });
        else {
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, prev);
        }
        continue;
      }
      const next = existsSync(abs) ? await readFile(abs, "utf8") : null;
      if (prev === next) continue;
      records.push(
        next === null
          ? { epic, file, base_hash: sha256(prev), range: [0, 0], insert: "", delete_file: true, source, ts }
          : { epic, file, base_hash: sha256(prev), range: [0, prev?.length ?? 0], insert: next, source, ts },
      );
    }
    await appendEditRecords(ctx.dataDir, epic, records);
    if (this.cfg.remote) await this.eng.pushCheckpoint(epic, this.cfg.member, this.gitRemote).catch(() => undefined);
    await this.sync(epic);
    return { before, files: records.map((r) => r.file) };
  }

  /** 구현 관문 명령 실행 (§7.5): 확장이 직접 실행한다(에이전트가 결과를 꾸밀 수 없게). 전체 로그는 세션 원본 ref에 둔다 */
  async runGateCommands(epic: string, commit: string, onOutput?: (s: string) => void): Promise<{ cmd: string; exit: number; summary: string; log_hash: string }[]> {
    const p = await this.pipelineFor((await this.epicState(epic)).config_version);
    const wt = await this.worktree(epic);
    const out: { cmd: string; exit: number; summary: string; log_hash: string }[] = [];
    for (const [i, cmd] of (p?.phases.implementation.gate.commands ?? []).entries()) {
      onOutput?.(`$ ${cmd}\n`);
      const { exit, log } = await runShell(cmd, wt, onOutput);
      const summary = log.trim().split("\n").filter((l) => l.trim()).at(-1)?.trim().slice(0, 200) ?? "";
      await new RunStore(this.cfg.repo).put(epic, `gate/${commit}/${i}.log.gz`, gzipSync(log), `gate ${commit.slice(0, 10)} ${cmd}`);
      out.push({ cmd, exit, summary, log_hash: sha256(log)! });
    }
    if (this.cfg.remote) await git(["push", "-q", "--no-verify", this.gitRemote, `${RunStore.ref(epic)}:${RunStore.ref(epic)}`], { cwd: this.cfg.repo }).catch((e) => this.warnings.push(`테스트 로그를 올리지 못했다: ${e instanceof Error ? e.message : e}`));
    return out;
  }

  /**
   * 구현 완료(제출) (§4.1, §7.3, §7.5, X5): 관문 검사 → 에픽 브랜치 커밋·공유 → 명령 실행·보고(gate.reported) → phase.completed.
   * 설명 없는 변경이나 impl-log 형식 문제가 있으면 커밋하지 않고 이유를 돌려준다
   */
  async submitImplementation(
    epic: string,
    opts: { onOutput?: (s: string) => void } = {},
  ): Promise<{ ok: true; commit: string; phase: Phase } | { ok: false; problems: string[]; coverage?: CoverageReport }> {
    const s0 = await this.epicState(epic);
    if (writerOf(s0) !== this.cfg.member) return { ok: false, problems: [`조종수(@${writerOf(s0)})만 제출할 수 있습니다`] };
    if (s0.phase !== "IMPLEMENTATION") return { ok: false, problems: [`지금은 ${s0.phase} 단계입니다`] };
    const open = [...s0.threads.values()].filter((t) => t.phase === s0.phase && t.status === "open");
    const r = await this.commitAndReport(epic, "구현 제출", "IMPLEMENTATION", opts, open.length ? [`열린 쓰레드 ${open.length}개`] : []);
    if (!r.ok) return r;
    await this.passEvent(epic, "phase.completed", { phase: "IMPLEMENTATION", commit: r.commit });
    // 검증 티어 리뷰를 바로 요청한다 (M5 Y1: 같은 커밋, 통과 보고가 있으므로)
    const s1 = await this.sync(epic);
    if (s1.phase === "VERIFICATION" && reviewOf(s1)) await this.passEvent(epic, "review.requested", await this.verificationData(epic, r.commit));
    const s = await this.sync(epic);
    if (this.cfg.remote) await this.trackerPhase(epic, s.phase);
    await this.mentionReviewTurn(epic, s);
    return { ok: true, commit: r.commit, phase: s.phase };
  }

  /**
   * 관문 검사 → 에픽 브랜치 커밋·공유 → 관문 명령 실행 → 테스트 보고 (§7.5). 구현 제출과 검증 중 다시 요청이 같이 쓴다.
   * 설명 없는 변경·impl-log 문제가 있으면 커밋하지 않는다
   */
  private async commitAndReport(
    epic: string,
    label: string,
    phase: Phase,
    opts: { onOutput?: (s: string) => void },
    extra: string[] = [],
  ): Promise<{ ok: true; commit: string } | { ok: false; problems: string[]; coverage?: CoverageReport }> {
    const st = await this.implementationStatus(epic);
    const problems: string[] = [];
    for (const h of st.coverage.unexplained) {
      problems.push(`설명 없는 변경 ${h.file}:${linesLabel([h.newLines])} — ${h.sources.filter((x) => !x.explained).map((x) => x.why).join(", ") || "출처 없음"}`);
    }
    if (st.coverage.ratio < st.threshold) problems.unshift(`coverage ${(st.coverage.ratio * 100).toFixed(0)}% < ${(st.threshold * 100).toFixed(0)}%`);
    problems.push(...st.implLog.map((p) => `impl-log: ${p}`), ...extra);
    if (problems.length) return { ok: false, problems, coverage: st.coverage };

    const wt = await this.worktree(epic);
    // 이 커밋이 편집 기록의 어디까지인가 (M7 E3): 반영 서버가 이 위치까지 재적용해 coverage를 다시 계산한다
    const seq = await lastSeq(await this.eng.dataDir(), epic);
    await this.eng.commitAll(wt, `${epic}: ${label} (Step ${st.step})`, { "Flightdeck-Epic": epic, "Flightdeck-Phase": phase, "Flightdeck-Seq": String(seq) });
    const commit = this.cfg.remote ? await this.eng.pushEpicBranch(epic, this.gitRemote) : await this.eng.revParse("HEAD", wt);
    const commands = await this.runGateCommands(epic, commit, opts.onOutput);
    await this.passEvent(epic, "gate.reported", { commit, commands });
    const failed = commands.filter((c) => c.exit !== 0);
    if (failed.length) return { ok: false, problems: failed.map((c) => `명령 실패 (종료 코드 ${c.exit}): ${c.cmd} — ${c.summary}`) };
    return { ok: true, commit };
  }

  // ---- 검증 (§4.2 VERIFICATION, §9.3, M5) ----

  /** 검증 중 다시 요청 (Y1): 수정 제안을 반영한 뒤. 관문 검사 → 커밋 → 테스트 보고 → 리뷰 요청 (재승인은 reapproval대로) */
  async requestVerification(epic: string, opts: { onOutput?: (s: string) => void } = {}): Promise<{ ok: true; state: EpicState } | { ok: false; problems: string[]; coverage?: CoverageReport }> {
    const s0 = await this.epicState(epic);
    if (writerOf(s0) !== this.cfg.member) return { ok: false, problems: [`조종수(@${writerOf(s0)})만 리뷰를 요청할 수 있습니다`] };
    if (s0.phase !== "VERIFICATION") return { ok: false, problems: [`지금은 ${s0.phase} 단계입니다`] };
    const r = await this.commitAndReport(epic, "검증 다시 요청", "VERIFICATION", opts);
    if (!r.ok) return r;
    await this.passEvent(epic, "review.requested", await this.verificationData(epic, r.commit));
    const s = await this.sync(epic);
    await this.mentionReviewTurn(epic, s);
    return { ok: true, state: s };
  }

  /** 검증 리뷰 요청의 data: 산출물 = 그 커밋의 tree (§4.2). 서버는 원격 에픽 브랜치 끝과 같은지 다시 본다 */
  private async verificationData(epic: string, commit: string) {
    const tree = (await git(["rev-parse", `${commit}^{tree}`], { cwd: await this.worktree(epic) })).trim();
    return { phase: "VERIFICATION", artifact_hash: `tree:${tree}`, commit };
  }

  /** 리뷰 사본에서 고친 내용 (리뷰 커밋 대비, .flightdeck/ 제외, 새 파일 포함) */
  async copyDiff(wt: string): Promise<string> {
    const tmp = path.join(await this.eng.dataDir(), `copy-index-${process.pid}`);
    const env = { GIT_INDEX_FILE: tmp };
    try {
      await git(["read-tree", "HEAD"], { cwd: wt, env });
      await git(["add", "-A", "--", ".", ":(exclude).flightdeck"], { cwd: wt, env });
      return await git(["diff", "--cached", "--binary", "HEAD", "--", ".", ":(exclude).flightdeck"], { cwd: wt, env });
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * 수정 제안 (§9.3, Y3): 리뷰 사본에서 고친 내용을 수정 요청 쓰레드에 붙인다. 위치는 file:range(리뷰 커밋 기준).
   * 붙인 뒤 사본을 리뷰 커밋으로 되돌린다. 쓰레드 ID를 돌려준다
   */
  async suggestFix(epic: string, t: { file: string; range: [number, number]; body: string; to?: string[] }): Promise<string> {
    if ((await this.role(epic)) !== "review") throw new Error("수정 제안은 검증 단계 리뷰 사본에서 만든다");
    const wt = await this.worktree(epic);
    const patch = await this.copyDiff(wt);
    if (!patch.trim()) throw new Error("리뷰 사본에서 고친 내용이 없습니다");
    const s = await this.epicState(epic);
    const thread = await this.createCodeThread(epic, { ...t, kind: "change_request", to: t.to ?? (writerOf(s) ? [writerOf(s)!] : []), patch });
    await git(["checkout", "-q", "-f", "HEAD", "--", "."], { cwd: wt });
    await git(["clean", "-fdq", "-e", ".flightdeck/.runtime"], { cwd: wt });
    return thread;
  }

  /** 코드 쓰레드 (§3.3, Y2): 앵커 = 리뷰 커밋(또는 담당자 작업 폴더의 HEAD) 기준 줄 범위와 앞뒤 3줄 */
  async createCodeThread(epic: string, t: { file: string; range: [number, number]; kind: "question" | "change_request" | "note"; to: string[]; body: string; patch?: string; session?: string }): Promise<string> {
    const s = await this.epicState(epic);
    const wt = await this.worktree(epic);
    const role = await this.role(epic);
    const rev = role === "owner" ? await this.eng.revParse("HEAD", wt) : (s.review.requested?.commit ?? (await this.eng.revParse("HEAD", wt)));
    const text = await git(["show", `${rev}:${t.file}`], { cwd: wt }).catch(() => "");
    const lines = text.split("\n");
    const [a, b] = t.range;
    const context = [...lines.slice(Math.max(0, a - 4), a - 1), ...lines.slice(b, b + 3)].slice(0, 6);
    const id = ulid();
    const thread = threadIdFrom(id);
    const anchor: Anchor = { type: "code", file: t.file, rev, range: [a, Math.max(a, b)], context };
    await this.emit(epic, "thread.created", { thread, phase: s.phase, file: t.file, anchor, kind: t.kind, to: t.to, body: t.body, commit: rev, ...(t.patch ? { patch: t.patch } : {}), ...(t.session ? { source: "session" as const, sid: t.session } : {}) }, this.cfg.member, id);
    await this.sync(epic);
    await this.mention(epic, t.to, `${t.kind === "change_request" ? (t.patch ? "수정 제안" : "수정 요청") : t.kind === "question" ? "질문" : "메모"} 1건 · ${t.file}`, thread);
    return thread;
  }

  /**
   * 코드 쓰레드의 지금 위치 (§3.5). 담당자 작업 폴더에서는 편집 기록으로 옮긴다(M7 E5): rev 커밋의 Flightdeck-Seq 뒤 편집을 따라가므로
   * 그 줄 자체가 고쳐져도 위치를 잃지 않는다. 편집 기록으로 따라갈 수 없으면(rev에 위치가 없거나 기록이 이어지지 않음) diff 줄 매핑(M5)
   */
  async codeThreadPositions(epic: string): Promise<{ thread: Thread; file: string; range: [number, number]; lost: boolean; via: "editlog" | "diff" }[]> {
    const s = await this.epicState(epic);
    const wt = await this.worktree(epic);
    const owner = (await this.role(epic)) === "owner";
    const log = owner ? await readEditLog(await this.eng.dataDir(), epic) : [];
    const out: { thread: Thread; file: string; range: [number, number]; lost: boolean; via: "editlog" | "diff" }[] = [];
    for (const t of s.threads.values()) {
      if (t.anchor.type !== "code") continue;
      const a = t.anchor;
      if (owner) {
        const seq = seqTrailer(await git(["log", "-1", "--format=%B", a.rev], { cwd: wt }).catch(() => ""));
        const revText = seq === null ? null : await gitBuffer(["cat-file", "blob", `${a.rev}:${a.file}`], { cwd: wt }).then((b) => b.toString("utf8"), () => null);
        const m = seq !== null && revText !== null ? moveLines(a.file, revText, seq, log, a.range) : null;
        // 작업 트리 내용과 맞는지도 본다 (기록되지 않은 변경이 있으면 diff로)
        if (m && (await readFile(path.join(wt, a.file), "utf8").catch(() => null)) === m.text) {
          out.push({ thread: t, file: a.file, range: m.range, lost: m.lost, via: "editlog" });
          continue;
        }
      }
      const diff = await git(["diff", "-U0", "--no-color", a.rev, "--", a.file], { cwd: wt }).catch(() => "");
      out.push({ thread: t, file: a.file, ...mapLines(diff, a.range), via: "diff" });
    }
    return out;
  }

  // ---- 편집 기록 서버 (서버 ③, M7) ----

  private uploaded = new Map<string, { last: number; memos: string }>();

  /**
   * 로컬 편집 기록·메모를 서버에 올린다 (E1·E8). 이 PC가 그 에픽의 작업 폴더(담당자 창)일 때만.
   * 서버의 마지막 seq 다음부터 보내고, 어긋나면(409) 서버가 알려 준 위치부터 다시 보낸다. 올린 마지막 seq
   */
  async syncEditlog(epic: string): Promise<number | null> {
    const r = this.cfg.remote;
    if (!r) return null;
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic)) || (await readState(dataDir, epic)).role !== "owner") return null;
    const log = await readEditLog(dataDir, epic);
    const memos = await readMemos(dataDir, epic);
    const memoKey = sha256(JSON.stringify(memos))!;
    let cur = this.uploaded.get(epic) ?? { last: (await r.server.editlog(r.product, epic, Number.MAX_SAFE_INTEGER)).last, memos: "" };
    for (let attempt = 0; attempt < 5; attempt++) {
      const records = log.filter((x) => x.seq > cur.last).slice(0, 2000);
      if (!records.length && cur.memos === memoKey) break;
      try {
        const res = await r.server.uploadEditlog(r.product, { epic, records, ...(cur.memos !== memoKey ? { memos } : {}) });
        cur = { last: res.last, memos: memoKey };
      } catch (e) {
        if (e instanceof ServerRequestError && e.status === 409 && typeof e.data?.last === "number") {
          cur = { last: e.data.last, memos: cur.memos };
          continue;
        }
        throw e;
      }
    }
    this.uploaded.set(epic, cur);
    return cur.last;
  }

  /**
   * 코드 파일 외부 변경 감지 (§7.4, M7 E7): 편집 기록 재적용 ≠ 디스크인 파일을 external:unknown으로 기록한다.
   * 에이전트 도구가 실행 중이면(훅이 곧 기록) null: 호출하는 쪽이 나중에 다시 부른다. 기록한 파일 목록
   */
  async recordExternal(epic: string): Promise<string[] | null> {
    const dataDir = await this.eng.dataDir();
    if (toolInProgress(dataDir, epic)) return null;
    const ctx = await this.implContext(epic);
    // 구현·검증(수정 제안 반영 뒤 다시 요청) 중에만 코드가 바뀐다
    if (ctx.state.role !== "owner" || !["IMPLEMENTATION", "VERIFICATION"].includes(ctx.state.phase)) return [];
    return recordDrift(ctx);
  }

  /**
   * 줄 단위 출처 (E6): 담당자 창은 로컬 편집 기록, 다른 창(리뷰·질문)은 서버에서 그 창의 커밋 기준으로.
   * text는 계산한 내용: 에디터 내용과 다르면(저장 안 한 편집, 리뷰 사본의 수정) 호출하는 쪽이 그 줄을 "확인 안 됨"으로 본다
   */
  async lineBlame(epic: string, file: string): Promise<{ lines: (BlameEntry | null)[]; text: string | null; via: "local" | "server" }> {
    const role = await this.role(epic);
    if (role === "owner") {
      const ctx = await this.implContext(epic);
      const base = await baseContent(this.cfg.repo, ctx.baseSha, file);
      const b = blame(file, base, await readEditLog(ctx.dataDir, epic), { memos: await readMemos(ctx.dataDir, epic) });
      return { lines: b.lines, text: b.text, via: "local" };
    }
    const r = this.cfg.remote;
    if (!r) return { lines: [], text: null, via: "server" };
    const rev = await this.eng.revParse("HEAD", await this.worktree(epic));
    const b = await r.server.blame(r.product, epic, file, rev);
    return { lines: b.lines, text: b.text, via: "server" };
  }

  /**
   * 수정 제안 반영 (§9.3, Y4): 담당자 작업 폴더에 패치를 적용하고, 바뀐 파일을 출처 patch로 편집 기록에 남긴 뒤 patch.applied.
   * 반영 뒤에는 requestVerification으로 다시 요청한다
   */
  async applyPatch(epic: string, threadId: string): Promise<string[]> {
    const s = await this.epicState(epic);
    if (writerOf(s) !== this.cfg.member || (await this.role(epic)) !== "owner") throw new Error("수정 제안은 조종수의 작업 폴더에서 반영한다");
    const t = s.threads.get(threadId);
    const patch = t?.replies.filter((r) => r.patch).at(-1)?.patch ?? t?.patch;
    if (!t || !patch) throw new Error("수정 제안이 없는 쓰레드");
    const wt = await this.worktree(epic);
    const files = (await git(["apply", "--numstat", "-"], { cwd: wt, input: patch })).trim().split("\n").map((l) => l.split("\t")[2]!).filter(Boolean);
    const ctx = await this.implContext(epic);
    await recordDrift(ctx); // 반영 전 편집 기록 = 디스크
    const before = new Map<string, string | null>();
    for (const f of files) before.set(f, existsSync(path.join(wt, f)) ? await readFile(path.join(wt, f), "utf8") : null);
    try {
      await git(["apply", "--whitespace=nowarn", "-"], { cwd: wt, input: patch });
    } catch (e) {
      throw new Error(`수정 제안이 지금 코드에 맞지 않아 반영하지 못했습니다. 제안자에게 다시 만들어 달라고 답글을 남기세요 (${e instanceof Error ? e.message.split("\n").at(-1) : e})`);
    }
    const ts = nowIso();
    const source = { kind: "patch" as const, member: this.cfg.member, thread: threadId };
    for (const f of files) {
      const after = existsSync(path.join(wt, f)) ? await readFile(path.join(wt, f), "utf8") : null;
      await appendEditRecords(ctx.dataDir, epic, diffRecords(epic, f, before.get(f) ?? null, after, source, ts));
    }
    await this.emit(epic, "patch.applied", { thread: threadId, commit: t.anchor.type === "code" ? t.anchor.rev : await this.eng.revParse("HEAD", wt) });
    await this.sync(epic);
    return files;
  }

  /** 구현 재개 (§4.3): VERIFICATION → IMPLEMENTATION. 수정 요청을 에이전트로 반영할 때 */
  async resumeImplementation(epic: string, reason: string): Promise<EpicState> {
    await this.emit(epic, "phase.reverted", { from: "VERIFICATION", to: "IMPLEMENTATION", reason });
    const s = await this.sync(epic);
    if (this.cfg.remote) await this.trackerPhase(epic, s.phase);
    return s;
  }

  /**
   * 반영 따라가기 (§11, Y6·Y9). 담당자 창의 동기화에서 부른다.
   * needs_report: 서버가 main을 병합한 커밋으로 작업 폴더를 fast-forward하고, 테스트를 다시 실행·보고한다(서버가 그 서명 뒤 반영을 다시 건다)
   */
  async followLanding(epic: string, s: EpicState, opts: { onOutput?: (s: string) => void } = {}): Promise<"reported" | "waiting" | null> {
    if (s.phase !== "LANDING" || !s.landing || writerOf(s) !== this.cfg.member) return null;
    if (s.landing.status !== "needs_report") return "waiting";
    const commit = s.landing.commit;
    if (s.gates.has(commit)) return "waiting";
    if (this.following.has(epic)) return "waiting";
    this.following.add(epic);
    try {
      const wt = await this.worktree(epic);
      await this.eng.fetchEpicBranch(epic, this.gitRemote);
      const ctx = await this.implContext(epic);
      await recordDrift(ctx);
      const before = await this.eng.revParse("HEAD", wt);
      await git(["merge", "-q", "--ff-only", commit], { cwd: wt });
      // 바뀐 파일은 main에서 온 것이다 (external:<commit>)
      const changed = (await git(["diff", "--name-only", "-z", before, commit], { cwd: wt })).split("\0").filter(Boolean);
      for (const f of changed) {
        const prev = await git([...RAW_ARGS, "cat-file", "blob", `${before}:${f}`], { cwd: wt, env: RAW_ENV }).catch(() => null);
        const next = existsSync(path.join(wt, f)) ? await readFile(path.join(wt, f), "utf8") : null;
        await appendEditRecords(ctx.dataDir, epic, diffRecords(epic, f, prev, next, { kind: "external", commit }, nowIso()));
      }
      const commands = await this.runGateCommands(epic, commit, opts.onOutput);
      await this.passEvent(epic, "gate.reported", { commit, commands });
      return "reported";
    } finally {
      this.following.delete(epic);
    }
  }

  private following = new Set<string>();

  /**
   * main 감사 (§11.4, Y8): 감사 시작점(가장 오래된 에픽의 base) 뒤 main first-parent 커밋 중
   * 서명된 반영(epic.landed)이 아닌 것
   */
  async auditMain(): Promise<AuditFinding[]> {
    const r = this.cfg.remote;
    if (!r) return [];
    await this.pull();
    const p = parsePipeline(r.config.pipeline_yaml);
    const target = p.landing.target;
    await git(["fetch", "-q", "--no-tags", this.gitRemote, `+refs/heads/${target}:refs/remotes/${this.gitRemote}/${target}`], { cwd: this.cfg.repo });
    const landed = new Map<string, string>();
    const mismatched = new Map<string, string>();
    const bases: string[] = [];
    for (const epic of await this.store.listEpics()) {
      const s = await this.epicState(epic);
      if (s.base_sha) bases.push(s.base_sha);
      if (s.landed) landed.set(epic, s.landed.main_commit);
      if (s.config_mismatch) mismatched.set(epic, s.config_mismatch.version);
    }
    if (!bases.length) return [];
    // 가장 오래된 base: 다른 base들의 조상
    let start = bases[0]!;
    for (const b of bases.slice(1)) {
      const isAnc = await git(["merge-base", "--is-ancestor", b, start], { cwd: this.cfg.repo }).then(() => true, () => false);
      if (isAnc) start = b;
    }
    const log = await git(["log", "--first-parent", "--format=%H%x00%s%x00%(trailers:only,unfold)%x01", `${start}..refs/remotes/${this.gitRemote}/${target}`], { cwd: this.cfg.repo }).catch(() => "");
    const commits: MainCommit[] = log
      .split("\x01")
      .map((x) => x.replace(/^\n/, ""))
      .filter(Boolean)
      .map((rec) => {
        const [sha, subject, tr] = rec.split("\0") as [string, string, string];
        const trailers: Record<string, string> = {};
        for (const m of (tr ?? "").matchAll(/^([A-Za-z-]+): (.+)$/gm)) trailers[m[1]!] = m[2]!;
        return { sha, subject, trailers };
      });
    return auditMain(commits, landed, p.landing.audit_allow, mismatched);
  }

  /** 자동 초안 (§6.1 headless): 백그라운드 claude -p. 끝나면 세션 ID로 이어서 작업(resume)한다 */
  async draft(epic: string, extra = ""): Promise<{ sessionId: string; result: string }> {
    const adapter = this.cfg.adapter;
    if (!adapter.headless) throw new Error(`${adapter.id}는 headless 실행을 지원하지 않습니다`);
    const s = await this.epicState(epic);
    const a = PHASE_ARTIFACT[s.phase as keyof typeof PHASE_ARTIFACT];
    if (!a && s.phase !== "IMPLEMENTATION") throw new Error(`${s.phase} 단계는 자동 실행 대상이 아닙니다`);
    const prompt = [
      a
        ? `Flightdeck ${s.phase} 단계의 초안을 작성하세요.\n세션 맥락에 있는 단계 룰과 산출물 형식(필수 섹션)을 따라 .flightdeck/epics/${epic}/${a.file}를 쓰고, 끝나기 전에 인수인계 기록(handoff.md)도 쓰세요.`
        : `Flightdeck IMPLEMENTATION 단계입니다. .flightdeck/epics/${epic}/design.md의 설계대로 구현하세요.\n세션 맥락의 단계 룰을 따라 Step 하나를 끝낼 때마다 flightdeck_log_step으로 기록하고, 끝나기 전에 flightdeck_submit으로 검사한 뒤 인수인계 기록(handoff.md)을 쓰세요.`,
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

/** 셸 명령 실행: 표준 출력·오류를 합친 로그와 종료 코드 */
function runShell(cmd: string, cwd: string, onOutput?: (s: string) => void): Promise<{ exit: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const on = (d: Buffer) => {
      log += d.toString("utf8");
      onOutput?.(d.toString("utf8"));
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", (e) => resolve({ exit: 127, log: log + String(e) }));
    child.on("close", (code) => resolve({ exit: code ?? 1, log }));
  });
}

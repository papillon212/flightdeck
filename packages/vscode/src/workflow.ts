// 에픽 워크플로 (설계 §9.1 진입 흐름, §4 단계, §3 쓰레드). VS Code API를 쓰지 않는 순수 Node 모듈이다.
// 확장(extension.ts)은 이 모듈을 화면에 연결만 한다. 테스트·스크립트에서도 그대로 쓴다.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTextEdit, checkSections, diffToEdits, ensureParagraphIds, nowIso, reduce, renderThreads, replay, restoreParagraphIds, sha256, stripThreads, threadIdFrom, ulid, type EpicState } from "@flightdeck/core";
import { GitEngine, LocalEventStore } from "@flightdeck/git";
import { DEV_TRUST, HANDOFF_SECTIONS, PHASE_ARTIFACT, type Anchor, type EditRecord, type EditSource, type Event, type EventOf, type EventType, type LocalEpicState, type Phase, type Trust } from "@flightdeck/schema";
import type { AgentAdapter } from "@flightdeck/agent";
import { appendEditRecords, readEditLog, readState, statePath, writeState } from "@flightdeck/hook";

export interface WorkflowConfig {
  /** 제품 레포 main worktree */
  repo: string;
  /** 이 PC의 사용자 */
  member: string;
  /** 설정 레포의 제품 폴더 (rules/, pipeline.yaml) */
  configDir: string;
  /** dist/flightdeck-hook.mjs, dist/flightdeck-mcp.mjs가 있는 폴더 */
  distDir: string;
  adapter: AgentAdapter;
  model?: string;
  maxTurns?: number;
  excludeSecrets?: string[];
  /** 서버 서명 검증 기준 (§12). 없으면 개발 모드 */
  trust?: Trust;
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
    this.store = new LocalEventStore(cfg.repo);
  }

  get trust(): Trust {
    return this.cfg.trust ?? DEV_TRUST;
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
    const e = { v: 1, id, type, epic, author, at: nowIso(), data } as EventOf<T>;
    // 메타 브랜치는 append-only라 한번 쓰면 지울 수 없다. reducer가 무시할 이벤트(권한·관문)는 쓰기 전에 막고 이유를 알린다
    const events = await this.store.list(epic);
    const ignored = reduce(epic, [...events, e as Event], this.trust).ignored.find((i) => i.event === e.id);
    if (ignored) throw new Error(`${type} 거부: ${ignored.reason}${ignored.reason.includes("권한") ? ` (나: ${author})` : ""}`);
    await this.store.append(e as Event);
    return e;
  }

  /**
   * 에픽 시작 (§9.1): 작업 폴더 → epic.md 커밋 → epic.started → 로컬 상태 → 에이전트 설정 설치.
   * M1은 일감 도구 대신 제목·본문을 직접 받는다.
   */
  async start(epic: string, title: string, body: string): Promise<{ worktree: string; state: EpicState }> {
    const { path: worktree, baseSha } = await this.eng.createEpicWorktree(epic);
    const dir = this.epicDir(worktree, epic);
    await mkdir(dir, { recursive: true });
    const epicMd = path.join(dir, "epic.md");
    if (!existsSync(epicMd)) {
      await writeFile(epicMd, `# ${epic} · ${title}\n\n${body.trim()}\n`);
      await this.eng.commit(worktree, [path.relative(worktree, epicMd)], `${epic}: 에픽 시작`, { "Flightdeck-Epic": epic });
    }
    if (!(await this.store.list(epic)).some((e) => e.type === "epic.started")) {
      await this.emit(epic, "epic.started", { tracker_ref: epic, owner: this.cfg.member, base_sha: baseSha, config_version: "local" });
    }
    const dataDir = await this.eng.dataDir();
    if (!existsSync(statePath(dataDir, epic))) {
      const s: LocalEpicState = {
        epic,
        repo: this.cfg.repo,
        worktree,
        member: this.cfg.member,
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
    return { worktree, state: await this.sync(epic) };
  }

  async worktree(epic: string): Promise<string> {
    return (await readState(await this.eng.dataDir(), epic)).worktree;
  }

  async epicState(epic: string): Promise<EpicState> {
    return reduce(epic, await this.store.list(epic), this.trust);
  }

  /** 이벤트로 상태를 다시 계산해 로컬 상태 파일(훅이 읽음)의 단계를 맞추고, 문서를 다시 그린다 */
  async sync(epic: string): Promise<EpicState> {
    const s = await this.epicState(epic);
    const dataDir = await this.eng.dataDir();
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

  async createThread(epic: string, t: { file: string; pid: string; kind: "question" | "change_request" | "note"; to: string[]; body: string }): Promise<string> {
    const s = await this.epicState(epic);
    const id = ulid();
    const thread = threadIdFrom(id);
    const anchor: Anchor = { type: "paragraph", pid: t.pid };
    await this.emit(epic, "thread.created", { thread, phase: s.phase, file: t.file, anchor, kind: t.kind, to: t.to, body: t.body }, this.cfg.member, id);
    await this.sync(epic);
    return thread;
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
    await this.emit(epic, "phase.completed", { phase });
    const s = await this.sync(epic);
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

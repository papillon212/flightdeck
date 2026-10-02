// 에픽 워크플로 (설계 §9.1 진입 흐름, §4 단계, §3 쓰레드). VS Code API를 쓰지 않는 순수 Node 모듈이다.
// 확장(extension.ts)은 이 모듈을 화면에 연결만 한다. 테스트·스크립트에서도 그대로 쓴다.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTextEdit, checkSections, diffToEdits, ensureParagraphIds, nowIso, reduce, renderThreads, sha256, stripThreads, threadIdFrom, ulid, type EpicState } from "@flightdeck/core";
import { GitEngine, LocalEventStore } from "@flightdeck/git";
import { HANDOFF_SECTIONS, PHASE_ARTIFACT, type Anchor, type Event, type EventOf, type EventType, type LocalEpicState, type Phase } from "@flightdeck/schema";
import type { AgentAdapter } from "@flightdeck/agent";
import { appendEditRecords, readState, statePath, writeState } from "@flightdeck/hook";

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
}

export const ARTIFACT_FILES = ["analysis.md", "design.md"] as const;

export class EpicWorkflow {
  readonly eng: GitEngine;
  readonly store: LocalEventStore;

  constructor(readonly cfg: WorkflowConfig) {
    this.eng = new GitEngine(cfg.repo, { excludeSecrets: cfg.excludeSecrets });
    this.store = new LocalEventStore(cfg.repo);
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
    const ignored = reduce(epic, [...events, e as Event]).ignored.find((i) => i.event === e.id);
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
    return reduce(epic, await this.store.list(epic));
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

  /**
   * 산출물에 문단 ID를 붙이고 쓰레드 블록을 다시 그린다 (§3.2). 바뀐 파일 목록을 돌려준다.
   * 이 변경도 편집 기록에 남긴다(출처 flightdeck, 설계 제안 T4). 그래야 편집 기록 재적용 = 디스크가 유지된다.
   */
  async renderDocs(epic: string, s?: EpicState): Promise<string[]> {
    const state = s ?? (await this.epicState(epic));
    const wt = await this.worktree(epic);
    const dataDir = await this.eng.dataDir();
    const changed: string[] = [];
    for (const name of ARTIFACT_FILES) {
      const file = path.join(this.epicDir(wt, epic), name);
      if (!existsSync(file)) continue;
      const cur = await readFile(file, "utf8");
      const withIds = ensureParagraphIds(stripThreads(cur)).text;
      const next = renderThreads(withIds, name, state.threads.values());
      if (next === cur) continue;
      await writeFile(file, next);
      changed.push(name);
      const rel = path.relative(wt, file).split(path.sep).join("/");
      const reason: "thread_render" | "paragraph_ids" = withIds === stripThreads(cur) ? "thread_render" : "paragraph_ids";
      let base = cur;
      const records = diffToEdits(cur, next).map((e) => {
        const r = { epic, file: rel, base_hash: sha256(base), range: e.range, insert: e.insert, ts: nowIso(), source: { kind: "flightdeck" as const, member: this.cfg.member, reason } };
        base = applyTextEdit(base, e);
        return r;
      });
      await appendEditRecords(dataDir, epic, records);
    }
    return changed;
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

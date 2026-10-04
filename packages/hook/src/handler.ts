// flightdeck-hook의 이벤트별 처리 (설계 §6.1 연동 지점 표).
// session.start  → 실행 등록(run.started) + 단계 룰·맥락 주입
// prompt.submit  → 세션 중 단계가 바뀌었으면 새 단계 룰 주입
// tool.before    → 단계별 권한(§6.2), 편집 전 스냅샷
// tool.after     → 편집 기록(§8.6)
// session.stop   → 바뀐 게 있으면 체크포인트(§8.1)
// session.end    → 체크포인트 + run.finished
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkParagraphIds, nowIso, pipelineFromDir, reduce, reviewOf, sha256, ulid } from "@flightdeck/core";
import type { EditRecord, EditSource, Event, LocalEpicState } from "@flightdeck/schema";
import type { AgentAdapter, HookEvent, HookResponse } from "@flightdeck/agent";
import { git, GitEngine, isSecret, LocalEventStore, pushDetached, RAW_ARGS, RAW_ENV, RunStore } from "@flightdeck/git";
import { phaseChangedContext, sessionContext, viewerContext } from "./context.ts";
import { saveTranscript } from "./impl.ts";
import { decide } from "./policy.ts";
import { appendEditRecords, hookLog, lastSeq, saveSnapshot, takeSnapshot, updateState } from "./store.ts";

export interface HandlerDeps {
  adapter: AgentAdapter;
  dataDir: string;
  state: LocalEpicState;
  now?: () => Date;
}

export async function handle(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  if (d.state.role !== "owner") return handleViewer(ev, d);
  switch (ev.kind) {
    case "session.start":
      return onSessionStart(ev, d);
    case "prompt.submit":
      return onPromptSubmit(ev, d);
    case "tool.before":
      return onToolBefore(ev, d);
    case "tool.after":
      return onToolAfter(ev, d);
    case "session.stop":
      await checkpoint(ev, d, "턴 종료");
      await storeTranscript(ev, d);
      pushRefs(d);
      return { kind: "allow" };
    case "session.end":
      await onSessionEnd(ev, d);
      return { kind: "allow" };
  }
}

/**
 * 읽기 전용 창 (§3.6, §6.2 v0.13): 개인 질문 세션이라 실행·편집 기록·체크포인트를 남기지 않는다.
 * 권한만 본다(산출물 문서의 쓰레드 초안만 쓰기, 셸은 읽기 전용). 초안 밖의 변경은 확장이 되돌린다.
 */
async function handleViewer(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  const s = d.state;
  if (ev.kind === "session.start") {
    const st = await loadEpicState(d);
    const rv = reviewOf(st);
    const review = rv?.current?.reviewers.includes(s.member)
      ? `지금은 @${s.member}의 리뷰 차례입니다(${rv.current.name} 티어). 사용자가 승인 여부를 판단할 수 있게 문서를 검사해 주세요. 승인은 사용자가 직접 합니다.`
      : undefined;
    const copy = s.role === "review" ? { copy: true, rev: st.review.requested?.commit } : {};
    return { kind: "context", text: await viewerContext({ epic: s.epic, phase: st.phase, member: s.member, worktree: s.worktree, state: st, ...(review ? { review } : {}), ...copy }) };
  }
  if (ev.kind !== "tool.before") return { kind: "allow" };
  const t = ev.tool!;
  const decision = decide({
    phase: s.phase,
    epic: s.epic,
    runId: null,
    worktree: realpathLoose(s.worktree),
    tool: { name: t.name, kind: t.kind, paths: t.paths.map(realpathLoose), command: t.command },
    protectedPaths: d.adapter.protectedPaths(),
    role: s.role === "review" ? "review" : "viewer",
  });
  return decision.allow ? { kind: "allow" } : { kind: "deny", reason: decision.reason };
}

const iso = (d: HandlerDeps) => nowIso(d.now?.() ?? new Date());

async function loadEpicState(d: HandlerDeps) {
  const p = pipelineFromDir(d.state.configDir);
  return reduce(d.state.epic, await new LocalEventStore(d.state.repo).list(d.state.epic), d.state.trust, { pipelines: () => p });
}

async function onSessionStart(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  const s = d.state;
  let run = s.runs[ev.sessionId];
  if (!run) {
    const runId = ulid();
    const event = {
      v: 1 as const,
      id: ulid(),
      type: "run.started" as const,
      epic: s.epic,
      author: s.member,
      at: iso(d),
      data: { run_id: runId, phase: s.phase, member: s.member, agent: d.adapter.id, ckpt_from: (await new GitEngine(s.repo).tryRevParse(GitEngine.checkpointRef(s.epic, s.member))) ?? undefined },
    } satisfies Event;
    await new LocalEventStore(s.repo).append(event);
    const updated = await updateState(d.dataDir, s.epic, (st) => {
      st.runs[ev.sessionId] = { run_id: runId, context_phase: st.phase, started_at: iso(d) };
    });
    run = updated.runs[ev.sessionId]!;
  } else {
    await updateState(d.dataDir, s.epic, (st) => {
      st.runs[ev.sessionId]!.context_phase = st.phase;
    });
  }
  const text = await sessionContext({ epic: s.epic, phase: s.phase, runId: run.run_id, worktree: s.worktree, configDir: s.configDir, state: await loadEpicState(d) });
  return { kind: "context", text };
}

async function onPromptSubmit(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  const run = d.state.runs[ev.sessionId];
  if (!run || run.context_phase === d.state.phase) return { kind: "allow" };
  const text = await phaseChangedContext({ epic: d.state.epic, from: run.context_phase, to: d.state.phase, runId: run.run_id, configDir: d.state.configDir });
  await updateState(d.dataDir, d.state.epic, (st) => {
    st.runs[ev.sessionId]!.context_phase = st.phase;
  });
  return { kind: "context", text };
}

/** 존재하지 않는 경로도 가장 가까운 상위 폴더를 realpath로 풀어 정규화한다 (§6.1 경로 정규화) */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.join(realpathSync(cur), ...rest);
}

async function onToolBefore(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  const t = ev.tool!;
  const s = d.state;
  const worktree = realpathLoose(s.worktree);
  const paths = t.paths.map(realpathLoose);
  const run = s.runs[ev.sessionId];
  const decision = decide({
    phase: s.phase,
    epic: s.epic,
    runId: run?.run_id ?? null,
    worktree,
    tool: { name: t.name, kind: t.kind, paths, command: t.command },
    protectedPaths: d.adapter.protectedPaths(),
    // VERIFICATION의 에이전트 셸은 구현 관문 명령만 (§6.2)
    testCommands: pipelineFromDir(s.configDir)?.phases.implementation.gate.commands ?? [],
  });
  if (!decision.allow) {
    await hookLog(d.dataDir, s.epic, { kind: "deny", tool: t.name, paths, command: t.command, reason: decision.reason });
    return { kind: "deny", reason: decision.reason };
  }
  // 편집 기록용 스냅샷 (§8.6 v0.10: 디스크 전후)
  if (t.kind === "write") {
    const files: Record<string, string | null> = {};
    for (const p of paths) {
      const r = rel(worktree, p);
      if (isSecret(r, s.excludeSecrets)) {
        // 비밀 파일은 내용을 남기지 않는다 (§8.1 v0.10). 바뀌었다는 사실만 훅 로그에
        await hookLog(d.dataDir, s.epic, { kind: "secret_write", tool: t.name, file: r });
        continue;
      }
      files[r] = existsSync(p) ? await readFile(p, "utf8") : null;
    }
    await saveSnapshot(d.dataDir, s.epic, t.useId, { files });
  } else if (t.kind === "shell") {
    await saveSnapshot(d.dataDir, s.epic, t.useId, { tree: await new GitEngine(s.repo, { excludeSecrets: s.excludeSecrets }).snapshotTree(worktree) });
  }
  return { kind: "allow" };
}

async function onToolAfter(ev: HookEvent, d: HandlerDeps): Promise<HookResponse> {
  const t = ev.tool!;
  const s = d.state;
  const snap = await takeSnapshot(d.dataDir, s.epic, t.useId);
  if (!snap) return { kind: "allow" };
  const worktree = realpathLoose(s.worktree);
  const run = s.runs[ev.sessionId];
  if (!run) return { kind: "allow" };

  // 산출물의 문단 ID를 지우거나 바꾸면 되돌린다 (§3.2, §6.2)
  const reverted: string[] = [];
  for (const [file, before] of Object.entries(snap.files ?? {})) {
    if (before === null || !isArtifact(file, s.epic)) continue;
    const abs = path.join(worktree, file);
    const after = existsSync(abs) ? await readFile(abs, "utf8") : null;
    const violations = after === null ? [{ kind: "deleted" }] : checkParagraphIds(before, after);
    if (!violations.length) continue;
    await writeFile(abs, before);
    delete snap.files![file];
    reverted.push(file);
    await hookLog(d.dataDir, s.epic, { kind: "pid_revert", tool: t.name, file, violations });
  }
  const records: Omit<EditRecord, "seq">[] = [];
  const push = (file: string, before: string | null, after: string | null, source: EditSource) => {
    if (before === after) return;
    if (after === null) {
      records.push({ epic: s.epic, file, base_hash: sha256(before), range: [0, 0], insert: "", delete_file: true, source, ts: iso(d) });
      return;
    }
    let cur = before;
    for (const e of d.adapter.extractEdits(ev, { path: file, content: before }, { path: file, content: after })) {
      records.push({ epic: s.epic, file, base_hash: sha256(cur), range: e.range, insert: e.insert, source, ts: iso(d) });
      cur = (cur ?? "").slice(0, e.range[0]) + e.insert + (cur ?? "").slice(e.range[1]);
    }
  };

  // 구현 단계의 편집은 지금 열린 Step(마지막 기록 + 1)에 속한다 (M4 제안 X2)
  const step = s.phase === "IMPLEMENTATION" ? { step: s.impl_step + 1 } : {};
  if (snap.files) {
    const source: EditSource = { kind: "agent", member: s.member, adapter: d.adapter.id, run: run.run_id, ...step, prompt_id: ev.promptId, tool_use_id: t.useId };
    for (const [file, before] of Object.entries(snap.files)) {
      const abs = path.join(worktree, file);
      push(file, before, existsSync(abs) ? await readFile(abs, "utf8") : null, source);
    }
  }
  if (snap.tree) {
    const eng = new GitEngine(s.repo, { excludeSecrets: s.excludeSecrets });
    const after = await eng.snapshotTree(worktree);
    if (after !== snap.tree) {
      const source: EditSource = { kind: "agent_shell", member: s.member, run: run.run_id, ...step, cmd: t.command ?? t.name };
      const changed = (await git(["diff-tree", "-r", "-z", "--no-renames", snap.tree, after], { cwd: worktree })).split("\0").filter(Boolean);
      for (let i = 0; i < changed.length; i += 2) {
        const [, , preBlob, postBlob, status] = changed[i]!.split(" ") as [string, string, string, string, string];
        const file = changed[i + 1]!;
        const blob = (sha: string) => git([...RAW_ARGS, "cat-file", "blob", sha], { cwd: worktree, env: RAW_ENV });
        push(file, status.startsWith("A") ? null : await blob(preBlob), status.startsWith("D") ? null : await blob(postBlob), source);
      }
    }
  }
  const added = await appendEditRecords(d.dataDir, s.epic, records);
  if (added.length) await hookLog(d.dataDir, s.epic, { kind: "edits", tool: t.name, seq: added.map((r) => r.seq) });
  if (s.phase === "IMPLEMENTATION") await trace(d, ev, added, worktree);
  if (reverted.length) {
    return {
      kind: "context",
      text: `[Flightdeck] ${reverted.join(", ")}의 이번 편집을 되돌렸습니다. 문단 ID 줄(<!-- p:xxxx -->)을 지우거나 바꾸면 안 됩니다. 파일을 다시 읽고, ID 줄은 그대로 둔 채 내용만 고치세요.`,
    };
  }
  return { kind: "allow" };
}

/** 문단 ID를 지켜야 하는 산출물 (§3.2: 분석/설계 문서) */
function isArtifact(file: string, epic: string): boolean {
  return file === `.flightdeck/epics/${epic}/analysis.md` || file === `.flightdeck/epics/${epic}/design.md`;
}

/** trace.jsonl (§7.2): 구현 단계의 파일 편집·셸 명령. 편집 기록의 요약이라 실패해도 실행을 막지 않는다 */
async function trace(d: HandlerDeps, ev: HookEvent, added: EditRecord[], worktree: string): Promise<void> {
  const s = d.state;
  const t = ev.tool!;
  const base = { ts: iso(d), tool: t.name, step: s.impl_step + 1 };
  const lines: Record<string, unknown>[] = [];
  if (t.kind === "shell") lines.push({ ...base, cmd: t.command ?? "", ...(t.failed ? { failed: true } : {}) });
  const byFile = new Map<string, [number, number]>();
  for (const r of added) {
    const abs = path.join(worktree, r.file);
    const text = existsSync(abs) ? await readFile(abs, "utf8") : "";
    const a = text.slice(0, r.range[0]).split("\n").length;
    const b = text.slice(0, r.range[0] + r.insert.length).split("\n").length;
    const cur = byFile.get(r.file);
    byFile.set(r.file, cur ? [Math.min(cur[0], a), Math.max(cur[1], b)] : [a, b]);
  }
  for (const [file, range] of byFile) lines.push({ ...base, file, range });
  if (!lines.length) return;
  const f = path.join(worktree, ".flightdeck", "epics", s.epic, "trace.jsonl");
  await mkdir(path.dirname(f), { recursive: true });
  await appendFile(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function checkpoint(ev: HookEvent, d: HandlerDeps, why: string): Promise<string | null> {
  const s = d.state;
  const run = s.runs[ev.sessionId];
  if (!run) return null;
  const eng = new GitEngine(s.repo, { excludeSecrets: s.excludeSecrets });
  return eng.checkpointIfChanged(realpathLoose(s.worktree), {
    epic: s.epic,
    member: s.member,
    message: `에이전트 체크포인트 (${why})`,
    trailers: {
      "Flightdeck-Run": run.run_id,
      ...(s.phase === "IMPLEMENTATION" ? { "Flightdeck-Step": String(s.impl_step + 1) } : {}),
      "Flightdeck-Source": "agent",
      "Flightdeck-Seq": String(await lastSeq(d.dataDir, s.epic)),
    },
  });
}

/** 세션 원본 저장 (§6.4, X7): 턴이 끝날 때마다 그 세션 파일을 새로 쓴다. 기록 경로라 실패해도 막지 않는다 */
async function storeTranscript(ev: HookEvent, d: HandlerDeps): Promise<void> {
  const run = d.state.runs[ev.sessionId];
  const filter = d.adapter.filterTranscriptItem?.bind(d.adapter);
  if (!run || !ev.transcriptPath || !filter) return;
  try {
    const n = await saveTranscript(d.state, run.run_id, ev.sessionId, ev.transcriptPath, filter);
    await hookLog(d.dataDir, d.state.epic, { kind: "transcript", run: run.run_id, items: n });
  } catch (e) {
    await hookLog(d.dataDir, d.state.epic, { kind: "error", event: "transcript", message: e instanceof Error ? e.message : String(e) });
  }
}

/** 서버 모드: 체크포인트·세션 원본 ref를 백그라운드로 올린다 (§8.1, X7) */
function pushRefs(d: HandlerDeps): void {
  const s = d.state;
  if (!s.product) return;
  pushDetached(s.repo, s.gitRemote ?? "origin", [GitEngine.checkpointRef(s.epic, s.member), RunStore.ref(s.epic)]);
}

async function onSessionEnd(ev: HookEvent, d: HandlerDeps): Promise<void> {
  const s = d.state;
  const run = s.runs[ev.sessionId];
  if (!run) return;
  await checkpoint(ev, d, "세션 종료");
  await storeTranscript(ev, d);
  pushRefs(d);
  const eng = new GitEngine(s.repo);
  const ckpt = (await eng.tryRevParse(GitEngine.checkpointRef(s.epic, s.member))) ?? undefined;
  await new LocalEventStore(s.repo).append({
    v: 1,
    id: ulid(),
    type: "run.finished",
    epic: s.epic,
    author: s.member,
    at: iso(d),
    data: { run_id: run.run_id, phase: s.phase, member: s.member, ckpt_to: ckpt },
  });
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join("/");

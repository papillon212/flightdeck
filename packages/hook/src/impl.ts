// 구현 단계 공통 처리 (설계 §7, §8.1, §6.4, M4 계획). 훅·MCP 서버·확장이 같이 쓴다.
// - coverage 대상 파일 모으기와 coverage 계산 (§7.3)
// - flightdeck_log_step: 체크포인트 → impl-log Step 작성 (X1)
// - 세션 원본 저장(허용 목록 필터 + 비밀값 가림 + gzip)과 검색 (§6.4)
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  checkImplLog,
  coverage,
  diffRecords,
  dotenvValues,
  nowIso,
  parseImplLog,
  provenance,
  redactSecrets,
  renderImplLog,
  searchTranscripts,
  secretEnvValues,
  stepChanges,
  transcriptText,
  type CoverageReport,
  type ImplMemo,
  type ImplStep,
  type TranscriptDoc,
} from "@flightdeck/core";
import { git, gitBuffer, GitEngine, isSecret, RAW_ARGS, RAW_ENV, RunStore } from "@flightdeck/git";
import type { EditMemo, EditRecord, LocalEpicState } from "@flightdeck/schema";
import { appendEditRecords, readEditLog, readMemos, updateState } from "./store.ts";

export const implLogRel = (epic: string) => `.flightdeck/epics/${epic}/impl-log.md`;
export const designRel = (epic: string) => `.flightdeck/epics/${epic}/design.md`;

export interface ImplContext {
  state: LocalEpicState;
  dataDir: string;
  /** 에픽의 base (epic.started.base_sha) */
  baseSha: string;
  /** pipeline implementation.gate.coverage_ignore */
  coverageIgnore: string[];
}

/** coverage 대상 파일인가: Flightdeck 기록(.flightdeck/)·coverage_ignore·비밀 파일은 뺀다 (X3) */
export function coverageTarget(file: string, ctx: ImplContext): boolean {
  if (file.startsWith(".flightdeck/")) return false;
  if (isSecret(file, ctx.state.excludeSecrets)) return false;
  return !ctx.coverageIgnore.some((g) => path.matchesGlob(file, g) || path.matchesGlob(path.posix.basename(file), g));
}

async function readOrNull(f: string): Promise<string | null> {
  return existsSync(f) ? readFile(f, "utf8") : null;
}

/** base 커밋의 파일 내용 (디스크 바이트와 같은 기준: 변환 없이). 없으면 null */
export async function baseContent(repo: string, baseSha: string, file: string): Promise<string | null> {
  try {
    return (await gitBuffer([...RAW_ARGS, "cat-file", "blob", `${baseSha}:${file}`], { cwd: repo, env: RAW_ENV })).toString("utf8");
  } catch {
    return null;
  }
}

/** coverage 대상 파일: base → 작업 트리에서 바뀐 파일 ∪ 편집 기록에 있는 파일 */
export async function implFiles(ctx: ImplContext, log?: EditRecord[]): Promise<{ file: string; base: string | null; records: EditRecord[]; current: string | null }[]> {
  const s = ctx.state;
  const records = log ?? (await readEditLog(ctx.dataDir, s.epic));
  const eng = new GitEngine(s.repo, { excludeSecrets: s.excludeSecrets });
  const tree = await eng.snapshotTree(s.worktree);
  const changed = (await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", ctx.baseSha, tree], { cwd: s.worktree })).split("\0").filter(Boolean);
  const files = [...new Set([...changed, ...records.map((r) => r.file)])].filter((f) => coverageTarget(f, ctx)).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      base: await baseContent(s.repo, ctx.baseSha, file),
      records: records.filter((r) => r.file === file),
      current: await readOrNull(path.join(s.worktree, file)),
    })),
  );
}

/** impl-log에 기록된(글이 채워진) Step 번호 */
export async function loggedSteps(state: LocalEpicState): Promise<Set<number>> {
  const md = await readOrNull(path.join(state.worktree, implLogRel(state.epic)));
  if (md === null) return new Set();
  return new Set(parseImplLog(md).steps.filter((s) => s.intent && s.decision).map((s) => s.n));
}

export async function computeCoverage(ctx: ImplContext): Promise<CoverageReport> {
  const files = await implFiles(ctx);
  return coverage(files, { loggedSteps: await loggedSteps(ctx.state), memos: await readMemos(ctx.dataDir, ctx.state.epic) });
}

/** impl-log 형식 검사 (impl_log_schema) */
export async function checkImplLogFile(state: LocalEpicState): Promise<string[]> {
  return checkImplLog(await readOrNull(path.join(state.worktree, implLogRel(state.epic))), await readOrNull(path.join(state.worktree, designRel(state.epic))));
}

/** 편집 기록 재적용 ≠ 디스크인 파일의 차이를 external:unknown으로 기록한다 (§7.4, X3). 기록한 파일 목록 */
export async function recordDrift(ctx: ImplContext): Promise<string[]> {
  const files = await implFiles(ctx);
  const out: string[] = [];
  for (const f of files) {
    const expected = provenance(f.base, f.records).text;
    if (expected === f.current) continue;
    await appendEditRecords(ctx.dataDir, ctx.state.epic, diffRecords(ctx.state.epic, f.file, expected, f.current, { kind: "external" }, nowIso()));
    out.push(f.file);
  }
  return out;
}

export interface LogStepInput {
  title: string;
  design_ref: string;
  intent: string;
  decision: string;
  alternatives: string;
  review_points: string;
  verification: string;
  /** 이미 기록한 Step을 다시 쓸 때 */
  step?: number;
}

/**
 * Step 기록 (§7.1, X1): 그 Step까지의 코드를 체크포인트로 남기고, 편집 기록으로 changes를 계산해 impl-log에 Step을 쓴다.
 * impl-log 변경은 편집 기록에 flightdeck/impl_log로 남긴다
 */
export async function logStep(ctx: ImplContext, input: LogStepInput, runId?: string): Promise<{ step: ImplStep; ckpt: string }> {
  const s = ctx.state;
  if (s.phase !== "IMPLEMENTATION") throw new Error(`구현 기록은 IMPLEMENTATION 단계에서 씁니다 (지금 ${s.phase})`);
  if (s.role !== "owner") throw new Error("읽기 전용 창에서는 구현 기록을 쓸 수 없습니다");
  const n = input.step ?? s.impl_step + 1;
  if (n < 1 || n > s.impl_step + 1) throw new Error(`Step 번호는 1~${s.impl_step + 1}입니다`);
  for (const k of ["title", "design_ref", "intent", "decision", "alternatives", "review_points", "verification"] as const) {
    if (!String(input[k] ?? "").trim()) throw new Error(`${k}가 비었습니다`);
  }
  const eng = new GitEngine(s.repo, { excludeSecrets: s.excludeSecrets });
  const log = await readEditLog(ctx.dataDir, s.epic);
  const trailers = { ...(runId ? { "Flightdeck-Run": runId } : {}), "Flightdeck-Step": String(n), "Flightdeck-Source": "agent", "Flightdeck-Seq": String(log.at(-1)?.seq ?? 0) };
  const ckpt =
    (await eng.checkpointIfChanged(s.worktree, { epic: s.epic, member: s.member, message: `Step ${n}: ${input.title}`, trailers })) ??
    (await eng.tryRevParse(GitEngine.checkpointRef(s.epic, s.member))) ??
    (await eng.revParse("HEAD", s.worktree));
  const files = await implFiles(ctx, log);
  const step: ImplStep = {
    n,
    // 에이전트가 제목에 "Step 1:"을 붙이면 "## Step 1: Step 1: …"이 된다 (M4 실측)
    title: input.title.trim().replace(/^step\s*\d+\s*[:.)-]\s*/i, "") || input.title.trim(),
    design_ref: input.design_ref.trim(),
    ckpt,
    changes: stepChanges(files, n),
    verification: input.verification.trim(),
    intent: input.intent.trim(),
    decision: input.decision.trim(),
    alternatives: input.alternatives.trim(),
    review_points: input.review_points.trim(),
  };
  const file = path.join(s.worktree, implLogRel(s.epic));
  const before = await readOrNull(file);
  const parsed = before === null ? { steps: [], memos: [] as ImplMemo[] } : parseImplLog(before);
  const steps = [...parsed.steps.filter((x) => x.n !== n), step];
  await writeImplLog(ctx, steps, parsed.memos, before);
  await updateState(ctx.dataDir, s.epic, (st) => {
    st.impl_step = Math.max(st.impl_step, n);
  });
  return { step, ckpt };
}

/** impl-log를 다시 쓰고 그 변경을 편집 기록에 남긴다 */
export async function writeImplLog(ctx: ImplContext, steps: ImplStep[], memos: ImplMemo[], before?: string | null): Promise<void> {
  const s = ctx.state;
  const file = path.join(s.worktree, implLogRel(s.epic));
  const prev = before === undefined ? await readOrNull(file) : before;
  const next = renderImplLog(s.epic, steps, memos);
  if (next === prev) return;
  await writeFile(file, next);
  await appendEditRecords(ctx.dataDir, s.epic, diffRecords(s.epic, implLogRel(s.epic), prev, next, { kind: "flightdeck", member: s.member, reason: "impl_log" }, nowIso()));
}

/** 메모를 impl-log의 "직접 수정 메모"에 그린다 (X4) */
export async function renderMemos(ctx: ImplContext, memos: EditMemo[], lines: (m: EditMemo) => string, who: (m: EditMemo) => string): Promise<void> {
  const file = path.join(ctx.state.worktree, implLogRel(ctx.state.epic));
  const before = await readOrNull(file);
  const steps = before === null ? [] : parseImplLog(before).steps;
  await writeImplLog(ctx, steps, memos.map((m) => ({ file: m.file, lines: lines(m), who: who(m), memo: m.memo })), before);
}

// ---- 세션 원본 (§6.4) ----

/** 가릴 값: 비밀 이름의 환경변수 + 작업 폴더 .env* 파일 값 (X6) */
export async function secretValues(worktree: string, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const out = secretEnvValues(env);
  for (const f of existsSync(worktree) ? readdirSync(worktree) : []) {
    if (/^\.env(\..+)?$/.test(f)) out.push(...dotenvValues(await readFile(path.join(worktree, f), "utf8").catch(() => "")));
  }
  return out;
}

/**
 * 세션 transcript를 허용 목록 필터 → 비밀값 가림 → gzip으로 runs ref에 저장한다.
 * filter: 어댑터의 filterTranscriptItem. 저장한 항목 수를 돌려준다
 */
export async function saveTranscript(state: LocalEpicState, runId: string, sessionId: string, transcriptPath: string, filter: (item: unknown) => unknown | null): Promise<number> {
  if (!existsSync(transcriptPath)) return 0;
  const values = await secretValues(state.worktree);
  const kept: string[] = [];
  for (const line of (await readFile(transcriptPath, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      continue; // 쓰는 중인 마지막 줄
    }
    const f = filter(item);
    if (f) kept.push(redactSecrets(JSON.stringify(f), values));
  }
  await new RunStore(state.repo).put(state.epic, `${runId}/${sessionId}.jsonl.gz`, gzipSync(kept.join("\n") + "\n"), `run ${runId} session ${sessionId}`);
  return kept.length;
}

/** 저장된 세션 원본을 검색 문서로 (run 지정 시 그 실행만) */
export async function transcriptDocs(repo: string, epic: string, runId?: string): Promise<TranscriptDoc[]> {
  const store = new RunStore(repo);
  const docs: TranscriptDoc[] = [];
  for (const f of await store.files(epic)) {
    const m = /^([^/]+)\/([^/]+)\.jsonl\.gz$/.exec(f);
    if (!m || (runId && m[1] !== runId)) continue;
    const lines = gunzipSync(await store.get(epic, f)).toString("utf8").split("\n").filter(Boolean);
    let i = 0;
    for (const l of lines) {
      const t = transcriptText(JSON.parse(l));
      if (t) docs.push({ run: m[1]!, session: m[2]!, i: i++, ...t });
    }
  }
  return docs;
}

export async function searchRuns(repo: string, epic: string, query: string, opts: { runId?: string; maxTokens?: number } = {}): Promise<string> {
  const docs = await transcriptDocs(repo, epic, opts.runId);
  if (!docs.length) return "저장된 세션 원본이 없습니다.";
  const hits = searchTranscripts(docs, query, opts.maxTokens ?? 2000);
  if (!hits.length) return `"${query}"와 관련된 구간을 찾지 못했습니다 (세션 ${new Set(docs.map((d) => d.session)).size}개, 항목 ${docs.length}개 검색).`;
  return hits.map((h) => `### 실행 ${h.doc.run} · 세션 ${h.doc.session.slice(0, 8)} · #${h.doc.i}\n${h.excerpt}`).join("\n\n");
}

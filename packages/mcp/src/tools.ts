// Flightdeck MCP 도구 (설계 §6.1 MCP 도구 표). M1: get_epic, list_threads, get_handoffs. M4: search_run, log_step, submit.
// 도구 설명에는 에이전트가 검색할 단어를 넣는다(§6.1 v0.10: Claude Code는 MCP 도구를 지연 로딩해 검색으로 찾는다).
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pipelineFromDir, reduce } from "@flightdeck/core";
import { GitEngine, LocalEventStore, pushDetached, RunStore } from "@flightdeck/git";
import { checkImplLogFile, computeCoverage, logStep, searchRuns, type ImplContext, type LogStepInput } from "@flightdeck/hook";
import { LocalEpicState } from "@flightdeck/schema";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  statePath: string;
}

async function load(ctx: ToolContext) {
  const state = LocalEpicState.parse(JSON.parse(await readFile(ctx.statePath, "utf8")));
  const p = pipelineFromDir(state.configDir);
  const epicState = reduce(state.epic, await new LocalEventStore(state.repo).list(state.epic), state.trust, { pipelines: () => p });
  return { state, epicState, epicDir: path.join(state.worktree, ".flightdeck", "epics", state.epic) };
}

export const TOOLS: ToolDef[] = [
  {
    name: "flightdeck_get_epic",
    description: "Flightdeck 에픽(일감) 원문과 현재 단계를 돌려준다. epic task ticket requirement phase 일감 요구사항 단계",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      const { state, epicState, epicDir } = await load(ctx);
      const md = path.join(epicDir, "epic.md");
      return JSON.stringify(
        {
          epic: state.epic,
          phase: epicState.phase,
          owner: epicState.owner,
          epic_md: existsSync(md) ? await readFile(md, "utf8") : null,
        },
        null,
        2,
      );
    },
  },
  {
    name: "flightdeck_list_threads",
    description: "Flightdeck 쓰레드(질문·수정 요청·메모)와 답글 목록. thread question answer comment review 쓰레드 질문 답변 결정",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "resolved", "all"], description: "기본 all" },
        phase: { type: "string", description: "단계로 거르기 (예: ANALYSIS)" },
      },
      additionalProperties: false,
    },
    async run(a, ctx) {
      const { epicState } = await load(ctx);
      const status = (a.status as string) ?? "all";
      const threads = [...epicState.threads.values()].filter((t) => (status === "all" || t.status === status) && (!a.phase || t.phase === a.phase));
      return JSON.stringify(
        threads.map((t) => ({ id: t.id, phase: t.phase, file: t.file, anchor: t.anchor, kind: t.kind, status: t.status, from: t.author, to: t.to, body: t.body, replies: t.replies.map((r) => ({ from: r.author, source: r.source, body: r.body, at: r.at })) })),
        null,
        2,
      );
    },
  },
  {
    name: "flightdeck_get_handoffs",
    description: "Flightdeck 이전 실행들의 인수인계 기록(handoff.md). handoff previous run summary decision 인수인계 이전 실행 결정 이유",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string", description: "특정 실행만 (생략하면 전부)" } },
      additionalProperties: false,
    },
    async run(a, ctx) {
      const { epicDir } = await load(ctx);
      const runs = path.join(epicDir, "runs");
      if (!existsSync(runs)) return "인수인계 기록이 없습니다.";
      const ids = readdirSync(runs).filter((r) => (!a.run_id || r === a.run_id) && existsSync(path.join(runs, r, "handoff.md"))).sort();
      if (!ids.length) return "인수인계 기록이 없습니다.";
      const parts = await Promise.all(ids.map(async (r) => `<!-- runs/${r}/handoff.md -->\n${await readFile(path.join(runs, r, "handoff.md"), "utf8")}`));
      return parts.join("\n\n---\n\n");
    },
  },
  {
    name: "flightdeck_search_run",
    description:
      "Flightdeck 세션 원본 검색: 이전 실행들의 대화(지시·에이전트 답·도구 호출)에서 관련 구간만 돌려준다. search transcript session history why reason 세션 원본 대화 검색 왜 이유 근거",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "찾을 내용 (예: 왜 Redis를 안 썼나)" },
        run_id: { type: "string", description: "특정 실행만 (생략하면 전부)" },
        max_tokens: { type: "number", description: "돌려줄 분량 (기본 2000)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(a, ctx) {
      const { state } = await load(ctx);
      // 리뷰어·질문 대상은 원격의 세션 원본을 받는다. 담당자는 자기 것이 로컬에 있다(받으면 아직 안 올린 것을 덮는다)
      if (state.role === "viewer" && state.product) await new RunStore(state.repo).fetch(state.epic, state.gitRemote ?? "origin").catch(() => false);
      return searchRuns(state.repo, state.epic, String(a.query ?? ""), { runId: a.run_id as string | undefined, maxTokens: typeof a.max_tokens === "number" ? a.max_tokens : undefined });
    },
  },
  {
    name: "flightdeck_log_step",
    description:
      "Flightdeck 구현 기록(impl-log) Step 추가. Step 하나를 끝낼 때마다 부른다. 체크포인트와 바뀐 줄 범위는 자동. implementation log step record checkpoint 구현 기록 단계 기록",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Step 제목" },
        design_ref: { type: "string", description: "구현한 설계 문단: design.md#p:xxxx (여러 개면 쉼표)" },
        intent: { type: "string", description: "의도" },
        decision: { type: "string", description: "결정과 이유" },
        alternatives: { type: "string", description: "검토한 대안과 버린 이유 (없으면 '없음')" },
        review_points: { type: "string", description: "리뷰어가 봐야 할 곳 (없으면 '없음')" },
        verification: { type: "string", description: "확인한 명령과 결과 (예: node --test  # 3 passed)" },
        step: { type: "number", description: "이미 기록한 Step을 고쳐 쓸 때만 그 번호" },
      },
      required: ["title", "design_ref", "intent", "decision", "alternatives", "review_points", "verification"],
      additionalProperties: false,
    },
    async run(a, ctx) {
      const { state, implCtx } = await loadImpl(ctx);
      const runId = Object.values(state.runs).sort((x, y) => (x.started_at < y.started_at ? 1 : -1))[0]?.run_id;
      const r = await logStep(implCtx, a as unknown as LogStepInput, runId);
      if (state.product) pushDetached(state.repo, state.gitRemote ?? "origin", [GitEngine.checkpointRef(state.epic, state.member)]);
      return [`Step ${r.step.n} 기록함: ${r.step.title}`, `ckpt: ${r.ckpt.slice(0, 10)}`, `changes: ${r.step.changes.join(", ") || "(이 Step의 코드 편집 없음)"}`].join("\n");
    },
  },
  {
    name: "flightdeck_submit",
    description: "Flightdeck 구현 관문 검사(제출 전): impl-log 형식과 설명 없는 변경(coverage). submit gate check coverage 제출 검사 관문",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      const { state, implCtx } = await loadImpl(ctx);
      if (state.phase !== "IMPLEMENTATION") return `구현 관문은 IMPLEMENTATION 단계에서 검사합니다 (지금 ${state.phase}).`;
      const problems = await checkImplLogFile(state);
      const cov = await computeCoverage(implCtx);
      const out: string[] = [];
      if (cov.drift.length) out.push(`편집 기록에 없는 변경이 있는 파일(Flightdeck 밖에서 바뀜): ${cov.drift.join(", ")}`);
      for (const h of cov.unexplained) out.push(`설명 없는 변경 ${h.file}:${h.newLines[0]}-${Math.max(h.newLines[0], h.newLines[1])} — ${h.sources.filter((s) => !s.explained).map((s) => s.why).join(", ") || "출처 없음"}`);
      out.push(...problems.map((p) => `impl-log: ${p}`));
      const head = `coverage ${(cov.ratio * 100).toFixed(0)}% (hunk ${cov.hunks.length}개 중 설명 없음 ${cov.unexplained.length}개)`;
      return out.length ? `통과하지 못함. ${head}\n${out.map((l) => "- " + l).join("\n")}\n에이전트 편집은 flightdeck_log_step으로 Step을 기록하면 설명됩니다. 사람·외부 변경의 메모는 사용자가 확장에서 씁니다.` : `통과. ${head}. 사용자가 확장에서 "구현 완료"를 누르면 테스트 명령을 실행해 보고합니다.`;
    },
  },
];

async function loadImpl(ctx: ToolContext) {
  const { state, epicState } = await load(ctx);
  if (!epicState.base_sha) throw new Error("시작되지 않은 에픽");
  const p = pipelineFromDir(state.configDir);
  const implCtx: ImplContext = {
    state,
    dataDir: path.dirname(path.dirname(ctx.statePath)),
    baseSha: epicState.base_sha,
    coverageIgnore: p?.phases.implementation.gate.coverage_ignore ?? [],
  };
  return { state, epicState, implCtx };
}

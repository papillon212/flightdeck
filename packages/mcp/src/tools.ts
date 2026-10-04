// Flightdeck MCP 도구 (설계 §6.1 MCP 도구 표). M1 범위: get_epic, list_threads, get_handoffs.
// 도구 설명에는 에이전트가 검색할 단어를 넣는다(§6.1 v0.10: Claude Code는 MCP 도구를 지연 로딩해 검색으로 찾는다).
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { reduce } from "@flightdeck/core";
import { LocalEventStore } from "@flightdeck/git";
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
  const epicState = reduce(state.epic, await new LocalEventStore(state.repo).list(state.epic), state.trust);
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
];

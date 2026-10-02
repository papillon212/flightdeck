// 에이전트에 넣는 맥락 (설계 §6.1 SessionStart·UserPromptSubmit 추가 컨텍스트).
// 단계 룰 + 산출물 형식 + 일감 + 열린 쓰레드 + 이전 인수인계 목록. 세션 원본은 넣지 않는다(§6.4 토큰 절감).
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Phase } from "@flightdeck/schema";
import { HANDOFF_SECTIONS, PHASE_ARTIFACT } from "@flightdeck/schema";
import type { EpicState } from "@flightdeck/core";

const MAX_EPIC_CHARS = 4000;

export async function phaseRules(configDir: string, phase: Phase): Promise<string> {
  const parts: string[] = [];
  for (const name of ["common", phase.toLowerCase()]) {
    const f = path.join(configDir, "rules", `${name}.md`);
    if (existsSync(f)) parts.push((await readFile(f, "utf8")).trim());
  }
  return parts.join("\n\n");
}

export interface ContextInput {
  epic: string;
  phase: Phase;
  runId: string;
  worktree: string;
  configDir: string;
  state: EpicState;
}

export async function sessionContext(c: ContextInput): Promise<string> {
  const epicDir = `.flightdeck/epics/${c.epic}`;
  const out: string[] = [`[Flightdeck] 에픽 ${c.epic} · 단계 ${c.phase} · 실행 ${c.runId}. 이 실행은 기록되고 팀이 리뷰합니다.`];

  const rules = await phaseRules(c.configDir, c.phase);
  if (rules) out.push("## 단계 룰", rules);

  out.push("## 산출물", ...artifactLines(c.phase, epicDir, c.runId));

  const epicMd = path.join(c.worktree, epicDir, "epic.md");
  if (existsSync(epicMd)) {
    const text = (await readFile(epicMd, "utf8")).trim();
    out.push("## 일감 (epic.md)", text.length > MAX_EPIC_CHARS ? text.slice(0, MAX_EPIC_CHARS) + "\n…(이하 생략, flightdeck_get_epic으로 전체 확인)" : text);
  }

  const open = [...c.state.threads.values()].filter((t) => t.status === "open");
  if (open.length) {
    out.push("## 열린 쓰레드");
    for (const t of open) {
      const last = t.replies.at(-1);
      out.push(`- ${t.id} (${t.kind}, @${t.author} → ${t.to.map((m) => "@" + m).join(" ") || "-"}): ${oneLine(t.body)}${last ? ` / 마지막 답글 @${last.author}: ${oneLine(last.body)}` : ""}`);
    }
  }
  const resolved = [...c.state.threads.values()].filter((t) => t.status === "resolved");
  if (resolved.length) {
    out.push("## 해결된 쓰레드 (결정 사항)");
    for (const t of resolved) out.push(`- ${t.id}: ${oneLine(t.body)} → ${oneLine(t.replies.at(-1)?.body ?? "(답글 없음)")}`);
  }

  const handoffs = listHandoffs(c.worktree, c.epic).filter((h) => !h.includes(c.runId));
  if (handoffs.length) out.push("## 이전 실행의 인수인계 기록", ...handoffs.map((h) => `- ${h}`), "필요하면 읽어서 이어받으세요(`flightdeck_get_handoffs`).");

  out.push("## Flightdeck 도구 (MCP)", "- flightdeck_get_epic: 일감 원문과 현재 단계", "- flightdeck_list_threads: 쓰레드와 답글", "- flightdeck_get_handoffs: 이전 실행들의 인수인계 기록");
  return out.join("\n\n");
}

/** 세션 중 단계가 바뀌었을 때 다음 프롬프트에 붙이는 맥락 (§6.1 단계 전환 반영) */
export async function phaseChangedContext(c: { epic: string; from: Phase; to: Phase; runId: string; configDir: string }): Promise<string> {
  const epicDir = `.flightdeck/epics/${c.epic}`;
  return [
    `[Flightdeck] 단계가 ${c.from} → ${c.to}로 바뀌었습니다. 지금부터 아래 룰을 따르세요. 이전 단계 산출물은 더 이상 고칠 수 없습니다.`,
    await phaseRules(c.configDir, c.to),
    "## 산출물",
    ...artifactLines(c.to, epicDir, c.runId),
  ].join("\n\n");
}

function artifactLines(phase: Phase, epicDir: string, runId: string): string[] {
  const a = PHASE_ARTIFACT[phase as keyof typeof PHASE_ARTIFACT];
  const lines: string[] = [];
  if (a) lines.push(`- 파일: ${epicDir}/${a.file}`, `- 필수 섹션(이 순서, \`## 제목\`): ${a.sections.join(", ")}`);
  lines.push(`- 인수인계 기록: ${epicDir}/runs/${runId}/handoff.md`, `  첫 줄 \`# Run ${runId} · ${phase}\`, 섹션(\`## 제목\`): ${HANDOFF_SECTIONS.join(", ")}`);
  return lines;
}

export function listHandoffs(worktree: string, epic: string): string[] {
  const runs = path.join(worktree, ".flightdeck", "epics", epic, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((r) => existsSync(path.join(runs, r, "handoff.md")))
    .sort()
    .map((r) => `.flightdeck/epics/${epic}/runs/${r}/handoff.md`);
}

const oneLine = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s).replace(/\s*\n\s*/g, " ");

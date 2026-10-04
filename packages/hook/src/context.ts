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

  out.push(...TOOLS_LINES, ...DRAFT_LINES);
  return out.join("\n\n");
}

const TOOLS_LINES = [
  "## Flightdeck 도구 (MCP)",
  [
    "- flightdeck_get_epic: 일감 원문과 현재 단계",
    "- flightdeck_list_threads: 쓰레드와 답글",
    "- flightdeck_get_handoffs: 이전 실행들의 인수인계 기록",
    "- flightdeck_search_run: 이전 실행의 세션 원본(대화) 검색. \"왜 이렇게 했나\"는 여기서 찾는다",
    "- flightdeck_log_step: (구현 단계) Step 기록",
    "- flightdeck_submit: (구현 단계) 구현 관문 검사",
  ].join("\n"),
];

/** 쓰레드 초안 블록 문법 (§3.2 v0.13). 사용자가 질문·답글·코멘트를 달라고 하면 이렇게 쓴다 */
const DRAFT_LINES = [
  "## 쓰레드 초안 (사용자가 질문·답글·코멘트를 달라고 할 때)",
  [
    "쓰레드 블록(<!-- flightdeck:thread … -->)은 직접 고치지 마세요. 대신 산출물 문서에 **초안 블록**을 쓰면, 사용자가 확인한 뒤 올립니다.",
    "- 새 쓰레드: 대상 블록(문단·목록 항목) **바로 아래**에",
    "  <!-- flightdeck:draft kind=question to=멤버1,멤버2 -->",
    "  본문",
    "  <!-- /flightdeck:draft -->",
    "  kind는 question(질문) | change_request(수정 요청) | note(코멘트). to는 받을 멤버(없으면 생략).",
    "- 답글: 아무 곳에나 <!-- flightdeck:draft reply=<쓰레드 ID> --> 본문 <!-- /flightdeck:draft -->",
    "- 문단 ID 줄(<!-- p:xxxx -->)은 지우거나 바꾸지 마세요.",
  ].join("\n"),
];

/** 질문 대상·리뷰어의 읽기 전용 창 (§3.6, §6.2 v0.13): 기록하지 않는 개인 질문 세션 */
export async function viewerContext(c: { epic: string; phase: Phase; member: string; worktree: string; state: EpicState; review?: string; copy?: boolean; rev?: string }): Promise<string> {
  const epicDir = `.flightdeck/epics/${c.epic}`;
  const out = c.copy
    ? [
        `[Flightdeck] 에픽 ${c.epic} · 단계 ${c.phase} · @${c.member}의 **리뷰 사본**(리뷰 요청 커밋 ${c.rev?.slice(0, 10) ?? "?"}). 이 세션은 기록하지 않습니다.`,
        [
          "- 코드를 자유롭게 읽고, 실행하고, 고칠 수 있습니다. 담당자의 작업 폴더에는 영향이 없습니다.",
          "- 고친 내용은 사용자가 확장에서 \"수정 제안 만들기\"를 누르면 이 커밋 대비 diff가 수정 요청 쓰레드에 붙어 담당자에게 갑니다. 하나의 제안에는 한 가지 수정만 담으세요.",
          `- ${epicDir}/ 아래 기록(impl-log 등)은 고치지 않습니다. git 명령은 쓸 수 없습니다.`,
          `- 구현 기록: ${epicDir}/impl-log.md (Step별 의도·결정·리뷰 포인트), 설계: ${epicDir}/design.md. "왜 이렇게 했나"는 flightdeck_search_run으로 세션 원본을 검색하세요.`,
        ].join("\n"),
      ]
    : [
        `[Flightdeck] 에픽 ${c.epic} · 단계 ${c.phase} · @${c.member}의 **읽기 전용 창**(질문 대상·리뷰). 이 세션은 기록하지 않습니다.`,
        [
          "- 문서 내용·코드는 고칠 수 없습니다. 고쳐도 확장이 되돌립니다.",
          `- 쓸 수 있는 것: ${epicDir}/analysis.md·design.md 안의 **쓰레드 초안 블록**뿐 (아래 문법).`,
          "- 셸은 읽기 전용 명령만 됩니다.",
          "- 사용자가 문서를 검사해 달라고 하면 문서·쓰레드·인수인계 기록을 읽고 답하세요. 질문·답글·코멘트를 달라고 하면 초안 블록으로 쓰세요.",
        ].join("\n"),
      ];
  if (c.review) out.push("## 리뷰", c.review);
  const open = [...c.state.threads.values()].filter((t) => t.status === "open");
  if (open.length) {
    out.push("## 열린 쓰레드");
    for (const t of open) out.push(`- ${t.id} (${t.kind}, @${t.author} → ${t.to.map((m) => "@" + m).join(" ") || "-"}): ${oneLine(t.body)}`);
  }
  const handoffs = listHandoffs(c.worktree, c.epic);
  if (handoffs.length) out.push("## 인수인계 기록", ...handoffs.map((h) => `- ${h}`));
  out.push(...TOOLS_LINES, ...DRAFT_LINES);
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
  if (phase === "IMPLEMENTATION") {
    lines.push(
      `- 기준 설계: ${epicDir}/design.md (통과한 설계. 고치지 않는다)`,
      "- 코드: 작업 폴더의 제품 코드. git 명령은 쓰지 않는다(버전 관리는 Flightdeck이 한다)",
      `- 구현 기록: ${epicDir}/impl-log.md. **직접 쓰지 말고** Step 하나를 끝낼 때마다 flightdeck_log_step으로 기록한다.`,
      "  넘기는 것: title, design_ref(design.md#p:xxxx — 이 Step이 구현한 설계 문단 ID), intent(의도), decision(결정), alternatives(검토한 대안), review_points(리뷰 포인트), verification(확인한 명령과 결과).",
      "  체크포인트와 바뀐 줄 범위(changes)는 Flightdeck이 채운다. 기록하지 않은 Step의 편집은 '설명 없는 변경'으로 제출이 막힌다.",
      "- 제출 전 flightdeck_submit으로 구현 관문(impl-log 형식, 설명 없는 변경)을 검사한다.",
    );
  }
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

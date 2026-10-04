// 단계별 도구 권한 (설계 §6.2). 순수 함수: 입력만 보고 허용/거부를 정한다.
// 경로는 호출하는 쪽에서 realpath로 정규화해 넘긴다(§6.1: 훅 입력은 /private/tmp 같은 실제 경로로 온다).
import path from "node:path";
import type { Phase } from "@flightdeck/schema";
import type { ToolKind } from "@flightdeck/agent";

export interface PolicyInput {
  phase: Phase;
  epic: string;
  runId: string | null;
  /** 정규화된 작업 폴더 절대 경로 */
  worktree: string;
  tool: { name: string; kind: ToolKind; paths: string[]; command?: string };
  /** 어댑터의 보호 경로 (worktree 기준 상대) */
  protectedPaths: string[];
  /** VERIFICATION에서 허용할 테스트 명령 (pipeline gate.commands) */
  testCommands?: string[];
  /**
   * viewer: 질문 대상·리뷰어의 읽기 전용 창 (§6.2 v0.13). 단계와 무관하게 산출물 문서(쓰레드 초안용)만 쓰고, 셸은 읽기 전용.
   * review: VERIFICATION 리뷰 사본 (M5 Y3). .flightdeck/ 밖은 자유롭게 고치고 셸도 쓴다(git 제외). 기록하지 않는다
   */
  role?: "owner" | "viewer" | "review";
}

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason: `Flightdeck: ${reason}` });

/** 분석·설계 단계에서 허용하는 읽기 전용 명령 */
export const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "pwd", "echo", "which", "file", "stat", "du",
  "sort", "uniq", "cut", "jq", "diff", "cd", "true", "basename", "dirname", "realpath",
]);

/** 읽기 전용 셸: 허용 목록 명령만, 명령 치환·파일 출력·git 불가 */
function readOnlyShell(cmd: string, where: string): Decision {
  const segments = splitCommand(cmd);
  if (segments.some((s) => s.prog === "git")) return deny("git 명령은 쓸 수 없습니다. 버전 관리는 Flightdeck이 합니다.");
  if (/\$\(|`/.test(cmd)) return deny(`${where}에서는 명령 치환을 쓸 수 없습니다(읽기 전용).`);
  if (hasWriteRedirect(cmd)) return deny(`${where}에서는 파일로 출력할 수 없습니다(읽기 전용).`);
  const bad = segments.find((s) => !READ_ONLY_COMMANDS.has(s.prog) || (s.prog === "find" && /\s-(delete|exec|execdir|ok|fprint)/.test(s.text)));
  if (bad) return deny(`${where}에서는 읽기 전용 명령만 쓸 수 있습니다(${bad.prog} 불가).`);
  return ALLOW;
}

export function decide(p: PolicyInput): Decision {
  const rel = (abs: string) => path.relative(p.worktree, abs).split(path.sep).join("/");
  const inside = (abs: string) => {
    const r = path.relative(p.worktree, abs);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  const epicDir = `.flightdeck/epics/${p.epic}`;

  // 모든 단계: 보호 경로는 읽기·쓰기 모두 차단 (§6.2)
  for (const abs of p.tool.paths) {
    if (!inside(abs)) continue;
    const r = rel(abs);
    if (r === ".flightdeck/.runtime" || r.startsWith(".flightdeck/.runtime/")) return deny(`설정 캐시(${r})는 읽거나 쓸 수 없습니다.`);
    if (p.protectedPaths.includes(r)) return deny(`에이전트 설정 파일(${r})은 읽거나 쓸 수 없습니다.`);
  }

  if (p.role === "viewer") {
    if (p.tool.kind === "write") {
      for (const abs of p.tool.paths) {
        const r = inside(abs) ? rel(abs) : abs;
        if (r !== `${epicDir}/analysis.md` && r !== `${epicDir}/design.md`) {
          return deny(`읽기 전용 창입니다. 쓸 수 있는 것은 ${epicDir}/analysis.md·design.md의 쓰레드 초안 블록(<!-- flightdeck:draft … -->)뿐입니다 (${r} 불가).`);
        }
      }
      return ALLOW; // 초안 블록 밖의 변경은 확장이 되돌린다
    }
    if (p.tool.kind === "shell") return readOnlyShell(p.tool.command ?? "", "읽기 전용 창");
    return ALLOW;
  }

  if (p.role === "review") {
    if (p.tool.kind === "write") {
      for (const abs of p.tool.paths) {
        if (!inside(abs)) return deny(`리뷰 사본 밖(${abs})에는 쓸 수 없습니다.`);
        const r = rel(abs);
        if (r.startsWith(".flightdeck/")) return deny(`리뷰 사본에서는 Flightdeck 기록(${r})을 고치지 않습니다. 코드만 고치고, 고친 것은 사용자가 수정 제안으로 올립니다.`);
      }
      return ALLOW;
    }
    if (p.tool.kind === "shell") {
      const segments = splitCommand(p.tool.command ?? "");
      if (segments.some((s) => s.prog === "git")) return deny("git 명령은 쓸 수 없습니다. 수정 제안(diff)은 Flightdeck이 만듭니다.");
      if (segments.some((s) => s.prog === "rm" && /\s-[a-zA-Z]*r[a-zA-Z]*f|\s-[a-zA-Z]*f[a-zA-Z]*r|--recursive.*--force/.test(s.text))) return deny("rm -rf는 쓸 수 없습니다.");
      return ALLOW;
    }
    return ALLOW;
  }

  if (p.tool.kind === "write") {
    for (const abs of p.tool.paths) {
      if (!inside(abs)) return deny(`작업 폴더 밖(${abs})에는 쓸 수 없습니다.`);
      const r = rel(abs);
      if (!writeAllowed(p.phase, r, epicDir, p.runId)) return deny(`${p.phase} 단계에서는 ${r}에 쓸 수 없습니다. ${allowedWritesHint(p.phase, epicDir, p.runId)}`);
    }
    return ALLOW;
  }

  if (p.tool.kind === "shell") {
    const cmd = p.tool.command ?? "";
    const segments = splitCommand(cmd);
    if (segments.some((s) => s.prog === "git")) return deny("git 명령은 쓸 수 없습니다. 버전 관리는 Flightdeck이 합니다.");
    switch (p.phase) {
      case "ANALYSIS":
      case "DESIGN":
        return readOnlyShell(cmd, `${p.phase} 단계`);
      case "IMPLEMENTATION": {
        if (segments.some((s) => s.prog === "rm" && /\s-[a-zA-Z]*r[a-zA-Z]*f|\s-[a-zA-Z]*f[a-zA-Z]*r|--recursive.*--force/.test(s.text))) return deny("rm -rf는 쓸 수 없습니다.");
        return ALLOW;
      }
      case "VERIFICATION": {
        const ok = (p.testCommands ?? []).some((t) => cmd.trim() === t || cmd.trim().startsWith(`${t} `));
        return ok ? ALLOW : deny(`VERIFICATION 단계에서는 테스트 명령(${(p.testCommands ?? []).join(", ") || "없음"})만 쓸 수 있습니다.`);
      }
      default:
        return deny(`${p.phase} 단계에서는 셸을 쓸 수 없습니다.`);
    }
  }

  return ALLOW;
}

function writeAllowed(phase: Phase, r: string, epicDir: string, runId: string | null): boolean {
  const handoff = runId ? `${epicDir}/runs/${runId}/handoff.md` : null;
  switch (phase) {
    case "ANALYSIS":
      return r === `${epicDir}/analysis.md` || r === handoff;
    case "DESIGN":
      return r === `${epicDir}/design.md` || r === handoff;
    case "IMPLEMENTATION":
      // impl-log는 flightdeck_log_step으로만, trace는 훅이 쓴다 (M4 제안 X1·X10)
      return !r.startsWith(".flightdeck/") || r === handoff;
    default:
      return false;
  }
}

function allowedWritesHint(phase: Phase, epicDir: string, runId: string | null): string {
  const handoff = runId ? `, ${epicDir}/runs/${runId}/handoff.md` : "";
  if (phase === "ANALYSIS") return `쓸 수 있는 파일: ${epicDir}/analysis.md${handoff}`;
  if (phase === "DESIGN") return `쓸 수 있는 파일: ${epicDir}/design.md${handoff}`;
  if (phase === "IMPLEMENTATION") return `구현 기록(impl-log.md)은 flightdeck_log_step 도구로 씁니다. .flightdeck/ 안에서 직접 쓸 수 있는 것은 이번 실행의 인수인계 기록(${epicDir}/runs/<run-id>/handoff.md)뿐입니다.`;
  return "";
}

/** 명령을 ; && || | 줄바꿈으로 나누고 각 조각의 실행 프로그램을 찾는다 (앞의 VAR=값, sudo/env 등은 건너뜀) */
export function splitCommand(cmd: string): { prog: string; text: string }[] {
  return cmd
    .split(/;|&&|\|\||\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => {
      const words = text.split(/\s+/);
      let i = 0;
      while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ["sudo", "env", "command", "exec", "nohup", "time"].includes(words[i]!))) i++;
      const w = words[i] ?? "";
      return { prog: path.posix.basename(w.replace(/^["']|["']$/g, "")), text };
    });
}

/** 파일로 쓰는 리다이렉션이 있는가 (2>&1, >/dev/null, 2>/dev/null은 허용) */
export function hasWriteRedirect(cmd: string): boolean {
  const cleaned = cmd.replace(/\d?>&\d/g, "").replace(/\d?>>?\s*\/dev\/null/g, "");
  return /(^|[^<])>>?/.test(cleaned) || /\btee\b/.test(cleaned);
}

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
}

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason: `Flightdeck: ${reason}` });

/** 분석·설계 단계에서 허용하는 읽기 전용 명령 */
export const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "pwd", "echo", "which", "file", "stat", "du",
  "sort", "uniq", "cut", "jq", "diff", "cd", "true", "basename", "dirname", "realpath",
]);

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
      case "DESIGN": {
        if (/\$\(|`/.test(cmd)) return deny(`${p.phase} 단계에서는 명령 치환을 쓸 수 없습니다(읽기 전용).`);
        if (hasWriteRedirect(cmd)) return deny(`${p.phase} 단계에서는 파일로 출력할 수 없습니다(읽기 전용).`);
        const bad = segments.find((s) => !READ_ONLY_COMMANDS.has(s.prog) || (s.prog === "find" && /\s-(delete|exec|execdir|ok|fprint)/.test(s.text)));
        if (bad) return deny(`${p.phase} 단계에서는 읽기 전용 명령만 쓸 수 있습니다(${bad.prog} 불가).`);
        return ALLOW;
      }
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
      return !r.startsWith(".flightdeck/") || r === `${epicDir}/impl-log.md` || r === handoff;
    default:
      return false;
  }
}

function allowedWritesHint(phase: Phase, epicDir: string, runId: string | null): string {
  const handoff = runId ? `, ${epicDir}/runs/${runId}/handoff.md` : "";
  if (phase === "ANALYSIS") return `쓸 수 있는 파일: ${epicDir}/analysis.md${handoff}`;
  if (phase === "DESIGN") return `쓸 수 있는 파일: ${epicDir}/design.md${handoff}`;
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

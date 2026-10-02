// AgentAdapter (설계 §6.5). 에이전트 CLI마다 다른 부분(설정 파일, 훅 입출력, 편집 형식, 세션 기록)을 가둔다.
// Flightdeck의 나머지는 에이전트 종류를 모르고 아래 공통 타입만 쓴다.
import type { TextEdit } from "@flightdeck/core";

export type HookEventKind = "session.start" | "prompt.submit" | "tool.before" | "tool.after" | "session.stop" | "session.end";

/** 도구가 하는 일의 공통 분류 (§6.2 "쓰기", "셸"은 공통 개념) */
export type ToolKind = "read" | "write" | "shell" | "mcp" | "other";

export interface HookEvent {
  kind: HookEventKind;
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  promptId?: string;
  /** session.start: startup | resume | clear | compact … */
  source?: string;
  prompt?: string;
  tool?: {
    name: string;
    kind: ToolKind;
    useId: string;
    /** 읽거나 쓰는 파일 (절대 경로, realpath 전) */
    paths: string[];
    /** 셸 명령 */
    command?: string;
    input: unknown;
    response?: unknown;
  };
  raw: unknown;
}

export type HookResponse =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "context"; text: string };

/** 에이전트 CLI가 받아들일 훅 출력 (stdout 문자열 + 종료 코드) */
export interface HookOutput {
  stdout: string;
  exitCode: number;
}

export interface McpSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionRef {
  sessionId: string;
  cwd: string;
}

export interface FileSnapshot {
  path: string;
  /** null: 파일 없음 */
  content: string | null;
}

export interface Capabilities {
  sessionStartContext: boolean;
  promptContext: boolean;
  preToolBlock: boolean;
  postToolEdits: boolean;
  midRunContext: boolean;
  transcript: boolean;
  resume: boolean;
}

export interface AgentAdapter {
  id: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  /** 도구별 설정 파일에 훅·MCP 등록 (§6.1 설정 배치) */
  installConfig(worktree: string, hookCmd: string, mcp: McpSpec, opts?: { model?: string }): Promise<void>;
  /** 에이전트가 고치면 안 되는 설정 파일 (worktree 기준 상대 경로, §6.2) */
  protectedPaths(): string[];
  parseHookEvent(raw: unknown): HookEvent;
  renderHookResponse(event: HookEvent, r: HookResponse): HookOutput;
  /** 디스크 전후 스냅샷 → 편집 (§8.6 v0.10). 페이로드는 범위 분할 힌트로만 쓴다 */
  extractEdits(event: HookEvent, before: FileSnapshot, after: FileSnapshot): TextEdit[];
  /** 저장·중계할 transcript 항목만 남긴다 (§6.4 허용 목록 필터). 버릴 항목은 null */
  filterTranscriptItem?(item: unknown): unknown | null;
  headless?(prompt: string, o: { cwd: string; model?: string; maxTurns?: number; allowedTools?: string[] }): Promise<SessionRef & { result: string }>;
  resumeCommand?(s: SessionRef): string[];
  capabilities: Capabilities;
}

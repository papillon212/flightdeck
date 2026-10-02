// Claude Code 어댑터 (설계 §6.1, §6.5). M0에서 확인한 훅 입출력을 그대로 따른다.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffToEdits } from "@flightdeck/core";
import type { AgentAdapter, FileSnapshot, HookEvent, HookEventKind, HookOutput, HookResponse, McpSpec, SessionRef, ToolKind } from "./types.ts";

const EVENT_KIND: Record<string, HookEventKind> = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submit",
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
  Stop: "session.stop",
  SessionEnd: "session.end",
};
const HOOK_NAME = Object.fromEntries(Object.entries(EVENT_KIND).map(([k, v]) => [v, k])) as Record<HookEventKind, string>;

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);

/** transcript에서 저장·중계할 기록 종류 (§6.4 허용 목록) */
const KEEP_TYPES = new Set(["user", "assistant"]);
const KEEP_ATTACHMENTS = new Set(["hook_additional_context"]);

/** 확장이 claude를 띄울 때 지울 환경변수 (§6.1: 상속되면 transcript가 저장되지 않는 등) */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)));
}

function toolKind(name: string): ToolKind {
  if (WRITE_TOOLS.has(name)) return "write";
  if (READ_TOOLS.has(name)) return "read";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

function toolPaths(name: string, input: Record<string, unknown>, cwd: string): string[] {
  const p = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (!p) return name === "Grep" || name === "Glob" ? [cwd] : [];
  return [path.isAbsolute(p) ? p : path.join(cwd, p)];
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly capabilities = {
    sessionStartContext: true,
    promptContext: true,
    preToolBlock: true,
    postToolEdits: true,
    midRunContext: true,
    transcript: true,
    resume: true,
  };

  constructor(readonly bin = "claude") {}

  detect(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      execFile(this.bin, ["--version"], { env: cleanEnv() }, (err, stdout) => {
        if (err) resolve({ installed: false });
        else resolve({ installed: true, version: /\d+\.\d+\.\d+/.exec(stdout)?.[0] });
      });
    });
  }

  protectedPaths(): string[] {
    return [".claude/settings.local.json", ".mcp.json"];
  }

  /**
   * worktree에 .claude/settings.local.json과 .mcp.json을 쓴다 (§6.1 설정 배치, v0.10).
   * settings.local.json의 다른 키는 그대로 두고 Flightdeck 키만 덮어쓴다.
   */
  async installConfig(worktree: string, hookCmd: string, mcp: McpSpec, opts: { model?: string } = {}): Promise<void> {
    const file = path.join(worktree, ".claude", "settings.local.json");
    await mkdir(path.dirname(file), { recursive: true });
    const cur = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
    const entry = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCmd }] }];
    const settings = {
      ...cur,
      hooks: {
        SessionStart: entry(),
        UserPromptSubmit: entry(),
        PreToolUse: entry("*"),
        PostToolUse: entry("*"),
        Stop: entry(),
        SessionEnd: entry(),
      },
      enabledMcpjsonServers: [mcp.name],
      permissions: { ...(cur.permissions ?? {}), allow: [...new Set([...(cur.permissions?.allow ?? []), `mcp__${mcp.name}`])] },
      ...(opts.model ? { model: opts.model } : {}),
    };
    await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
    const mcpFile = path.join(worktree, ".mcp.json");
    const curMcp = existsSync(mcpFile) ? JSON.parse(await readFile(mcpFile, "utf8")) : {};
    const servers = { ...(curMcp.mcpServers ?? {}), [mcp.name]: { command: mcp.command, args: mcp.args, ...(mcp.env ? { env: mcp.env } : {}) } };
    await writeFile(mcpFile, JSON.stringify({ ...curMcp, mcpServers: servers }, null, 2) + "\n");
  }

  parseHookEvent(raw: unknown): HookEvent {
    const r = raw as Record<string, any>;
    const kind = EVENT_KIND[r.hook_event_name];
    if (!kind) throw new Error(`알 수 없는 훅 이벤트: ${r.hook_event_name}`);
    const cwd = String(r.cwd ?? process.cwd());
    const ev: HookEvent = {
      kind,
      sessionId: String(r.session_id ?? ""),
      transcriptPath: r.transcript_path,
      cwd,
      promptId: r.prompt_id,
      source: r.source,
      prompt: r.prompt,
      raw,
    };
    if (r.tool_name) {
      const input = (r.tool_input ?? {}) as Record<string, unknown>;
      ev.tool = {
        name: r.tool_name,
        kind: toolKind(r.tool_name),
        useId: String(r.tool_use_id ?? ""),
        paths: toolPaths(r.tool_name, input, cwd),
        command: typeof input.command === "string" ? input.command : undefined,
        input,
        response: r.tool_response,
      };
    }
    return ev;
  }

  /** §6.1 훅 입출력 표 */
  renderHookResponse(event: HookEvent, r: HookResponse): HookOutput {
    const hookEventName = HOOK_NAME[event.kind];
    if (r.kind === "allow") return { stdout: "", exitCode: 0 };
    if (r.kind === "deny") {
      if (event.kind !== "tool.before") throw new Error("deny는 tool.before에서만 쓴다");
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: r.reason } }), exitCode: 0 };
    }
    if (!["session.start", "prompt.submit", "tool.after"].includes(event.kind)) return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: r.text } }), exitCode: 0 };
  }

  extractEdits(_event: HookEvent, before: FileSnapshot, after: FileSnapshot) {
    return diffToEdits(before.content ?? "", after.content ?? "");
  }

  /** §6.4 허용 목록: 사람 프롬프트, 에이전트 텍스트·도구 호출, 도구 결과, Flightdeck이 주입한 컨텍스트만 남긴다 */
  filterTranscriptItem(item: unknown): unknown | null {
    const o = item as Record<string, any>;
    if (o?.type === "attachment") return KEEP_ATTACHMENTS.has(o.attachment?.type) ? pickTranscript(o) : null;
    if (!KEEP_TYPES.has(o?.type)) return null;
    if (o.isMeta) return null;
    return pickTranscript(o);
  }

  headless(prompt: string, o: { cwd: string; model?: string; maxTurns?: number; allowedTools?: string[] }): Promise<SessionRef & { result: string }> {
    const args = ["-p", prompt, "--output-format", "json"];
    if (o.model) args.push("--model", o.model);
    if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
    if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(" "));
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: o.cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        try {
          const j = JSON.parse(out);
          resolve({ sessionId: j.session_id, cwd: o.cwd, result: j.result ?? "" });
        } catch {
          reject(new Error(`claude -p 실패 (${code}): ${err || out}`.slice(0, 2000)));
        }
      });
    });
  }

  resumeCommand(s: SessionRef): string[] {
    return [this.bin, "--resume", s.sessionId];
  }
}

/** 개인 정보가 섞일 수 있는 필드를 빼고 필요한 것만 남긴다 */
function pickTranscript(o: Record<string, any>) {
  return {
    type: o.type,
    uuid: o.uuid,
    parentUuid: o.parentUuid,
    timestamp: o.timestamp,
    sessionId: o.sessionId,
    version: o.version,
    ...(o.message ? { message: { id: o.message.id, role: o.message.role, model: o.message.model, content: o.message.content } } : {}),
    ...(o.attachment ? { attachment: { type: o.attachment.type, hookName: o.attachment.hookName, content: o.attachment.content } } : {}),
  };
}

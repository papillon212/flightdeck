// flightdeck-hook CLI: 모든 에이전트 훅의 공통 진입점 (설계 §13 packages/hook).
// 사용: flightdeck-hook <adapter> --repo <제품 레포> --epic <에픽 ID>   (stdin: 에이전트의 훅 입력 JSON)
// 실패 정책 (§6.1 v0.10): 내부 오류가 나면 tool.before는 거부(fail-closed), 나머지는 허용(fail-open)하고 훅 로그에 남긴다.
import { ClaudeCodeAdapter, type AgentAdapter, type HookEvent } from "@flightdeck/agent";
import { GitEngine } from "@flightdeck/git";
import { handle } from "./handler.ts";
import { hookLog, readState } from "./store.ts";

const ADAPTERS: Record<string, () => AgentAdapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
};

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} 인자가 없습니다`);
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(): Promise<{ stdout: string; exitCode: number }> {
  const adapter = ADAPTERS[process.argv[2] ?? ""]?.();
  const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
  let ev: HookEvent | null = null;
  let dataDir: string | null = null;
  let epic: string | null = null;
  try {
    if (!adapter) throw new Error(`알 수 없는 어댑터: ${process.argv[2]}`);
    ev = adapter.parseHookEvent(raw);
    epic = arg("epic");
    dataDir = await new GitEngine(arg("repo")).dataDir();
    const state = await readState(dataDir, epic);
    const resp = await handle(ev, { adapter, dataDir, state });
    return adapter.renderHookResponse(ev, resp);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    if (dataDir && epic) await hookLog(dataDir, epic, { kind: "error", event: raw.hook_event_name, tool: raw.tool_name, message }).catch(() => {});
    else process.stderr.write(`flightdeck-hook 오류: ${message}\n`);
    const isBefore = ev ? ev.kind === "tool.before" : raw.hook_event_name === "PreToolUse";
    if (isBefore) {
      const reason = `Flightdeck 훅 오류로 이 도구 호출을 막았습니다. 담당자에게 알려 주세요. (${(err as Error)?.message ?? err})`;
      if (adapter && ev) return adapter.renderHookResponse(ev, { kind: "deny", reason });
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }), exitCode: 0 };
    }
    return { stdout: "", exitCode: 0 };
  }
}

run().then((o) => {
  if (o.stdout) process.stdout.write(o.stdout);
  process.exit(o.exitCode);
});

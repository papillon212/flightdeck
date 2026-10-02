// 최소 MCP 서버 (stdio, 줄 단위 JSON-RPC 2.0). 의존성 없음 — M0 06번 스파이크와 같은 방식.
import readline from "node:readline";
import { TOOLS, type ToolContext } from "./tools.ts";

const SERVER_INFO = { name: "flightdeck", version: "0.1.0" };

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}

/** 요청 하나를 처리해 응답을 돌려준다. 알림(id 없음)이면 null */
export async function handleRpc(msg: RpcMessage, ctx: ToolContext): Promise<object | null> {
  if (msg.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `알 수 없는 도구: ${msg.params?.name}`);
      try {
        return ok({ content: [{ type: "text", text: await tool.run(msg.params?.arguments ?? {}, ctx) }] });
      } catch (err) {
        return ok({ content: [{ type: "text", text: `Flightdeck 도구 오류: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `지원하지 않는 메서드: ${msg.method}`);
  }
}

export function serve(ctx: ToolContext): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 파싱 실패" } }) + "\n");
      return;
    }
    const res = await handleRpc(msg, ctx);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
}

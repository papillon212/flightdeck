#!/usr/bin/env node
// M0 스파이크용 최소 MCP 서버 (stdio, 줄 단위 JSON-RPC). 의존성 없음.
// 도구 flightdeck_ping 하나를 제공하고, 호출·초기화를 FD_STATE/mcp-log.jsonl에 기록한다.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const STATE = process.env.FD_STATE ?? "/tmp";
const log = (o) => fs.appendFileSync(path.join(STATE, "mcp-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

log({ event: "started", pid: process.pid, cwd: process.cwd() });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // 알림은 무시
  switch (msg.method) {
    case "initialize":
      log({ event: "initialize", client: msg.params?.clientInfo });
      return send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "flightdeck-spike", version: "0.0.1" },
      } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
        name: "flightdeck_ping",
        description: "Flightdeck 연결 확인. 현재 에픽 단계를 돌려준다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }] } });
    case "tools/call":
      log({ event: "call", name: msg.params?.name });
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong: epic CU-test, phase ANALYSIS" }] } });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "@flightdeck/core";
import { git, GitEngine, LocalEventStore } from "@flightdeck/git";
import { handleRpc } from "../src/index.ts";

const DIST = path.resolve(import.meta.dirname, "../../../dist/flightdeck-mcp.mjs");
let root: string, repo: string, statePath: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-mcp-test-"));
  repo = path.join(root, "product");
  await mkdir(repo);
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@e.com"]]) await git(a, { cwd: repo });
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await git(["add", "."], { cwd: repo });
  await git(["commit", "-q", "-m", "init"], { cwd: repo });
  const eng = new GitEngine(repo);
  const wt = (await eng.createEpicWorktree("CU-9")).path;
  const epicDir = path.join(wt, ".flightdeck/epics/CU-9");
  await mkdir(path.join(epicDir, "runs/01JB3K9PZQ8W5R2N7T4M6X1C0D"), { recursive: true });
  await writeFile(path.join(epicDir, "epic.md"), "# 일감 본문\n");
  await writeFile(path.join(epicDir, "runs/01JB3K9PZQ8W5R2N7T4M6X1C0D/handoff.md"), "# Run 01JB… · ANALYSIS\n## 목표\n분석\n");
  const store = new LocalEventStore(repo);
  const at = () => new Date().toISOString();
  await store.append({ v: 1, id: ulid(), type: "epic.started", epic: "CU-9", author: "dh.lee", at: at(), data: { tracker_ref: "CU-9", owner: "dh.lee", base_sha: await eng.revParse("HEAD"), config_version: "local" } });
  await store.append({ v: 1, id: ulid(), type: "thread.created", epic: "CU-9", author: "dh.lee", at: at(), data: { thread: "t-AAAAAAAA", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:a91c" }, kind: "question", to: ["park"], body: "TTL은?" } });
  statePath = path.join(await eng.dataDir(), "state", "CU-9.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ epic: "CU-9", repo, worktree: wt, member: "dh.lee", phase: "ANALYSIS", configDir: root, runs: {} }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const call = async (name: string, args: object = {}) => {
  const r = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { statePath })) as any;
  return r.result.content[0].text as string;
};

describe("flightdeck MCP 서버 (설계 §6.1)", () => {
  it("tools/list: M1 도구 3개", async () => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { statePath })) as any;
    expect(r.result.tools.map((t: any) => t.name)).toEqual(["flightdeck_get_epic", "flightdeck_list_threads", "flightdeck_get_handoffs"]);
  });

  it("get_epic, list_threads, get_handoffs", async () => {
    expect(JSON.parse(await call("flightdeck_get_epic"))).toMatchObject({ epic: "CU-9", phase: "ANALYSIS", owner: "dh.lee", epic_md: "# 일감 본문\n" });
    expect(JSON.parse(await call("flightdeck_list_threads", { status: "open" }))).toMatchObject([{ id: "t-AAAAAAAA", body: "TTL은?", to: ["park"] }]);
    expect(JSON.parse(await call("flightdeck_list_threads", { status: "resolved" }))).toEqual([]);
    expect(await call("flightdeck_get_handoffs")).toContain("## 목표\n분석");
  });

  it("알 수 없는 메서드·도구는 오류, 알림은 응답 없음", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", id: 2, method: "nope" }, { statePath })).toMatchObject({ error: { code: -32601 } });
    expect(await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } }, { statePath })).toMatchObject({ error: { code: -32602 } });
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { statePath })).toBeNull();
  });

  it.skipIf(!existsSync(DIST))("묶은 실행 파일이 stdio로 응답한다", async () => {
    const child = spawn("node", [DIST, "--repo", repo, "--epic", "CU-9"]);
    const lines: string[] = [];
    child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "flightdeck_get_epic" } }) + "\n");
    for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    expect(JSON.parse(lines[0]!).result.serverInfo.name).toBe("flightdeck");
    expect(JSON.parse(JSON.parse(lines[1]!).result.content[0].text).phase).toBe("ANALYSIS");
  });
});

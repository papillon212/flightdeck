import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { replay, sha256, ulid } from "@flightdeck/core";
import { git, GitEngine, LocalEventStore } from "@flightdeck/git";
import type { LocalEpicState } from "@flightdeck/schema";
import { handle, readEditLog, readState, writeState } from "../src/index.ts";

const CONFIG = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST_HOOK = path.resolve(import.meta.dirname, "../../../dist/flightdeck-hook.mjs");
const adapter = new ClaudeCodeAdapter();

let root: string, repo: string, wt: string, dataDir: string;
const SESSION = "11111111-2222-3333-4444-555555555555";
const EPIC = "CU-1";

const raw = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  transcript_path: "/tmp/none.jsonl",
  cwd: wt,
  permission_mode: "default",
  prompt_id: "prompt-1",
  hook_event_name,
  ...extra,
});
let toolSeq = 0;
const tool = (name: string, input: Record<string, unknown>) => ({ tool_name: name, tool_input: input, tool_use_id: `toolu_${++toolSeq}` });

async function fire(hook_event_name: string, extra: Record<string, unknown> = {}) {
  const ev = adapter.parseHookEvent(raw(hook_event_name, extra));
  const state = await readState(dataDir, EPIC);
  const resp = await handle(ev, { adapter, dataDir, state });
  return { resp, out: adapter.renderHookResponse(ev, resp) };
}

/** 도구 하나를 훅 전후로 감싸 실행한다 */
async function runTool(name: string, input: Record<string, unknown>, act: () => Promise<void>) {
  const t = tool(name, input);
  const before = await fire("PreToolUse", t);
  if (before.resp.kind === "deny") return before.resp;
  await act();
  await fire("PostToolUse", { ...t, tool_response: {} });
  return before.resp;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-hook-test-"));
  repo = path.join(root, "product");
  await mkdir(repo);
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "tester"], ["config", "user.email", "t@example.com"]]) await git(a, { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await git(["add", "."], { cwd: repo });
  await git(["commit", "-q", "-m", "base"], { cwd: repo });

  const eng = new GitEngine(repo);
  wt = (await eng.createEpicWorktree(EPIC)).path;
  dataDir = await eng.dataDir();
  await mkdir(path.join(wt, ".flightdeck/epics", EPIC), { recursive: true });
  await writeFile(path.join(wt, ".flightdeck/epics", EPIC, "epic.md"), "# CU-1 토큰 갱신 개선\n\n리프레시 토큰을 회전시킨다.\n");
  await eng.commit(wt, [`.flightdeck/epics/${EPIC}/epic.md`], "에픽 시작");
  await new LocalEventStore(repo).append({
    v: 1, id: ulid(), type: "epic.started", epic: EPIC, author: "dh.lee", at: new Date().toISOString(),
    data: { tracker_ref: EPIC, owner: "dh.lee", base_sha: await eng.revParse("HEAD"), config_version: "local" },
  });
  const state: LocalEpicState = { epic: EPIC, repo, worktree: wt, member: "dh.lee", role: "owner", phase: "ANALYSIS", configDir: CONFIG, trust: { mode: "dev" }, excludeSecrets: [".env", "*.pem"], runs: {} };
  await writeState(dataDir, state);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("flightdeck-hook (설계 §6.1)", () => {
  let runId: string;

  it("session.start: 실행 등록(run.started) + 단계 룰·산출물·일감 주입", async () => {
    const { out } = await fire("SessionStart", { source: "startup" });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("SessionStart");
    expect(ctx.additionalContext).toContain("단계 ANALYSIS");
    expect(ctx.additionalContext).toContain("## 분석 단계"); // rules/analysis.md
    expect(ctx.additionalContext).toContain("필수 섹션(이 순서, `## 제목`): 요구사항 요약, 영향 범위, 불명확한 점, 가정");
    expect(ctx.additionalContext).toContain("리프레시 토큰을 회전시킨다.");
    runId = (await readState(dataDir, EPIC)).runs[SESSION]!.run_id;
    expect(ctx.additionalContext).toContain(`runs/${runId}/handoff.md`);
    const events = await new LocalEventStore(repo).list(EPIC);
    expect(events.map((e) => e.type)).toEqual(["epic.started", "run.started"]);
    // resume은 같은 실행을 이어간다
    await fire("SessionStart", { source: "resume" });
    expect((await readState(dataDir, EPIC)).runs[SESSION]!.run_id).toBe(runId);
    expect((await new LocalEventStore(repo).list(EPIC)).length).toBe(2);
  });

  it("tool.before: 단계별 권한 (§6.2). 경로는 realpath로 비교", async () => {
    const analysis = path.join(wt, `.flightdeck/epics/${EPIC}/analysis.md`);
    expect((await fire("PreToolUse", tool("Write", { file_path: analysis, content: "x" }))).resp.kind).toBe("allow");
    const denied = await fire("PreToolUse", tool("Write", { file_path: path.join(wt, "app.txt"), content: "x" }));
    expect(JSON.parse(denied.out.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect((await fire("PreToolUse", tool("Bash", { command: "git status" }))).resp.kind).toBe("deny");
    expect((await fire("PreToolUse", tool("Read", { file_path: path.join(wt, ".mcp.json") }))).resp.kind).toBe("deny");
    expect((await fire("PreToolUse", tool("Bash", { command: "ls -la" }))).resp.kind).toBe("allow");
  });

  it("tool.after: 파일 도구 편집 기록 → 재적용하면 디스크와 같다 (§8.6)", async () => {
    const rel = `.flightdeck/epics/${EPIC}/analysis.md`;
    const abs = path.join(wt, rel);
    await runTool("Write", { file_path: abs }, () => writeFile(abs, "## 요구사항 요약\n토큰 회전\r\n🌏\n"));
    await runTool("Edit", { file_path: abs }, async () => writeFile(abs, (await readFile(abs, "utf8")).replace("토큰 회전", "리프레시 토큰 회전")));
    const log = await readEditLog(dataDir, EPIC);
    expect(log.map((r) => r.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log[0]).toMatchObject({ file: rel, base_hash: null, source: { kind: "agent", member: "dh.lee", adapter: "claude-code", run: runId, prompt_id: "prompt-1" } });
    const r = replay(new Map(), log);
    expect(r.mismatches).toEqual([]);
    expect(r.files.get(rel)).toBe(await readFile(abs, "utf8"));
  });

  it("tool.after: 산출물의 문단 ID를 지우면 편집을 되돌리고 에이전트에게 알린다 (§3.2, §6.2)", async () => {
    const abs = path.join(wt, `.flightdeck/epics/${EPIC}/analysis.md`);
    const withIds = "<!-- p:aaaa -->\n## 요구사항 요약\n<!-- p:bbbb -->\n리프레시 토큰 회전\n";
    await writeFile(abs, withIds);
    const t = tool("Edit", { file_path: abs });
    await fire("PreToolUse", t);
    await writeFile(abs, withIds.replace("<!-- p:bbbb -->\n", "")); // 에이전트가 ID 줄을 지움
    const { out } = await fire("PostToolUse", { ...t, tool_response: {} });
    expect(await readFile(abs, "utf8")).toBe(withIds);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain("되돌렸습니다");
    // ID를 지키며 내용만 고치면 그대로 둔다
    const t2 = tool("Edit", { file_path: abs });
    await fire("PreToolUse", t2);
    await writeFile(abs, withIds.replace("리프레시 토큰 회전", "리프레시 토큰을 매번 회전"));
    expect((await fire("PostToolUse", { ...t2, tool_response: {} })).out.stdout).toBe("");
    expect(await readFile(abs, "utf8")).toContain("매번 회전");
  });

  it("tool.after: 셸 편집은 agent_shell로 기록, 비밀 파일은 내용을 남기지 않는다", async () => {
    await writeState(dataDir, { ...(await readState(dataDir, EPIC)), phase: "IMPLEMENTATION" });
    const before = (await readEditLog(dataDir, EPIC)).length;
    await runTool("Bash", { command: "sed -i '' s/base/BASE/ app.txt" }, async () => {
      await writeFile(path.join(wt, "app.txt"), (await readFile(path.join(wt, "app.txt"), "utf8")).replace("base", "BASE"));
    });
    await runTool("Write", { file_path: path.join(wt, ".env") }, () => writeFile(path.join(wt, ".env"), "TOKEN=secret-value\n"));
    const added = (await readEditLog(dataDir, EPIC)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ file: "app.txt", base_hash: sha256("base\n"), range: [0, 4], insert: "BASE", source: { kind: "agent_shell", cmd: "sed -i '' s/base/BASE/ app.txt" } });
    expect(JSON.stringify(await readEditLog(dataDir, EPIC))).not.toContain("secret-value");
  });

  it("prompt.submit: 세션 중 단계가 바뀌면 새 단계 룰을 한 번 붙인다", async () => {
    await writeState(dataDir, { ...(await readState(dataDir, EPIC)), phase: "DESIGN" });
    const { out } = await fire("UserPromptSubmit", { prompt: "계속" });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("단계가 ANALYSIS → DESIGN로 바뀌었습니다");
    expect(ctx).toContain("## 설계 단계");
    expect((await fire("UserPromptSubmit", { prompt: "다시" })).out.stdout).toBe("");
  });

  it("session.stop: 바뀐 게 있을 때만 체크포인트 (§8.1)", async () => {
    const eng = new GitEngine(repo);
    await fire("Stop");
    const first = await eng.listCheckpoints(EPIC, "dh.lee");
    expect(first).toHaveLength(1);
    expect(first[0]!.trailers).toMatchObject({ "Flightdeck-Run": runId, "Flightdeck-Source": "agent" });
    expect(Number(first[0]!.trailers["Flightdeck-Seq"])).toBe((await readEditLog(dataDir, EPIC)).at(-1)!.seq);
    await fire("Stop");
    // 수정 전에는 간헐적으로 2개였다: 같은 크기 편집(base→BASE)을 racy git 때문에 예전 내용으로 담음 (T6)
    expect(await eng.listCheckpoints(EPIC, "dh.lee")).toHaveLength(1);
    expect((await git(["ls-tree", "-r", "--name-only", first[0]!.sha], { cwd: wt }))).not.toContain(".env");
  });

  it("session.end: run.finished", async () => {
    await fire("SessionEnd");
    const events = await new LocalEventStore(repo).list(EPIC);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", data: { run_id: runId } });
  });
});

describe("flightdeck-hook CLI 실패 정책 (설계 §6.1 v0.10)", () => {
  const cli = (input: object, args: string[]) =>
    new Promise<{ stdout: string; code: number | null }>((resolve) => {
      const child = execFile("node", [DIST_HOOK, ...args], (err, stdout) => resolve({ stdout, code: err ? (err as any).code ?? 1 : 0 }));
      child.stdin!.end(JSON.stringify(input));
    });

  it.skipIf(!existsSync(DIST_HOOK))("상태 파일이 없으면 tool.before는 거부(fail-closed), 나머지는 허용(fail-open)", async () => {
    const args = ["claude-code", "--repo", repo, "--epic", "NO-SUCH-EPIC"];
    const pre = await cli(raw("PreToolUse", tool("Read", { file_path: path.join(wt, "app.txt") })), args);
    expect(pre.code).toBe(0);
    expect(JSON.parse(pre.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecisionReason).toContain("Flightdeck 훅 오류");
    const post = await cli(raw("PostToolUse", tool("Read", { file_path: "x" })), args);
    expect(post).toEqual({ stdout: "", code: 0 });
    expect(await readFile(path.join(dataDir, "hook", "NO-SUCH-EPIC", "hook-log.jsonl"), "utf8")).toContain('"kind":"error"');
  });

  it.skipIf(!existsSync(DIST_HOOK))("정상 경로: 묶은 CLI가 SessionStart 컨텍스트를 낸다", async () => {
    const out = await cli(raw("SessionStart", { source: "startup", session_id: "cli-session" }), ["claude-code", "--repo", repo, "--epic", EPIC]);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain("[Flightdeck] 에픽 CU-1");
  });
});

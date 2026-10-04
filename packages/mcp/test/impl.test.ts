// 구현 단계의 훅·MCP (M4-2): Step이 붙은 편집 기록, trace, impl-log 직접 쓰기 차단, flightdeck_log_step,
// flightdeck_submit(설명 없는 변경), 실패한 셸 명령의 편집, 세션 원본 저장·검색(비밀값 가림)
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nowIso, parseImplLog, sha256, ulid } from "@flightdeck/core";
import { git, GitEngine, LocalEventStore, RunStore } from "@flightdeck/git";
import { appendEditRecords, appendMemo, computeCoverage, handle, readEditLog, readState, recordDrift, writeState, type ImplContext } from "@flightdeck/hook";
import { ClaudeCodeAdapter } from "../../agent/src/index.ts";
import { handleRpc } from "../src/index.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const adapter = new ClaudeCodeAdapter();
const EPIC = "CU-4";
const SESSION = "aaaaaaaa-2222-3333-4444-555555555555";
let root: string, repo: string, wt: string, dataDir: string, statePath: string, configDir: string, base: string;

const raw = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ session_id: SESSION, transcript_path: path.join(root, "transcript.jsonl"), cwd: wt, prompt_id: "p-1", hook_event_name, ...extra });
let n = 0;
const tool = (name: string, input: Record<string, unknown>) => ({ tool_name: name, tool_input: input, tool_use_id: `toolu_${++n}` });
async function fire(name: string, extra: Record<string, unknown> = {}) {
  const ev = adapter.parseHookEvent(raw(name, extra));
  return handle(ev, { adapter, dataDir, state: await readState(dataDir, EPIC) });
}
async function runTool(name: string, input: Record<string, unknown>, act: () => Promise<void>, after = "PostToolUse") {
  const t = tool(name, input);
  const before = await fire("PreToolUse", t);
  if (before.kind === "deny") return before;
  await act();
  await fire(after, { ...t, tool_response: {} });
  return before;
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { statePath })) as { result: { content: { text: string }[]; isError?: boolean } };
  return r.result;
};
const implCtx = async (): Promise<ImplContext> => ({ state: await readState(dataDir, EPIC), dataDir, baseSha: base, coverageIgnore: [] });
const STEP = { title: "토큰 회전", design_ref: "design.md#p:a91c", intent: "회전 구현", decision: "Set 사용", alternatives: "없음", review_points: "a.js:2", verification: "node --test  # ok" };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-impl-test-"));
  repo = path.join(root, "product");
  await mkdir(repo);
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@e.com"]]) await git(a, { cwd: repo });
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/a.js"), "export const a = 1;\nexport const b = 2;\n");
  await git(["add", "."], { cwd: repo });
  await git(["commit", "-q", "-m", "init"], { cwd: repo });
  // 리뷰어가 없는 파이프라인: 리뷰 요청만으로 IMPLEMENTATION
  configDir = path.join(root, "config");
  await mkdir(path.join(configDir, "rules"), { recursive: true });
  await writeFile(path.join(configDir, "pipeline.yaml"), (await readFile(path.join(SAMPLE, "pipeline.yaml"), "utf8")).replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups: {}\n"));
  const eng = new GitEngine(repo);
  base = await eng.revParse("HEAD");
  wt = (await eng.createEpicWorktree(EPIC)).path;
  dataDir = await eng.dataDir();
  await mkdir(path.join(wt, ".flightdeck/epics", EPIC), { recursive: true });
  await writeFile(path.join(wt, ".flightdeck/epics", EPIC, "design.md"), "<!-- p:a91c -->\n## 개요\n회전\n");
  const store = new LocalEventStore(repo);
  const ev = (type: string, data: unknown) => store.append({ v: 1, id: ulid(), type, epic: EPIC, author: "dh.lee", at: nowIso(), data } as never);
  await ev("epic.started", { tracker_ref: EPIC, owner: "dh.lee", base_sha: base, config_version: "v1" });
  await ev("phase.completed", { phase: "ANALYSIS" });
  await ev("review.requested", { phase: "DESIGN", artifact_hash: "sha256:x", commit: base });
  await writeState(dataDir, { epic: EPIC, repo, worktree: wt, member: "dh.lee", role: "owner", phase: "IMPLEMENTATION", configDir, trust: { mode: "dev" }, runs: {} });
  statePath = path.join(dataDir, "state", `${EPIC}.json`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("구현 단계 훅·MCP (M4-2)", { timeout: 30_000 }, () => {
  it("에이전트 편집에 열린 Step(1)이 붙고 trace에 남는다. impl-log 직접 쓰기는 막는다", async () => {
    expect((await call("flightdeck_get_epic")).content[0]!.text).toContain('"phase": "IMPLEMENTATION"');
    await fire("SessionStart", { source: "startup" });
    const f = path.join(wt, "src/a.js");
    await runTool("Edit", { file_path: f }, async () => writeFile(f, "export const a = 1;\nexport const b = 3;\n"));
    const log = await readEditLog(dataDir, EPIC);
    expect(log.at(-1)).toMatchObject({ file: "src/a.js", source: { kind: "agent", step: 1 } });
    const trace = (await readFile(path.join(wt, ".flightdeck/epics", EPIC, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(trace).toEqual([expect.objectContaining({ tool: "Edit", file: "src/a.js", range: [2, 2], step: 1 })]);
    const denied = await runTool("Write", { file_path: path.join(wt, ".flightdeck/epics", EPIC, "impl-log.md") }, async () => {});
    expect(denied).toMatchObject({ kind: "deny", reason: expect.stringContaining("flightdeck_log_step") });
  });

  it("flightdeck_log_step: 체크포인트 → Step 작성(changes 자동), 다음 편집은 Step 2", async () => {
    const r = await call("flightdeck_log_step", STEP);
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain("Step 1 기록함");
    const md = await readFile(path.join(wt, ".flightdeck/epics", EPIC, "impl-log.md"), "utf8");
    const [s1] = parseImplLog(md).steps;
    expect(s1).toMatchObject({ n: 1, changes: ["src/a.js:2"], intent: "회전 구현" });
    const ckpts = await new GitEngine(repo).listCheckpoints(EPIC, "dh.lee");
    expect(ckpts[0]).toMatchObject({ sha: s1!.ckpt, trailers: { "Flightdeck-Step": "1" } });
    expect((await readState(dataDir, EPIC)).impl_step).toBe(1);
    expect((await readEditLog(dataDir, EPIC)).at(-1)!.source).toEqual({ kind: "flightdeck", member: "dh.lee", reason: "impl_log" });
    expect((await call("flightdeck_submit")).content[0]!.text).toMatch(/^통과\. coverage 100%/);
  });

  it("flightdeck_submit: 기록 안 한 Step·실패한 셸 명령의 편집·사람 수정·외부 변경을 잡는다", async () => {
    const f = path.join(wt, "src/a.js");
    await runTool("Edit", { file_path: f }, async () => writeFile(f, (await readFile(f, "utf8")) + "export const c = 4;\n"));
    // 실패한 Bash(PostToolUseFailure)가 바꾼 파일도 기록된다 (X9)
    await runTool("Bash", { command: "node gen.js" }, async () => writeFile(path.join(wt, "src/gen.js"), "// generated\n"), "PostToolUseFailure");
    expect((await readEditLog(dataDir, EPIC)).at(-1)).toMatchObject({ file: "src/gen.js", source: { kind: "agent_shell", step: 2, cmd: "node gen.js" } });
    // 사람 편집 (확장이 기록) + 외부 변경 (아무도 기록 안 함)
    const before = await readFile(f, "utf8");
    const after = before.replace("export const a = 1;", "export const a = 10;");
    await appendEditRecords(dataDir, EPIC, [{ epic: EPIC, file: "src/a.js", base_hash: sha256(before), range: [0, before.indexOf("\n")], insert: "export const a = 10;", source: { kind: "human", member: "dh.lee" }, ts: nowIso() }]);
    await writeFile(f, after);
    await writeFile(path.join(wt, "README.md"), "외부\n");
    const text = (await call("flightdeck_submit")).content[0]!.text;
    expect(text).toContain("통과하지 못함");
    expect(text).toContain("Flightdeck 밖에서 바뀜): README.md");
    expect(text).toContain("기록되지 않은 Step 2의 에이전트 편집");
    expect(text).toContain("메모 없는 직접 수정 (@dh.lee)");

    // 외부 변경을 기록하면 메모가 필요한 묶음이 된다. 메모를 달고 Step 2를 기록하면 통과
    expect(await recordDrift(await implCtx())).toEqual(["README.md"]);
    const cov = await computeCoverage(await implCtx());
    expect(cov.drift).toEqual([]);
    expect(cov.groups.map((g) => [g.file, g.kind])).toEqual([["README.md", "external"], ["src/a.js", "agent"], ["src/a.js", "human"], ["src/gen.js", "agent"]]);
    for (const g of cov.groups.filter((x) => x.kind !== "agent")) await appendMemo(dataDir, { epic: EPIC, file: g.file, seqs: g.seqs, memo: "메모", member: "dh.lee", at: nowIso() });
    expect((await call("flightdeck_log_step", { ...STEP, title: "c 추가" })).content[0]!.text).toContain("Step 2 기록함");
    expect((await call("flightdeck_submit")).content[0]!.text).toMatch(/^통과\./);
  });

  it("턴 종료: 세션 원본을 필터·비밀값 가림·압축해 runs ref에 저장하고, flightdeck_search_run으로 찾는다", async () => {
    process.env.FD_TEST_TOKEN = "supersecretvalue123";
    await writeFile(path.join(wt, ".env"), "DB_PASSWORD=hunter2hunter2\n");
    const lines = [
      { type: "system", content: "시스템 프롬프트 (버림)" },
      { type: "user", timestamp: "2026-10-04T10:00:00Z", message: { role: "user", content: "토큰 회전을 구현해 줘. 토큰은 supersecretvalue123" } },
      { type: "assistant", timestamp: "2026-10-04T10:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "Redis 대신 Set을 쓴 이유: 재사용 탐지가 단순해서. 비번 hunter2hunter2" }] } },
    ];
    await writeFile(path.join(root, "transcript.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await fire("Stop", { stop_hook_active: false });
    const runId = (await readState(dataDir, EPIC)).runs[SESSION]!.run_id;
    const files = await new RunStore(repo).files(EPIC);
    expect(files).toEqual([`${runId}/${SESSION}.jsonl.gz`]);
    const stored = gunzipSync(await new RunStore(repo).get(EPIC, files[0]!)).toString("utf8");
    expect(stored).not.toContain("시스템 프롬프트");
    expect(stored).not.toContain("supersecretvalue123");
    expect(stored).not.toContain("hunter2hunter2");
    expect(stored.match(/\[REDACTED\]/g)).toHaveLength(2);
    const hit = (await call("flightdeck_search_run", { query: "왜 Redis 안 썼나" })).content[0]!.text;
    expect(hit).toContain(`### 실행 ${runId}`);
    expect(hit).toContain("재사용 탐지가 단순해서");
    // 같은 내용으로 다시 저장해도 커밋이 늘지 않는다
    const head = await new RunStore(repo).head(EPIC);
    await fire("Stop", { stop_hook_active: false });
    expect(await new RunStore(repo).head(EPIC)).toBe(head);
    delete process.env.FD_TEST_TOKEN;
    expect(existsSync(path.join(wt, ".env"))).toBe(true);
  });
});

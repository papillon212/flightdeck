import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { listThreadBlocks, parseBlocks, replay } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { readEditLog, readState } from "@flightdeck/hook";
import { EpicWorkflow } from "../src/workflow.ts";

const CONFIG = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
let root: string, repo: string, wf: EpicWorkflow, wt: string;
const EPIC = "CU-7";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-wf-test-"));
  repo = path.join(root, "product");
  await mkdir(repo);
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@e.com"]]) await git(a, { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# product\n");
  await git(["add", "."], { cwd: repo });
  await git(["commit", "-q", "-m", "init"], { cwd: repo });
  wf = new EpicWorkflow({ repo, member: "dh.lee", configDir: CONFIG, distDir: DIST, adapter: new ClaudeCodeAdapter() });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const analysisPath = () => path.join(wt, ".flightdeck/epics", EPIC, "analysis.md");

describe("EpicWorkflow (설계 §9.1, §4)", () => {
  it("start: 작업 폴더·epic.md 커밋·epic.started·로컬 상태·훅/MCP 설정", async () => {
    const r = await wf.start(EPIC, "토큰 갱신 개선", "리프레시 토큰을 회전시킨다.");
    wt = r.worktree;
    expect(r.state.phase).toBe("ANALYSIS");
    expect(await readFile(path.join(wt, ".flightdeck/epics", EPIC, "epic.md"), "utf8")).toContain("# CU-7 · 토큰 갱신 개선");
    expect(await git(["log", "-1", "--format=%s", "flightdeck/CU-7"], { cwd: repo })).toContain("에픽 시작");
    const settings = JSON.parse(await readFile(path.join(wt, ".claude/settings.local.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(`flightdeck-hook.mjs" claude-code --repo "${repo}" --epic "CU-7"`);
    expect(settings.enabledMcpjsonServers).toEqual(["flightdeck"]);
    expect(settings.permissions.allow).toContain("mcp__flightdeck");
    expect(JSON.parse(await readFile(path.join(wt, ".mcp.json"), "utf8")).mcpServers.flightdeck.args).toContain("CU-7");
    expect((await git(["status", "--porcelain"], { cwd: wt })).trim()).toBe("");
    // 두 번 시작해도 이벤트가 겹치지 않는다
    await wf.start(EPIC, "토큰 갱신 개선", "x");
    expect((await wf.store.list(EPIC)).filter((e) => e.type === "epic.started")).toHaveLength(1);
  });

  it("에이전트가 쓴 초안에 문단 ID를 붙이고, 쓰레드를 그 문단 아래 그린다. 렌더링도 편집 기록에 남는다 (T4)", async () => {
    const draft = "## 요구사항 요약\n리프레시 토큰을 회전시킨다.\n\n## 영향 범위\nsrc/auth\n\n## 불명확한 점\n- TTL이 몇 분인가?\n- 재사용 탐지 시 모든 세션을 끊는가?\n\n## 가정\n30분으로 가정\n";
    await writeFile(analysisPath(), draft);
    expect(await wf.renderDocs(EPIC)).toEqual(["analysis.md"]);
    const doc = await readFile(analysisPath(), "utf8");
    const rel = `.flightdeck/epics/${EPIC}/analysis.md`;
    const log = (await readEditLog(await wf.eng.dataDir(), EPIC)).filter((r) => r.file === rel);
    expect(log.every((r) => r.source.kind === "flightdeck" && r.source.reason === "paragraph_ids")).toBe(true);
    const r = replay(new Map([[rel, draft]]), log);
    expect(r.mismatches).toEqual([]);
    expect(r.files.get(rel)).toBe(doc);
    // 목록 항목마다 따로 쓰레드를 달 수 있다
    const items = parseBlocks(doc.split("\n")).filter((b) => b.text.startsWith("- "));
    expect(items).toHaveLength(2);
    expect(new Set(items.map((b) => b.pid)).size).toBe(2);
    const ttl = parseBlocks(doc.split("\n")).find((b) => b.text === "- TTL이 몇 분인가?")!;
    expect(ttl.pid).toMatch(/^p:[0-9a-f]{4}$/);
    const thread = await wf.createThread(EPIC, { file: "analysis.md", pid: ttl.pid!, kind: "question", to: ["park"], body: "TTL은 요구사항상 몇 분인가요?" });
    const rendered = await readFile(analysisPath(), "utf8");
    expect(listThreadBlocks(rendered)).toEqual([expect.objectContaining({ id: thread, status: "open", anchor: ttl.pid })]);
    expect(rendered.indexOf("TTL은 요구사항상")).toBeGreaterThan(rendered.indexOf("TTL이 몇 분인가?"));
    expect(rendered.indexOf("TTL은 요구사항상")).toBeLessThan(rendered.indexOf("재사용 탐지 시")); // 해당 항목 바로 아래
    expect(await wf.renderDocs(EPIC)).toEqual([]); // 멱등
    const all = (await readEditLog(await wf.eng.dataDir(), EPIC)).filter((x) => x.file === rel);
    expect(replay(new Map([[rel, draft]]), all).files.get(rel)).toBe(rendered);
    expect(all.at(-1)!.source).toMatchObject({ kind: "flightdeck", reason: "thread_render" });
  });

  it("권한 없는 동작은 이벤트를 쓰기 전에 막고 이유를 알린다 (메타 브랜치는 append-only)", async () => {
    const other = new EpicWorkflow({ ...wf.cfg, member: "choi" });
    const before = (await wf.store.list(EPIC)).length;
    const [t] = [...(await wf.epicState(EPIC)).threads.keys()];
    await expect(other.setThreadStatus(EPIC, t!, true)).rejects.toThrow(/thread.resolved 거부: resolve\/reopen 권한 없음 \(나: choi\)/);
    await new Promise((r) => setTimeout(r, 1100)); // 쓰레드 ID 충돌(T1)을 피해 권한 검사만 본다
    await expect(other.createThread(EPIC, { file: "analysis.md", pid: "p:0000", kind: "note", to: [], body: "x" })).rejects.toThrow(/쓰레드 생성 권한 없음/);
    expect((await wf.store.list(EPIC)).length).toBe(before);
  });

  it("설계 제안 T1 증거: 1초 안에 쓰레드 두 개를 만들면 ID가 겹친다 (쓰기 전에 막힘)", async () => {
    const before = (await wf.store.list(EPIC)).length;
    const pid = parseBlocks((await readFile(analysisPath(), "utf8")).split("\n")).find((b) => b.pid)!.pid!;
    const a = await wf.createThread(EPIC, { file: "analysis.md", pid, kind: "note", to: [], body: "첫째" });
    await expect(wf.createThread(EPIC, { file: "analysis.md", pid, kind: "note", to: [], body: "둘째" })).rejects.toThrow(/이미 있는 쓰레드 ID/);
    expect((await wf.store.list(EPIC)).length).toBe(before + 1);
    await wf.setThreadStatus(EPIC, a, true); // 다음 테스트(관문)에 영향이 없도록
  });

  it("관문: 열린 쓰레드·빈 섹션이 있으면 완료 불가 (§4.1)", async () => {
    const r = await wf.completePhase(EPIC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join("\n")).toMatch(/열린 쓰레드 1개/);
  });

  it("답을 받고 해결하면 DESIGN으로. 산출물이 에픽 브랜치에 커밋되고 훅이 읽는 단계도 바뀐다", async () => {
    const [t] = [...(await wf.epicState(EPIC)).threads.keys()];
    await wf.reply(EPIC, t!, "30분, 슬라이딩 갱신입니다.", { author: "park" });
    await wf.setThreadStatus(EPIC, t!, true);
    expect(await readFile(analysisPath(), "utf8")).toContain("status=resolved");
    const r = await wf.completePhase(EPIC);
    expect(r).toMatchObject({ ok: true, phase: "DESIGN" });
    expect(await git(["show", "--name-only", "--format=%s", "flightdeck/CU-7"], { cwd: repo })).toContain(`.flightdeck/epics/${EPIC}/analysis.md`);
    expect((await readState(await wf.eng.dataDir(), EPIC)).phase).toBe("DESIGN");
    expect(existsSync(path.join(wt, ".flightdeck/epics", EPIC, "design.md"))).toBe(false);
  });

  it("DESIGN 산출물 형식 검사", async () => {
    await writeFile(path.join(wt, ".flightdeck/epics", EPIC, "design.md"), "## 개요\n회전\n");
    const c = await wf.checkPhase(EPIC);
    expect(c.problems.join("\n")).toContain("빠진 섹션: 변경 컴포넌트, 인터페이스, 데이터 변경, 테스트 계획, 리스크");
  });
});

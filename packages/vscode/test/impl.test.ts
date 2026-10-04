// M4 완료 기준 "설명 없는 hunk 차단"을 workflow 수준에서 돌린다 (m4-plan).
// 서버(메모리) + 로컬 bare 원격 + 클론 2개: 담당자 dh.lee, 질문 대상 park(세션 원본 검색).
// 에이전트 편집은 훅이 하는 일(디스크 쓰기 + Step이 붙은 편집 기록)을 직접 한다. 훅 자체는 mcp/test/impl.test.ts에서 본다
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { diffRecords, generateServerKey, keyFingerprint, nowIso, parseImplLog } from "@flightdeck/core";
import { git, RunStore } from "@flightdeck/git";
import { appendEditRecords, logStep, readState, saveTranscript, searchRuns } from "@flightdeck/hook";
import type { EditSource } from "@flightdeck/schema";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-88impl";
let root: string, remote: string, srv: Server, url: string;
let A: EpicWorkflow, P: EpicWorkflow;
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAA";

async function member(id: string): Promise<EpicWorkflow> {
  const repo = path.join(root, id);
  await git(["clone", "-q", remote, repo], { cwd: root });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@e.com`]]) await git(["config", k!, v!], { cwd: repo });
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const config = await server.config("sample");
  const configDir = await cacheConfig(path.join(repo, ".git", "flightdeck"), config);
  return new EpicWorkflow({ repo, member: id, configDir, distDir: DIST, adapter: new ClaudeCodeAdapter(), remote: { server, product: "sample", config } });
}

const ANALYSIS = "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/token.js\n\n## 불명확한 점\n- 없음\n\n## 가정\n30분\n";
const DESIGN = "## 개요\n리프레시 토큰을 회전시킨다.\n\n## 변경 컴포넌트\nsrc/token.js\n\n## 인터페이스\nrotate(token)\n\n## 데이터 변경\n없음\n\n## 테스트 계획\ncheck.js\n\n## 리스크\n재사용 탐지\n";
const wtFile = async (rel: string) => path.join(await A.worktree(EPIC), rel);
const epicFile = async (name: string) => wtFile(`.flightdeck/epics/${EPIC}/${name}`);

/** 훅이 하는 일: 디스크에 쓰고 그 변경을 출처와 함께 기록 */
async function edit(rel: string, after: string, source: EditSource) {
  const f = await wtFile(rel);
  const before = existsSync(f) ? await readFile(f, "utf8") : null;
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, after);
  await appendEditRecords(await A.eng.dataDir(), EPIC, diffRecords(EPIC, rel, before, after, source, nowIso()));
}
const agent = async (rel: string, after: string) => {
  const st = await readState(await A.eng.dataDir(), EPIC);
  return edit(rel, after, { kind: "agent", member: "dh.lee", adapter: "claude-code", run: RUN, step: st.impl_step + 1 });
};
const step = async (title: string, pid: string) =>
  logStep(await A.implContext(EPIC), { title, design_ref: `design.md#${pid}`, intent: `${title} 구현`, decision: "단순하게", alternatives: "없음", review_points: "없음", verification: "node check.js  # ok" }, RUN);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-impl-wf-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  // 구현 관문 명령: src/token.js에 BUG가 있으면 실패
  await writeFile(path.join(seed, "check.js"), "const fs = require('fs');\nconst t = fs.existsSync('src/token.js') ? fs.readFileSync('src/token.js', 'utf8') : '';\nif (t.includes('BUG')) { console.log('FAIL: BUG'); process.exit(1); }\nconsole.log('ok 1 passed');\n");
  await git(["add", "."], { cwd: seed });
  await git(["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "init"], { cwd: seed });
  await git(["push", "-q", remote, "main"], { cwd: seed });

  const store = new MemoryStore();
  for (const id of ["dh.lee", "park"]) await store.upsertMember({ id, email: `${id}@e.com`, active: true, admin: id === "dh.lee" }, "test");
  const p = await readProductDir(SAMPLE, remote);
  // 리뷰어 없는 티어만 (설계 리뷰는 M3에서 봤다): 리뷰 요청만으로 IMPLEMENTATION. 관문 명령은 check.js
  p.pipeline_yaml = p.pipeline_yaml.replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups: {}\n").replace("commands: [pnpm lint, pnpm test]", "commands: [node check.js]");
  await store.addConfigVersion({ ...p, created_by: "test" });
  const app = createApp({ store, signer: new EventSigner({ store, dataDir: path.join(root, "server"), ...keys }), keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  [A, P] = [await member("dh.lee"), await member("park")];

  await A.start(EPIC, "토큰 회전", "리프레시 토큰을 회전시킨다.");
  await writeFile(await epicFile("analysis.md"), ANALYSIS);
  expect(await A.completePhase(EPIC)).toMatchObject({ ok: true, phase: "DESIGN" });
  await writeFile(await epicFile("design.md"), DESIGN);
  expect(await A.requestReview(EPIC)).toMatchObject({ ok: true, state: { phase: "IMPLEMENTATION" } });
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

let pidRotate: string;

describe("구현·기록 (M4 완료 기준)", { timeout: 60_000 }, () => {
  it("Step 1: 에이전트 편집 → log_step → 관문 검사 통과(명령 전)", async () => {
    const design = await readFile(await epicFile("design.md"), "utf8");
    pidRotate = /<!-- (p:[0-9a-f]{4}) -->\nrotate\(token\)/.exec(design)![1]!;
    await agent("src/token.js", "export function rotate(t) {\n  return t + 1;\n}\n");
    const st0 = await A.implementationStatus(EPIC);
    expect(st0.coverage.unexplained.map((h) => h.sources[0]!.why)).toEqual(["기록되지 않은 Step 1의 에이전트 편집"]);
    expect(st0.implLog[0]).toContain("impl-log.md가 없습니다");
    const r = await step("rotate", pidRotate);
    expect(r.step.changes).toEqual(["src/token.js:1-3"]);
    const st = await A.implementationStatus(EPIC);
    expect([st.coverage.unexplained, st.implLog, st.step]).toEqual([[], [], 1]);
  });

  it("체크포인트 복원: 잘못된 편집을 되돌리면 그 흔적이 coverage에 남지 않는다 (X8)", async () => {
    const ckpt = (await A.checkpoints(EPIC))[0]!; // Step 1 체크포인트
    await agent("src/token.js", "export function rotate(t) {\n  return WRONG;\n}\n");
    await agent("src/extra.js", "x\n");
    expect((await A.implementationStatus(EPIC)).coverage.unexplained.length).toBe(2);
    const r = await A.restore(EPIC, ckpt.sha);
    expect(r.files.sort()).toEqual(["src/extra.js", "src/token.js"]);
    expect(await readFile(await wtFile("src/token.js"), "utf8")).toContain("t + 1");
    expect(existsSync(await wtFile("src/extra.js"))).toBe(false);
    expect(parseImplLog(await readFile(await epicFile("impl-log.md"), "utf8")).steps.map((s) => s.n)).toEqual([1]); // 기록은 그대로
    const st = await A.implementationStatus(EPIC);
    expect([st.coverage.unexplained, st.drift]).toEqual([[], []]);
    expect((await A.checkpoints(EPIC))[0]!.trailers["Flightdeck-Source"]).toBe("restore");
  });

  it("사람 직접 수정·외부 변경·기록 안 한 Step이 있으면 제출이 막힌다", async () => {
    await agent("src/token.js", "export function rotate(t) {\n  return t + 1; // BUG\n}\n"); // Step 2, 기록 안 함
    const f = await wtFile("src/token.js");
    await edit("src/token.js", (await readFile(f, "utf8")).replace("export function", "/** 회전 */\nexport function"), { kind: "human", member: "dh.lee" });
    await writeFile(await wtFile("README.md"), "# product\n외부 도구로 고침\n"); // 기록 없음
    const r = await A.submitImplementation(EPIC);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^coverage \d+% < 100%$/),
        expect.stringContaining("README.md:2 — 메모 없는 외부 변경"),
        expect.stringContaining("메모 없는 직접 수정 (@dh.lee)"),
        expect.stringContaining("기록되지 않은 Step 2의 에이전트 편집"),
      ]),
    );
    // 아무것도 커밋하지 않았다
    expect((await git(["log", "-1", "--format=%s", "HEAD"], { cwd: await A.worktree(EPIC) })).trim()).not.toContain("구현 제출");
  });

  it("메모를 달고 Step 2를 기록하면 통과. 명령이 실패하면 보고는 남고 단계는 그대로", async () => {
    const { coverage } = await A.implementationStatus(EPIC);
    const groups = coverage.groups.filter((g) => g.kind !== "agent");
    expect(groups.map((g) => [g.file, g.kind])).toEqual([["README.md", "external"], ["src/token.js", "human"]]);
    for (const g of groups) await A.addMemo(EPIC, g, g.kind === "human" ? "주석 추가" : "README 문구");
    await step("주석", pidRotate);
    const md = parseImplLog(await readFile(await epicFile("impl-log.md"), "utf8"));
    // 사람 수정은 Step 2 편집과 같은 hunk(1-4줄)지만, 묶음의 범위는 사람이 넣은 줄만이다 (X11)
    expect(md.memos.map((m) => [m.file, m.lines, m.memo])).toEqual([["README.md", "2", "README 문구"], ["src/token.js", "1", "주석 추가"]]);
    const out: string[] = [];
    const r = await A.submitImplementation(EPIC, { onOutput: (s) => out.push(s) });
    expect(r).toMatchObject({ ok: false, problems: [expect.stringContaining("명령 실패 (종료 코드 1): node check.js — FAIL: BUG")] });
    expect(out.join("")).toContain("$ node check.js");
    const s = await A.epicState(EPIC);
    expect(s.phase).toBe("IMPLEMENTATION");
    expect([...s.gates.values()].map((g) => g.ok)).toEqual([false]);
  });

  it("서버: 원격 에픽 브랜치에 없는 커밋의 보고, 통과 보고가 없는 커밋의 완료는 거부", async () => {
    const server = A.cfg.remote!.server;
    await expect(server.requestEvent("sample", EPIC, "gate.reported", { commit: "f".repeat(40), commands: [] })).rejects.toThrow(/원격 에픽 브랜치에 없음/);
    await expect(server.requestEvent("sample", EPIC, "phase.completed", { phase: "IMPLEMENTATION" })).rejects.toThrow(/실패한 명령/);
    await expect(P.cfg.remote!.server.requestEvent("sample", EPIC, "gate.reported", { commit: (await A.epicState(EPIC)).gates.keys().next().value, commands: [] })).rejects.toThrow(/담당자만/);
  });

  it("고쳐서 다시 제출 → 서버 서명 gate.reported·phase.completed → VERIFICATION", async () => {
    await agent("src/token.js", (await readFile(await wtFile("src/token.js"), "utf8")).replace(" // BUG", ""));
    await step("BUG 제거", pidRotate);
    const r = await A.submitImplementation(EPIC);
    // 이 설정은 검증 티어에도 리뷰어가 없어 건너뛴다 → 바로 반영 대기 (M5)
    expect(r).toMatchObject({ ok: true, phase: "LANDING" });
    const events = (await A.store.list(EPIC)).filter((e) => e.type === "gate.reported" || e.type === "phase.completed");
    expect(events.map((e) => [e.type, !!e.sig, (e.data as { phase?: string }).phase ?? ""])).toEqual([
      ["phase.completed", true, "ANALYSIS"],
      ["gate.reported", true, ""],
      ["gate.reported", true, ""],
      ["phase.completed", true, "IMPLEMENTATION"],
    ]);
    const done = events.at(-1)!.data as { commit: string; artifact_hash: string };
    expect(done.artifact_hash).toMatch(/^tree:[0-9a-f]{40}$/);
    // 원격 에픽 브랜치에 코드·impl-log·trace가 올라갔고 비밀 파일은 없다
    const files = (await git(["ls-tree", "-r", "--name-only", done.commit], { cwd: A.cfg.repo })).split("\n");
    expect(files).toEqual(expect.arrayContaining(["src/token.js", `.flightdeck/epics/${EPIC}/impl-log.md`]));
    // 테스트 로그는 세션 원본 ref에
    expect((await new RunStore(A.cfg.repo).files(EPIC)).filter((f) => f.startsWith("gate/"))).toHaveLength(2);
  });

  it("세션 원본: 담당자가 저장한 것을 질문 대상(park)이 받아 검색한다", async () => {
    const tp = path.join(root, "t.jsonl");
    await writeFile(tp, JSON.stringify({ type: "assistant", timestamp: "2026-10-04T10:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "rotate는 t + 1로 단순화했다. 해시 체인은 과해서 버렸다." }] } }) + "\n");
    await saveTranscript(await readState(await A.eng.dataDir(), EPIC), RUN, "sess-1", tp, (x) => new ClaudeCodeAdapter().filterTranscriptItem(x));
    await git(["push", "-q", "origin", `${RunStore.ref(EPIC)}:${RunStore.ref(EPIC)}`], { cwd: A.cfg.repo });
    expect(await new RunStore(P.cfg.repo).fetch(EPIC)).toBe(true);
    const text = await searchRuns(P.cfg.repo, EPIC, "해시 체인을 왜 버렸나");
    expect(text).toContain("해시 체인은 과해서 버렸다");
  });
});

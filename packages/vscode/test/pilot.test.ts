// M8 완료 기준 "관찰자가 1초 안에 조종수 작업을 보고, 의견이 에이전트까지 전달됨"과 조종 넘기기를 workflow 수준에서 (m8-plan).
// 서버(메모리, 실시간 중계 포함) + 로컬 bare 원격 + 담당자 dh.lee(처음 조종수), 관찰자 park.
// 에이전트 편집은 훅이 하는 일을 직접 한다. 의견이 훅에서 에이전트 컨텍스트로 들어가는 것은 hook.test가 본다.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { diffRecords, generateServerKey, keyFingerprint, nowIso, writerOf } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { appendEditRecords, lastSeq, logStep, pendingOpinions, readEditLog, readState, updateState } from "@flightdeck/hook";
import { createApp, EventSigner, LiveHub, MemoryStore, readProductDir } from "@flightdeck/server";
import type { EditSource } from "@flightdeck/schema";
import { LiveConnection, LiveFollower, PilotStreamer, type LiveMessage } from "../src/live.ts";
import { cacheConfig, ServerClient, ServerRequestError } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-88pilot";
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAD";
let root: string, remote: string, srv: Server, url: string;
let A: EpicWorkflow, P: EpicWorkflow;
const adapter = new ClaudeCodeAdapter();

async function member(id: string): Promise<EpicWorkflow> {
  const repo = path.join(root, id);
  await git(["clone", "-q", remote, repo], { cwd: root });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@test.local`]]) await git(["config", k!, v!], { cwd: repo });
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const config = await server.config("sample");
  const configDir = await cacheConfig(path.join(repo, ".git", "flightdeck"), config);
  return new EpicWorkflow({ repo, member: id, configDir, distDir: DIST, adapter, remote: { server, product: "sample", config } });
}

const ANALYSIS = "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/token.js\n\n## 불명확한 점\n- 없음\n\n## 가정\n30분\n";
const DESIGN = "## 개요\n회전\n\n## 변경 컴포넌트\nsrc/token.js\n\n## 인터페이스\nrotate(t)\n\n## 데이터 변경\n없음\n\n## 테스트 계획\ncheck.js\n\n## 리스크\n없음\n";

/** 조종수 작업 폴더의 파일을 고치고 편집 기록을 남긴다 (훅·에디터가 하는 일) */
async function edit(w: EpicWorkflow, file: string, fn: (s: string) => string, source?: EditSource) {
  const wt = await w.worktree(EPIC);
  const f = path.join(wt, file);
  const before = await readFile(f, "utf8").catch(() => null);
  const after = fn(before ?? "");
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, after);
  const dataDir = await w.eng.dataDir();
  const st = await readState(dataDir, EPIC);
  const src = source ?? { kind: "agent", member: w.cfg.member, adapter: "claude-code", run: RUN, step: st.impl_step + 1 };
  await appendEditRecords(dataDir, EPIC, diffRecords(EPIC, file, before, after, src, nowIso()));
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-pilot-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "check.js"), "const { rotate } = require('./src/token.js');\nif (rotate(1) !== 2) process.exit(1);\nconsole.log('ok');\n");
  for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@test.local", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) await git(a, { cwd: seed });
  const store = new MemoryStore();
  for (const id of ["dh.lee", "park"]) await store.upsertMember({ id, email: `${id}@test.local`, active: true, admin: id === "dh.lee" }, "test");
  const p = await readProductDir(SAMPLE, remote);
  // 설계 리뷰어 없음(바로 통과), 검증 lead = dh.lee (park이 조종하는 동안 검증 리뷰가 멈춰 있게)
  p.pipeline_yaml = p.pipeline_yaml
    .replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups:\n    verifiers: [dh.lee]\n")
    .replace("commands: [pnpm lint, pnpm test]", "commands: [node check.js]")
    .replace(/(verification:[\s\S]*?- \{ name: lead, reviewers: \{ group: )leads/, "$1verifiers");
  await store.addConfigVersion({ ...p, created_by: "test" });
  const signer = new EventSigner({ store, dataDir: path.join(root, "server"), ...keys });
  const app = createApp({ store, signer, keys, devLogin: true, live: new LiveHub() });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  [A, P] = [await member("dh.lee"), await member("park")];

  await A.start(EPIC, "토큰 회전", "리프레시 토큰을 회전시킨다.");
  const dir = path.join(await A.worktree(EPIC), ".flightdeck/epics", EPIC);
  await writeFile(path.join(dir, "analysis.md"), ANALYSIS);
  await A.completePhase(EPIC);
  await writeFile(path.join(dir, "design.md"), DESIGN);
  await A.requestReview(EPIC);
  await edit(A, "src/token.js", () => "function rotate(t) {\n  return t + 1;\n}\nmodule.exports = { rotate };\n");
  const pid = /<!-- (p:[0-9a-f]{4}) -->\nrotate\(t\)/.exec(await readFile(path.join(dir, "design.md"), "utf8"))![1]!;
  await logStep(await A.implContext(EPIC), { title: "rotate", design_ref: `design.md#${pid}`, intent: "회전", decision: "+1", alternatives: "없음", review_points: "없음", verification: "node check.js # ok" }, RUN);
  await A.eng.pushCheckpoint(EPIC, "dh.lee");
  await A.syncEditlog(EPIC);
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("조종수 모델 (M8 완료 기준)", { timeout: 90_000 }, () => {
  let live: { worktree: string; seq: number };
  const got: LiveMessage[] = [];
  let pConn: LiveConnection, aConn: LiveConnection, follower: LiveFollower, streamer: PilotStreamer;

  it("관찰 시작: 조종수의 체크포인트 + 서버 편집 기록으로 @live를 맞춘다 (L8)", async () => {
    await edit(A, "src/token.js", (s) => s + "// 체크포인트 뒤 편집\n"); // 체크포인트에 없고 서버 편집 기록에만
    await A.syncEditlog(EPIC);
    const o = await P.openLive(EPIC);
    live = { worktree: o.worktree, seq: o.seq };
    expect(o).toMatchObject({ pilot: "dh.lee", mismatch: null, seq: await lastSeq(await A.eng.dataDir(), EPIC) });
    expect(path.basename(o.worktree)).toBe(`${EPIC}@live`);
    expect(await readFile(path.join(o.worktree, "src/token.js"), "utf8")).toBe(await readFile(path.join(await A.worktree(EPIC), "src/token.js"), "utf8"));
  });

  it("실시간: 조종수의 편집이 1초 안에 관찰 창에 적용되고, 대화 블록도 온다 (L1·L6)", async () => {
    const r = P.cfg.remote!;
    follower = new LiveFollower({ dir: live.worktree, product: "sample", epic: EPIC, server: r.server, seq: live.seq });
    pConn = new LiveConnection(r.server, "sample", EPIC, (m) => {
      got.push(m);
      if (m.type === "edit") void follower.push(m.data.records);
    }).start();
    const dataDir = await A.eng.dataDir();
    // 세션 기록 파일 (훅이 SessionStart에서 경로를 적어 둔다)
    const transcript = path.join(root, "session.jsonl");
    await writeFile(transcript, "");
    await updateState(dataDir, EPIC, (st) => {
      st.runs["s-1"] = { run_id: RUN, context_phase: "IMPLEMENTATION", started_at: nowIso(), transcript };
    });
    streamer = await new PilotStreamer({ server: A.cfg.remote!.server, product: "sample", epic: EPIC, dataDir, filter: (i) => adapter.filterTranscriptItem(i), secrets: async () => [], intervalMs: 50 }).start();
    await until("관찰자 연결", async () => pConn.connected);
    for (let i = 0; i < 5; i++) {
      await edit(A, "src/token.js", (s) => s.replace("return t + 1;", `return t + 1; // ${i}`).replace(/ \/\/ \d(?= \/\/ \d)/, ""));
      await new Promise((res) => setTimeout(res, 100));
    }
    await appendFile(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "회전 테스트를 추가해 줘" }, timestamp: nowIso() }) + "\n");
    await appendFile(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "check.js에 경우를 더하겠습니다" }] }, timestamp: nowIso() }) + "\n");
    const want = await readFile(path.join(await A.worktree(EPIC), "src/token.js"), "utf8");
    await until("관찰 창 적용", async () => (await readFile(path.join(live.worktree, "src/token.js"), "utf8")) === want);
    expect(follower.seq).toBe(await lastSeq(dataDir, EPIC));
    expect(Math.max(...follower.latencies)).toBeLessThan(1000);
    const chat = await until("대화 블록", async () => got.find((m) => m.type === "chat"));
    expect(chat.data.blocks.map((b: { role: string; text: string }) => `${b.role}: ${b.text}`)).toEqual(["user: 회전 테스트를 추가해 줘", "assistant: check.js에 경우를 더하겠습니다"]);
  });

  it("조종수만 편집·대화를 보낸다", async () => {
    const e = await P.cfg.remote!.server.liveSend("sample", EPIC, "edit", { records: [] }).catch((x) => x as ServerRequestError);
    expect(e).toMatchObject({ status: 403 });
  });

  it("의견: 관찰자 → 조종수에게만 → 조종수가 전달하면 훅 대기열로, 관찰자에게 상태 (L7)", async () => {
    const aGot: LiveMessage[] = [];
    aConn = new LiveConnection(A.cfg.remote!.server, "sample", EPIC, (m) => aGot.push(m)).start();
    await until("조종수 연결", async () => aConn.connected);
    await P.cfg.remote!.server.liveSend("sample", EPIC, "opinion", { id: "op-1", body: "음수 입력도 확인해 주세요", target: "src/token.js:2" }, ["dh.lee"]);
    const op = await until("의견 도착", async () => aGot.find((m) => m.type === "opinion"));
    expect(op).toMatchObject({ from: "park", to: ["dh.lee"], data: { body: "음수 입력도 확인해 주세요" } });
    await A.deliverOpinion(EPIC, { id: op.data.id, from: op.from, body: op.data.body, urgent: false, at: nowIso(), target: op.data.target });
    expect((await pendingOpinions(await A.eng.dataDir(), EPIC)).map((o) => o.body)).toEqual(["음수 입력도 확인해 주세요"]);
    await A.cfg.remote!.server.liveSend("sample", EPIC, "opinion.status", { id: "op-1", status: "delivered" }, ["park"]);
    await until("상태 알림", async () => got.find((m) => m.type === "opinion.status"));
    await expect(P.deliverOpinion(EPIC, { id: "x", from: "park", body: "x", urgent: false, at: nowIso() })).rejects.toThrow(/조종수의 작업 폴더/);
  });

  it("조종 넘기기: 체크포인트·편집 기록을 올리고 pilot.changed → 새 조종수가 공유 안 된 작업까지 이어받아 제출한다 (L3·L4)", async () => {
    streamer.stop();
    // 이전 조종수가 테스트 로그(세션 원본 ref)를 이미 올렸다: 새 조종수의 첫 테스트 로그 push가 거절되면 안 된다
    await A.runGateCommands(EPIC, (await git(["rev-parse", "HEAD"], { cwd: await A.worktree(EPIC) })).trim());
    await edit(A, "src/token.js", (s) => s + "// 넘기기 직전, 공유 안 된 작업\n");
    const s = await A.handOff(EPIC, "park", "request");
    expect([writerOf(s), s.owner, await A.role(EPIC)]).toEqual(["park", "dh.lee", "viewer"]);
    const aFile = await readFile(path.join(await A.worktree(EPIC), "src/token.js"), "utf8");
    // 이전 조종수는 이제 편집 기록을 올릴 수 없다
    const up = await A.cfg.remote!.server.uploadEditlog("sample", { epic: EPIC, records: [], memos: [] }).catch((x) => x as ServerRequestError);
    expect(up).toMatchObject({ status: 403 });

    const r = await P.adoptPilot(EPIC);
    expect(r.worktree).toBe(P.eng.worktreePath(EPIC));
    expect(await readFile(path.join(r.worktree, "src/token.js"), "utf8")).toBe(aFile);
    expect(await P.role(EPIC)).toBe("owner");
    expect(await readEditLog(await P.eng.dataDir(), EPIC)).toEqual(await readEditLog(await A.eng.dataDir(), EPIC));
    // 새 조종수가 이어서: Step 2 기록 → 제출 → VERIFICATION (park은 검증 lead라 다음은 리뷰 차례)
    await edit(P, "src/token.js", (s2) => s2 + "// park의 Step 2\n");
    const dir = path.join(r.worktree, ".flightdeck/epics", EPIC);
    const pid = /<!-- (p:[0-9a-f]{4}) -->\nrotate\(t\)/.exec(await readFile(path.join(dir, "design.md"), "utf8"))![1]!;
    await logStep(await P.implContext(EPIC), { title: "마무리", design_ref: `design.md#${pid}`, intent: "정리", decision: "주석", alternatives: "없음", review_points: "없음", verification: "node check.js # ok" }, "01JB7AAAAAAAAAAAAAAAAAAAAE");
    const st = await P.implementationStatus(EPIC);
    for (const g of st.coverage.groups) await P.addMemo(EPIC, g, "조종 넘기기 전후의 정리 주석");
    expect(await P.submitImplementation(EPIC)).toMatchObject({ ok: true, phase: "VERIFICATION" });
    expect(P.warnings.filter((w) => w.includes("테스트 로그"))).toEqual([]);
    const commit = (await P.epicState(EPIC)).review.requested!.commit;
    expect((await git(["log", "-1", "--format=%an", commit], { cwd: P.cfg.repo })).trim()).toBe("park");
  });

  it("강제 인수: 담당자가 이탈한 조종수의 마지막 체크포인트·편집 기록에서 이어간다 (L5)", async () => {
    await edit(P, "src/token.js", (s) => s + "// park이 끊기기 전 마지막 편집\n");
    await P.checkpoint(EPIC, "끊기기 전");
    await P.syncEditlog(EPIC);
    const pFile = await readFile(path.join(await P.worktree(EPIC), "src/token.js"), "utf8");
    await expect(P.adoptPilot(EPIC, { takeover: true })).rejects.toThrow(/담당자만/);
    const r = await A.adoptPilot(EPIC, { takeover: true });
    expect(writerOf(r.state)).toBe("dh.lee");
    expect(r.state.pilotHistory.map((h) => `${h.from}→${h.to}:${h.reason}`)).toEqual(["dh.lee→park:request", "park→dh.lee:takeover"]);
    expect(await readFile(path.join(r.worktree, "src/token.js"), "utf8")).toBe(pFile);
    pConn.stop();
    aConn.stop();
  });
});

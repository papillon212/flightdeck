// M7 완료 기준 "모든 hunk의 출처가 조회되고, 쓰레드가 대규모 수정 후에도 위치 유지"를 workflow 수준에서 (m7-plan).
// 서버(메모리) + 로컬 bare 원격 + 담당자 dh.lee, 검증 lead park. 에이전트 편집은 훅이 하는 일을 직접 한다(M4·M5 테스트와 같음).
// 반영 서버의 coverage 재계산(E3)은 M5 검증 테스트(verify.test)의 반영이 거친다.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { diffRecords, generateServerKey, keyFingerprint, nowIso } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { appendEditRecords, lastSeq, logStep, readEditLog, readState } from "@flightdeck/hook";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import type { EditSource } from "@flightdeck/schema";
import { blameLabel } from "../src/blame-label.ts";
import { cacheConfig, ServerClient, ServerRequestError } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-77editlog";
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAC";
let root: string, remote: string, srv: Server, url: string;
let A: EpicWorkflow, P: EpicWorkflow;

async function member(id: string): Promise<EpicWorkflow> {
  const repo = path.join(root, id);
  await git(["clone", "-q", remote, repo], { cwd: root });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@test.local`]]) await git(["config", k!, v!], { cwd: repo });
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const config = await server.config("sample");
  const configDir = await cacheConfig(path.join(repo, ".git", "flightdeck"), config);
  return new EpicWorkflow({ repo, member: id, configDir, distDir: DIST, adapter: new ClaudeCodeAdapter(), remote: { server, product: "sample", config } });
}

const ANALYSIS = "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/token.js\n\n## 불명확한 점\n- 없음\n\n## 가정\n30분\n";
const DESIGN = "## 개요\n회전\n\n## 변경 컴포넌트\nsrc/token.js\n\n## 인터페이스\nrotate(t)\n\n## 데이터 변경\n없음\n\n## 테스트 계획\ncheck.js\n\n## 리스크\n없음\n";
const TOKEN = "function rotate(t) {\n  return t + 1;\n}\nmodule.exports = { rotate };\n";
const agent = (step: number): EditSource => ({ kind: "agent", member: "dh.lee", adapter: "claude-code", run: RUN, step });

/** 담당자 작업 폴더의 파일을 고치고 편집 기록을 남긴다 (훅·에디터가 하는 일) */
async function edit(file: string, fn: (s: string) => string, source: EditSource | "step") {
  const wt = await A.worktree(EPIC);
  const f = path.join(wt, file);
  const before = await readFile(f, "utf8").catch(() => null);
  const after = fn(before ?? "");
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, after);
  const dataDir = await A.eng.dataDir();
  const src = source === "step" ? agent((await readState(dataDir, EPIC)).impl_step + 1) : source;
  await appendEditRecords(dataDir, EPIC, diffRecords(EPIC, file, before, after, src, nowIso()));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-editlog-wf-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "check.js"), "const { rotate } = require('./src/token.js');\nif (rotate(1) !== 2) process.exit(1);\nconsole.log('ok');\n");
  for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@test.local", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) await git(a, { cwd: seed });
  const store = new MemoryStore();
  for (const id of ["dh.lee", "park", "choi"]) await store.upsertMember({ id, email: `${id}@test.local`, active: true, admin: id === "dh.lee" }, "test");
  const p = await readProductDir(SAMPLE, remote);
  p.pipeline_yaml = p.pipeline_yaml
    .replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups:\n    verifiers: [park]\n    qa: [choi]\n")
    .replace("commands: [pnpm lint, pnpm test]", "commands: [node check.js]")
    .replace(/(verification:[\s\S]*?- \{ name: lead, reviewers: \{ group: )leads/, "$1verifiers");
  await store.addConfigVersion({ ...p, created_by: "test" });
  const signer = new EventSigner({ store, dataDir: path.join(root, "server"), ...keys });
  const app = createApp({ store, signer, keys, devLogin: true });
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
  await edit("src/token.js", () => TOKEN, "step");
  const pid = /<!-- (p:[0-9a-f]{4}) -->\nrotate\(t\)/.exec(await readFile(path.join(dir, "design.md"), "utf8"))![1]!;
  await logStep(await A.implContext(EPIC), { title: "rotate", design_ref: `design.md#${pid}`, intent: "회전", decision: "+1", alternatives: "없음", review_points: "없음", verification: "node check.js # ok" }, RUN);
  await edit("src/token.js", (s) => s.replace("module.exports", "// 공개\nmodule.exports"), { kind: "human", member: "dh.lee" });
  const st = await A.implementationStatus(EPIC);
  for (const g of st.coverage.groups) await A.addMemo(EPIC, g, "공개 함수 표시");
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("편집 기록 서버 (M7 완료 기준)", { timeout: 90_000 }, () => {
  it("구현 제출: 커밋에 편집 기록 위치(Flightdeck-Seq), 서명 요청 전에 서버로 올라감 (E1·E3)", async () => {
    expect(await A.submitImplementation(EPIC)).toMatchObject({ ok: true, phase: "VERIFICATION" });
    const dataDir = await A.eng.dataDir();
    const local = await lastSeq(dataDir, EPIC);
    const msg = await git(["log", "-1", "--format=%B", (await A.epicState(EPIC)).review.requested!.commit], { cwd: A.cfg.repo });
    expect(msg).toContain(`Flightdeck-Seq: ${local}`);
    const server = await A.cfg.remote!.server.editlog("sample", EPIC);
    expect(server.last).toBe(local);
    expect(server.records).toEqual(await readEditLog(dataDir, EPIC));
    expect(server.memos.map((m) => m.memo)).toEqual(["공개 함수 표시"]);
  });

  it("편집 기록을 갖지 않은 리뷰어도 줄 단위 출처를 본다 (서버, E6)", async () => {
    await P.openAsViewer(EPIC);
    const b = await P.lineBlame(EPIC, "src/token.js");
    expect(b.via).toBe("server");
    expect(b.text).toBe(await readFile(path.join(await P.worktree(EPIC), "src/token.js"), "utf8"));
    expect(b.lines.map((l) => blameLabel(l).split(" · ")[0])).toEqual([
      "@dh.lee의 에이전트",
      "@dh.lee의 에이전트",
      "@dh.lee의 에이전트",
      "@dh.lee 직접 수정",
      "@dh.lee의 에이전트",
      "에픽 시작 때부터 있던 줄",
    ]);
    expect(blameLabel(b.lines[3])).toContain("메모: 공개 함수 표시");
    expect(blameLabel(b.lines[0])).toContain("Step 1");
    const own = await A.lineBlame(EPIC, "src/token.js");
    expect([own.via, own.lines.length]).toEqual(["local", 6]);
  });

  it("쓰레드 위치: 위에 30줄을 넣고 그 줄 자체를 고쳐도 편집 기록으로 따라간다 (E5)", async () => {
    const tid = await P.createCodeThread(EPIC, { file: "src/token.js", range: [2, 2], kind: "question", to: ["dh.lee"], body: "음수는?" });
    await A.pull();
    await edit("src/token.js", (s) => Array.from({ length: 30 }, (_, i) => `// 머리말 ${i}`).join("\n") + "\n" + s, { kind: "human", member: "dh.lee" });
    await edit("src/token.js", (s) => s.replace("return t + 1;", "return Math.max(0, t) + 1;"), { kind: "human", member: "dh.lee" });
    const [pos] = (await A.codeThreadPositions(EPIC)).filter((x) => x.thread.id === tid);
    expect(pos).toMatchObject({ via: "editlog", range: [32, 32], lost: false });
    const lines = (await readFile(path.join(await A.worktree(EPIC), "src/token.js"), "utf8")).split("\n");
    expect(lines[31]).toBe("  return Math.max(0, t) + 1;");
    // 같은 상황을 diff 줄 매핑(M5)으로 보면 위치를 잃는다
    const diff = await git(["diff", "-U0", "--no-color", (await A.epicState(EPIC)).review.requested!.commit, "--", "src/token.js"], { cwd: await A.worktree(EPIC) });
    const { mapLines } = await import("@flightdeck/core");
    expect(mapLines(diff, [2, 2]).lost).toBe(true);
  });

  it("작업 폴더의 Flightdeck 밖 변경을 잡아 기록한다 (E7)", async () => {
    const f = path.join(await A.worktree(EPIC), "src/token.js");
    await writeFile(f, (await readFile(f, "utf8")) + "// 터미널에서 덧붙임\n");
    expect(await A.recordExternal(EPIC)).toEqual(["src/token.js"]);
    expect((await readEditLog(await A.eng.dataDir(), EPIC)).at(-1)!.source).toEqual({ kind: "external" });
    expect(await A.recordExternal(EPIC)).toEqual([]); // 기록 뒤에는 재적용 = 디스크
  });

  it("편집 기록은 담당자만 올린다, seq가 어긋나면 서버의 마지막 위치를 알려 준다 (E4·E1)", async () => {
    const one = (await readEditLog(await A.eng.dataDir(), EPIC)).slice(-1);
    const e1 = await P.cfg.remote!.server.uploadEditlog("sample", { epic: EPIC, records: one }).catch((e) => e as ServerRequestError);
    expect(e1).toMatchObject({ status: 403 });
    const e2 = await A.cfg.remote!.server.uploadEditlog("sample", { epic: EPIC, records: [{ ...one[0]!, seq: 9999 }] }).catch((e) => e as ServerRequestError);
    expect(e2).toMatchObject({ status: 409, data: { last: expect.any(Number) } });
    expect(await A.syncEditlog(EPIC)).toBe(await lastSeq(await A.eng.dataDir(), EPIC));
  });
});

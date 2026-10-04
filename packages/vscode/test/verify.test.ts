// M5 완료 기준 "실제 에픽 1개가 서버를 통해 main까지"를 workflow 수준에서 돌린다 (m5-plan).
// 서버(메모리) + 로컬 bare 원격 + 클론 3개: 담당자 dh.lee, 검증 lead park, qa choi.
// 에이전트 편집은 훅이 하는 일을 직접 한다(M4 테스트와 같음).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { diffRecords, generateServerKey, keyFingerprint, nowIso, reviewOf } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { appendEditRecords, logStep, readState } from "@flightdeck/hook";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-99verify";
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAA";
let root: string, remote: string, seed: string, srv: Server, url: string, signer: EventSigner;
let A: EpicWorkflow, P: EpicWorkflow, C: EpicWorkflow;

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
const DESIGN = "## 개요\n회전\n\n## 변경 컴포넌트\nsrc/token.js\n\n## 인터페이스\nrotate(t)\n\n## 데이터 변경\n없음\n\n## 테스트 계획\ncheck.js\n\n## 리스크\n없음\n";
const TOKEN = "function rotate(t) {\n  return t + 1;\n}\nmodule.exports = { rotate };\n";
const epicFile = async (w: EpicWorkflow, name: string) => path.join(await w.worktree(EPIC), ".flightdeck/epics", EPIC, name);

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-verify-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  await writeFile(path.join(seed, "check.js"), "const { rotate } = require('./src/token.js');\nif (rotate(1) !== 2) { console.log('FAIL'); process.exit(1); }\nconsole.log('ok');\n");
  for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) await git(a, { cwd: seed });

  const store = new MemoryStore();
  for (const id of ["dh.lee", "park", "choi"]) await store.upsertMember({ id, email: `${id}@e.com`, active: true, admin: id === "dh.lee" }, "test");
  const p = await readProductDir(SAMPLE, remote);
  // 설계 리뷰어 없음(바로 통과), 검증: lead = park, qa = choi
  p.pipeline_yaml = p.pipeline_yaml
    .replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups:\n    verifiers: [park]\n    qa: [choi]\n")
    .replace("commands: [pnpm lint, pnpm test]", "commands: [node check.js]")
    .replace(/(verification:[\s\S]*?- \{ name: lead, reviewers: \{ group: )leads/, "$1verifiers");
  await store.addConfigVersion({ ...p, created_by: "test" });
  signer = new EventSigner({ store, dataDir: path.join(root, "server"), ...keys });
  const app = createApp({ store, signer, keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  [A, P, C] = [await member("dh.lee"), await member("park"), await member("choi")];

  // 구현까지: 분석 → 설계(리뷰어 없음) → 에이전트 Step 1 → 구현 제출
  await A.start(EPIC, "토큰 회전", "리프레시 토큰을 회전시킨다.");
  await writeFile(await epicFile(A, "analysis.md"), ANALYSIS);
  expect(await A.completePhase(EPIC)).toMatchObject({ ok: true, phase: "DESIGN" });
  await writeFile(await epicFile(A, "design.md"), DESIGN);
  expect(await A.requestReview(EPIC)).toMatchObject({ ok: true, state: { phase: "IMPLEMENTATION" } });
  const wt = await A.worktree(EPIC);
  await mkdir(path.join(wt, "src"), { recursive: true });
  await writeFile(path.join(wt, "src/token.js"), TOKEN);
  const st = await readState(await A.eng.dataDir(), EPIC);
  await appendEditRecords(await A.eng.dataDir(), EPIC, diffRecords(EPIC, "src/token.js", null, TOKEN, { kind: "agent", member: "dh.lee", adapter: "claude-code", run: RUN, step: st.impl_step + 1 }, nowIso()));
  const pid = /<!-- (p:[0-9a-f]{4}) -->\nrotate\(t\)/.exec(await readFile(await epicFile(A, "design.md"), "utf8"))![1]!;
  await logStep(await A.implContext(EPIC), { title: "rotate", design_ref: `design.md#${pid}`, intent: "회전", decision: "+1", alternatives: "없음", review_points: "없음", verification: "node check.js # ok" }, RUN);
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("검증·반영 (M5 완료 기준)", { timeout: 90_000 }, () => {
  it("구현 제출 → VERIFICATION 리뷰 요청까지 한 번에 (Y1)", async () => {
    const r = await A.submitImplementation(EPIC);
    expect(r).toMatchObject({ ok: true, phase: "VERIFICATION" });
    const s = await A.epicState(EPIC);
    expect(reviewOf(s)?.current?.name).toBe("lead");
    expect(s.review.requested?.hash).toMatch(/^tree:/);
    expect(await C.reviewInbox()).toEqual([]);
    expect((await P.reviewInbox()).map((i) => [i.tier, i.phase])).toEqual([["lead", "VERIFICATION"]]);
  });

  it("lead(park): 리뷰 사본에서 고쳐 수정 제안 → 사본은 되돌아가고 자기 쓰레드가 열려 있으면 승인 거부", async () => {
    const [item] = await P.reviewInbox();
    await P.openAsViewer(EPIC, item!.commit);
    expect(await P.role(EPIC)).toBe("review");
    const f = path.join(await P.worktree(EPIC), "src/token.js");
    await writeFile(f, (await readFile(f, "utf8")).replace("return t + 1;", "// 정수만 받는다\n  return t + 1;"));
    await writeFile(path.join(await P.worktree(EPIC), "src/new.js"), "// 새 파일도 제안에 들어간다\n");
    const tid = await P.suggestFix(EPIC, { file: "src/token.js", range: [2, 2], body: "입력 가정을 주석으로 남겨 주세요" });
    const t = (await P.epicState(EPIC)).threads.get(tid)!;
    expect(t).toMatchObject({ kind: "change_request", to: ["dh.lee"], anchor: { type: "code", file: "src/token.js", range: [2, 2], rev: item!.commit } });
    expect(t.patch).toContain("+  // 정수만 받는다");
    expect(t.patch).toContain("src/new.js");
    expect(await readFile(f, "utf8")).toBe(TOKEN); // 사본은 리뷰 커밋으로
    expect(existsSync(path.join(await P.worktree(EPIC), "src/new.js"))).toBe(false);
    await expect(P.approve(EPIC)).rejects.toThrow(/승인자가 연 열린 쓰레드 1개/);
  });

  it("담당자: 받은 수정 제안 → 반영(출처 patch, 설명 필요 없음) → 다시 요청하면 lead부터 다시", async () => {
    const [inbox] = await A.inbox();
    expect(inbox).toMatchObject({ mine: true, thread: { author: "park", kind: "change_request" } });
    const pos = await A.codeThreadPositions(EPIC);
    expect(pos.map((p) => [p.file, p.range, p.lost])).toEqual([["src/token.js", [2, 2], false]]);
    expect((await A.applyPatch(EPIC, inbox!.thread.id)).sort()).toEqual(["src/new.js", "src/token.js"]);
    expect(await readFile(path.join(await A.worktree(EPIC), "src/token.js"), "utf8")).toContain("// 정수만 받는다");
    const st = await A.implementationStatus(EPIC);
    expect([st.coverage.unexplained, st.drift]).toEqual([[], []]);
    expect((await A.codeThreadPositions(EPIC))[0]).toMatchObject({ range: [3, 3], lost: false }); // 위에 한 줄 들어옴
    await A.reply(EPIC, inbox!.thread.id, "반영했습니다.");
    const r = await A.requestVerification(EPIC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(reviewOf(r.state)?.current?.name).toBe("lead");
    expect((await A.epicState(EPIC)).threads.get(inbox!.thread.id)!.applied).toHaveLength(1);
  });

  it("lead 승인 → (그 사이 main이 움직임) qa 승인 → 서버가 병합 커밋을 올리고 재보고 대기(needs_report)", async () => {
    await P.openAsViewer(EPIC); // 새 리뷰 커밋으로
    const [t] = [...(await P.epicState(EPIC)).threads.values()];
    await P.setThreadStatus(EPIC, t!.id, true);
    expect(reviewOf(await P.approve(EPIC))?.current?.name).toBe("qa");
    // 다른 일이 main에 들어왔다 (Flightdeck 밖: 감사에 걸려야 한다)
    await writeFile(path.join(seed, "OTHER.md"), "다른 변경\n");
    for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "다른 변경"], ["push", "-q", "origin", "main"]]) await git(a, { cwd: seed });
    await C.openAsViewer(EPIC);
    expect((await C.approve(EPIC)).phase).toBe("LANDING");
    const s = await until("needs_report", async () => {
      await A.pull();
      const x = await A.epicState(EPIC);
      return x.landing?.status === "needs_report" ? x : null;
    });
    // 병합 커밋: 부모 = 검증한 커밋 + main
    const parents = (await git(["rev-list", "--parents", "-n", "1", s.landing!.commit], { cwd: A.cfg.repo }).catch(async () => {
      await A.eng.fetchEpicBranch(EPIC);
      return git(["rev-list", "--parents", "-n", "1", s.landing!.commit], { cwd: A.cfg.repo });
    })).trim().split(" ");
    expect(parents).toHaveLength(3);
  });

  it("담당자 확장: 병합 커밋으로 따라가 테스트 재보고 → 서버가 main에 squash 반영 → DONE", async () => {
    const s0 = await A.epicState(EPIC);
    expect(await A.followLanding(EPIC, s0)).toBe("reported");
    expect(existsSync(path.join(await A.worktree(EPIC), "OTHER.md"))).toBe(true); // fast-forward
    const s = await until("DONE", async () => {
      await A.pull();
      const x = await A.epicState(EPIC);
      return x.phase === "DONE" ? x : null;
    });
    const main = s.landed!.main_commit;
    const remoteMain = (await git(["ls-remote", remote, "refs/heads/main"], { cwd: root })).split("\t")[0];
    expect(remoteMain).toBe(main);
    const msg = await git(["log", "-1", "--format=%B", main], { cwd: remote });
    expect(msg).toContain(`Flightdeck-Epic: ${EPIC}`);
    expect(msg).toContain("Flightdeck-Landed-By: flightdeck-server");
    expect(msg.split("\n")[0]).toContain("토큰 회전");
    const files = (await git(["ls-tree", "-r", "--name-only", main], { cwd: remote })).trim().split("\n");
    const dir = `.flightdeck/epics/${EPIC}`;
    expect(files).toEqual(expect.arrayContaining(["src/token.js", "src/new.js", "OTHER.md", `${dir}/impl-log.md`, `${dir}/design.md`, `${dir}/threads/code.json`]));
    expect(files).not.toContain(`${dir}/trace.jsonl`);
    expect((await git(["rev-list", "--parents", "-n", "1", main], { cwd: remote })).trim().split(" ")).toHaveLength(2); // squash: 부모 하나
    expect((await git(["ls-remote", remote, `refs/heads/flightdeck/${EPIC}`], { cwd: root })).trim()).toBe(""); // 에픽 브랜치 정리
    const signed = (await A.store.list(EPIC)).filter((e) => e.type === "epic.landed" || e.type === "land.rejected").map((e) => [e.type, !!e.sig]);
    expect(signed).toEqual([["land.rejected", true], ["epic.landed", true]]);
  });

  it("main 감사: Flightdeck 밖 커밋은 걸리고, 서명된 반영은 통과 (Y8)", async () => {
    const findings = await A.auditMain();
    expect(findings.map((f) => f.subject)).toEqual(["다른 변경"]);
  });
});

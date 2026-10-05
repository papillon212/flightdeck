// M5.5 완료 기준 "M5의 에픽 흐름이 내장 git 서버로 main까지 가고, 규칙 위반 push가 거부된다"를 workflow 수준에서 돌린다 (m5.5-plan).
// 서버(메모리) + 내장 git(로컬 시드 레포에서 가져옴) + 외부 미러(로컬 bare) + 서버 레포 받기로 만든 클론 3개.
// 모든 git 왕복은 HTTP + git 전용 토큰(credential helper)으로 한다.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { diffRecords, generateServerKey, keyFingerprint, nowIso, reviewOf } from "@flightdeck/core";
import { git, GitError } from "@flightdeck/git";
import { appendEditRecords, logStep, readState } from "@flightdeck/hook";
import { createApp, EventSigner, GitHost, MemoryStore, readProductDir } from "@flightdeck/server";
import { cloneFromServer, hostedUrl, needsRenew, remoteMismatch, storedToken } from "../src/gitaccess.ts";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-55hosted";
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAB";
let root: string, mirror: string, srv: Server, url: string, host: GitHost;
let A: EpicWorkflow, P: EpicWorkflow, C: EpicWorkflow;

async function member(id: string): Promise<EpicWorkflow> {
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const t = await server.gitToken();
  const repo = await cloneFromServer({ serverUrl: url, product: "sample", member: t.member, token: t.token, dest: path.join(root, id, "sample") });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@test.local`]]) await git(["config", k!, v!], { cwd: repo });
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
  root = await mkdtemp(path.join(tmpdir(), "fd-hosted-"));
  // 가져올 기존 레포 (외부 git에 있던 것)
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  await writeFile(path.join(seed, "check.js"), "const { rotate } = require('./src/token.js');\nif (rotate(1) !== 2) { console.log('FAIL'); process.exit(1); }\nconsole.log('ok');\n");
  for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@test.local", "commit", "-q", "-m", "init"]]) await git(a, { cwd: seed });
  mirror = path.join(root, "mirror.git");
  await git(["init", "-q", "--bare", "-b", "main", mirror], { cwd: root });

  const store = new MemoryStore();
  for (const id of ["dh.lee", "park", "choi"]) await store.upsertMember({ id, email: `${id}@test.local`, active: true, admin: id === "dh.lee" }, "test");
  const p = await readProductDir(SAMPLE, "builtin");
  p.pipeline_yaml = p.pipeline_yaml
    .replace(/^repo: builtin$/m, `repo: builtin\nmirror:\n  url: ${mirror}`)
    .replace(/groups:\n(\s+\w+: \[.*\]\n)+/, "groups:\n    verifiers: [park]\n    qa: [choi]\n")
    .replace("commands: [pnpm lint, pnpm test]", "commands: [node check.js]")
    .replace(/(verification:[\s\S]*?- \{ name: lead, reviewers: \{ group: )leads/, "$1verifiers");
  await store.addConfigVersion({ ...p, created_by: "test" });
  const dataDir = path.join(root, "server");
  let signer: EventSigner;
  host = new GitHost({ dataDir, secret: keys.privateKeyPem, trust: () => signer.trust(), isActive: async (m) => !!(await store.getMember(m))?.active, target: async () => "main" });
  signer = new EventSigner({ store, dataDir, ...keys, githost: host });
  const app = createApp({ store, signer, keys, devLogin: true, githost: host });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  host.attach(url);
  await host.ensureRepo("sample", { importUrl: seed });
  [A, P, C] = [await member("dh.lee"), await member("park"), await member("choi")];
});

afterAll(async () => {
  srv?.close();
  delete process.env.FD_HOOK_URL;
  delete process.env.FD_PUSH_ID;
  await rm(root, { recursive: true, force: true });
});

describe("내장 git 서버로 main까지 (M5.5 완료 기준)", { timeout: 120_000 }, () => {
  it("서버 레포 받기: 원격은 토큰 없는 서버 주소, 토큰은 0600 파일, credential helper가 읽는다 (Z3·Z7)", async () => {
    const repo = A.cfg.repo;
    expect(await remoteMismatch(repo, "origin", hostedUrl(url, "sample"))).toBeNull();
    const f = path.join(repo, ".git/flightdeck/git-credentials");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const t = await storedToken(path.join(repo, ".git/flightdeck"));
    expect(t?.member).toBe("dh.lee");
    expect(needsRenew(t, "dh.lee")).toBe(false);
    expect(needsRenew(t, "park")).toBe(true);
    const filled = await git(["credential", "fill"], { cwd: repo, input: `protocol=http\nhost=${new URL(url).host}\n\n` });
    expect(filled).toContain("username=dh.lee");
    expect(await readFile(path.join(repo, ".git/config"), "utf8")).not.toContain(t!.token); // 토큰은 설정 파일에 없다
  });

  it("분석 → 설계 → 구현 제출 → VERIFICATION: 서명·브랜치·체크포인트·세션 원본 push가 모두 내장 git으로", async () => {
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
    await A.eng.pushCheckpoint(EPIC, "dh.lee"); // 훅이 백그라운드로 하는 push (logStep이 만든 체크포인트)
    expect(await A.submitImplementation(EPIC)).toMatchObject({ ok: true, phase: "VERIFICATION" });
    const refs = await git(["for-each-ref", "--format=%(refname)"], { cwd: host.repoDir("sample") });
    expect(refs).toContain(`refs/heads/flightdeck/${EPIC}`);
    expect(refs).toContain(`refs/flightdeck/ckpt/${EPIC}/dh.lee`);
    expect(refs).toContain(`refs/flightdeck/runs/${EPIC}`); // 테스트 로그
  });

  it("검증 lead 승인 → qa의 main 직접 push는 거부 → qa 승인 → 서버가 내장 main에 반영 → DONE → 미러에도", async () => {
    await P.openAsViewer(EPIC);
    expect(await P.role(EPIC)).toBe("review");
    expect(reviewOf(await P.approve(EPIC))?.current?.name).toBe("qa");

    const repo = C.cfg.repo;
    await writeFile(path.join(repo, "OTHER.md"), "다른 변경\n");
    await git(["add", "."], { cwd: repo });
    await git(["commit", "-q", "-m", "다른 변경"], { cwd: repo });
    const err = await git(["push", "-q", "origin", "HEAD:main"], { cwd: repo }).then(() => null, (e: GitError) => e.stderr);
    expect(err).toContain("반영 서버만 쓸 수 있다");
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: repo });

    await C.openAsViewer(EPIC);
    expect((await C.approve(EPIC)).phase).toBe("LANDING");
    const s = await until("DONE", async () => {
      await A.pull();
      const x = await A.epicState(EPIC);
      return x.phase === "DONE" ? x : null;
    });
    const main = s.landed!.main_commit;
    expect((await git(["rev-parse", "main"], { cwd: host.repoDir("sample") })).trim()).toBe(main);
    expect(await git(["log", "-1", "--format=%B", main], { cwd: host.repoDir("sample") })).toContain(`Flightdeck-Epic: ${EPIC}`);
    expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/flightdeck/${EPIC}`], { cwd: host.repoDir("sample") })).trim()).toBe(""); // 에픽 브랜치 정리(서버만 지울 수 있다)
    await until("미러", async () => (await git(["rev-parse", "main"], { cwd: mirror }).catch(() => "")).trim() === main);
    expect(await git(["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: mirror })).not.toContain("flightdeck");
  });

  it("main 감사: 내장 git에서는 서버를 거치지 않은 main 커밋이 없다", async () => {
    expect(await A.auditMain()).toEqual([]);
  });
});

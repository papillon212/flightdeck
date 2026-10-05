// 내장 git 서버 (설계 D21, §1.5, M5.5): 실제 git 클라이언트로 HTTP clone·push, pre-receive 규칙, 미러, 백업.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateServerKey, ulid } from "@flightdeck/core";
import { git, GitError, RemoteEventStore } from "@flightdeck/git";
import type { Event } from "@flightdeck/schema";
import { createApp, EventSigner, GitHost, MemoryStore, readProductDir } from "../src/index.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const EPIC = "CU-55";
const keys = generateServerKey();
let root: string, srv: Server, url: string, store: MemoryStore, host: GitHost, signer: EventSigner;
const session: Record<string, string> = {};
const gitTok: Record<string, string> = {};

async function api(who: string | null, method: string, p: string, body?: unknown, bearer?: string) {
  const r = await fetch(url + p, {
    method,
    headers: { ...(who || bearer ? { authorization: `Bearer ${bearer ?? session[who!]}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: text };
  }
}

const repoUrl = (who?: string) => (who ? url.replace("http://", `http://${who}:${gitTok[who]}@`) : url) + "/git/sample.git";

/** push가 거부되면 서버가 남긴 이유(remote: 줄)를 돌려준다. 성공하면 null */
async function tryPush(cwd: string, args: string[]): Promise<string | null> {
  try {
    await git(["push", "-q", "--no-verify", ...args], { cwd });
    return null;
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    return e.stderr;
  }
}

async function cloneAs(who: string): Promise<string> {
  const dir = path.join(root, who);
  await git(["clone", "-q", repoUrl(who), dir], { cwd: root });
  for (const [k, v] of [["user.name", who], ["user.email", `${who}@test.local`]]) await git(["config", k!, v!], { cwd: dir });
  return dir;
}

function event(type: string, author: string, data: Record<string, unknown>): Event {
  return { v: 1, id: ulid(), type, epic: EPIC, author, at: new Date().toISOString(), data } as Event;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-githost-test-"));
  store = new MemoryStore();
  for (const [id, admin] of [["dh.lee", true], ["park", false], ["choi", false]] as const) await store.upsertMember({ id, email: `${id}@test.local`, active: true, admin }, "test");
  await store.addConfigVersion({ ...(await readProductDir(SAMPLE, "builtin")), created_by: "test" });
  const dataDir = path.join(root, "server");
  host = new GitHost({
    dataDir,
    secret: keys.privateKeyPem,
    trust: () => signer.trust(),
    isActive: async (m) => !!(await store.getMember(m))?.active,
    target: async () => "main",
  });
  signer = new EventSigner({ store, dataDir, ...keys, githost: host });
  const app = createApp({ store, signer, keys, devLogin: true, githost: host });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  host.attach(url);
  await host.ensureRepo("sample");
  for (const m of ["dh.lee", "park", "choi"]) {
    session[m] = (await api(null, "POST", "/auth/dev", { member: m })).data.token;
    gitTok[m] = (await api(m, "POST", "/git/token")).data.token;
  }
});

afterAll(async () => {
  srv?.close();
  delete process.env.FD_HOOK_URL;
  delete process.env.FD_PUSH_ID;
  await rm(root, { recursive: true, force: true });
});

describe("내장 git 서버 (§1.5, M5.5)", { timeout: 60_000 }, () => {
  let owner: string, park: string, base: string;

  it("git 전용 토큰으로만: 토큰 없음·로그인 세션 토큰·위조 토큰은 401, git 토큰으로 API는 못 쓴다", async () => {
    await expect(git(["ls-remote", repoUrl()], { cwd: root, env: { GIT_TERMINAL_PROMPT: "0" } })).rejects.toThrow();
    const asSession = url.replace("http://", `http://dh.lee:${session["dh.lee"]}@`) + "/git/sample.git";
    await expect(git(["ls-remote", asSession], { cwd: root, env: { GIT_TERMINAL_PROMPT: "0" } })).rejects.toThrow();
    const forged = gitTok.park!.replace(/^fdg1\.[^.]+/, `fdg1.${Buffer.from("dh.lee").toString("base64url")}`);
    expect(host.verifyToken(forged)).toBeNull();
    expect(host.verifyToken(gitTok.park!)).toBe("park");
    expect((await api(null, "GET", "/me", undefined, gitTok["dh.lee"])).status).toBe(401);
    expect(await git(["ls-remote", repoUrl("park")], { cwd: root })).toContain("refs/heads/main");
  });

  it("clone·에픽 시작: 서버 서명 이벤트는 서버 사본 → 내장 레포 push(훅 통과)로 들어간다", async () => {
    owner = await cloneAs("dh.lee");
    park = await cloneAs("park");
    base = (await git(["rev-parse", "HEAD"], { cwd: owner })).trim();
    const r = await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "epic.started", data: { tracker_ref: EPIC, base_sha: base } });
    expect(r).toMatchObject({ status: 200, data: { pushed: true } });
    expect(await git(["ls-remote", repoUrl("park"), "refs/heads/flightdeck-meta"], { cwd: root })).toContain("flightdeck-meta");
  });

  it("main 직접 push는 거부, 서버만 (§11.4)", async () => {
    await writeFile(path.join(owner, "hack.txt"), "x\n");
    await git(["add", "."], { cwd: owner });
    await git(["commit", "-q", "-m", "직접"], { cwd: owner });
    const err = await tryPush(owner, ["origin", "HEAD:main"]);
    expect(err).toContain("반영 서버만 쓸 수 있다");
    expect(await tryPush(owner, ["origin", "HEAD:refs/tags/v1"])).toContain("반영 서버만");
    expect(await tryPush(owner, ["origin", "HEAD:refs/heads/feature"])).toContain("쓰지 않는 ref");
    await git(["reset", "-q", "--hard", base], { cwd: owner });
  });

  it("에픽 브랜치: 담당자만, fast-forward만, 지우기는 서버만", async () => {
    await writeFile(path.join(owner, "a.txt"), "1\n");
    await git(["add", "."], { cwd: owner });
    await git(["commit", "-q", "-m", "a"], { cwd: owner });
    expect(await tryPush(owner, ["origin", `HEAD:refs/heads/flightdeck/${EPIC}`])).toBeNull();
    await git(["fetch", "-q", "origin", `flightdeck/${EPIC}`], { cwd: park });
    await git(["checkout", "-q", "-b", "e", "FETCH_HEAD"], { cwd: park });
    await writeFile(path.join(park, "a.txt"), "park\n");
    await git(["commit", "-q", "-am", "park"], { cwd: park });
    expect(await tryPush(park, ["origin", `HEAD:refs/heads/flightdeck/${EPIC}`])).toContain("에픽 조종수(@dh.lee)만");
    await git(["commit", "-q", "--amend", "-m", "a2"], { cwd: owner });
    expect(await tryPush(owner, ["-f", "origin", `HEAD:refs/heads/flightdeck/${EPIC}`])).toContain("fast-forward만");
    expect(await tryPush(owner, ["origin", `:refs/heads/flightdeck/${EPIC}`])).toContain("반영 서버만 지운다");
  });

  it("체크포인트는 그 멤버만, 세션 원본은 담당자만", async () => {
    expect(await tryPush(park, ["origin", `HEAD:refs/flightdeck/ckpt/${EPIC}/park`])).toBeNull();
    expect(await tryPush(park, ["origin", `HEAD:refs/flightdeck/ckpt/${EPIC}/dh.lee`])).toContain("그 멤버(@dh.lee)의 체크포인트만");
    expect(await tryPush(park, ["origin", `HEAD:refs/flightdeck/runs/${EPIC}`])).toContain("조종수(@dh.lee)만 세션 원본");
    expect(await tryPush(owner, ["origin", `HEAD:refs/flightdeck/runs/${EPIC}`])).toBeNull();
  });

  it("메타 브랜치: 자기 이름의 일반 이벤트 추가만. 남의 이름·서버 서명 종류·수정·삭제·이력 재작성은 거부", async () => {
    // 정상: 확장의 EventStore 그대로
    const parkStore = new RemoteEventStore(park, "origin", { backoffMs: 5 });
    await parkStore.append(event("thread.created", "park", { thread: "t-0000PARK", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:0001" }, kind: "note", to: [], body: "참고" }));
    expect((await parkStore.sync()).pending).toBe(0);

    // 남의 이름
    const forged = new RemoteEventStore(park, "origin", { backoffMs: 5, pushRetries: 1 });
    await forged.append(event("thread.resolved", "dh.lee", { thread: "t-0000PARK" }));
    expect((await forged.sync()).pending).toBe(1);
    const reason = await tryPush(park, ["origin", "refs/heads/flightdeck-meta:refs/heads/flightdeck-meta"]);
    expect(reason).toContain("남의 이름(@dh.lee)");
    await git(["update-ref", "refs/heads/flightdeck-meta", "refs/flightdeck/remote/origin/meta"], { cwd: park });

    // 서버 서명 종류를 멤버가
    await new RemoteEventStore(park, "origin", { pushRetries: 1 }).append(event("phase.completed", "park", { phase: "ANALYSIS", artifact_hash: "sha256:" + "0".repeat(64) }));
    expect(await tryPush(park, ["origin", "refs/heads/flightdeck-meta:refs/heads/flightdeck-meta"])).toContain("phase.completed는 서버만 기록한다");
    await git(["update-ref", "refs/heads/flightdeck-meta", "refs/flightdeck/remote/origin/meta"], { cwd: park });

    // 기존 이벤트 수정
    await git(["checkout", "-q", "-B", "meta", "refs/flightdeck/remote/origin/meta"], { cwd: park });
    const file = (await git(["ls-files", `epics/${EPIC}/events`], { cwd: park })).split("\n").find((f) => f.endsWith("-dh.lee.json"))!;
    const text = await readFile(path.join(park, file), "utf8");
    await writeFile(path.join(park, file), text.replace('"dh.lee"', '"park"'));
    await git(["commit", "-q", "-am", "수정"], { cwd: park });
    expect(await tryPush(park, ["origin", "HEAD:refs/heads/flightdeck-meta"])).toContain("수정 — 이벤트는 추가만");
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: park });
    await git(["rm", "-q", file], { cwd: park });
    await git(["commit", "-q", "-m", "삭제"], { cwd: park });
    expect(await tryPush(park, ["origin", "HEAD:refs/heads/flightdeck-meta"])).toContain("삭제 — 이벤트는 추가만");

    // 이력 재작성 (force push)
    await git(["reset", "-q", "--hard", "HEAD~2"], { cwd: park });
    expect(await tryPush(park, ["-f", "origin", "HEAD:refs/heads/flightdeck-meta"])).toContain("fast-forward만");
    expect(await tryPush(park, ["origin", ":refs/heads/flightdeck-meta"])).toContain("지울 수 없다");
  });

  it("서버를 거치지 않은 push(레포 폴더에 직접)는 훅이 거부한다", async () => {
    const err = await git(["push", "-q", host.repoDir("sample"), `HEAD:refs/flightdeck/ckpt/CU-56/park`], { cwd: park, env: { FD_PUSH_ID: "", FD_HOOK_URL: "" } }).catch((e: GitError) => e.stderr);
    expect(err).toContain("서버를 거치지 않은 push");
  });

  it("비활성 멤버의 git 토큰은 거부", async () => {
    await store.upsertMember({ id: "choi", email: "choi@test.local", active: false, admin: false }, "test");
    await expect(git(["ls-remote", repoUrl("choi")], { cwd: root, env: { GIT_TERMINAL_PROMPT: "0" } })).rejects.toThrow(/401|Authentication/i);
  });

  it("외부 미러: main을 올리고, 미러 쪽이 갈라지면 덮지 않는다 (Z5)", async () => {
    const mirror = path.join(root, "mirror.git");
    await git(["init", "-q", "--bare", "-b", "main", mirror], { cwd: root });
    const r = await host.syncMirror("sample", { url: mirror, refs: ["main", "tags/*"] });
    expect(r).toEqual({ pushed: ["refs/heads/main"], problems: [] });
    expect((await git(["rev-parse", "main"], { cwd: mirror })).trim()).toBe(base);
    expect(await git(["for-each-ref", "refs/heads"], { cwd: mirror })).not.toContain("flightdeck"); // 메타·에픽 브랜치는 미러하지 않는다
    expect((await host.syncMirror("sample", { url: mirror, refs: ["main"] })).pushed).toEqual([]);
    // 미러에 누가 직접 push했다
    await git(["push", "-q", "--no-verify", mirror, `${(await git(["rev-parse", "HEAD"], { cwd: owner })).trim()}:refs/heads/main`], { cwd: owner });
    const tmp = path.join(root, "srv-copy");
    await git(["clone", "-q", "--bare", host.repoDir("sample"), tmp], { cwd: root });
    const x = (await git(["commit-tree", `${base}^{tree}`, "-p", base, "-m", "서버 반영 흉내"], { cwd: tmp })).trim();
    await git(["push", "-q", host.repoDir("sample"), `${x}:refs/heads/main`], { cwd: tmp }); // 서버 push ID (attach)로
    const r2 = await host.syncMirror("sample", { url: mirror, refs: ["main"] });
    expect(r2.pushed).toEqual([]);
    expect(r2.problems[0]).toContain("갈라졌다");
  });

  it("어드민: 내장 레포가 없는 제품은 화면에서 가져오거나 빈 레포를 만든다. 그 전의 요청은 거부 (Z8)", async () => {
    const yaml = (product: string, repo: string) => (async () => (await readProductDir(SAMPLE, repo)).pipeline_yaml.replace(/^product: .*$/m, `product: ${product}`))();
    for (const [product, repo] of [["other", "builtin"], ["blank", "builtin"], ["ext", "git@example.com:x/ext.git"]] as const) {
      await store.addConfigVersion({ product, pipeline_yaml: await yaml(product, repo), rules: {}, created_by: "test" });
    }
    const admin = (who: string, p: string, body?: Record<string, string>) =>
      fetch(url + p, { method: body ? "POST" : "GET", redirect: "manual", headers: { authorization: `Bearer ${session[who]}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });

    expect(await (await admin("dh.lee", "/admin/products/other")).text()).toContain("내장 레포가 아직 없다");
    expect(await (await admin("dh.lee", "/admin/products/ext")).text()).toContain("외부 git: <code>git@example.com:x/ext.git</code>");
    const early = await api("dh.lee", "POST", "/events", { product: "other", epic: "CU-9", type: "epic.started", data: { tracker_ref: "CU-9", base_sha: "a".repeat(40) } });
    expect(early).toMatchObject({ status: 503, data: { error: expect.stringContaining("어드민 화면") } });

    expect((await admin("park", "/admin/products/other/repo", { action: "create" })).status).toBe(403); // 어드민만
    expect((await admin("dh.lee", "/admin/products/ext/repo", { action: "create" })).status).toBe(409); // 외부 git 제품
    expect((await admin("dh.lee", "/admin/products/other/repo", { action: "import", url: "--upload-pack=touch /tmp/x" })).status).toBe(502);
    expect((await host.repoInfo("other")).exists).toBe(false);

    // 가져오기: 다른 레포의 모든 ref
    expect((await admin("dh.lee", "/admin/products/other/repo", { action: "import", url: host.repoDir("sample") })).status).toBe(303);
    const info = await host.repoInfo("other");
    expect(info).toMatchObject({ exists: true, target: (await git(["rev-parse", "main"], { cwd: host.repoDir("sample") })).trim() });
    expect((await git(["for-each-ref", "--format=%(refname)"], { cwd: host.repoDir("other") })).trim().split("\n")).toEqual((await git(["for-each-ref", "--format=%(refname)"], { cwd: host.repoDir("sample") })).trim().split("\n"));
    expect(await git(["config", "--get", "remote.origin.url"], { cwd: host.repoDir("other") }).catch(() => "")).toBe(""); // 원본 주소를 남기지 않는다
    expect(await (await admin("dh.lee", "/admin/products/other")).text()).toContain("내장 git: <code>/git/other.git</code>");
    expect((await admin("dh.lee", "/admin/products/other/repo", { action: "create" })).status).toBe(409); // 이미 있다

    // 빈 레포 만들기 → 바로 HTTP로 받고, 훅이 규칙을 강제한다
    expect((await admin("dh.lee", "/admin/products/blank/repo", { action: "create" })).status).toBe(303);
    const blank = path.join(root, "blank-clone");
    await git(["clone", "-q", url.replace("http://", `http://dh.lee:${gitTok["dh.lee"]}@`) + "/git/blank.git", blank], { cwd: root });
    expect((await git(["log", "--format=%s", "main"], { cwd: blank })).trim()).toBe("blank 시작");
    expect(await tryPush(blank, ["origin", "HEAD:main"])).toBeNull(); // 같은 커밋: 바뀌는 ref 없음
    await git(["-c", "user.name=x", "-c", "user.email=x@test.local", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: blank });
    expect(await tryPush(blank, ["origin", "HEAD:main"])).toContain("반영 서버만");
    expect((await store.audit()).filter((a) => a.action.startsWith("repo.")).map((a) => [a.action, (a.detail as { product: string }).product])).toEqual([
      ["repo.create", "blank"],
      ["repo.import", "other"],
    ]);
  });

  it("백업: 레포마다 bundle, 그것으로 복원하면 메타·main이 그대로 (Z6)", async () => {
    const bundles = await host.backup(path.join(root, "backup"));
    expect(bundles).toHaveLength(3); // sample, other, blank
    const bundle = bundles.find((b) => path.basename(b).startsWith("sample-"));
    const restored = path.join(root, "restored.git");
    await git(["clone", "-q", "--mirror", bundle!, restored], { cwd: root });
    for (const ref of ["refs/heads/main", "refs/heads/flightdeck-meta", `refs/heads/flightdeck/${EPIC}`]) {
      expect((await git(["rev-parse", ref], { cwd: restored })).trim()).toBe((await git(["rev-parse", ref], { cwd: host.repoDir("sample") })).trim());
    }
  });
});

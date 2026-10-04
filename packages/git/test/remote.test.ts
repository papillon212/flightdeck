// 원격 메타 브랜치·에픽 브랜치 공유 (설계 §1.3, §2.1, §2.4, §3.1, §3.7). 로컬 bare 원격 + 클론 2개.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Event } from "@flightdeck/schema";
import { ulid } from "@flightdeck/core";
import { git, GitEngine, MetaRewriteError, RemoteEventStore } from "../src/index.ts";

let root: string, remote: string, a: string, b: string;
const EPIC = "CU-9";

const reply = (author: string, body: string): Event => ({
  v: 1, id: ulid(), type: "thread.replied", epic: EPIC, author, at: new Date().toISOString(), data: { thread: "t-AAAAAAAA", body, source: "human" },
});

async function clone(name: string): Promise<string> {
  const dir = path.join(root, name);
  await git(["clone", "-q", remote, dir], { cwd: root });
  await git(["config", "user.name", name], { cwd: dir });
  await git(["config", "user.email", `${name}@example.com`], { cwd: dir });
  return dir;
}

const store = (repo: string) => new RemoteEventStore(repo, "origin", { backoffMs: 5, pushRetries: 30 });

async function remoteHistory(): Promise<{ count: number; merges: number }> {
  const out = (await git(["rev-list", "--parents", "flightdeck-meta"], { cwd: remote })).trim().split("\n");
  return { count: out.length, merges: out.filter((l) => l.split(" ").length > 2).length };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-remote-test-"));
  remote = path.join(root, "remote.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  await git(["add", "."], { cwd: seed });
  await git(["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "init"], { cwd: seed });
  await git(["push", "-q", remote, "main"], { cwd: seed });
  a = await clone("a");
  b = await clone("b");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("RemoteEventStore", () => {
  it("A가 추가한 이벤트를 B가 sync로 받는다", async () => {
    const e = reply("dh.lee", "첫 이벤트");
    await store(a).append(e);
    const r = await store(b).sync();
    expect(r).toMatchObject({ received: true, pending: 0 });
    expect((await store(b).list(EPIC)).map((x) => x.id)).toEqual([e.id]);
  });

  it("두 클라이언트가 동시에 10개씩 추가해도 유실 0, 병합 커밋 0, 같은 결과", async () => {
    const sa = store(a), sb = store(b);
    const evs = [...Array.from({ length: 10 }, (_, i) => ["a", i] as const), ...Array.from({ length: 10 }, (_, i) => ["b", i] as const)];
    await Promise.all(evs.map(([who, i]) => (who === "a" ? sa : sb).append(reply(who === "a" ? "dh.lee" : "park", `${who}${i}`))));
    await sa.sync();
    await sb.sync();
    await sa.sync();
    const la = (await sa.list(EPIC)).map((x) => x.id), lb = (await sb.list(EPIC)).map((x) => x.id);
    expect(la).toHaveLength(21);
    expect(lb).toEqual(la);
    expect(await remoteHistory()).toEqual({ count: 21, merges: 0 });
  }, 60_000);

  it("원격에 닿지 못하면 이벤트는 로컬에 남고, 다시 닿으면 묶어서 보낸다", async () => {
    await git(["remote", "set-url", "origin", path.join(root, "nowhere.git")], { cwd: a });
    const s = new RemoteEventStore(a, "origin", { backoffMs: 1, pushRetries: 2 });
    for (const n of [1, 2, 3]) await s.append(reply("dh.lee", `오프라인 ${n}`)); // 던지지 않는다
    expect((await s.list(EPIC)).filter((x) => x.type === "thread.replied" && x.data.body.startsWith("오프라인"))).toHaveLength(3);
    await git(["remote", "set-url", "origin", remote], { cwd: a });
    await store(b).append(reply("park", "그 사이 B")); // 갈라진 상태 만들기
    const r = await s.sync();
    expect(r).toMatchObject({ pushed: 3, pending: 0, received: true });
    await store(b).sync();
    expect((await store(b).list(EPIC)).length).toBe(25);
    expect((await remoteHistory()).merges).toBe(0);
  });

  it("원격 메타 브랜치를 force push로 되돌리면 받아들이지 않는다 (설계 §2.1)", async () => {
    const c = await clone("c");
    await git(["fetch", "-q", "origin", "flightdeck-meta"], { cwd: c });
    const old = (await git(["rev-parse", "FETCH_HEAD~5"], { cwd: c })).trim();
    await git(["push", "-q", "--force", "origin", `${old}:refs/heads/flightdeck-meta`], { cwd: c });
    const before = (await store(a).list(EPIC)).length;
    await expect(store(a).sync()).rejects.toBeInstanceOf(MetaRewriteError);
    expect((await store(a).list(EPIC)).length).toBe(before); // 로컬 이벤트는 그대로
    // 복구: 관리자가 원래 끝을 되돌려 놓으면 다시 받아들인다
    await git(["push", "-q", "--force", "origin", "refs/heads/flightdeck-meta:refs/heads/flightdeck-meta"], { cwd: a });
    await expect(store(a).sync()).resolves.toMatchObject({ pending: 0 });
  });

  it("원격을 과거 커밋으로 되돌린 뒤 내가 새 이벤트를 추가해도, 덮어쓰지 않고 재작성을 감지한다", async () => {
    const c = path.join(root, "c");
    const sa = store(a);
    await sa.sync();
    await git(["fetch", "-q", "origin", "flightdeck-meta"], { cwd: c });
    const tip = (await git(["rev-parse", "FETCH_HEAD"], { cwd: c })).trim();
    await git(["push", "-q", "--force", "origin", `${tip}~2:refs/heads/flightdeck-meta`], { cwd: c }); // 내 끝의 조상으로 되돌림
    await sa.append(reply("dh.lee", "되돌린 뒤")); // append는 sync 실패를 삼킨다
    expect((await git(["rev-parse", "flightdeck-meta"], { cwd: remote })).trim()).not.toBe(await sa.head()); // 빠른 길로 덮지 않았다
    await expect(sa.sync()).rejects.toBeInstanceOf(MetaRewriteError);
    await git(["push", "-q", "--force", "origin", `${tip}:refs/heads/flightdeck-meta`], { cwd: c }); // 복구
    await expect(sa.sync()).resolves.toMatchObject({ pending: 0 });
  });

  it("watch: 원격이 바뀌면 sync하고 알린다", async () => {
    const sb = store(b);
    const seen: number[] = [];
    await sb.sync(); // 밀린 것을 먼저 받아 두고 감시를 시작한다
    const w = sb.watch(() => seen.push(Date.now()), { intervalMs: 50 });
    try {
      await store(a).append(reply("dh.lee", "watch"));
      const t0 = Date.now();
      while (!seen.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
      expect(seen.length).toBeGreaterThan(0);
      expect((await sb.list(EPIC)).some((x) => x.type === "thread.replied" && x.data.body === "watch")).toBe(true);
    } finally {
      w.dispose();
    }
  });
});

describe("에픽 브랜치 공유 (설계 §2.4, §3.1 thread.created.commit)", () => {
  it("담당자가 올린 공유 커밋을 질문 대상이 읽기 전용 창으로 열고, 다음 공유 커밋으로 옮긴다", async () => {
    const ea = new GitEngine(a), eb = new GitEngine(b);
    const { path: wt } = await ea.createEpicWorktree(EPIC);
    await mkdir(path.join(wt, ".flightdeck/epics", EPIC), { recursive: true });
    const doc = path.join(wt, ".flightdeck/epics", EPIC, "analysis.md");
    await writeFile(doc, "## 불명확한 점\n- TTL?\n");
    await ea.commit(wt, [path.relative(wt, doc)], "공유 1");
    const c1 = await ea.pushEpicBranch(EPIC);

    const v1 = await eb.openViewWorktree(EPIC, c1);
    const viewDoc = path.join(v1.path, ".flightdeck/epics", EPIC, "analysis.md");
    expect(await readFile(viewDoc, "utf8")).toContain("TTL?");
    expect((await git(["rev-parse", "HEAD"], { cwd: v1.path })).trim()).toBe(c1);

    await writeFile(viewDoc, (await readFile(viewDoc, "utf8")) + "<!-- 렌더링된 쓰레드 블록 -->\n"); // B 쪽 렌더링
    await writeFile(doc, "## 불명확한 점\n- 액세스 TTL은?\n");
    await ea.commit(wt, [path.relative(wt, doc)], "공유 2");
    const c2 = await ea.pushEpicBranch(EPIC);
    const v2 = await eb.openViewWorktree(EPIC); // 커밋을 안 주면 원격 끝
    expect(v2.commit).toBe(c2);
    expect(await readFile(viewDoc, "utf8")).toBe("## 불명확한 점\n- 액세스 TTL은?\n");
    expect(await git(["branch", "--list", "flightdeck/*"], { cwd: b })).toBe(""); // B에는 에픽 브랜치를 만들지 않는다
  });
});

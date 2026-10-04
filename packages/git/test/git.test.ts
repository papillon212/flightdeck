import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Event as EventSchema, type Event } from "@flightdeck/schema";
import { ulid } from "@flightdeck/core";
import { git, GitEngine, isSecret, LocalEventStore } from "../src/index.ts";

let root: string;
let repo: string;

async function sh(args: string[], cwd = repo) {
  return git(args, { cwd });
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".claude") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = (await readFile(p)).toString("base64");
    }
  };
  await walk(dir);
  return out;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-git-test-"));
  repo = path.join(root, "product");
  await mkdir(repo);
  await sh(["init", "-q", "-b", "main"]);
  await sh(["config", "user.name", "tester"]);
  await sh(["config", "user.email", "tester@example.com"]);
  await sh(["config", "core.autocrlf", "input"]); // 이 PC의 전역 설정과 같은 조건
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await sh(["add", "."]);
  await sh(["commit", "-q", "-m", "base"]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GitEngine: 에픽 작업 폴더 (설계 §2.4)", () => {
  it("../<repo>.flightdeck/<epic>에 flightdeck/<epic> 브랜치로 만든다", async () => {
    const eng = new GitEngine(repo);
    const w = await eng.createEpicWorktree("CU-1");
    expect(w.path).toBe(path.join(root, "product.flightdeck", "CU-1"));
    expect(w.branch).toBe("flightdeck/CU-1");
    expect(existsSync(path.join(w.path, "app.txt"))).toBe(true);
    // 설정 파일은 추적되지 않는다
    await mkdir(path.join(w.path, ".claude"), { recursive: true });
    await writeFile(path.join(w.path, ".claude", "settings.local.json"), "{}");
    await writeFile(path.join(w.path, ".mcp.json"), "{}");
    expect((await sh(["status", "--porcelain"], w.path)).trim()).toBe("");
    // 두 번 불러도 같은 폴더
    expect((await eng.createEpicWorktree("CU-1")).path).toBe(w.path);
  });

  it("지정한 파일만 에픽 브랜치에 커밋한다", async () => {
    const eng = new GitEngine(repo);
    const wt = eng.worktreePath("CU-1");
    await mkdir(path.join(wt, ".flightdeck/epics/CU-1"), { recursive: true });
    await writeFile(path.join(wt, ".flightdeck/epics/CU-1/epic.md"), "# 에픽\n");
    await writeFile(path.join(wt, "untouched.txt"), "커밋 대상 아님\n");
    const sha = await eng.commit(wt, [".flightdeck/epics/CU-1/epic.md"], "에픽 시작", { "Flightdeck-Epic": "CU-1" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await sh(["log", "-1", "--format=%B"], wt)).toContain("Flightdeck-Epic: CU-1");
    expect((await sh(["status", "--porcelain"], wt)).trim()).toBe("?? untouched.txt");
    expect(await eng.commit(wt, [".flightdeck/epics/CU-1/epic.md"], "변경 없음")).toBeNull();
  });
});

describe("GitEngine: 체크포인트 (설계 §8.1)", () => {
  it("브랜치·index·작업 트리를 건드리지 않고, 디스크 바이트 그대로 담고, 비밀 파일은 뺀다", async () => {
    const eng = new GitEngine(repo);
    const wt = eng.worktreePath("CU-1");
    await writeFile(path.join(wt, "app.txt"), "base\nedit-1\n");
    await writeFile(path.join(wt, "crlf.txt"), "one\r\ntwo\r\n");
    await writeFile(path.join(wt, "staged.txt"), "staged\n");
    await sh(["add", "staged.txt"], wt);
    await writeFile(path.join(wt, ".env"), "SECRET=1\n");
    await mkdir(path.join(wt, "keys"), { recursive: true });
    await writeFile(path.join(wt, "keys", "id.pem"), "-----BEGIN-----\n");

    const head = await sh(["rev-parse", "HEAD"], wt);
    const status = await sh(["status", "--porcelain"], wt);
    const index = await readFile(path.resolve(wt, (await sh(["rev-parse", "--git-path", "index"], wt)).trim()));
    const files = await snapshot(wt);

    const c1 = await eng.checkpoint(wt, { epic: "CU-1", member: "dh.lee", message: "ckpt 1", trailers: { "Flightdeck-Step": "1" } });

    expect(await sh(["rev-parse", "HEAD"], wt)).toBe(head);
    expect(await sh(["status", "--porcelain"], wt)).toBe(status);
    expect(await readFile(path.resolve(wt, (await sh(["rev-parse", "--git-path", "index"], wt)).trim()))).toEqual(index);
    expect(await snapshot(wt)).toEqual(files);

    const tree = (await sh(["ls-tree", "-r", "--name-only", c1], wt)).trim().split("\n");
    expect(tree).toContain("staged.txt");
    expect(tree).not.toContain(".env");
    expect(tree).not.toContain("keys/id.pem");
    expect(await sh(["cat-file", "blob", `${c1}:crlf.txt`], wt)).toBe("one\r\ntwo\r\n"); // autocrlf=input인데도 CRLF 유지
  });

  it("같은 1초 안에 같은 크기로 바뀐 파일도 놓치지 않는다 (racy git, 설계 제안 T6)", async () => {
    const eng = new GitEngine(repo);
    const wt = eng.worktreePath("CU-1");
    const f = path.join(wt, "racy.txt");
    // 재현 조건: 사용자 index에 a를 기록한 같은 초에 같은 크기 b로 바꾸고, 다음 초 이후에 스냅샷을 뜬다.
    // 수정 전(index 복사로 시각이 새로 찍힘)에는 셸 재현에서 6/6회 예전 내용 a가 담겼다.
    for (let i = 0; i < 2; i++) {
      const a = `aaaa${i}\n`;
      const b = `bbbb${i}\n`;
      await writeFile(f, a);
      await sh(["add", "racy.txt"], wt);
      await writeFile(f, b);
      await new Promise((r) => setTimeout(r, 1100));
      const tree = await eng.snapshotTree(wt);
      expect(await sh(["cat-file", "blob", `${tree}:racy.txt`], wt)).toBe(b);
    }
    await sh(["rm", "-q", "-f", "--cached", "racy.txt"], wt);
    await rm(f);
  });

  it("체인으로 이어지고, CAS가 오래된 값을 거부한다", async () => {
    const eng = new GitEngine(repo);
    const wt = eng.worktreePath("CU-1");
    await writeFile(path.join(wt, "app.txt"), "base\nedit-1\nedit-2\n");
    const c2 = await eng.checkpoint(wt, { epic: "CU-1", member: "dh.lee", message: "ckpt 2", trailers: { "Flightdeck-Step": "2" } });
    const list = await eng.listCheckpoints("CU-1", "dh.lee");
    expect(list.map((c) => c.trailers["Flightdeck-Step"])).toEqual(["2", "1"]);
    expect(list[0]!.sha).toBe(c2);
    await expect(sh(["update-ref", GitEngine.checkpointRef("CU-1", "dh.lee"), list[1]!.sha, list[1]!.sha], wt)).rejects.toThrow(/but expected|is at/);
  });

  it("이 시점으로 복원: 작업 트리만 그 시점 바이트로, 직전 상태는 체크포인트로 남는다", async () => {
    const eng = new GitEngine(repo);
    const wt = eng.worktreePath("CU-1");
    const [, c1] = await eng.listCheckpoints("CU-1", "dh.lee");
    await writeFile(path.join(wt, "later.txt"), "나중에 만든 파일\n");
    const head = await sh(["rev-parse", "HEAD"], wt);
    const { before } = await eng.restoreCheckpoint(wt, c1!.sha, { epic: "CU-1", member: "dh.lee" });
    expect(await readFile(path.join(wt, "app.txt"), "utf8")).toBe("base\nedit-1\n");
    expect(await readFile(path.join(wt, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
    expect(existsSync(path.join(wt, "later.txt"))).toBe(false);
    expect(await readFile(path.join(wt, ".env"), "utf8")).toBe("SECRET=1\n"); // 비밀 파일은 체크포인트 밖이라 복원해도 지워지지 않는다
    expect(existsSync(path.join(wt, "keys", "id.pem"))).toBe(true);
    expect(await sh(["rev-parse", "HEAD"], wt)).toBe(head);
    expect((await eng.listCheckpoints("CU-1", "dh.lee"))[0]!.sha).toBe(before);
    expect(await sh(["cat-file", "-p", `${before}:later.txt`], wt)).toBe("나중에 만든 파일\n");
  });
});

// 동시 추가는 git 프로세스를 많이 띄워 전체 테스트를 함께 돌리면 느려진다
describe("LocalEventStore (설계 §1.3, §3.1)", { timeout: 60_000 }, () => {
  let t = 1_790_000_000_000;
  const mk = (author: string, body: string): Event =>
    EventSchema.parse({
      v: 1,
      id: ulid((t += 1)),
      type: "thread.replied",
      epic: "CU-1",
      author,
      at: new Date(t).toISOString(),
      data: { thread: "t-AAAAAAAA", body, source: "human" },
    }) as Event;

  it("append → list, 파일 이름은 <ULID>-<member>.json", async () => {
    const store = new LocalEventStore(repo);
    const e = mk("dh.lee", "첫 이벤트");
    await store.append(e);
    const list = await store.list("CU-1");
    expect(list).toEqual([e]);
    expect(await sh(["ls-tree", "-r", "--name-only", "flightdeck-meta"])).toContain(`epics/CU-1/events/${e.id}-dh.lee.json`);
    expect(await store.list("OTHER")).toEqual([]);
  });

  it("동시에 20건을 추가해도 모두 남고 이력은 선형이다 (CAS 재시도)", async () => {
    const store = new LocalEventStore(repo);
    const before = (await store.list("CU-1")).length;
    const batch = Array.from({ length: 20 }, (_, i) => mk(i % 2 ? "park" : "kim", `동시 ${i}`));
    await Promise.all(batch.map((e) => store.append(e)));
    const list = await store.list("CU-1");
    expect(list.length).toBe(before + 20);
    expect(Number((await sh(["rev-list", "--count", "--merges", "flightdeck-meta"])).trim())).toBe(0);
    expect(list.map((e) => e.id)).toEqual([...list.map((e) => e.id)].sort());
  });

  it("형식이 틀린 이벤트 파일은 버리고 알려준다", async () => {
    const store = new LocalEventStore(repo);
    // 손으로 잘못된 파일을 넣는다
    const blob = (await git(["hash-object", "-w", "--stdin"], { cwd: repo, input: '{"v":1,"type":"thread.replied"}' })).trim();
    const idx = path.join(root, "bad.index");
    const env = { GIT_INDEX_FILE: idx };
    await git(["read-tree", "flightdeck-meta"], { cwd: repo, env });
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},epics/CU-1/events/BAD-x.json`], { cwd: repo, env });
    const tree = (await git(["write-tree"], { cwd: repo, env })).trim();
    const commit = (await git(["commit-tree", tree, "-p", "flightdeck-meta", "-m", "bad"], { cwd: repo })).trim();
    await git(["update-ref", "refs/heads/flightdeck-meta", commit], { cwd: repo });
    const r = await store.listDetailed("CU-1");
    expect(r.invalid.map((i) => i.path)).toEqual(["epics/CU-1/events/BAD-x.json"]);
    expect(r.events.length).toBeGreaterThan(0);
  });

  it("append는 형식이 틀린 이벤트를 쓰지 않는다", async () => {
    const store = new LocalEventStore(repo);
    await expect(store.append({ ...mk("kim", "x"), id: "nope" } as Event)).rejects.toThrow();
  });
});

describe("비밀 파일 패턴", () => {
  it("슬래시 없는 패턴은 파일 이름에, 있는 패턴은 경로에 맞춘다", () => {
    expect(isSecret(".env", [".env"])).toBe(true);
    expect(isSecret("sub/.env.local", [".env.*"])).toBe(true);
    expect(isSecret("a/b/key.pem", ["*.pem"])).toBe(true);
    expect(isSecret("config/secrets/x.json", ["config/secrets/**"])).toBe(true);
    expect(isSecret("src/env.ts", [".env", ".env.*"])).toBe(false);
  });
});

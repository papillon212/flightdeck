// M2 완료 기준 "2인이 원격으로 분석 Q&A"를 확장 없이 workflow 수준에서 돌린다.
// 서버(메모리 저장소, 개발용 로그인) + 로컬 bare 원격 + 클론 2개(담당자 dh.lee, 질문 대상 park) + 가짜 일감 도구.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { generateServerKey, keyFingerprint, listThreadBlocks, parseBlocks, ulid, verifyEvent } from "@flightdeck/core";
import { git, RemoteEventStore } from "@flightdeck/git";
import { readEditLog } from "@flightdeck/hook";
import type { Event, Phase } from "@flightdeck/schema";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import type { TrackerAdapter, TrackerEpic, TrackerUser } from "@flightdeck/tracker";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
let root: string, remote: string, srv: Server, url: string;
let A: EpicWorkflow, B: EpicWorkflow, tracker: FakeTracker;
let epic: string;

class FakeTracker implements TrackerAdapter {
  id = "clickup";
  status = new Map<string, string>();
  mentions: { ref: string; to: string[]; text: string; link: string }[] = [];
  constructor(private tasks: TrackerEpic[], private statusMap: Partial<Record<Phase, string>>) {
    for (const t of tasks) this.status.set(t.ref, t.status);
  }
  async me(): Promise<TrackerUser> {
    return { id: "111" };
  }
  async listAssignedEpics() {
    return this.tasks.map((t) => ({ ...t, status: this.status.get(t.ref)! }));
  }
  async getEpic(ref: string) {
    const t = this.tasks.find((x) => x.ref === ref)!;
    return { ...t, status: this.status.get(ref)! };
  }
  async setPhase(ref: string, phase: Phase) {
    if (this.statusMap[phase]) this.status.set(ref, this.statusMap[phase]!);
  }
  async setFields() {}
  async notifyMention(ref: string, to: TrackerUser[], text: string, link: string) {
    this.mentions.push({ ref, to: to.map((u) => u.id), text, link });
  }
}

async function clone(name: string, member: string): Promise<string> {
  const dir = path.join(root, name);
  await git(["clone", "-q", remote, dir], { cwd: root });
  await git(["config", "user.name", member], { cwd: dir });
  await git(["config", "user.email", `${member}@e.com`], { cwd: dir });
  return dir;
}

async function workflow(repo: string, member: string, withTracker: boolean): Promise<EpicWorkflow> {
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(member);
  const config = await server.config("sample");
  const dataDir = path.join(repo, ".git", "flightdeck");
  const configDir = await cacheConfig(dataDir, config);
  return new EpicWorkflow({
    repo, member, configDir, distDir: DIST, adapter: new ClaudeCodeAdapter(),
    remote: { server, product: "sample", config, ...(withTracker ? { tracker } : {}), linkFor: (e, t) => `vscode://flightdeck.flightdeck/open?epic=${e}${t ? `&thread=${t}` : ""}` },
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-collab-test-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  await git(["add", "."], { cwd: seed });
  await git(["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "init"], { cwd: seed });
  await git(["push", "-q", remote, "main"], { cwd: seed });

  const store = new MemoryStore();
  await store.upsertMember({ id: "dh.lee", email: "dh@e.com", active: true, admin: true, tracker_id: "111" }, "test");
  await store.upsertMember({ id: "park", email: "park@e.com", active: true, admin: false, tracker_id: "222" }, "test");
  await store.addConfigVersion({ ...(await readProductDir(SAMPLE, remote)), created_by: "test" });
  const app = createApp({ store, signer: new EventSigner({ store, dataDir: path.join(root, "server"), ...keys }), keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  tracker = new FakeTracker(
    [{ ref: "86abc", epicId: "CU-86abc", title: "토큰 갱신 개선", body: "리프레시 토큰을 회전시킨다.", url: "https://app.clickup.com/t/86abc", status: "to do", tags: ["flightdeck"] }],
    { ANALYSIS: "분석", DESIGN: "설계" },
  );
  A = await workflow(await clone("dh", "dh.lee"), "dh.lee", true);
  B = await workflow(await clone("park", "park"), "park", false);
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

const ANALYSIS = "## 요구사항 요약\n리프레시 토큰을 회전시킨다.\n\n## 영향 범위\nsrc/auth\n\n## 불명확한 점\n- TTL이 몇 분인가?\n\n## 가정\n30분\n";

describe("2인 원격 분석 Q&A (M2 완료 기준)", { timeout: 60_000 }, () => {
  it("A: 내 일감에서 에픽 시작 → 서버 서명 epic.started, 에픽 브랜치에 epic.md, 일감 상태 분석", async () => {
    const mine = await A.assignedEpics();
    expect(mine.map((e) => e.epicId)).toEqual(["CU-86abc"]);
    const r = await A.startFromTracker(mine[0]!);
    epic = "CU-86abc";
    expect(r.state).toMatchObject({ phase: "ANALYSIS", owner: "dh.lee", tracker_ref: "86abc", config_version: "sample-v1" });
    expect(await readFile(path.join(r.worktree, ".flightdeck/epics", epic, "epic.md"), "utf8")).toContain("일감: https://app.clickup.com/t/86abc");
    expect((await git(["ls-remote", remote, `refs/heads/flightdeck/${epic}`], { cwd: root })).trim()).not.toBe("");
    expect(tracker.status.get("86abc")).toBe("분석");
    expect(await A.assignedEpics()).toEqual([]); // 시작한 일감은 목록에서 빠진다
    await expect(B.start(epic, "x", "y")).rejects.toThrow(/이미 @dh.lee이\(가\) 담당한 에픽/);
  });

  it("A: 질문 → 문서 공유 커밋 + 일감 멘션(내용 없이)", async () => {
    const wt = await A.worktree(epic);
    await writeFile(path.join(wt, ".flightdeck/epics", epic, "analysis.md"), ANALYSIS); // 에이전트 초안 대신
    await A.renderDocs(epic);
    const doc = await readFile(path.join(wt, ".flightdeck/epics", epic, "analysis.md"), "utf8");
    const pid = parseBlocks(doc.split("\n")).find((b) => b.text === "- TTL이 몇 분인가?")!.pid!;
    await expect(A.createThread(epic, { file: "analysis.md", pid, kind: "question", to: ["ghost"], body: "?" })).rejects.toThrow(/등록되지 않았거나 비활성인 멤버: @ghost/);
    const t = await A.createThread(epic, { file: "analysis.md", pid, kind: "question", to: ["park"], body: "TTL은 요구사항상 몇 분인가요?" });
    const created = (await A.store.list(epic)).find((e) => e.type === "thread.created") as Event & { type: "thread.created" };
    expect(created.data.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(created.sig).toBeUndefined(); // 일반 이벤트는 서명하지 않는다
    expect((await git(["ls-remote", remote, `refs/heads/flightdeck/${epic}`], { cwd: root })).split(/\s/)[0]).toBe(created.data.commit);
    expect(tracker.mentions).toEqual([{ ref: "86abc", to: ["222"], text: `질문 1건 · analysis.md · ${epic}`, link: `vscode://flightdeck.flightdeck/open?epic=${epic}&thread=${t}` }]);
    expect(JSON.stringify(tracker.mentions)).not.toContain("TTL"); // 질문 내용은 일감 도구에 복제하지 않는다
    expect(A.warnings).toEqual([]);
  });

  it("B: 받은 질문 → 읽기 전용 창(공유 커밋)에 쓰레드가 그려지고, 답글만 단다", async () => {
    const inbox = await B.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ epic, thread: { to: ["park"], body: "TTL은 요구사항상 몇 분인가요?" } });
    const v = await B.openAsViewer(epic, inbox[0]!.commit);
    const doc = await readFile(path.join(v.worktree, ".flightdeck/epics", epic, "analysis.md"), "utf8");
    expect(listThreadBlocks(doc)).toEqual([expect.objectContaining({ id: inbox[0]!.thread.id, status: "open" })]);
    expect(doc.indexOf("TTL은 요구사항상")).toBeGreaterThan(doc.indexOf("- TTL이 몇 분인가?"));
    expect(await B.role(epic)).toBe("viewer");
    // 에이전트 설정: 리뷰 정책 훅 + MCP (v0.13 W7). git에는 잡히지 않는다
    expect(existsSync(path.join(v.worktree, ".claude/settings.local.json"))).toBe(true);
    expect(await git(["status", "--porcelain", "--untracked-files=all"], { cwd: v.worktree })).not.toMatch(/\.claude|\.mcp\.json/);
    // 질문 대상은 리뷰어가 아니라 새 쓰레드를 만들 수 없다 (답글만)
    await expect(B.createThread(epic, { file: "analysis.md", pid: "p:0000", kind: "note", to: [], body: "x" })).rejects.toThrow(/쓰레드 생성 권한 없음/);
    await B.reply(epic, inbox[0]!.thread.id, "30분, 슬라이딩 갱신입니다.");
    expect(await readEditLog(path.join(B.cfg.repo, ".git", "flightdeck"), epic)).toEqual([]); // 읽기 전용 창은 편집 기록을 남기지 않는다
    expect(await B.inbox()).toEqual([]); // 내가 마지막으로 답했으므로
    expect(await readFile(path.join(v.worktree, ".flightdeck/epics", epic, "analysis.md"), "utf8")).toContain("30분, 슬라이딩 갱신입니다.");
  });

  it("위조: 서명 없는 단계 완료를 메타 브랜치에 직접 넣어도 양쪽 모두 무시한다", async () => {
    const forged = { v: 1, id: ulid(), type: "phase.completed", epic, author: "dh.lee", at: new Date().toISOString(), data: { phase: "ANALYSIS" } } as Event;
    await new RemoteEventStore(B.cfg.repo).append(forged); // park이 담당자 이름으로 위조
    for (const w of [A, B]) {
      const s = await w.sync(epic);
      expect(s.phase).toBe("ANALYSIS");
      expect(s.ignored).toContainEqual(expect.objectContaining({ event: forged.id, reason: "서버 서명 없음" }));
    }
  });

  it("A: 답을 보고 해결 → 분석 완료(서버 서명, artifact_hash) → DESIGN, 일감 상태 설계", async () => {
    const s = await A.sync(epic);
    const [t] = [...s.threads.values()];
    expect(t!.replies.map((r) => [r.author, r.body])).toEqual([["park", "30분, 슬라이딩 갱신입니다."]]);
    expect((await A.completePhase(epic)).ok).toBe(false); // 열린 쓰레드
    await A.setThreadStatus(epic, t!.id, true);
    const r = await A.completePhase(epic);
    expect(r).toMatchObject({ ok: true, phase: "DESIGN" });
    const done = (await A.store.list(epic)).filter((e) => e.type === "phase.completed" && e.sig);
    expect(done).toHaveLength(1);
    expect(verifyEvent(done[0]!, keys.publicKey)).toBe(true);
    expect(done[0]!.data).toMatchObject({ phase: "ANALYSIS", artifact_hash: expect.stringMatching(/^sha256:/) });
    expect(tracker.status.get("86abc")).toBe("설계");
    expect((await B.sync(epic)).phase).toBe("DESIGN"); // B에게도 같은 결과
  });
});

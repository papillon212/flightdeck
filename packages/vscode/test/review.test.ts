// M3 완료 기준 "설계가 2티어 통과"를 workflow 수준에서 돌린다 (설계 §4.2 v0.13, m3-plan).
// 서버(메모리) + 로컬 bare 원격 + 클론 3개: 담당자 dh.lee, lead 리뷰어 park, architect 리뷰어 choi.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { generateServerKey, keyFingerprint, parseBlocks, reviewOf } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import type { Phase } from "@flightdeck/schema";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import type { TrackerAdapter, TrackerEpic, TrackerUser } from "@flightdeck/tracker";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-77abc";
let root: string, remote: string, srv: Server, url: string;
let A: EpicWorkflow, P: EpicWorkflow, C: EpicWorkflow;
const tracker = { status: "to do", mentions: [] as { to: string[]; text: string }[] };

class FakeTracker implements TrackerAdapter {
  id = "clickup";
  constructor(private map: Partial<Record<Phase, string>>) {}
  async me(): Promise<TrackerUser> {
    return { id: "111" };
  }
  async listAssignedEpics(): Promise<TrackerEpic[]> {
    return [];
  }
  async getEpic(ref: string): Promise<TrackerEpic> {
    return { ref, epicId: EPIC, title: "", body: "", url: "", status: tracker.status, tags: [] };
  }
  async setPhase(_ref: string, phase: Phase) {
    if (this.map[phase]) tracker.status = this.map[phase]!;
  }
  async setFields() {}
  async notifyMention(_ref: string, to: TrackerUser[], text: string) {
    tracker.mentions.push({ to: to.map((u) => u.id), text });
  }
}

async function member(id: string): Promise<EpicWorkflow> {
  const repo = path.join(root, id);
  await git(["clone", "-q", remote, repo], { cwd: root });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@e.com`]]) await git(["config", k!, v!], { cwd: repo });
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const config = await server.config("sample");
  const configDir = await cacheConfig(path.join(repo, ".git", "flightdeck"), config);
  return new EpicWorkflow({
    repo, member: id, configDir, distDir: DIST, adapter: new ClaudeCodeAdapter(),
    remote: { server, product: "sample", config, tracker: new FakeTracker({ ANALYSIS: "분석", DESIGN: "설계", IMPLEMENTATION: "구현" }) },
  });
}

const ANALYSIS = "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/auth\n\n## 불명확한 점\n- 없음\n\n## 가정\n30분\n";
const DESIGN = "## 개요\n리프레시 토큰을 회전시킨다.\n\n## 변경 컴포넌트\nsrc/auth/token.ts\n\n## 인터페이스\nrefresh(token)\n\n## 데이터 변경\n없음\n\n## 테스트 계획\n단위 테스트\n\n## 리스크\n재사용 탐지\n";
const doc = async (w: EpicWorkflow, file: string) => path.join(await w.worktree(EPIC), ".flightdeck/epics", EPIC, file);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-review-test-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await writeFile(path.join(seed, "README.md"), "# product\n");
  await git(["add", "."], { cwd: seed });
  await git(["-c", "user.name=s", "-c", "user.email=s@e.com", "commit", "-q", "-m", "init"], { cwd: seed });
  await git(["push", "-q", remote, "main"], { cwd: seed });

  const store = new MemoryStore();
  for (const [id, tid] of [["dh.lee", "111"], ["park", "222"], ["choi", "333"]] as const) await store.upsertMember({ id, email: `${id}@e.com`, active: true, admin: id === "dh.lee", tracker_id: tid }, "test");
  const p = await readProductDir(SAMPLE, remote);
  p.pipeline_yaml = p.pipeline_yaml.replace("leads: [kim]", "leads: [park]").replace("architects: [park, lee]", "architects: [choi]");
  await store.addConfigVersion({ ...p, created_by: "test" });
  const app = createApp({ store, signer: new EventSigner({ store, dataDir: path.join(root, "server"), ...keys }), keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  [A, P, C] = [await member("dh.lee"), await member("park"), await member("choi")];

  // DESIGN 단계까지
  await A.start(EPIC, "토큰 회전", "리프레시 토큰을 회전시킨다.", { trackerRef: "77abc" });
  await writeFile(await doc(A, "analysis.md"), ANALYSIS);
  expect(await A.completePhase(EPIC)).toMatchObject({ ok: true, phase: "DESIGN" });
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("설계 2티어 리뷰 (M3 완료 기준)", { timeout: 60_000 }, () => {
  it("담당자: 단계 완료가 아니라 리뷰 요청. 형식이 틀리면 요청하지 않는다", async () => {
    expect(await A.completePhase(EPIC)).toMatchObject({ ok: false, problems: [expect.stringContaining("리뷰 요청")] });
    await writeFile(await doc(A, "design.md"), "## 개요\n회전\n");
    expect(await A.requestReview(EPIC)).toMatchObject({ ok: false, problems: [expect.stringContaining("빠진 섹션")] });
    await writeFile(await doc(A, "design.md"), DESIGN);
    const r = await A.requestReview(EPIC);
    expect(r.ok).toBe(true);
    expect(reviewOf((r as { state: Parameters<typeof reviewOf>[0] }).state)?.current?.name).toBe("lead");
    expect(tracker.mentions.at(-1)).toEqual({ to: ["222"], text: `리뷰 차례(lead) · design.md · ${EPIC}` });
    expect(await C.reviewInbox()).toEqual([]); // architect는 아직 차례가 아님
  });

  it("lead(park): 리뷰 차례 → 읽기 전용 창 → 에이전트가 쓴 초안을 올린다. 초안 밖의 변경은 되돌린다", async () => {
    const [item] = await P.reviewInbox();
    expect(item).toMatchObject({ epic: EPIC, tier: "lead", phase: "DESIGN" });
    await P.openAsViewer(EPIC, item!.commit);
    const f = await doc(P, "design.md");
    const md = await readFile(f, "utf8");
    const risk = parseBlocks(md.split("\n")).find((b) => b.text === "재사용 탐지")!;
    // 에이전트가 하는 일: 리스크 문단 아래 초안 + (규칙을 어기고) 본문도 고침
    const lines = md.split("\n");
    lines.splice(risk.end + 1, 0, "", "<!-- flightdeck:draft kind=change_request to=dh.lee -->", "재사용 탐지 시 모든 세션을 끊는 근거를 적어 주세요.", "<!-- /flightdeck:draft -->");
    await writeFile(f, lines.join("\n").replace("리프레시 토큰을 회전시킨다.", "에이전트가 고친 문장"));
    await P.sync(EPIC);
    expect(P.lastRender).toEqual([expect.objectContaining({ file: "design.md", external: true })]); // 되돌렸다는 표시
    const after = await readFile(f, "utf8");
    expect(after).not.toContain("에이전트가 고친 문장");
    const drafts = await P.drafts(EPIC);
    expect(drafts).toEqual([{ file: "design.md", draft: expect.objectContaining({ kind: "change_request", to: ["dh.lee"], anchor: risk.pid }) }]);

    const t = await P.postDraft(EPIC, "design.md", drafts[0]!.draft.key);
    expect(await P.drafts(EPIC)).toEqual([]);
    const s = await P.epicState(EPIC);
    expect(s.threads.get(t)).toMatchObject({ author: "park", kind: "change_request", anchor: { pid: risk.pid } });
    const created = (await P.store.list(EPIC)).find((e) => e.type === "thread.created" && e.data.thread === t)!;
    expect(created.data).toMatchObject({ source: "agent", commit: item!.commit });
    // 본인이 연 쓰레드가 열려 있으면 승인 거부
    await expect(P.approve(EPIC)).rejects.toThrow(/승인자가 연 열린 쓰레드 1개/);
  });

  it("담당자: 고쳐서 다시 요청 (공유 시 올리지 않은 초안이 있으면 거부)", async () => {
    const f = await doc(A, "design.md");
    await A.sync(EPIC);
    await writeFile(f, (await readFile(f, "utf8")).replace("## 리스크", "## 리스크\n<!-- flightdeck:draft kind=note -->\n개인 메모\n<!-- /flightdeck:draft -->"));
    await expect(A.requestReview(EPIC)).rejects.toThrow(/올리지 않은 쓰레드 초안이 1개/);
    await A.discardDraft(EPIC, "design.md", (await A.drafts(EPIC))[0]!.draft.key);
    await writeFile(f, (await readFile(f, "utf8")).replace("재사용 탐지\n", "재사용 탐지: 같은 리프레시 토큰이 두 번 쓰이면 그 사용자의 모든 세션을 끊는다 (탈취 가정)\n"));
    expect((await A.requestReview(EPIC)).ok).toBe(true);
  });

  it("lead: 쓰레드를 해결하고 승인 → architect 차례, 멘션", async () => {
    const [t] = [...(await P.epicState(EPIC)).threads.values()].filter((x) => x.author === "park");
    await P.reply(EPIC, t!.id, "반영 확인했습니다.");
    await P.setThreadStatus(EPIC, t!.id, true);
    await expect(A.approve(EPIC)).rejects.toThrow(/담당자 자신의 승인/); // 담당자는 유일한 리뷰어인 티어가 없다
    const s = await P.approve(EPIC);
    expect(reviewOf(s)?.current?.name).toBe("architect");
    expect(tracker.mentions.at(-1)).toEqual({ to: ["333"], text: `리뷰 차례(architect) · design.md · ${EPIC}` });
  });

  it("on_change: 담당자가 다시 고쳐 요청하면 lead부터 다시", async () => {
    const f = await doc(A, "design.md");
    await A.sync(EPIC);
    await writeFile(f, (await readFile(f, "utf8")).replace("단위 테스트", "단위 테스트, 재사용 탐지 통합 테스트"));
    expect((await A.requestReview(EPIC)).ok).toBe(true);
    expect(await C.reviewInbox()).toEqual([]);
    expect((await P.reviewInbox()).map((x) => x.tier)).toEqual(["lead"]);
    await P.openAsViewer(EPIC); // 새 요청 커밋으로
    await P.approve(EPIC);
  });

  it("architect(choi): 승인 → IMPLEMENTATION, 일감 상태 구현. 모두 서버 서명", async () => {
    const [item] = await C.reviewInbox();
    expect(item?.tier).toBe("architect");
    const s = await C.approve(EPIC);
    expect(s.phase).toBe("IMPLEMENTATION");
    expect(tracker.status).toBe("구현");
    const approvals = (await C.store.list(EPIC)).filter((e) => e.type === "review.approved");
    expect(approvals.map((e) => [e.author, (e.data as { tier: string }).tier, !!e.sig])).toEqual([
      ["park", "lead", true],
      ["park", "lead", true],
      ["choi", "architect", true],
    ]);
    expect((await A.sync(EPIC)).phase).toBe("IMPLEMENTATION");
  });
});

// M6 완료 기준 "회의 요약이 올바른 쓰레드에 게시"를 workflow 수준에서 (m6-plan).
// 서버(메모리) + 로컬 bare 원격 + 주최자 dh.lee(담당자), 참여자 park. 회의는 시험용 회의 자료(FixtureMeet),
// 앵커링 에이전트는 정해진 답을 돌려주는 가짜(실제 claude는 VS Code 시나리오에서). Meet 응답 해석은 실제 응답 모양으로 따로 본다.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { generateServerKey, keyFingerprint } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { createApp, EventSigner, MemoryStore, readProductDir } from "@flightdeck/server";
import { docBodyText, FixtureMeet, parseArtifacts, parseEntries, parseSpace, RestMeet, waitForNotes, type MeetAdapter } from "../src/meet.ts";
import { cacheConfig, ServerClient } from "../src/server-client.ts";
import { EpicWorkflow } from "../src/workflow.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const DIST = path.resolve(import.meta.dirname, "../../../dist");
const keys = generateServerKey();
const EPIC = "CU-66meet";
let root: string, remote: string, srv: Server, url: string, fixture: string;
let A: EpicWorkflow, P: EpicWorkflow;
let lastPrompt = "";
let answer = "[]";

/** 앵커링 에이전트 대역: 받은 지시문을 남기고 정해진 JSON을 돌려준다 */
class FakeAgent extends ClaudeCodeAdapter {
  override async headless(prompt: string, o: { cwd: string }) {
    lastPrompt = prompt;
    return { sessionId: "fake", cwd: o.cwd, result: answer };
  }
}

async function member(id: string): Promise<EpicWorkflow> {
  const repo = path.join(root, id);
  await git(["clone", "-q", remote, repo], { cwd: root });
  for (const [k, v] of [["user.name", id], ["user.email", `${id}@test.local`]]) await git(["config", k!, v!], { cwd: repo });
  const server = new ServerClient(url, null, keyFingerprint(keys.publicKey));
  await server.devLogin(id);
  const config = await server.config("sample");
  const configDir = await cacheConfig(path.join(repo, ".git", "flightdeck"), config);
  return new EpicWorkflow({ repo, member: id, configDir, distDir: DIST, adapter: new FakeAgent(), remote: { server, product: "sample", config } });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-meet-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  const seed = path.join(root, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: root });
  await mkdir(path.join(seed, "src"), { recursive: true });
  await writeFile(path.join(seed, "src/token.js"), "function rotate(t) {\n  return t + 1;\n}\nmodule.exports = { rotate };\n");
  for (const a of [["add", "."], ["-c", "user.name=s", "-c", "user.email=s@test.local", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) await git(a, { cwd: seed });
  const store = new MemoryStore();
  for (const id of ["dh.lee", "park"]) await store.upsertMember({ id, email: `${id}@test.local`, active: true, admin: id === "dh.lee" }, "test");
  await store.addConfigVersion({ ...(await readProductDir(SAMPLE, remote)), created_by: "test" });
  const signer = new EventSigner({ store, dataDir: path.join(root, "server"), ...keys });
  const app = createApp({ store, signer, keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  [A, P] = [await member("dh.lee"), await member("park")];
  fixture = path.join(root, "meeting");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "notes.md"), "## 요약\n액세스 토큰 TTL은 30분, 슬라이딩 갱신으로 정했다.\n## 다음 단계\n- dh.lee: 설계에 반영\n");
  await writeFile(path.join(fixture, "transcript.json"), JSON.stringify([{ participant: "park", startTime: "2026-10-05T10:01:00Z", text: "TTL은 30분이 좋겠습니다" }]));
  await A.start(EPIC, "토큰 회전", "리프레시 토큰을 회전시킨다.");
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("회의 → 요약 게시 (M6 완료 기준)", { timeout: 60_000 }, () => {
  let sid = "";
  let question = "";

  it("회의 시작 → 참여자 포커스 → 주최자 종료 (G1)", async () => {
    const dir = path.join(await A.worktree(EPIC), ".flightdeck/epics", EPIC);
    await writeFile(path.join(dir, "analysis.md"), "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/token.js\n\n## 불명확한 점\n- 액세스 토큰 TTL은?\n\n## 가정\n없음\n");
    await A.sync(EPIC);
    const pid = /<!-- (p:[0-9a-f]{4}) -->\n- 액세스 토큰 TTL은\?/.exec(await readFile(path.join(dir, "analysis.md"), "utf8"))![1]!;
    question = await A.createThread(EPIC, { file: "analysis.md", pid, kind: "question", to: ["park"], body: "액세스 토큰 TTL은 몇 분인가요?" });
    const r = await A.startSession(EPIC, "TTL 논의", new FixtureMeet(fixture));
    sid = r.sid;
    expect(r.space.uri).toContain("meet.google.com");
    await P.pull();
    const s = await P.epicState(EPIC);
    expect(s.sessions.get(sid)).toMatchObject({ host: "dh.lee", title: "TTL 논의" });
    await expect(P.endSession(EPIC, sid)).rejects.toThrow(/주최자만/);
    await A.endSession(EPIC, sid);
    await P.pull();
    await P.postFocus(EPIC, sid, [{ ts: new Date().toISOString(), file: "src/token.js", range: [2, 2] }]);
    await A.pull();
    expect((await A.epicState(EPIC)).sessions.get(sid)!.focus.map((f) => f.member)).toEqual(["park"]);
  });

  it("주최자: 회의록·전사·포커스·쓰레드로 앵커링 초안을 만든다 (G3·G6)", async () => {
    answer = JSON.stringify([
      { target: { thread: question }, summary: "TTL은 30분, 슬라이딩 갱신", decisions: ["30분"], actions: [] },
      { target: { file: "src/token.js", lines: [2, 2] }, summary: "rotate의 갱신 시점을 30분 기준으로", decisions: [], actions: ["dh.lee: 구현에 반영"] },
      { target: { epic: true }, summary: "다음 회의는 금요일" },
    ]);
    const r = await A.collectSession(EPIC, sid, new FixtureMeet(fixture), { intervalMs: 1 });
    expect(r.notes.notes).toContain("30분");
    expect(lastPrompt).toContain(question);
    expect(lastPrompt).toContain("@park src/token.js:2-2");
    expect(lastPrompt).toContain("TTL은 30분이 좋겠습니다");
    expect(r.items).toHaveLength(3);
    const md = await readFile(r.draft, "utf8");
    expect(md).toContain(`target=thread:${question}`);
    // 주최자 검토: 문장을 고친다
    await writeFile(r.draft, md.replace("TTL은 30분, 슬라이딩 갱신", "TTL은 30분, 쓸 때마다 슬라이딩 갱신"));
  });

  it("게시: 그 쓰레드에 회의 요약 답글, 코드 위치에 새 쓰레드, 요약 파일은 에픽 브랜치로 (G4)", async () => {
    const r = await A.publishSession(EPIC, sid);
    expect(r).toEqual({ replies: 1, created: 1, epicItems: 1 });
    await P.pull();
    const s = await P.epicState(EPIC);
    const reply = s.threads.get(question)!.replies.at(-1)!;
    expect(reply).toMatchObject({ author: "dh.lee", source: "session", body: expect.stringContaining("쓸 때마다 슬라이딩 갱신") });
    const code = [...s.threads.values()].find((t) => t.anchor.type === "code")!;
    expect(code).toMatchObject({ kind: "note", file: "src/token.js", anchor: { range: [2, 2] }, body: expect.stringContaining(`🎙 회의 ${sid}`) });
    expect(s.sessions.get(sid)!.published).toMatchObject({ items: 3 });
    const head = (await git(["ls-remote", remote, `refs/heads/flightdeck/${EPIC}`], { cwd: root })).split("\t")[0]!;
    const file = await git(["show", `${head}:.flightdeck/epics/${EPIC}/sessions/${sid}.md`], { cwd: A.cfg.repo });
    expect(file).toContain("## 에픽 전체\n다음 회의는 금요일");
    await expect(A.publishSession(EPIC, sid)).rejects.toThrow(/이미 게시한 회의/);
  });
});

describe("Meet 응답 해석 (실제 응답 모양, M0 10번)", () => {
  it("공간·회의록·전사·문서 본문", () => {
    expect(parseSpace({ name: "spaces/abc", meetingUri: "https://meet.google.com/abc-defg-hij", meetingCode: "abc-defg-hij", config: { artifactConfig: { smartNotesConfig: { autoSmartNotesGeneration: "ON" }, transcriptionConfig: {} } } })).toEqual({
      name: "spaces/abc",
      uri: "https://meet.google.com/abc-defg-hij",
      code: "abc-defg-hij",
      artifacts: { notes: "ON", transcript: "알 수 없음" },
    });
    expect(parseArtifacts({ smartNotes: [{ name: "n1", state: "FILE_GENERATED", docsDestination: { document: "doc1" } }] }, { transcripts: [{ name: "t1", state: "STARTED" }] })).toEqual({ notes: [{ name: "n1", state: "FILE_GENERATED", docId: "doc1" }], transcripts: [{ name: "t1", state: "STARTED" }] });
    expect(parseEntries([{ transcriptEntries: [{ participant: "p/1", text: "안녕", startTime: "a", endTime: "b", languageCode: "ko" }] }, {}])).toEqual([{ participant: "p/1", text: "안녕", startTime: "a", endTime: "b" }]);
    expect(docBodyText({ body: { content: [{ paragraph: { elements: [{ textRun: { content: "요약\n" } }] } }, { sectionBreak: {} }, { paragraph: { elements: [{ textRun: { content: "TTL 30분" } }] } }] } })).toBe("요약\nTTL 30분");
  });

  it("REST: 공간 필터·페이지 처리, 회의록 대기(끝나기 전 → 생성 중 → 생성됨)", async () => {
    const calls: string[] = [];
    let phase = 0;
    const f = (async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${u.replace("https://meet.googleapis.com/v2/", "").replace("https://docs.googleapis.com/v1/", "docs:")}`);
      const body = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (u.includes("conferenceRecords?")) return body({ conferenceRecords: phase === 0 ? [{ name: "conferenceRecords/c1", startTime: "a" }] : [{ name: "conferenceRecords/c1", startTime: "a", endTime: "b" }] });
      if (u.endsWith("/smartNotes")) return body({ smartNotes: [{ name: "n", state: phase < 2 ? "STARTED" : "FILE_GENERATED", docsDestination: { document: "d1" } }] });
      if (u.endsWith("/transcripts")) return body({ transcripts: [{ name: "conferenceRecords/c1/transcripts/t1", state: "FILE_GENERATED" }] });
      if (u.includes("/entries")) return body(u.includes("pageToken") ? { transcriptEntries: [{ participant: "p", text: "2", startTime: "s" }] } : { transcriptEntries: [{ participant: "p", text: "1", startTime: "s" }], nextPageToken: "x" });
      if (u.includes("documents/")) return body({ body: { content: [{ paragraph: { elements: [{ textRun: { content: "회의록" } }] } }] } });
      throw new Error(u);
    }) as typeof fetch;
    const meet: MeetAdapter = new RestMeet(async () => "tok", f);
    const waits: string[] = [];
    const r = await waitForNotes(meet, "spaces/abc", { intervalMs: 1, sleep: async () => void phase++, onWait: (m) => waits.push(m) });
    expect(r).toMatchObject({ conference: { name: "conferenceRecords/c1" }, notes: "회의록", notesDoc: "d1" });
    expect(r.transcript.map((e) => e.text)).toEqual(["1", "2"]);
    expect(waits.map((w) => w.split(" ")[0])).toEqual(["회의", "회의록"]);
    expect(calls[0]).toBe(`GET conferenceRecords?filter=${encodeURIComponent('space.name="spaces/abc"').replace(/%20/g, "+")}`);
  });

  it("회의록이 끝내 없으면 시간을 넘긴 뒤 회의록 없이(전사는 있으면) (G6)", async () => {
    const meet: MeetAdapter = {
      kind: "x",
      createSpace: async () => ({ name: "s", uri: "u" }),
      conferences: async () => [{ name: "c", startTime: "a", endTime: "b" }],
      artifacts: async () => ({ notes: [], transcripts: [] }),
      transcriptEntries: async () => [],
      docText: async () => "",
    };
    expect(await waitForNotes(meet, "s", { intervalMs: 1, timeoutMs: 5 })).toMatchObject({ notes: null, transcript: [] });
  });
});

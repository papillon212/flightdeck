// M2 수동 시나리오 자동 진행 (개발 모드 + FLIGHTDECK_SCENARIO=<결과 폴더>일 때만). docs/m2-plan.md "M2 수동 시나리오".
// 실제 VS Code 창 두 개(멤버별)에서 확장이 스스로 단계를 진행한다. 화면 클릭 대신:
// - 빠른 선택·거터 +·알림 버튼처럼 사람이 고르는 곳은 그 선택이 부르는 함수를 직접 부른다.
// - 답글·해결·단계 완료는 확장의 명령(flightdeck.reply/resolve/completePhase)을 그대로 실행한다.
// - 에이전트 초안 대신 정해진 분석 문서를 쓴다 (구독 사용량 절약. 초안 작성은 M1에서 확인).
// 단계 결과는 <결과 폴더>/<멤버>.jsonl에 한 줄씩 남긴다.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { parseBlocks } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import type { EpicWorkflow } from "./workflow.ts";

export interface ScenarioHooks {
  wf: EpicWorkflow;
  epic: string | null;
  worktree: string | null;
  role: "owner" | "viewer";
  /** 이 창에 그려진 쓰레드 (Comments API) */
  commentThread(id: string): vscode.CommentThread | undefined;
  /** 이 창에 그려진 쓰레드 초안 (Comments API) */
  draftThreads(): vscode.CommentThread[];
  commentThreadCount(): number;
  statusText(): string;
  /** 확장이 띄운 알림 문구 (받은 질문, 새 답글) */
  notifications: string[];
  refresh(): Promise<void>;
  openViewer(epic: string, commit?: string): Promise<void>;
}

const TASK = "[M2 시나리오]";
const ANALYSIS = [
  "## 요구사항 요약",
  "리프레시 토큰을 쓸 때마다 새 토큰을 발급하고 이전 토큰은 무효로 한다.",
  "",
  "## 영향 범위",
  "- src/auth/token.ts: 발급·갱신",
  "",
  "## 불명확한 점",
  "- 액세스 토큰 TTL은 몇 분인가?",
  "- 재사용 탐지 시 모든 세션을 끊는가?",
  "",
  "## 가정",
  "- 재사용 탐지 시 해당 사용자의 모든 세션을 끊는다",
  "",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 5 * 60_000, everyMs = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`시간 초과: ${what}`);
    await sleep(everyMs);
  }
}

export async function runScenario(h: ScenarioHooks, dir: string): Promise<void> {
  const me = h.wf.cfg.member;
  await mkdir(dir, { recursive: true });
  const t0 = Date.now();
  const log = async (step: string, data: unknown) => {
    await appendFile(path.join(dir, `${me}.jsonl`), JSON.stringify({ at: new Date().toISOString(), sec: Math.round((Date.now() - t0) / 1000), step, ...(data as object) }) + "\n");
  };
  try {
    if (process.env.FLIGHTDECK_SCENARIO_KIND === "m3") return await runM3(h, log);
    if (me === "dh.lee" && !h.epic) return await ownerStart(h, log);
    if (me === "dh.lee" && h.role === "owner") return await ownerAsk(h, log);
    if (me === "park" && !h.epic) return await viewerWait(h, log);
    if (me === "park" && h.role === "viewer") return await viewerReply(h, log);
    await log("건너뜀", { me, epic: h.epic, role: h.role });
  } catch (e) {
    await log("오류", { error: (e as Error).stack ?? String(e) });
  }
}

type Log = (step: string, data: unknown) => Promise<void>;

/** 1. [dh.lee] 내 일감에서 에픽 시작 → 분석 문서 작성 → 작업 폴더 열기 */
async function ownerStart(h: ScenarioHooks, log: Log) {
  const list = await h.wf.assignedEpics();
  const t = list.find((e) => e.title.includes(TASK));
  await log("내 일감", { list: list.map((e) => `${e.epicId} ${e.status} ${e.title}`) });
  if (!t) throw new Error("시나리오 일감이 내 일감에 없다");
  const r = await h.wf.startFromTracker(t); // 빠른 선택에서 이 일감을 고른 것과 같다
  const doc = path.join(r.worktree, ".flightdeck/epics", t.epicId, "analysis.md");
  await writeFile(doc, ANALYSIS); // 에이전트 초안 대신
  await log("에픽 시작", { epic: t.epicId, phase: r.state.phase, owner: r.state.owner, config: r.state.config_version, tracker: (await h.wf.cfg.remote!.tracker!.getEpic(t.ref)).status, warnings: h.wf.warnings.splice(0) });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: false });
}

/** 3·5. [dh.lee] 작업 폴더: 질문 → 답글 알림 기다림 → 해결 → 단계 완료 */
async function ownerAsk(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const file = path.join(h.worktree!, ".flightdeck/epics", epic, "analysis.md");
  await h.refresh(); // 문단 ID 부여
  let s = await h.wf.epicState(epic);
  let tid = [...s.threads.keys()][0];
  if (!tid) {
    const lines = (await readFile(file, "utf8")).split("\n");
    const pid = parseBlocks(lines).find((b) => b.text.startsWith("- 액세스 토큰 TTL"))!.pid!;
    // 거터 +에서 "질문"을 고르고 "@park …"을 올린 것과 같다
    tid = await h.wf.createThread(epic, { file: "analysis.md", pid, kind: "question", to: ["park"], body: "@park 액세스 토큰 TTL은 요구사항상 몇 분인가요?" });
    await h.refresh();
    await log("질문", { thread: tid, commentThreads: h.commentThreadCount(), status: h.statusText(), warnings: h.wf.warnings.splice(0) });
  }
  const t1 = Date.now();
  const note = await until("park의 답글 알림", async () => h.notifications.find((n) => n.includes("@park이(가) 답했습니다")));
  s = await h.wf.epicState(epic);
  await log("답글 알림", { notification: note, waitSec: Math.round((Date.now() - t1) / 1000), replies: s.threads.get(tid)!.replies.map((r) => `@${r.author}: ${r.body}`) });

  await vscode.commands.executeCommand("flightdeck.resolve", h.commentThread(tid)); // 쓰레드 제목의 해결 버튼
  await log("해결", { status: (await h.wf.epicState(epic)).threads.get(tid)!.status });
  void vscode.commands.executeCommand("flightdeck.completePhase"); // 끝나면 정보 알림을 띄우고 기다리므로 기다리지 않는다
  await until("DESIGN", async () => (await h.wf.epicState(epic)).phase === "DESIGN", 2 * 60_000, 2000);
  await sleep(1500);
  const ref = (await h.wf.epicState(epic)).tracker_ref!;
  const done = (await h.wf.store.list(epic)).filter((e) => e.type === "phase.completed" && e.sig);
  await log("단계 완료", { status: h.statusText(), tracker: (await h.wf.cfg.remote!.tracker!.getEpic(ref)).status, signedPhaseCompleted: done.map((e) => ({ author: e.author, data: e.data })), warnings: h.wf.warnings.splice(0) });
}

/** 2. [park] 받은 질문 알림 기다림 → 읽기 전용 창 열기 */
async function viewerWait(h: ScenarioHooks, log: Log) {
  const t1 = Date.now();
  const note = await until("받은 질문 알림", async () => h.notifications.find((n) => n.includes("@dh.lee의 질문")));
  const item = (await h.wf.inbox())[0]!;
  await log("받은 질문 알림", { notification: note, waitSec: Math.round((Date.now() - t1) / 1000), epic: item.epic, thread: item.thread.id, commit: item.commit });
  await h.openViewer(item.epic, item.commit); // 알림의 "열기" 버튼
}

/** 4·6. [park] 읽기 전용 창: 쓰레드 확인 → 답글 → 단계 완료 반영 기다림 */
async function viewerReply(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  const s = await h.wf.epicState(epic);
  const t = [...s.threads.values()].find((x) => x.to.includes("park"))!;
  let createError = "";
  await h.wf.createThread(epic, { file: "analysis.md", pid: "p:0000", kind: "note", to: [], body: "x" }).catch((e) => (createError = (e as Error).message));
  const head = (await git(["rev-parse", "HEAD"], { cwd: h.worktree! })).trim();
  await log("읽기 전용 창", {
    status: h.statusText(),
    commentThreads: h.commentThreadCount(),
    canReply: h.commentThread(t.id)?.canReply,
    readonlyInclude: vscode.workspace.getConfiguration("files").get("readonlyInclude"),
    createThreadError: createError,
    head,
  });
  if (!t.replies.some((r) => r.author === "park")) {
    await vscode.commands.executeCommand("flightdeck.reply", { thread: h.commentThread(t.id), text: "30분, 슬라이딩 갱신입니다." }); // 쓰레드 답글 입력 → 올리기
    await log("답글", { replies: (await h.wf.epicState(epic)).threads.get(t.id)!.replies.map((r) => `@${r.author}: ${r.body}`), status: h.statusText() });
  }
  const t1 = Date.now();
  await until("DESIGN 반영", async () => {
    await h.refresh();
    return h.statusText().includes("DESIGN");
  }, 5 * 60_000, 5000);
  await log("단계 완료 반영", { status: h.statusText(), waitSec: Math.round((Date.now() - t1) / 1000) });
}

// ---------------------------------------------------------------- M3: 설계 2티어 리뷰 (docs/m3-plan.md)
// 담당자 dh.lee, lead park, architect choi. park의 에이전트(실제 claude haiku 1회)가 수정 요청 초안을 쓰고 park이 올린다.

const M3_TASK = "[M3 시나리오]";
const DESIGN = [
  "## 개요", "리프레시 토큰을 쓸 때마다 새 토큰을 발급하고 이전 토큰은 무효로 한다.", "",
  "## 변경 컴포넌트", "- src/auth/token.ts: refresh()", "",
  "## 인터페이스", "- refresh(refreshToken, userId) → { access, refresh }", "",
  "## 데이터 변경", "- 리프레시 토큰 저장소에 사용 여부(used) 추가", "",
  "## 테스트 계획", "- 회전·재사용 단위 테스트", "",
  "## 리스크", "- 재사용 탐지", "",
].join("\n");

async function runM3(h: ScenarioHooks, log: Log) {
  const me = h.wf.cfg.member;
  if (me === "dh.lee" && !h.epic) return m3OwnerStart(h, log);
  if (me === "dh.lee") return m3Owner(h, log);
  if (!h.epic) return m3ReviewerWait(h, log);
  if (me === "park") return m3Lead(h, log);
  if (me === "choi") return m3Architect(h, log);
}

/** 1. [dh.lee] 내 일감에서 시작 → 분석 완료(서버 서명) → 설계 문서 → 작업 폴더 */
async function m3OwnerStart(h: ScenarioHooks, log: Log) {
  const t = (await h.wf.assignedEpics()).find((e) => e.title.includes(M3_TASK));
  if (!t) throw new Error("M3 시나리오 일감이 내 일감에 없다");
  const r = await h.wf.startFromTracker(t);
  const dir = path.join(r.worktree, ".flightdeck/epics", t.epicId);
  await writeFile(path.join(dir, "analysis.md"), ANALYSIS);
  const done = await h.wf.completePhase(t.epicId);
  await writeFile(path.join(dir, "design.md"), DESIGN); // 에이전트 설계 초안 대신
  await log("에픽 시작·분석 완료", { epic: t.epicId, config: r.state.config_version, completed: done, warnings: h.wf.warnings.splice(0) });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: false });
}

/** 2·5. [dh.lee] 리뷰 요청 → park의 수정 요청 알림 → 답글·문서 수정·다시 요청 → IMPLEMENTATION까지 */
async function m3Owner(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  let s = await h.wf.epicState(epic);
  if (!s.review.requested) {
    await vscode.commands.executeCommand("flightdeck.requestReview");
    s = await until("리뷰 요청", async () => {
      const x = await h.wf.epicState(epic);
      return x.review.requested ? x : null;
    }, 2 * 60_000, 2000);
    await log("리뷰 요청", { status: h.statusText(), hash: s.review.requested!.hash, warnings: h.wf.warnings.splice(0) });
  }
  const first = s.review.requested!.event;
  const t1 = Date.now();
  const note = await until("park의 수정 요청 알림", async () => h.notifications.find((n) => n.includes("@park의 질문")));
  s = await h.wf.epicState(epic);
  const cr = [...s.threads.values()].find((t) => t.author === "park")!;
  await log("수정 요청 알림", { notification: note, waitSec: Math.round((Date.now() - t1) / 1000), thread: cr.id, kind: cr.kind, body: cr.body });

  await vscode.commands.executeCommand("flightdeck.reply", { thread: h.commentThread(cr.id), text: "리스크에 근거를 적었습니다. 다시 봐 주세요." });
  const f = path.join(h.worktree!, ".flightdeck/epics", epic, "design.md");
  await writeFile(f, (await readFile(f, "utf8")).replace("- 재사용 탐지\n", "- 재사용 탐지: 같은 리프레시 토큰이 두 번 쓰이면 탈취로 보고 그 사용자의 모든 세션을 끊는다\n"));
  await sleep(1500); // 파일 감시 → 다시 그림
  await vscode.commands.executeCommand("flightdeck.requestReview");
  s = await until("다시 요청", async () => {
    const x = await h.wf.epicState(epic);
    return x.review.requested && x.review.requested.event !== first ? x : null;
  }, 2 * 60_000, 2000);
  await log("수정 후 다시 요청", { status: h.statusText(), lead: s.review.approvals.length });

  const t2 = Date.now();
  await until("IMPLEMENTATION", async () => {
    await h.refresh();
    return (await h.wf.epicState(epic)).phase === "IMPLEMENTATION";
  }, 8 * 60_000, 5000);
  const ref = (await h.wf.epicState(epic)).tracker_ref!;
  const approvals = (await h.wf.store.list(epic)).filter((e) => e.type === "review.approved").map((e) => `${e.author}/${(e.data as { tier: string }).tier}/${e.sig ? "서명" : "서명 없음"}`);
  await log("설계 통과", { waitSec: Math.round((Date.now() - t2) / 1000), status: h.statusText(), tracker: (await h.wf.cfg.remote!.tracker!.getEpic(ref)).status, approvals });
}

/** 3. [park·choi] 리뷰 차례 알림 → 읽기 전용 창 */
async function m3ReviewerWait(h: ScenarioHooks, log: Log) {
  const t1 = Date.now();
  const note = await until("리뷰 차례 알림", async () => h.notifications.find((n) => n.includes("리뷰 차례입니다")), 10 * 60_000);
  const [item] = await h.wf.reviewInbox();
  await log("리뷰 차례 알림", { notification: note, waitSec: Math.round((Date.now() - t1) / 1000), item });
  await h.openViewer(item!.epic, item!.commit);
}

/** 4. [park] 에이전트(실제 claude)에게 검사·수정 요청 초안을 시키고 올림 → 담당자 수정·재요청 → 해결·승인 */
async function m3Lead(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  await log("읽기 전용 창", { status: h.statusText() });
  const s0 = await h.wf.epicState(epic);
  if (![...s0.threads.values()].some((t) => t.author === "park")) {
    const prompt = [
      `.flightdeck/epics/${epic}/design.md를 읽고, '## 리스크' 섹션의 목록 항목 바로 아래에 담당자 dh.lee에게 보내는 수정 요청 쓰레드 초안을 하나 달아 주세요.`,
      "내용: 재사용 탐지 시 어떤 조치를 하는지(세션을 끊는지)와 근거를 적어 주세요.",
      "세션 맥락의 쓰레드 초안 문법(kind=change_request to=dh.lee)을 따르고, 문서의 다른 내용은 고치지 마세요.",
    ].join("\n");
    const t1 = Date.now();
    const r = await h.wf.cfg.adapter.headless!(prompt, { cwd: h.worktree!, model: "haiku", maxTurns: 12, allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "mcp__flightdeck"] });
    await until("초안 표시", async () => {
      await h.refresh();
      return h.draftThreads().length > 0;
    }, 60_000, 2000);
    const drafts = await h.wf.drafts(epic);
    await log("에이전트 초안", { sec: Math.round((Date.now() - t1) / 1000), result: r.result.slice(0, 300), drafts: drafts.map((d) => ({ kind: d.draft.kind, to: d.draft.to, anchor: d.draft.anchor, body: d.draft.body, error: d.draft.error })) });
    await vscode.commands.executeCommand("flightdeck.postDraft", h.draftThreads()[0]); // 초안의 "올리기" 버튼
    const s1 = await h.wf.epicState(epic);
    const mine = [...s1.threads.values()].find((t) => t.author === "park");
    const ev = (await h.wf.store.list(epic)).find((e) => e.type === "thread.created" && e.data.thread === mine?.id);
    await log("초안 올림", { thread: mine?.id, kind: mine?.kind, source: (ev?.data as { source?: string })?.source, drafts: h.draftThreads().length, approveError: await h.wf.approve(epic).then(() => "승인됨(예상 밖)", (e) => (e as Error).message) });
  }
  const first = (await h.wf.epicState(epic)).review.requested!.event;
  const t2 = Date.now();
  await until("담당자 재요청", async () => {
    await h.wf.openAsViewer(epic);
    await h.refresh();
    const s = await h.wf.epicState(epic);
    return s.review.requested?.event !== first;
  }, 8 * 60_000, 5000);
  const s2 = await h.wf.epicState(epic);
  const mine = [...s2.threads.values()].find((t) => t.author === "park")!;
  await log("재요청 받음", { waitSec: Math.round((Date.now() - t2) / 1000), replies: mine.replies.map((r) => `@${r.author}: ${r.body}`), viewHead: (await git(["rev-parse", "HEAD"], { cwd: h.worktree! })).trim() === s2.review.requested!.commit });
  await vscode.commands.executeCommand("flightdeck.resolve", h.commentThread(mine.id));
  const s3 = await h.wf.approve(epic); // 승인 확인 창의 "승인"
  await log("lead 승인", { status: h.statusText(), next: s3.review.requested ? "architect 차례" : "-", approvals: s3.review.approvals.map((a) => `${a.author}/${a.tier}`) });
}

/** 6. [choi] architect 승인 → IMPLEMENTATION */
async function m3Architect(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  await log("읽기 전용 창", { status: h.statusText() });
  const s = await h.wf.approve(epic);
  await h.refresh();
  await log("architect 승인", { phase: s.phase, status: h.statusText() });
}

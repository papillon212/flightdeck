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
  role: "owner" | "viewer" | "review";
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
    if (process.env.FLIGHTDECK_SCENARIO_KIND === "m4") return await runM4(h, log);
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

// ---------------------------------------------------------------- M4: 구현·기록 (docs/m4-plan.md)
// 담당자 dh.lee(설정 sample-m4: lead = dh.lee 혼자라 스스로 승인, architect 없음 → 건너뜀), 질문 대상 park.
// 담당자의 에이전트(실제 claude haiku 1회)가 2 Step으로 구현한다 → 사람 직접 수정·외부 변경 → 제출 차단 → 메모 → 통과.
// park의 에이전트(실제 claude haiku 1회)가 읽기 전용 창에서 세션 원본을 검색한다.

const M4_TASK = "[M4 시나리오]";
const M4_DESIGN = [
  "## 개요", "src/token.js에 리프레시 토큰 회전 함수 rotate를 만든다. CommonJS 모듈(module.exports)이다.", "",
  "## 변경 컴포넌트", "- src/token.js: rotate(store, token)", "",
  "## 인터페이스", "- rotate(store, token) → 새 토큰 문자열. store는 Map(토큰 → { used: boolean }). 새 토큰을 { used: false }로 넣고 이전 토큰을 used: true로 바꾼다", "",
  "## 데이터 변경", "- 없음 (메모리 Map)", "",
  "## 테스트 계획", "- 레포의 node check.js", "",
  "## 리스크", "- 이미 쓴 토큰을 다시 쓰면 Error('reused')를 던진다 (재사용 탐지)", "",
].join("\n");

async function runM4(h: ScenarioHooks, log: Log) {
  const me = h.wf.cfg.member;
  if (me === "dh.lee" && !h.epic) return m4OwnerStart(h, log);
  if (me === "dh.lee") return m4Owner(h, log);
  if (me === "park" && !h.epic) return m4ViewerWait(h, log);
  if (me === "park") return m4Viewer(h, log);
}

/** 1. [dh.lee] 시작 → 분석 완료 → 설계 → 리뷰 요청 → 스스로 lead 승인(유일한 리뷰어) → IMPLEMENTATION → 작업 폴더 */
async function m4OwnerStart(h: ScenarioHooks, log: Log) {
  const t = (await h.wf.assignedEpics()).find((e) => e.title.includes(M4_TASK));
  if (!t) throw new Error("M4 시나리오 일감이 내 일감에 없다");
  const r = await h.wf.startFromTracker(t);
  const dir = path.join(r.worktree, ".flightdeck/epics", t.epicId);
  await writeFile(path.join(dir, "analysis.md"), ANALYSIS);
  const done = await h.wf.completePhase(t.epicId);
  await writeFile(path.join(dir, "design.md"), M4_DESIGN);
  const req = await h.wf.requestReview(t.epicId);
  const s = await h.wf.approve(t.epicId);
  await log("에픽 시작 → IMPLEMENTATION", { epic: t.epicId, config: r.state.config_version, analysis: done.ok, review: req.ok, phase: s.phase, warnings: h.wf.warnings.splice(0) });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: false });
}

/** 2~5. [dh.lee] 에이전트 구현(2 Step) → 직접 수정·외부 변경 → 제출 차단 → 메모 → 제출 → VERIFICATION */
async function m4Owner(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const wt = h.worktree!;
  await h.refresh();
  const dataDir = await h.wf.eng.dataDir();
  const { readState, readEditLog } = await import("@flightdeck/hook");
  const { RunStore } = await import("@flightdeck/git");
  if ((await readState(dataDir, epic)).impl_step === 0) {
    const prompt = [
      `Flightdeck IMPLEMENTATION 단계입니다. .flightdeck/epics/${epic}/design.md의 설계대로 구현하세요. 두 Step으로 나눕니다.`,
      "Step 1: src/token.js에 rotate(store, token)를 만든다 (새 토큰 발급·저장, 이전 토큰 used 표시). 끝나면 flightdeck_log_step으로 기록 (design_ref는 '## 인터페이스' 아래 문단의 ID).",
      "Step 2: 이미 쓴 토큰이면 Error('reused')를 던진다. node check.js로 확인하고 flightdeck_log_step으로 기록 (design_ref는 '## 리스크' 아래 문단의 ID).",
      "새 토큰은 crypto.randomBytes(16).toString('hex')로 만든다. 마지막에 flightdeck_submit으로 검사하고 결과를 한 줄로 알려 주세요. handoff.md는 쓰지 않아도 됩니다.",
    ].join("\n");
    const t1 = Date.now();
    const r = await h.wf.cfg.adapter.headless!(prompt, { cwd: wt, model: "haiku", maxTurns: 30, allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "mcp__flightdeck"] });
    await sleep(3000); // 백그라운드 push
    const st = await readState(dataDir, epic);
    const log0 = await readEditLog(dataDir, epic);
    const implLog = await readFile(path.join(wt, ".flightdeck/epics", epic, "impl-log.md"), "utf8").catch(() => "");
    const { parseImplLog } = await import("@flightdeck/core");
    await log("에이전트 구현", {
      sec: Math.round((Date.now() - t1) / 1000),
      result: r.result.slice(0, 400),
      impl_step: st.impl_step,
      steps: parseImplLog(implLog).steps.map((x) => ({ n: x.n, title: x.title, design_ref: x.design_ref, ckpt: x.ckpt.slice(0, 10), changes: x.changes })),
      agentEdits: log0.filter((x) => x.source.kind === "agent" || x.source.kind === "agent_shell").map((x) => `${x.source.kind}:${x.file}:step${"step" in x.source ? x.source.step : "-"}`),
      checkpoints: (await h.wf.checkpoints(epic)).map((c) => `${c.sha.slice(0, 7)} ${c.message.split("\n")[0]} ${c.trailers["Flightdeck-Step"] ?? ""}`),
      runs: await new RunStore(h.wf.cfg.repo).files(epic),
      remoteRefs: (await git(["ls-remote", h.wf.gitRemote], { cwd: h.wf.cfg.repo })).split("\n").filter((l) => l.includes(`refs/flightdeck/`) && l.includes(epic)).map((l) => l.split("\t")[1]),
      trace: (await readFile(path.join(wt, ".flightdeck/epics", epic, "trace.jsonl"), "utf8").catch(() => "")).trim().split("\n").length,
    });
  }
  await h.refresh();
  await log("구현 후 상태", { status: h.statusText(), check: await h.wf.implementationStatus(epic).then((s) => ({ unexplained: s.coverage.unexplained.length, implLog: s.implLog })) });

  // 사람 직접 수정: 에디터로 주석 한 줄 넣고 저장 (HumanEdits가 human으로 기록)
  const doc = await vscode.workspace.openTextDocument(path.join(wt, "src/token.js"));
  await vscode.window.showTextDocument(doc);
  const we = new vscode.WorkspaceEdit();
  we.insert(doc.uri, new vscode.Position(0, 0), "// 리프레시 토큰 회전 (설계 design.md)\n");
  await vscode.workspace.applyEdit(we);
  await doc.save();
  await sleep(1500);
  // 외부 변경: Flightdeck 밖에서 파일을 고침
  await writeFile(path.join(wt, "README.md"), (await readFile(path.join(wt, "README.md"), "utf8")) + "\n토큰 회전은 src/token.js\n");
  await sleep(500);

  // 제출 1차: 막혀야 한다 (명령 대신 그 명령이 부르는 함수. 경고 창은 모달이라 자동 진행이 멈춘다)
  await vscode.workspace.saveAll(false);
  const r1 = await h.wf.completePhase(epic);
  await h.refresh();
  await log("제출 1차", { ok: r1.ok, problems: r1.ok ? [] : r1.problems, status: h.statusText(), head: (await git(["log", "-1", "--format=%s"], { cwd: wt })).trim() });

  // 메모 (메모 입력 창이 부르는 함수)
  const st = await h.wf.implementationStatus(epic);
  const memos: string[] = [];
  for (const g of st.coverage.groups) {
    if (g.kind === "agent") {
      memos.push(`에이전트 편집(Step 기록 필요): ${g.file}`);
      continue;
    }
    await h.wf.addMemo(epic, g, g.kind === "human" ? "모듈 머리 주석을 직접 달았다" : "README에 위치 안내 한 줄");
    memos.push(`${g.kind}: ${g.file}`);
  }
  await log("메모", { memos, after: (await h.wf.implementationStatus(epic)).coverage.unexplained.length });

  // 제출 2차: 관문 → 커밋·공유 → node check.js → gate.reported → phase.completed
  const out: string[] = [];
  const r2 = await h.wf.completePhase(epic, { onOutput: (s) => out.push(s) });
  await h.refresh();
  const evs = (await h.wf.store.list(epic)).filter((e) => e.type === "gate.reported" || e.type === "phase.completed").map((e) => `${e.type}${"phase" in e.data ? `(${e.data.phase})` : ""}/${e.sig ? "서명" : "서명 없음"}`);
  const ref = (await h.wf.epicState(epic)).tracker_ref!;
  await log("제출 2차", { r: r2, output: out.join("").trim().slice(-300), events: evs, status: h.statusText(), tracker: await h.wf.cfg.remote?.tracker?.getEpic(ref).then((x) => x.status, (e) => String(e)), warnings: h.wf.warnings.splice(0) });
}

/** 6. [park] 담당자가 구현을 제출하면 읽기 전용 창을 연다 */
async function m4ViewerWait(h: ScenarioHooks, log: Log) {
  const t1 = Date.now();
  const epic = await until("M4 에픽 VERIFICATION", async () => {
    await h.wf.pull();
    for (const e of await h.wf.store.listEpics()) {
      const s = await h.wf.epicState(e);
      if (s.phase === "VERIFICATION" && s.owner === "dh.lee") return e;
    }
    return null;
  }, 20 * 60_000, 10_000);
  await log("담당자 제출 확인", { epic, waitSec: Math.round((Date.now() - t1) / 1000) });
  await h.openViewer(epic);
}

/** 7. [park] 내 에이전트(실제 claude)에게 세션 원본 검색을 시킨다 */
async function m4Viewer(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  const prompt = [
    "이 에픽의 구현 실행에서 새 토큰을 어떤 방법으로 만들기로 했는지, flightdeck_search_run 도구로 세션 원본을 검색해서 찾아 주세요.",
    "찾은 근거(세션 원본 발췌)와 함께 두세 줄로 답해 주세요. 파일은 고치지 마세요.",
  ].join("\n");
  const t1 = Date.now();
  const r = await h.wf.cfg.adapter.headless!(prompt, { cwd: h.worktree!, model: "haiku", maxTurns: 8, allowedTools: ["Read", "Grep", "Glob", "mcp__flightdeck"] });
  const { RunStore } = await import("@flightdeck/git");
  await log("세션 원본 검색", { sec: Math.round((Date.now() - t1) / 1000), status: h.statusText(), runs: await new RunStore(h.wf.cfg.repo).files(epic), answer: r.result.slice(0, 800) });
}

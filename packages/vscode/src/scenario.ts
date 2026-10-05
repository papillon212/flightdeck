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
  role: "owner" | "viewer" | "review" | "live";
  /** 조종수 모델 (M8): 관찰자 창 / 조종수 창 */
  live?: () => import("./live-ui.ts").LiveWindow | null;
  pilot?: () => import("./live-ui.ts").PilotWindow | null;
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
    if (process.env.FLIGHTDECK_SCENARIO_KIND === "m5" || process.env.FLIGHTDECK_SCENARIO_KIND === "m55") return await runM5(h, log);
    if (process.env.FLIGHTDECK_SCENARIO_KIND === "m7") return await runM7(h, log);
    if (process.env.FLIGHTDECK_SCENARIO_KIND === "m8") return await runM8(h, log);
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

// ---------------------------------------------------------------- M5: 검증·반영 (docs/m5-plan.md)
// 담당자 dh.lee, 검증 lead park, qa choi (설정: 설계 lead = dh.lee 자기 승인, 검증 lead = park, qa = choi, 관문 명령 node check.js).
// 담당자의 구현은 훅이 하는 일(에이전트 출처 편집 기록 + log_step)을 직접 한다(M4에서 실제 claude로 확인).
// park의 에이전트(실제 claude haiku 1회)가 리뷰 사본에서 고친 것을 park이 수정 제안으로 올린다.
// choi는 승인 직전에 main에 다른 커밋을 넣어(Flightdeck 밖) main 이동 → 병합 → 재보고 경로와 감사를 확인한다.

/** M5.5(FLIGHTDECK_SCENARIO_KIND=m55)는 같은 흐름을 내장 git 서버로 돌린다: park는 직접 고치고(구독 사용 절약), choi의 main 직접 push는 거부돼야 한다 */
const M55 = process.env.FLIGHTDECK_SCENARIO_KIND === "m55";
const M7 = process.env.FLIGHTDECK_SCENARIO_KIND === "m7";
const M5_TASK = M7 ? "[M7 시나리오]" : M55 ? "[M5.5 시나리오]" : "[M5 시나리오]";
const M5_TOKEN = [
  'const crypto = require("crypto");',
  "",
  "function rotate(store, token) {",
  "  const cur = store.get(token);",
  '  if (!cur || cur.used) throw new Error("reused");',
  "  cur.used = true;",
  '  const next = crypto.randomBytes(16).toString("hex");',
  "  store.set(next, { used: false });",
  "  return next;",
  "}",
  "",
  "module.exports = { rotate };",
  "",
].join("\n");

async function runM5(h: ScenarioHooks, log: Log) {
  const me = h.wf.cfg.member;
  if (me === "dh.lee" && !h.epic) return m5OwnerStart(h, log);
  if (me === "dh.lee") return m5Owner(h, log);
  if (!h.epic) return m5ReviewerWait(h, log);
  if (me === "park") return m5Lead(h, log);
  if (me === "choi") return m5Qa(h, log);
}

/** 1. [dh.lee] 시작 → 분석·설계(자기 승인) → 구현(Step 1) → 구현 제출 → VERIFICATION 리뷰 요청 */
async function m5OwnerStart(h: ScenarioHooks, log: Log) {
  // 다시 실행해도 이어서 한다 (이미 시작한 에픽은 "내 일감"에서 빠지므로 일감 도구에서 직접 찾는다)
  const tracker = h.wf.cfg.remote!.tracker!;
  const t = (await tracker.listAssignedEpics(await tracker.me())).find((e) => e.title.includes(M5_TASK));
  if (!t) throw new Error("M5 시나리오 일감이 내 일감에 없다");
  const epic = t.epicId;
  await h.wf.pull();
  const r = (await h.wf.epicState(epic)).owner ? { worktree: await h.wf.worktree(epic) } : await h.wf.startFromTracker(t);
  const dir = path.join(r.worktree, ".flightdeck/epics", epic);
  if ((await h.wf.epicState(epic)).phase === "ANALYSIS") {
    await writeFile(path.join(dir, "analysis.md"), ANALYSIS);
    await h.wf.completePhase(epic);
  }
  if ((await h.wf.epicState(epic)).phase === "DESIGN") {
    await writeFile(path.join(dir, "design.md"), M4_DESIGN);
    await h.wf.requestReview(epic);
    await h.wf.approve(epic);
  }
  // 에이전트가 하는 일 (훅): src/token.js 작성 → 편집 기록(Step 1) → log_step
  const { appendEditRecords, logStep, readEditLog, readState } = await import("@flightdeck/hook");
  const { diffRecords, nowIso, ulid } = await import("@flightdeck/core");
  const dataDir = await h.wf.eng.dataDir();
  const run = ulid();
  if (!(await readEditLog(dataDir, epic)).some((x) => x.file === "src/token.js")) {
    await mkdir(path.join(r.worktree, "src"), { recursive: true });
    const f = path.join(r.worktree, "src/token.js");
    const before = await readFile(f, "utf8").catch(() => null);
    await writeFile(f, M5_TOKEN);
    const st = await readState(dataDir, epic);
    await appendEditRecords(dataDir, epic, diffRecords(epic, "src/token.js", before, M5_TOKEN, { kind: "agent", member: "dh.lee", adapter: "claude-code", run, step: st.impl_step + 1 }, nowIso()));
  }
  if ((await readState(dataDir, epic)).impl_step === 0) {
    const design = await readFile(path.join(dir, "design.md"), "utf8");
    const pid = /<!-- (p:[0-9a-f]{4}) -->\n- rotate/.exec(design)?.[1] ?? /<!-- (p:[0-9a-f]{4}) -->/.exec(design)![1]!;
    await logStep(await h.wf.implContext(epic), { title: "rotate와 재사용 탐지", design_ref: `design.md#${pid}`, intent: "설계의 rotate 구현", decision: "Map 저장, randomBytes(16) hex", alternatives: "없음", review_points: "src/token.js:5 재사용 판정", verification: "node check.js  # ok 3 passed" }, run);
  }
  const sub = await h.wf.submitImplementation(epic);
  const s = await h.wf.epicState(epic);
  await log("구현 제출 → 검증 리뷰 요청", { epic, submit: sub, phase: s.phase, tier: s.review.requested ? "lead" : "-", warnings: h.wf.warnings.splice(0) });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: false });
}

/** 4·6. [dh.lee] 수정 제안 알림 → 반영 → 다시 요청 → (main 이동) 재보고 자동 → DONE */
async function m5Owner(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  let s = await h.wf.epicState(epic);
  if (s.phase === "VERIFICATION" && ![...s.threads.values()].some((t) => t.applied.length)) {
    const t1 = Date.now();
    const note = await until("수정 제안 알림", async () => h.notifications.find((n) => n.includes("@park의 수정 요청")), 10 * 60_000);
    s = await h.wf.epicState(epic);
    const t = [...s.threads.values()].find((x) => x.author === "park" && x.patch)!;
    await log("수정 제안 알림", { notification: note, waitSec: Math.round((Date.now() - t1) / 1000), thread: t.id, anchor: t.anchor, patch: t.patch });
    const ct = h.commentThread(t.id);
    await vscode.commands.executeCommand("flightdeck.applyPatch", ct); // 쓰레드의 "수정 제안 반영" 버튼 (끝의 확인 알림은 무시)
    await vscode.commands.executeCommand("flightdeck.reply", { thread: h.commentThread(t.id), text: "반영했습니다. 다시 요청합니다." });
    const st = await h.wf.implementationStatus(epic);
    const r = await h.wf.requestVerification(epic); // "검증 다시 요청" 명령의 함수 (경고 창이 모달이라)
    await log("반영·다시 요청", { file: await readFile(path.join(h.worktree!, "src/token.js"), "utf8"), unexplained: st.coverage.unexplained.length, r: r.ok ? { ok: true, tier: "lead" } : r, status: h.statusText() });
  }
  const t2 = Date.now();
  let sawNeedsReport = false;
  s = await until("DONE", async () => {
    await h.refresh(); // LANDING · needs_report면 refresh가 재보고한다
    const x = await h.wf.epicState(epic);
    if (x.landing?.status === "needs_report") sawNeedsReport = true;
    return x.phase === "DONE" ? x : null;
  }, 20 * 60_000, 5000);
  const evs = (await h.wf.store.list(epic)).filter((e) => ["gate.reported", "review.requested", "review.approved", "land.rejected", "epic.landed"].includes(e.type)).map((e) => `${e.type}${"reason" in e.data ? `(${(e.data as { reason: string }).reason})` : ""}/${e.author}/${e.sig ? "서명" : "-"}`);
  const main = s.landed!.main_commit;
  await git(["fetch", "-q", h.wf.gitRemote, "main"], { cwd: h.wf.cfg.repo });
  const ref = s.tracker_ref!;
  await sleep(3000); // 일감 조정
  await h.refresh();
  await log("반영 완료", {
    waitSec: Math.round((Date.now() - t2) / 1000),
    sawNeedsReport,
    status: h.statusText(),
    events: evs,
    main,
    message: (await git(["log", "-1", "--format=%B", main], { cwd: h.wf.cfg.repo })).trim(),
    files: (await git(["show", "--stat", "--format=", main], { cwd: h.wf.cfg.repo })).trim().split("\n"),
    epicBranch: (await git(["ls-remote", h.wf.gitRemote, `refs/heads/flightdeck/${epic}`], { cwd: h.wf.cfg.repo })).trim() || "(삭제됨)",
    tracker: await h.wf.cfg.remote?.tracker?.getEpic(ref).then((x) => x.status, (e) => String(e)),
    audit: (await h.wf.auditMain()).map((f) => `${f.sha.slice(0, 7)} ${f.subject}`),
    warnings: h.wf.warnings.splice(0),
  });
}

/** 2. [park·choi] 리뷰 차례 알림 → 리뷰 사본 */
async function m5ReviewerWait(h: ScenarioHooks, log: Log) {
  const t1 = Date.now();
  const item = await until("검증 리뷰 차례", async () => (await h.wf.reviewInbox()).find((i) => i.phase === "VERIFICATION"), 20 * 60_000, 5000);
  await log("리뷰 차례", { item, waitSec: Math.round((Date.now() - t1) / 1000), notified: h.notifications.find((n) => n.includes("리뷰 차례입니다")) ?? null });
  await h.openViewer(item.epic, item.commit);
}

/** 3·5. [park] 에이전트(실제 claude)가 리뷰 사본에서 고침 → 수정 제안 → 담당자 반영·재요청 → 해결·승인 */
async function m5Lead(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const wt = h.worktree!;
  await h.refresh();
  await log("리뷰 사본", { role: h.role, status: h.statusText() });
  const s0 = await h.wf.epicState(epic);
  if (![...s0.threads.values()].some((t) => t.author === "park")) {
    const prompt = [
      "이 리뷰 사본의 src/token.js를 읽고, rotate 함수 맨 앞에 token이 문자열이 아니면 TypeError('token must be a string')를 던지는 검사를 한 줄 추가하세요.",
      "다른 동작은 바꾸지 마세요. node check.js로 확인하고, 결과를 한 줄로 알려 주세요.",
    ].join("\n");
    const t1 = Date.now();
    const r = M55
      ? await (async () => {
          // 에이전트가 하는 수정과 같은 것 (M5에서 실제 claude로 확인)
          const f = path.join(wt, "src/token.js");
          const text = await readFile(f, "utf8");
          await writeFile(f, text.replace(/(function rotate\([^)]*\) \{\n)/, "$1  if (typeof token !== 'string') throw new TypeError('token must be a string');\n"));
          return { result: "직접 수정 (M5.5: 구독 사용 절약)" };
        })()
      : await h.wf.cfg.adapter.headless!(prompt, { cwd: wt, model: "haiku", maxTurns: 10, allowedTools: ["Read", "Edit", "Write", "Bash", "mcp__flightdeck"] });
    const changed = await git(["status", "--short"], { cwd: wt });
    await log("에이전트 수정 (리뷰 사본)", { sec: Math.round((Date.now() - t1) / 1000), result: r.result.slice(0, 300), changed: changed.trim() });
    // "수정 제안 만들기": src/token.js의 rotate 줄을 골라 실행한 것과 같다
    const doc = await vscode.workspace.openTextDocument(path.join(wt, "src/token.js"));
    const line = doc.getText().split("\n").findIndex((l) => l.includes("function rotate"));
    const tid = await h.wf.suggestFix(epic, { file: "src/token.js", range: [line + 1, line + 1], body: "token 형식 검사를 넣어 주세요 (리뷰 사본에서 확인: node check.js 통과)" });
    await h.refresh();
    const t = (await h.wf.epicState(epic)).threads.get(tid)!;
    await log("수정 제안", { thread: tid, anchor: t.anchor, patch: t.patch, copyClean: (await git(["status", "--short"], { cwd: wt })).trim() === "", approveError: await h.wf.approve(epic).then(() => "승인됨(예상 밖)", (e) => (e as Error).message) });
  }
  const first = (await h.wf.epicState(epic)).review.requested!.event;
  const t2 = Date.now();
  await until("담당자 다시 요청", async () => {
    const s = await h.wf.epicState(epic);
    if (s.review.requested?.event === first) {
      await h.wf.pull();
      return false;
    }
    await h.wf.openAsViewer(epic);
    return true;
  }, 15 * 60_000, 5000);
  await h.refresh();
  const s = await h.wf.epicState(epic);
  const mine = [...s.threads.values()].find((t) => t.author === "park")!;
  await vscode.commands.executeCommand("flightdeck.resolve", h.commentThread(mine.id));
  const s2 = await h.wf.approve(epic);
  await log("lead 승인", { waitSec: Math.round((Date.now() - t2) / 1000), applied: mine.applied.length, replies: mine.replies.map((r) => `@${r.author}: ${r.body}`), copyHasFix: (await readFile(path.join(wt, "src/token.js"), "utf8")).includes("TypeError"), next: s2.review.requested ? "qa" : s2.phase });
}

/** 6. [choi] main에 다른 커밋(Flightdeck 밖) → qa 승인 → 서버가 반영 */
async function m5Qa(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  const item = await until("qa 차례", async () => (await h.wf.reviewInbox()).find((i) => i.epic === epic && i.tier === "qa"), 20 * 60_000, 5000);
  await h.wf.openAsViewer(epic, item.commit);
  // 그 사이 다른 일이 main에 들어온다 (반영 서버를 거치지 않은 직접 push → 감사에 걸려야 한다)
  const repo = h.wf.cfg.repo;
  await git(["fetch", "-q", "origin", "main"], { cwd: repo });
  await git(["checkout", "-q", "main"], { cwd: repo });
  await git(["merge", "-q", "--ff-only", "origin/main"], { cwd: repo });
  await writeFile(path.join(repo, "NOTICE.md"), `${M55 ? "M5.5" : "M5"} 시나리오: 검증 중에 main에 들어온 다른 변경\n`);
  await git(["add", "NOTICE.md"], { cwd: repo });
  await git(["-c", "user.name=choi", "-c", "user.email=choi@test.local", "commit", "-q", "-m", `${M55 ? "M5.5" : "M5"} 시나리오: main 이동`], { cwd: repo });
  // 내장 git(M5.5)에서는 서버가 거부해야 한다 (§1.5 pre-receive)
  const pushError = await git(["push", "-q", "origin", "main"], { cwd: repo }).then(() => null, (e) => (e as Error).message);
  if (pushError) await git(["reset", "-q", "--hard", "origin/main"], { cwd: repo });
  const s = await h.wf.approve(epic);
  await log("qa 승인", { phase: s.phase, landing: s.landing, mainPush: pushError ?? "성공", head: (await git(["rev-parse", "HEAD"], { cwd: repo })).trim() });
}

// ---------------------------------------------------------------- M7: 편집 기록 서버 (docs/m7-plan.md)
// M5와 같은 사람·설정. 담당자 구현(에이전트 출처 Step 1) → 제출 → park이 리뷰 사본에서 hover로 출처를 읽고 코드 쓰레드(질문)를 단다
// → 담당자가 실제 에디터로 큰 수정(위에 30줄, 그 줄 자체 고침) + 터미널식 외부 변경 → 쓰레드 위치·외부 변경 기록 확인
// → 메모 → 다시 요청 → park·choi 승인 → 반영 서버가 서버 편집 기록으로 coverage를 다시 계산하고 반영.

async function runM7(h: ScenarioHooks, log: Log) {
  const me = h.wf.cfg.member;
  if (me === "dh.lee" && !h.epic) return m5OwnerStart(h, log);
  if (me === "dh.lee") return m7Owner(h, log);
  if (!h.epic) return m5ReviewerWait(h, log);
  if (me === "park") return m7Lead(h, log);
  if (me === "choi") return m7Qa(h, log);
}

/** [park] 리뷰 사본: 줄마다 hover(실제 VS Code hover 명령)로 출처 → 코드 쓰레드 질문 → 다시 요청을 기다려 승인 */
async function m7Lead(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const wt = h.worktree!;
  await h.refresh();
  const s0 = await h.wf.epicState(epic);
  if (![...s0.threads.values()].some((t) => t.author === "park")) {
    const uri = vscode.Uri.file(path.join(wt, "src/token.js"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const t1 = Date.now();
    const hovers: string[] = [];
    for (let line = 0; line < doc.lineCount; line++) {
      const hs = (await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(line, 0))) ?? [];
      const mine = hs.flatMap((x) => x.contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))).find((v) => v.includes("Flightdeck 출처"));
      hovers.push(`${line + 1}: ${(mine ?? "(없음)").replace("**Flightdeck 출처** · ", "")}`);
    }
    await log("hover 출처 (리뷰 사본, 서버 편집 기록)", { ms: Date.now() - t1, hovers });
    const line = doc.getText().split("\n").findIndex((l) => l.includes("cur.used = true")) + 1;
    const tid = await h.wf.createCodeThread(epic, { file: "src/token.js", range: [line, line], kind: "question", to: ["dh.lee"], body: "재사용 표시를 저장 전에 하는 이유가 있나요?" });
    await log("코드 쓰레드", { thread: tid, line });
  }
  const first = (await h.wf.epicState(epic)).review.requested!.event;
  await until("담당자 다시 요청", async () => {
    const s = await h.wf.epicState(epic);
    if (s.review.requested?.event === first) {
      await h.wf.pull();
      return false;
    }
    await h.wf.openAsViewer(epic);
    return true;
  }, 15 * 60_000, 5000);
  await h.refresh();
  const mine = [...(await h.wf.epicState(epic)).threads.values()].find((t) => t.author === "park")!;
  await vscode.commands.executeCommand("flightdeck.resolve", h.commentThread(mine.id));
  const s2 = await h.wf.approve(epic);
  await log("lead 승인", { replies: mine.replies.map((r) => `@${r.author}: ${r.body}`), next: s2.review.requested ? "qa" : s2.phase });
}

/** [choi] qa 차례 → 승인 (반영 서버가 서버 편집 기록으로 coverage 재계산) */
async function m7Qa(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  await h.refresh();
  const item = await until("qa 차례", async () => (await h.wf.reviewInbox()).find((i) => i.epic === epic && i.tier === "qa"), 20 * 60_000, 5000);
  await h.wf.openAsViewer(epic, item.commit);
  const s = await h.wf.approve(epic);
  await log("qa 승인", { phase: s.phase, landing: s.landing });
}

/** [dh.lee] 질문 알림 → 실제 에디터로 큰 수정 → 쓰레드 위치 → 외부 변경 → 메모 → 답글·다시 요청 → DONE */
async function m7Owner(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const wt = h.worktree!;
  await h.refresh();
  let s = await h.wf.epicState(epic);
  if (s.phase === "VERIFICATION" && ![...s.threads.values()].some((t) => t.replies.some((r) => r.author === "dh.lee"))) {
    await until("park의 질문", async () => {
      await h.wf.pull();
      return [...(await h.wf.epicState(epic)).threads.values()].find((t) => t.author === "park");
    }, 15 * 60_000, 3000);
    await h.refresh();
    s = await h.wf.epicState(epic);
    const t = [...s.threads.values()].find((x) => x.author === "park")!;
    const before = h.commentThread(t.id)?.range?.start.line;
    // 실제 에디터 편집 (onDidChangeTextDocument → 사람 편집 기록): 위에 30줄, 쓰레드가 달린 줄 자체를 고친다
    const uri = vscode.Uri.file(path.join(wt, "src/token.js"));
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), Array.from({ length: 30 }, (_, i) => `// 머리말 ${i + 1}`).join("\n") + "\n"));
    const at = doc.getText().split("\n").findIndex((l) => l.includes("cur.used = true"));
    await ed.edit((b) => b.replace(new vscode.Range(at, 0, at, doc.lineAt(at).text.length), "  cur.used = true; // 저장 전에 표시해 동시 재사용을 막는다"));
    await doc.save();
    await sleep(1500);
    await h.refresh();
    const pos = (await h.wf.codeThreadPositions(epic)).find((x) => x.thread.id === t.id)!;
    const drawn = h.commentThread(t.id)?.range?.start.line;
    // 터미널에서 고친 것처럼 (Flightdeck 밖): 파일 감시(1초 디바운스)가 잡아야 한다. 제출 검사도 잡으므로 그 전에 기다린다
    const f = path.join(wt, "src/token.js");
    const { readEditLog } = await import("@flightdeck/hook");
    const dataDir = await h.wf.eng.dataDir();
    const beforeSeq = (await readEditLog(dataDir, epic)).at(-1)?.seq ?? 0;
    await writeFile(f, (await readFile(f, "utf8")) + "// 터미널에서 덧붙인 줄\n");
    const t2 = Date.now();
    const ext = await until("외부 변경 기록 (파일 감시)", async () => (await readEditLog(dataDir, epic)).find((r) => r.seq > beforeSeq && r.source.kind === "external" && r.file === "src/token.js"), 60_000, 200);
    await log("큰 수정 뒤 쓰레드 위치 · 외부 변경", {
      thread: t.id,
      anchor: t.anchor,
      position: pos,
      drawnLine: drawn === undefined ? null : drawn + 1,
      beforeLine: before === undefined ? null : before + 1,
      lineText: (await readFile(f, "utf8")).split("\n")[pos.range[0] - 1],
      external: { seq: ext.seq, ms: Date.now() - t2 },
      status: h.statusText(),
    });
    const st = await h.wf.implementationStatus(epic);
    for (const g of st.coverage.groups) await h.wf.addMemo(epic, g, g.kind === "external" ? "터미널에서 남긴 메모 줄" : "머리말과 재사용 표시 이유 주석");
    await vscode.commands.executeCommand("flightdeck.reply", { thread: h.commentThread(t.id), text: "동시 재사용을 막기 위해서입니다. 주석으로 남겼습니다." });
    const r = await h.wf.requestVerification(epic);
    const server = await h.wf.cfg.remote!.server.editlog(h.wf.cfg.remote!.product, epic, Number.MAX_SAFE_INTEGER);
    await log("메모·다시 요청", { groups: st.coverage.groups.map((g) => `${g.file}:${g.kind}:${g.seqs.join("-")}`), r: r.ok ? "ok" : r, serverLast: server.last, localLast: (await readEditLog(dataDir, epic)).at(-1)?.seq });
  }
  const t3 = Date.now();
  s = await until("DONE", async () => {
    await h.refresh();
    const x = await h.wf.epicState(epic);
    return x.phase === "DONE" || x.phase === "IMPLEMENTATION" ? x : null; // IMPLEMENTATION = 반영 거부
  }, 20 * 60_000, 5000);
  const rejected = (await h.wf.store.list(epic)).filter((e) => e.type === "land.rejected").map((e) => e.data);
  await log("반영", { phase: s.phase, waitSec: Math.round((Date.now() - t3) / 1000), main: s.landed?.main_commit ?? null, rejected, status: h.statusText(), warnings: h.wf.warnings.splice(0) });
}

// ---------------------------------------------------------------- M8: 조종수 모델 (docs/m8-plan.md)
// dh.lee(담당자·처음 조종수)가 실제 claude(haiku 1회)로 3 Step 구현을 돌리는 동안 park이 관찰 창(@live)으로 보고
// 일반 의견 → 급한 의견을 보낸다. dh.lee 쪽은 받은 의견을 조종수가 고른 것처럼 전달한다(일반 / "[급함]"이면 급한 의견).
// 실행이 끝나면 park이 조종을 요청하고, dh.lee가 넘기고, park이 자기 작업 폴더에서 이어받아 Step을 더해 제출한다.

const M8_TASK = "[M8 시나리오]";
const M8_DESIGN = [
  "## 개요", "src/revoke.js에 모든 토큰을 무효로 하는 revokeAll을 만든다. CommonJS 모듈(module.exports)이다.", "",
  "## 변경 컴포넌트", "- src/revoke.js: revokeAll(store)", "",
  "## 인터페이스", "- revokeAll(store) → 무효로 바꾼 토큰 수. store는 Map(토큰 → { used: boolean }). 모든 값을 used: true로 바꾼다", "",
  "## 데이터 변경", "- 없음 (메모리 Map)", "",
  "## 테스트 계획", "- 레포의 node check.js (rotate)는 그대로 통과해야 한다", "",
  "## 리스크", "- 없음", "",
].join("\n");

async function runM8(h: ScenarioHooks, log: Log) {
  const me = h.wf.cfg.member;
  if (me === "dh.lee" && !h.epic) return m8OwnerStart(h, log);
  if (me === "dh.lee" && h.role === "owner") return m8Pilot(h, log);
  if (me === "park" && !h.epic) return m8ParkHome(h, log);
  if (me === "park" && h.role === "live") return m8Live(h, log);
  if (me === "park" && h.role === "owner") return m8NewPilot(h, log);
}

/** [dh.lee] 시작 → 분석 → 설계(자기 승인) → IMPLEMENTATION → 작업 폴더 */
async function m8OwnerStart(h: ScenarioHooks, log: Log) {
  const t = (await h.wf.assignedEpics()).find((e) => e.title.includes(M8_TASK));
  if (!t) throw new Error("M8 시나리오 일감이 내 일감에 없다");
  const r = await h.wf.startFromTracker(t);
  const dir = path.join(r.worktree, ".flightdeck/epics", t.epicId);
  await writeFile(path.join(dir, "analysis.md"), ANALYSIS);
  await h.wf.completePhase(t.epicId);
  await writeFile(path.join(dir, "design.md"), M8_DESIGN);
  await h.wf.requestReview(t.epicId);
  const s = await h.wf.approve(t.epicId);
  // 관찰자가 붙을 수 있게 첫 체크포인트를 올린다 (관찰은 조종수의 체크포인트에서 시작한다, L8)
  await h.wf.checkpoint(t.epicId, "구현 시작");
  await log("에픽 시작 → IMPLEMENTATION", { epic: t.epicId, phase: s.phase });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: false });
}

/** [dh.lee] 조종수 창: 실제 claude로 구현, 받은 의견을 전달, 끝나면 조종 요청을 받아 넘긴다 */
async function m8Pilot(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const s0 = await h.wf.epicState(epic);
  if (s0.pilotHistory.length) return; // 이미 넘겼다
  await until("조종수 창 실시간", async () => h.pilot?.(), 30_000, 500);
  // 받은 의견을 조종수가 고른 것처럼 처리한다: "[급함]"으로 시작하면 급한 의견, 아니면 에이전트에 전달
  const { handleOpinion } = await import("./live-ui.ts");
  const handled = new Set<string>();
  const opinionLoop = setInterval(() => {
    const pw = h.pilot?.();
    if (!pw) return;
    for (const o of pw.opinions.list.filter((x) => x.status === "new" && !handled.has(x.id))) {
      handled.add(o.id);
      const urgent = o.body.startsWith("[급함]");
      void handleOpinion({ wf: h.wf, epic, worktree: h.worktree! }, pw.opinions, o, urgent ? "urgent" : "deliver", o.body.replace("[급함]", "").trim())
        .then(() => log("의견 처리", { id: o.id, from: o.from, body: o.body, as: urgent ? "급한 의견" : "에이전트에 전달", at: new Date().toISOString() }))
        .catch((e) => log("오류", { error: String(e) }));
    }
  }, 300);
  // park이 관찰 창을 열 때까지 기다렸다가 실행 (관찰 시작 전 편집은 체크포인트로만 보인다)
  await until("관찰자 접속", async () => {
    const r = h.wf.cfg.remote!;
    return (await r.server.livePresence(r.product, epic))["park"]?.online;
  }, 10 * 60_000, 2000);
  const prompt = [
    `.flightdeck/epics/${epic}/design.md의 설계대로 구현하세요. 세 Step으로 나눠서 한 번에 하나씩 하세요.`,
    "Step 1: src/revoke.js에 revokeAll(store)의 기본 동작(모든 값을 used: true로)을 쓰고 module.exports로 내보냅니다.",
    "Step 2: revokeAll이 무효로 바꾼 토큰 수를 돌려주게 합니다.",
    "Step 3: src/revoke.js 맨 위에 모듈 설명 주석을 답니다.",
    "각 Step이 끝날 때마다 node check.js를 실행하고 flightdeck_log_step으로 그 Step을 기록하세요(Step 하나를 구현·확인·기록한 뒤 다음 Step).",
    "작업 중에 관찰자 의견이 전달되면 그 의견을 따르세요.",
  ].join("\n");
  const t1 = Date.now();
  const r = await h.wf.cfg.adapter.headless!(prompt, { cwd: h.worktree!, model: "haiku", maxTurns: 40, allowedTools: ["Read", "Edit", "Write", "Bash", "mcp__flightdeck"] });
  clearInterval(opinionLoop);
  const { readEditLog } = await import("@flightdeck/hook");
  const dataDir = await h.wf.eng.dataDir();
  const hookLog = (await readFile(path.join(dataDir, "hook", epic, "hook-log.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await log("에이전트 실행 (조종수)", {
    sec: Math.round((Date.now() - t1) / 1000),
    result: r.result.slice(0, 600),
    opinionDeliveries: hookLog.filter((x) => x.kind === "opinion" || x.kind === "urgent_deny"),
    revoke: await readFile(path.join(h.worktree!, "src/revoke.js"), "utf8").catch(() => null),
    edits: (await readEditLog(dataDir, epic)).filter((x) => x.source.kind === "agent").length,
    implStep: (await (await import("@flightdeck/hook")).readState(dataDir, epic)).impl_step,
  });
  // 조종 요청을 기다려 넘긴다 (알림의 "수락" 버튼 = flightdeck.handOff)
  await until("조종 요청", async () => h.notifications.find((n) => n.includes("조종을 요청했습니다")), 15 * 60_000, 1000);
  await vscode.commands.executeCommand("flightdeck.handOff", "park");
  const s = await h.wf.epicState(epic);
  await log("조종 넘김", { pilot: s.pilot, history: s.pilotHistory, role: await h.wf.role(epic), status: h.statusText() });
}

/** [park] 레포 창: 조종수가 체크포인트를 올리면 관찰을 시작하고, 조종을 넘겨받으면 이어서 작업한다 */
async function m8ParkHome(h: ScenarioHooks, log: Log) {
  // 다시 실행: 이미 넘겨받은 에픽이 있으면 바로 이어서 작업
  await h.wf.pull();
  for (const e of await h.wf.store.listEpics()) {
    const s = await h.wf.epicState(e);
    if (s.pilot === "park" && s.pilotHistory.length && s.phase === "IMPLEMENTATION") {
      await log("넘겨받은 에픽 (다시 실행)", { epic: e });
      await vscode.commands.executeCommand("flightdeck.adoptPilot", e);
      return;
    }
  }
  const epic = await until("M8 에픽", async () => {
    await h.wf.pull();
    for (const e of await h.wf.store.listEpics()) {
      const s = await h.wf.epicState(e);
      if (s.phase === "IMPLEMENTATION" && s.owner === "dh.lee" && !s.pilotHistory.length && (await h.wf.eng.fetchCheckpoint(e, "dh.lee", h.wf.gitRemote).catch(() => null))) {
        const evs = await h.wf.store.list(e);
        const started = evs.find((x) => x.type === "epic.started");
        if (started && Date.now() - Date.parse(started.at) < 30 * 60_000) return e;
      }
    }
    return null;
  }, 15 * 60_000, 3000);
  await log("관찰 시작", { epic });
  await vscode.commands.executeCommand("flightdeck.watch", epic);
  const note = await until("조종 넘겨받음", async () => h.notifications.find((n) => n.includes("조종을 넘겨받았습니다")), 30 * 60_000, 1000);
  await log("넘겨받음 알림", { note });
  await vscode.commands.executeCommand("flightdeck.adoptPilot", epic); // 알림의 "이어서 작업"
}

/** [park] 관찰 창: 적용 지연, 대화, 의견 보내기(일반 → 급한), 실행이 끝나면 조종 요청 */
async function m8Live(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const lw = await until("관찰 창 실시간", async () => h.live?.(), 60_000, 500);
  const r = h.wf.cfg.remote!;
  await until("첫 편집 적용", async () => lw.follower.latencies.length > 0, 10 * 60_000, 300);
  await log("첫 편집 적용", { latencies: lw.follower.latencies, chat: lw.chat.count, status: h.statusText() });
  await r.server.liveSend(r.product, epic, "opinion", { id: "m8-op1", body: "src/revoke.js의 store가 Map이 아니면 TypeError를 던지게 해 주세요", target: "src/revoke.js" }, [lw.pilot]);
  await until("일반 의견 전달됨", async () => h.notifications.find((n) => n.includes("내 의견을 에이전트에 전달")), 5 * 60_000, 300);
  await sleep(4000);
  await r.server.liveSend(r.product, epic, "opinion", { id: "m8-op2", body: "[급함] 멈추세요: check.js는 절대 고치지 마세요. src/revoke.js만 고치세요" }, [lw.pilot]);
  await until("급한 의견 전달됨", async () => h.notifications.find((n) => n.includes("급한 의견으로 전달")), 5 * 60_000, 300);
  // 조종수의 실행이 끝날 때까지 (편집이 30초 동안 없으면)
  let last = lw.follower.seq;
  let quietSince = Date.now();
  await until("실행 끝", async () => {
    if (lw.follower.seq !== last) {
      last = lw.follower.seq;
      quietSince = Date.now();
    }
    return Date.now() - quietSince > 30_000;
  }, 20 * 60_000, 1000);
  const lat = lw.follower.latencies;
  const sorted = [...lat].sort((a, b) => a - b);
  await log("관찰 결과", {
    applied: lat.length,
    latencyMs: { max: sorted.at(-1), p50: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)] },
    chatBlocks: lw.chat.count,
    revoke: await readFile(path.join(h.worktree!, "src/revoke.js"), "utf8").catch(() => null),
    status: h.statusText(),
  });
  await vscode.commands.executeCommand("flightdeck.requestPilot");
  await log("조종 요청", {});
}

/** [park] 넘겨받은 작업 폴더: 이전 조종수의 공유 안 된 작업까지 이어받았는지 보고, Step을 더해 제출한다 */
async function m8NewPilot(h: ScenarioHooks, log: Log) {
  const epic = h.epic!;
  const wt = h.worktree!;
  const s = await h.wf.epicState(epic);
  const { readEditLog, readState, logStep } = await import("@flightdeck/hook");
  const dataDir = await h.wf.eng.dataDir();
  await log("넘겨받은 작업 폴더", { pilot: s.pilot, history: s.pilotHistory.map((x) => `${x.from}→${x.to}:${x.reason}`), revoke: await readFile(path.join(wt, "src/revoke.js"), "utf8").catch(() => null), editlog: (await readEditLog(dataDir, epic)).length, implStep: (await readState(dataDir, epic)).impl_step, status: h.statusText() });
  // 실제 에디터 편집으로 Step 하나 더 (사람 편집 → 메모)
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(wt, "src/revoke.js")));
  const ed = await vscode.window.showTextDocument(doc);
  await ed.edit((b) => b.insert(new vscode.Position(doc.lineCount, 0), "// park: 조종을 넘겨받아 마무리함\n"));
  await doc.save();
  await sleep(1500);
  const st = await h.wf.implementationStatus(epic);
  for (const g of st.coverage.groups) await h.wf.addMemo(epic, g, "조종 인계 뒤 마무리 주석");
  const r = await h.wf.submitImplementation(epic);
  const s2 = await h.wf.epicState(epic);
  void logStep;
  await log("제출 (새 조종수)", { r: r.ok ? { ok: true, phase: s2.phase } : r, unexplained: st.coverage.unexplained.length, groups: st.coverage.groups.length, warnings: h.wf.warnings.splice(0) });
}

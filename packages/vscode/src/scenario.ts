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

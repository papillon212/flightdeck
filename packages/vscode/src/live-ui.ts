// 조종수 모델 화면 (설계 §8.2~8.5, §9.2 "실시간", M8). extension.ts가 창의 역할에 따라 부른다.
// - 관찰자 창(`<epic>@live`): 조종수의 편집을 실시간 적용, 대화 뷰, 의견 보내기, 조종 요청
// - 조종수 창(작업 폴더): 편집·대화 스트림 보내기, 의견 패널(전달·급한 전달·답장·닫기), 조종 요청 수락, 조종 넘기기
// - 그 밖의 창: 조종을 넘겨받았으면 "이어서 작업", 담당자는 조종수 이탈 시 강제 인수
import path from "node:path";
import * as vscode from "vscode";
import { nowIso, ulid, writerOf, type EpicState } from "@flightdeck/core";
import { secretValues } from "@flightdeck/hook";
import { LiveConnection, LiveFollower, PilotStreamer, type ChatBlock, type LiveMessage } from "./live.ts";
import type { EpicWorkflow } from "./workflow.ts";

export interface LiveCtx {
  wf: EpicWorkflow;
  epic: string;
  worktree: string;
}

type Notify = (msg: string, ...actions: string[]) => Thenable<string | undefined>;

// ---------------------------------------------------------------- 대화 뷰 (관찰자)

class ChatItem extends vscode.TreeItem {
  constructor(
    readonly block: ChatBlock & { from: string; id: string },
  ) {
    const first = block.text.split("\n")[0]!.slice(0, 120);
    super(`${ROLE_LABEL[block.role] ?? block.role} · ${first}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = new vscode.MarkdownString("```\n" + block.text.slice(0, 3000) + "\n```");
    this.description = block.at?.slice(11, 19);
    this.contextValue = "fd-chat";
  }
}
const ROLE_LABEL: Record<string, string> = { user: "🧑 지시", assistant: "🤖 에이전트", tool: "🔧 도구 결과", flightdeck: "✈️ Flightdeck" };

export class ChatTree implements vscode.TreeDataProvider<ChatItem> {
  private items: ChatItem[] = [];
  private ev = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.ev.event;
  add(from: string, blocks: ChatBlock[]): void {
    for (const b of blocks) this.items.push(new ChatItem({ ...b, from, id: ulid() }));
    if (this.items.length > 300) this.items.splice(0, this.items.length - 300);
    this.ev.fire();
  }
  get count(): number {
    return this.items.length;
  }
  getTreeItem(e: ChatItem) {
    return e;
  }
  getChildren() {
    return [...this.items].reverse(); // 최신이 위
  }
}

// ---------------------------------------------------------------- 의견 패널 (조종수)

export interface OpinionMsg {
  id: string;
  from: string;
  body: string;
  target?: string;
  at: string;
  status: "new" | "delivered" | "urgent" | "replied" | "dismissed";
}

class OpinionItem extends vscode.TreeItem {
  constructor(readonly o: OpinionMsg) {
    super(`@${o.from}: ${o.body.slice(0, 100)}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${o.target ?? ""} ${STATUS[o.status]}`.trim();
    this.tooltip = o.body;
    this.contextValue = o.status === "new" ? "fd-opinion-new" : "fd-opinion-done";
  }
}
const STATUS: Record<OpinionMsg["status"], string> = { new: "새 의견", delivered: "에이전트에 전달", urgent: "급한 의견으로 전달", replied: "답장함", dismissed: "닫음" };

export class OpinionTree implements vscode.TreeDataProvider<OpinionItem> {
  readonly list: OpinionMsg[] = [];
  private ev = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.ev.event;
  add(o: OpinionMsg): void {
    if (this.list.some((x) => x.id === o.id)) return;
    this.list.push(o);
    this.ev.fire();
  }
  set(id: string, status: OpinionMsg["status"]): void {
    const o = this.list.find((x) => x.id === id);
    if (o) o.status = status;
    this.ev.fire();
  }
  get pending(): number {
    return this.list.filter((o) => o.status === "new").length;
  }
  getTreeItem(e: OpinionItem) {
    return e;
  }
  getChildren() {
    return [...this.list].reverse().map((o) => new OpinionItem(o));
  }
}

// ---------------------------------------------------------------- 관찰자 창

export interface LiveWindow {
  follower: LiveFollower;
  chat: ChatTree;
  pilot: string;
  status(): string;
  dispose(): void;
}

/** 관찰자 창 (L8): 체크포인트 + 서버 편집 기록으로 맞춘 뒤 실시간 편집을 적용한다. 맞지 않으면 다시 맞춘다 */
export async function startLiveWindow(c: LiveCtx, out: vscode.OutputChannel, notify: Notify, refresh: () => void): Promise<LiveWindow> {
  const r = c.wf.cfg.remote!;
  const chat = new ChatTree();
  let opened = await c.wf.openLive(c.epic);
  if (opened.mismatch !== null) out.appendLine(`[관찰] 편집 기록 ${opened.mismatch}가 체크포인트와 맞지 않는다`);
  let follower!: LiveFollower;
  const makeFollower = (seq: number) =>
    new LiveFollower({
      dir: c.worktree,
      product: r.product,
      epic: c.epic,
      server: r.server,
      seq,
      onApplied: (recs) => {
        const lat = follower.latencies.slice(-recs.length);
        out.appendLine(`[관찰] 편집 ${recs.map((x) => x.seq).join(",")} 적용 (지연 ${lat.join(",")}ms)`);
        refresh();
      },
      onReset: (why) => {
        out.appendLine(`[관찰] ${why} → 다시 맞춘다`);
        void c.wf.openLive(c.epic).then((o) => {
          opened = o;
          follower = makeFollower(o.seq);
          refresh();
        });
      },
    });
  follower = makeFollower(opened.seq);
  const conn = new LiveConnection(r.server, r.product, c.epic, (m: LiveMessage) => {
    if (m.type === "edit" && m.from === opened.pilot) void follower.push(m.data.records);
    else if (m.type === "chat") chat.add(m.from, m.data.blocks);
    else if (m.type === "opinion.status" && m.to?.includes(c.wf.cfg.member)) void notify(`Flightdeck: @${m.from}이(가) 내 의견을 ${STATUS[m.data.status as OpinionMsg["status"]] ?? m.data.status}`);
    else if (m.type === "opinion.reply" && m.to?.includes(c.wf.cfg.member)) void notify(`Flightdeck: @${m.from}의 답장 — ${m.data.body}`);
    else if (m.type === "pilot.answer") void notify(`Flightdeck: @${m.from}이(가) 조종 요청을 ${m.data.accepted ? `수락했습니다 (새 조종수 @${m.data.to})` : "거절했습니다"}`);
  }, (ok, e) => out.appendLine(`[관찰] 실시간 ${ok ? "연결" : `끊김: ${e instanceof Error ? e.message : e}`}`)).start();
  return {
    get follower() {
      return follower;
    },
    chat,
    pilot: opened.pilot,
    status: () => `관찰 중 · 조종수 @${opened.pilot}${conn.connected ? "" : " · 연결 끊김"}${follower.latencies.length ? ` · 지연 ${follower.latencies.at(-1)}ms` : ""}`,
    dispose: () => conn.stop(),
  };
}

/** 의견 보내기 (§8.4): 대화 블록·편집 중인 줄·일반 */
export async function sendOpinion(c: LiveCtx, pilot: string, target: string | undefined): Promise<string | null> {
  const body = await vscode.window.showInputBox({ title: `조종수 @${pilot}에게 의견`, prompt: target ? `대상: ${target}` : "일반 의견", ignoreFocusOut: true });
  if (!body?.trim()) return null;
  const r = c.wf.cfg.remote!;
  const id = ulid();
  await r.server.liveSend(r.product, c.epic, "opinion", { id, body: body.trim(), ...(target ? { target } : {}) }, [pilot]);
  return id;
}

// ---------------------------------------------------------------- 조종수 창

export interface PilotWindow {
  opinions: OpinionTree;
  dispose(): void;
}

/** 조종수 창: 스트림 보내기 + 의견·조종 요청 받기 */
export async function startPilotWindow(c: LiveCtx, out: vscode.OutputChannel, notify: Notify, refresh: () => void, onRequest: (from: string) => void): Promise<PilotWindow> {
  const r = c.wf.cfg.remote!;
  const dataDir = await c.wf.eng.dataDir();
  const streamer = await new PilotStreamer({
    server: r.server,
    product: r.product,
    epic: c.epic,
    dataDir,
    filter: (item) => (c.wf.cfg.adapter.filterTranscriptItem ? c.wf.cfg.adapter.filterTranscriptItem(item) : null),
    secrets: () => secretValues(c.worktree),
    intervalMs: Number(process.env.FLIGHTDECK_LIVE_MS) || 200,
    onError: (e) => out.appendLine(`[실시간] ${e instanceof Error ? e.message : e}`),
  }).start();
  const opinions = new OpinionTree();
  const conn = new LiveConnection(r.server, r.product, c.epic, (m: LiveMessage) => {
    if (m.type === "opinion" && m.to?.includes(c.wf.cfg.member)) {
      opinions.add({ id: m.data.id, from: m.from, body: m.data.body, ...(m.data.target ? { target: m.data.target } : {}), at: m.at, status: "new" });
      void notify(`Flightdeck: @${m.from}의 의견 — ${String(m.data.body).slice(0, 80)}`, "의견 보기").then((p) => (p ? vscode.commands.executeCommand("flightdeck.opinions.focus") : undefined));
      refresh();
    } else if (m.type === "pilot.request" && m.to?.includes(c.wf.cfg.member)) onRequest(m.from);
  }, (ok, e) => out.appendLine(`[실시간] ${ok ? "연결" : `끊김: ${e instanceof Error ? e.message : e}`}`)).start();
  return {
    opinions,
    dispose: () => {
      streamer.stop();
      conn.stop();
    },
  };
}

/** 의견 처리 (§8.4 표): 에이전트에 전달 / 급한 의견 / 답장 / 닫기 */
export async function handleOpinion(c: LiveCtx, tree: OpinionTree, o: OpinionMsg, action: "deliver" | "urgent" | "reply" | "dismiss", text?: string): Promise<void> {
  const r = c.wf.cfg.remote!;
  if (action === "deliver" || action === "urgent") {
    const body = text ?? o.body;
    await c.wf.deliverOpinion(c.epic, { id: o.id, from: o.from, body, urgent: action === "urgent", at: nowIso(), ...(o.target ? { target: o.target } : {}) });
    tree.set(o.id, action === "urgent" ? "urgent" : "delivered");
    await r.server.liveSend(r.product, c.epic, "opinion.status", { id: o.id, status: action === "urgent" ? "urgent" : "delivered" }, [o.from]);
  } else if (action === "reply") {
    if (!text) return;
    tree.set(o.id, "replied");
    await r.server.liveSend(r.product, c.epic, "opinion.reply", { id: o.id, body: text }, [o.from]);
  } else {
    tree.set(o.id, "dismissed");
    await r.server.liveSend(r.product, c.epic, "opinion.status", { id: o.id, status: "dismissed" }, [o.from]);
  }
}

/** 조종을 넘겨받았는가 (이 PC에 작업 폴더가 없는데 조종수가 나) */
export function adoptedButNotOpened(s: EpicState, me: string, role: string | null): boolean {
  return writerOf(s) === me && s.pilotHistory.length > 0 && role !== "owner";
}

export const liveFolderEpic = (folder: string): string | null => {
  const m = /^(.+)@live$/.exec(path.basename(folder));
  return m && path.basename(path.dirname(folder)).endsWith(".flightdeck") ? m[1]! : null;
};

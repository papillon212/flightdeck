// 회의 화면 (설계 §10.1, M6). extension.ts가 에픽 창에서 부른다.
// - Meet 어댑터: 설정 flightdeck.meet = google(OAuth 클라이언트 필요) | gws(개발 모드) | fixture(개발 모드, 시험용 회의 자료)
// - 회의 중 포커스: 이 창에서 보는 파일·줄을 2초 간격으로 모았다가 회의가 끝나면 한 번 올린다(G1)
// - 주최자: 끝내면 회의록을 기다려 앵커링 초안을 열고(G3·G6), 검토 뒤 게시
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { nowIso, type EpicState } from "@flightdeck/core";
import { FixtureMeet, googleDesktopLogin, GwsMeet, MEET_SCOPES, RestMeet, type MeetAdapter } from "./meet.ts";
import type { EpicWorkflow } from "./workflow.ts";

const REFRESH_KEY = "flightdeck.google.refresh";

/** 설정에 따른 Meet 어댑터. 개발용(gws·fixture)은 개발 모드에서만 */
export async function meetAdapter(ext: vscode.ExtensionContext): Promise<MeetAdapter> {
  const cfg = vscode.workspace.getConfiguration("flightdeck");
  const kind = cfg.get<string>("meet") || "google";
  const dev = ext.extensionMode === vscode.ExtensionMode.Development;
  if (kind === "fixture") {
    if (!dev) throw new Error("시험용 회의 자료(fixture)는 개발 모드에서만 쓸 수 있습니다");
    const dir = process.env.FLIGHTDECK_MEET_FIXTURE || cfg.get<string>("meetFixtureDir");
    if (!dir) throw new Error("flightdeck.meetFixtureDir 설정이 없습니다");
    return new FixtureMeet(dir);
  }
  if (kind === "gws") {
    if (!dev) throw new Error("gws 위임은 개발 모드에서만 쓸 수 있습니다");
    return new GwsMeet(cfg.get<string>("gwsPath") || "gws");
  }
  const clientId = cfg.get<string>("googleClientId");
  if (!clientId) throw new Error("Google OAuth 클라이언트(flightdeck.googleClientId)가 없습니다. 관리자에게 받으세요");
  const clientSecret = cfg.get<string>("googleClientSecret") || undefined;
  let access: { token: string; until: number } | null = null;
  return new RestMeet(async () => {
    if (access && access.until > Date.now() + 60_000) return access.token;
    const refresh = await ext.secrets.get(REFRESH_KEY);
    if (refresh) {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ refresh_token: refresh, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), grant_type: "refresh_token" }),
      });
      const t = (await r.json()) as { access_token?: string; expires_in?: number };
      if (t.access_token) {
        access = { token: t.access_token, until: Date.now() + (t.expires_in ?? 3600) * 1000 };
        return access.token;
      }
    }
    const t = await googleDesktopLogin({ clientId, ...(clientSecret ? { clientSecret } : {}), scopes: MEET_SCOPES, open: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)) });
    if (t.refresh_token) await ext.secrets.store(REFRESH_KEY, t.refresh_token);
    access = { token: t.access_token, until: Date.now() + t.expires_in * 1000 };
    return access.token;
  });
}

/** 진행 중인 회의 (끝나지 않은 것) */
export function openSession(s: EpicState) {
  return [...s.sessions.values()].find((x) => !x.ended_at) ?? null;
}

/** 회의 중 포커스 기록 (§10.1 ③, G1). 회의가 끝나면 한 번 올린다 */
export class FocusRecorder implements vscode.Disposable {
  private entries: { ts: string; file: string; range: [number, number] }[] = [];
  private last = "";
  private subs: vscode.Disposable[] = [];
  private sid: string | null = null;

  constructor(
    private wf: EpicWorkflow,
    private epic: string,
    private worktree: string,
    private out: vscode.OutputChannel,
  ) {
    const rec = (ed: vscode.TextEditor | undefined) => {
      if (!this.sid || !ed || ed.document.uri.scheme !== "file") return;
      const rel = path.relative(this.worktree, ed.document.uri.fsPath).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
      const vis = ed.visibleRanges[0];
      const sel = ed.selection;
      const range: [number, number] = sel.isEmpty && vis ? [vis.start.line + 1, vis.end.line + 1] : [sel.start.line + 1, sel.end.line + 1];
      const key = `${rel}:${range.join("-")}`;
      if (key === this.last) return;
      this.last = key;
      this.entries.push({ ts: nowIso(), file: rel, range });
    };
    let timer: NodeJS.Timeout | null = null;
    const throttled = (ed: vscode.TextEditor | undefined) => {
      if (timer) return;
      timer = setTimeout(() => ((timer = null), rec(ed ?? vscode.window.activeTextEditor)), 2000);
    };
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((e) => rec(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => throttled(e.textEditor)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => throttled(e.textEditor)),
    );
  }

  get count(): number {
    return this.entries.length;
  }

  /** 상태가 바뀔 때 부른다: 회의가 시작되면 모으기 시작, 끝나면 올린다 */
  async update(s: EpicState): Promise<void> {
    const open = openSession(s);
    if (open && this.sid !== open.sid) {
      this.sid = open.sid;
      this.entries = [];
      this.last = "";
    }
    if (!this.sid) return;
    const ss = s.sessions.get(this.sid);
    if (!ss?.ended_at) return;
    const sid = this.sid;
    this.sid = null;
    if (ss.focus.some((f) => f.member === this.wf.cfg.member)) return;
    const flag = path.join(await this.wf.eng.dataDir(), "sessions", `${sid}.focus-posted`);
    if (existsSync(flag)) return;
    await this.wf.postFocus(this.epic, sid, this.entries);
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(flag, String(this.entries.length));
    this.out.appendLine(`[회의] 포커스 ${this.entries.length}건을 올렸다 (${sid})`);
  }

  /** 시나리오·테스트용: 지금 보는 위치를 바로 기록 */
  recordNow(): void {
    this.last = "";
    const ed = vscode.window.activeTextEditor;
    if (ed && this.sid) {
      const rel = path.relative(this.worktree, ed.document.uri.fsPath).split(path.sep).join("/");
      this.entries.push({ ts: nowIso(), file: rel, range: [ed.selection.start.line + 1, ed.selection.end.line + 1] });
    }
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

/** 주최자: 회의록을 기다려 앵커링 초안을 만들고 연다 (§10.1 ⑤⑥) */
export async function collectAndOpen(ext: vscode.ExtensionContext, wf: EpicWorkflow, epic: string, sid: string, out: vscode.OutputChannel): Promise<string> {
  const meet = await meetAdapter(ext);
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck 회의 ${sid}`, cancellable: false }, (p) =>
    wf.collectSession(epic, sid, meet, {
      intervalMs: Number(process.env.FLIGHTDECK_MEET_POLL_MS) || 60_000,
      onWait: (m) => p.report({ message: m }),
    }),
  );
  out.appendLine(`[회의] ${sid} 회의록 ${r.notes.notes ? `${r.notes.notes.length}자` : "없음"}, 전사 ${r.notes.transcript.length}건, 항목 ${r.items.length}개`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(r.draft));
  await vscode.window.showTextDocument(doc, { preview: false });
  return r.draft;
}

export async function readDraft(wf: EpicWorkflow, sid: string): Promise<string | null> {
  const f = await wf.sessionDraftPath(sid);
  return existsSync(f) ? readFile(f, "utf8") : null;
}

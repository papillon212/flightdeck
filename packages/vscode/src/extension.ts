// Flightdeck VS Code 확장 (M1: 로컬 단일 사용자). 설계 §9.
// 화면을 workflow(EpicWorkflow)에 연결만 한다. 대화 화면은 만들지 않는다(§6.1): 에이전트는 Claude Code를 그대로 쓴다.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { ClaudeCodeAdapter, cleanEnv } from "@flightdeck/agent";
import { coalesce, nowIso, parseBlocks, PID_LINE, restoreParagraphIds, sha256, type EpicState, type Thread } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { appendEditRecords, readState } from "@flightdeck/hook";
import type { EditRecord, LocalEpicState } from "@flightdeck/schema";
import { ARTIFACT_FILES, EpicWorkflow } from "./workflow.ts";

// ---------------------------------------------------------------- 에픽 찾기

interface Ctx {
  wf: EpicWorkflow;
  repo: string;
  /** 이 창이 에픽 작업 폴더면 그 에픽 */
  epic: string | null;
  worktree: string | null;
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await git(args, { cwd })).trim();
  } catch {
    return null;
  }
}

async function member(cwd: string): Promise<string> {
  const set = vscode.workspace.getConfiguration("flightdeck").get<string>("member");
  if (set) return set;
  const email = (await gitOut(["config", "user.email"], cwd)) ?? "";
  return (email.split("@")[0] || "me").toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

async function resolveCtx(ext: vscode.ExtensionContext): Promise<Ctx | null> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return null;
  const top = await gitOut(["rev-parse", "--show-toplevel"], folder);
  if (!top) return null;
  const common = await gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], top);
  if (!common) return null;
  const repo = path.dirname(common); // 일반 레포: <repo>/.git
  const cfg = vscode.workspace.getConfiguration("flightdeck");
  const configDir = cfg.get<string>("configDir") || path.join(ext.extensionPath, "config", "sample");
  const wf = new EpicWorkflow({
    repo,
    member: await member(top),
    configDir,
    distDir: path.join(ext.extensionPath, "dist"),
    adapter: new ClaudeCodeAdapter(cfg.get<string>("claudePath") || "claude"),
    model: cfg.get<string>("model") || undefined,
    maxTurns: cfg.get<number>("maxTurns") || 40,
  });
  // 이 폴더가 어느 에픽의 작업 폴더인가
  const stateDir = path.join(common, "flightdeck", "state");
  const real = realpathSync(top);
  let epic: string | null = null;
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir).filter((n) => n.endsWith(".json"))) {
      try {
        const s = JSON.parse(await readFile(path.join(stateDir, f), "utf8")) as LocalEpicState;
        if (existsSync(s.worktree) && realpathSync(s.worktree) === real) epic = s.epic;
      } catch {
        /* 다른 파일 */
      }
    }
  }
  return { wf, repo, epic, worktree: epic ? top : null };
}

// ---------------------------------------------------------------- 쓰레드 화면 (Comments API, §3.3·§9.2)

class ThreadView implements vscode.Disposable {
  private controller = vscode.comments.createCommentController("flightdeck", "Flightdeck");
  private threads = new Map<string, vscode.CommentThread>();

  constructor(private ctx: Ctx) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (this.isArtifact(doc.uri) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
    };
    this.controller.options = { prompt: "질문·요청을 쓰세요. @멤버로 받는 사람을 지정합니다", placeHolder: "예: @park TTL은 몇 분인가요?" };
  }

  isArtifact(uri: vscode.Uri): boolean {
    if (!this.ctx.epic || !this.ctx.worktree) return false;
    const dir = path.join(this.ctx.worktree, ".flightdeck", "epics", this.ctx.epic);
    return ARTIFACT_FILES.some((n) => samePath(uri.fsPath, path.join(dir, n)));
  }

  /** 상태가 바뀌면 쓰레드를 모두 다시 그린다. 위치는 thread.range가 아니라 문서의 문단 ID로 계산한다 (§3.3 v0.10) */
  async refresh(state: EpicState): Promise<void> {
    if (!this.ctx.epic || !this.ctx.worktree) return;
    for (const t of this.threads.values()) t.dispose();
    this.threads.clear();
    for (const name of ARTIFACT_FILES) {
      const file = path.join(this.ctx.worktree, ".flightdeck", "epics", this.ctx.epic, name);
      if (!existsSync(file)) continue;
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      const blocks = parseBlocks(lines);
      for (const t of [...state.threads.values()].filter((x) => x.file === name && x.anchor.type === "paragraph")) {
        const b = blocks.find((x) => x.pid === (t.anchor.type === "paragraph" ? t.anchor.pid : ""));
        const line = b ? b.end : Math.max(0, lines.length - 1);
        const ct = this.controller.createCommentThread(vscode.Uri.file(file), new vscode.Range(line, 0, line, 0), comments(t));
        ct.label = `${t.id} · ${KIND_LABEL[t.kind]}${b ? "" : " · 위치를 잃음"}`;
        ct.contextValue = t.status === "open" ? "fd-open" : "fd-resolved";
        ct.state = t.status === "open" ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved;
        ct.collapsibleState = t.status === "open" ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
        ct.canReply = true;
        this.threads.set(t.id, ct);
      }
    }
  }

  idOf(thread: vscode.CommentThread): string | null {
    for (const [id, t] of this.threads) if (t === thread) return id;
    return null;
  }

  dispose(): void {
    this.controller.dispose();
  }
}

const KIND_LABEL = { question: "질문", change_request: "수정 요청", note: "메모" } as const;
const SOURCE_LABEL = { human: "", agent: " (에이전트)", session: " (회의)" } as const;

function comments(t: Thread): vscode.Comment[] {
  const c = (author: string, body: string, at: string): vscode.Comment => ({
    author: { name: author },
    body: new vscode.MarkdownString(body),
    mode: vscode.CommentMode.Preview,
    timestamp: new Date(at),
  });
  return [
    c(`@${t.author}${t.to.length ? " → " + t.to.map((m) => "@" + m).join(" ") : ""}`, t.body, t.at),
    ...t.replies.map((r) => c(`@${r.author}${SOURCE_LABEL[r.source]}`, r.body, r.at)),
  ];
}

// ---------------------------------------------------------------- 사람 편집 기록 (§8.6), 문단 ID 보호 (§6.2)

class HumanEdits implements vscode.Disposable {
  private shadows = new Map<string, string>();
  private pending = new Map<string, Omit<EditRecord, "seq">[]>();
  private timer: NodeJS.Timeout | null = null;
  /** 저장이 확인된 마지막 내용 (문단 ID 검사 기준) */
  private lastGood = new Map<string, string>();
  /** 저장 직전 ID 복원 편집이 들어갈 문서. 그 변경은 사람 편집이 아니라 flightdeck 출처로 기록한다 */
  private restoring = new Set<string>();
  private subs: vscode.Disposable[] = [];

  constructor(
    private ctx: Ctx,
    private dataDir: string,
    private member: string,
    private onArtifactSaved: () => Promise<void>,
  ) {
    for (const d of vscode.workspace.textDocuments) this.track(d);
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.track(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.change(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.willSave(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.saved(d)),
    );
  }

  private inWorktree(uri: vscode.Uri): string | null {
    if (uri.scheme !== "file" || !this.ctx.worktree) return null;
    const rel = path.relative(this.ctx.worktree, uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const r = rel.split(path.sep).join("/");
    if (r.startsWith(".git/") || r === ".claude/settings.local.json" || r === ".mcp.json" || r.startsWith(".flightdeck/.runtime/")) return null;
    return r;
  }

  private track(d: vscode.TextDocument) {
    if (!this.inWorktree(d.uri) || this.shadows.has(d.uri.fsPath)) return;
    this.shadows.set(d.uri.fsPath, d.getText());
    this.lastGood.set(d.uri.fsPath, d.getText());
  }

  private change(e: vscode.TextDocumentChangeEvent) {
    const rel = this.inWorktree(e.document.uri);
    if (!rel || !e.contentChanges.length) return;
    const key = e.document.uri.fsPath;
    const prev = this.shadows.get(key);
    const now = e.document.getText();
    this.shadows.set(key, now);
    if (prev === undefined) return;
    // 디스크 재로드(에이전트·Flightdeck·외부 도구가 파일을 바꿈)는 사람 편집이 아니다 (§7.4 v0.10)
    let disk: string | null = null;
    try {
      disk = readFileSync(key, "utf8");
    } catch {
      /* 새 파일 */
    }
    if (disk === now) {
      this.lastGood.set(key, now);
      return;
    }
    // 한 이벤트 안의 변경은 모두 이벤트 전 기준 오프셋 → 뒤에서부터 하나씩 기록 (base_hash 사슬)
    let base = prev;
    const list = this.pending.get(rel) ?? [];
    const restoring = this.restoring.delete(key);
    const source = restoring ? { kind: "flightdeck" as const, member: this.member, reason: "paragraph_ids" as const } : { kind: "human" as const, member: this.member };
    for (const c of [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      list.push({ epic: this.ctx.epic!, file: rel, base_hash: sha256(base), range: [c.rangeOffset, c.rangeOffset + c.rangeLength], insert: c.text, source, ts: nowIso() });
      base = base.slice(0, c.rangeOffset) + c.text + base.slice(c.rangeOffset + c.rangeLength);
    }
    this.pending.set(rel, list);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  /** IME 조합 같은 연속 편집을 묶어서 기록한다 (§8.6 v0.10) */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const all = [...this.pending.values()].flat();
    this.pending.clear();
    if (!all.length) return;
    const withSeq = all.map((r, i) => ({ ...r, seq: i + 1 }));
    const merged = coalesce(withSeq).map(({ seq: _s, ...r }) => r);
    await appendEditRecords(this.dataDir, this.ctx.epic!, merged);
  }

  private isArtifact(rel: string | null): boolean {
    return !!rel && ARTIFACT_FILES.some((n) => rel === `.flightdeck/epics/${this.ctx.epic}/${n}`);
  }

  /**
   * 저장 직전: 지워지거나 바뀐 문단 ID 줄만 되살린다 (§3.2 "저장할 때 검사해 복원").
   * 저장 자체에 편집을 끼워 넣으므로 디스크 쓰기와 경쟁하지 않고, 같은 저장의 다른 편집은 그대로 남는다.
   */
  private willSave(e: vscode.TextDocumentWillSaveEvent) {
    const d = e.document;
    if (!this.isArtifact(this.inWorktree(d.uri))) return;
    const before = this.lastGood.get(d.uri.fsPath);
    if (before === undefined) return;
    const fixed = restoreParagraphIds(before, d.getText());
    if (!fixed.restored.length) return;
    this.restoring.add(d.uri.fsPath);
    e.waitUntil(Promise.resolve([vscode.TextEdit.replace(d.validateRange(new vscode.Range(0, 0, d.lineCount, 0)), fixed.text)]));
    const what = fixed.restored.map((v) => (v.kind === "changed" ? `${v.to}→${v.from}` : v.pid)).join(", ");
    vscode.window.showWarningMessage(`Flightdeck: 지우거나 바꾼 문단 ID를 복원했습니다 (${what}). <!-- p:… --> 줄은 쓰레드 위치의 기준이라 그대로 두세요. 다른 수정은 저장됐습니다.`);
  }

  private async saved(d: vscode.TextDocument) {
    const rel = this.inWorktree(d.uri);
    if (!rel) return;
    await this.flush();
    if (!this.isArtifact(rel)) return;
    this.lastGood.set(d.uri.fsPath, d.getText());
    await this.onArtifactSaved();
  }

  dispose(): void {
    void this.flush();
    for (const s of this.subs) s.dispose();
  }
}

// ---------------------------------------------------------------- 활성화

export async function activate(ext: vscode.ExtensionContext): Promise<void> {
  const ctx = await resolveCtx(ext);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  ext.subscriptions.push(status);
  const out = vscode.window.createOutputChannel("Flightdeck");
  ext.subscriptions.push(out);
  vscode.commands.executeCommand("setContext", "flightdeck.inEpic", !!ctx?.epic);

  const need = (): Ctx & { epic: string; worktree: string } => {
    if (!ctx?.epic || !ctx.worktree) throw new Error("에픽 작업 폴더에서 실행하세요. (Flightdeck: 새 에픽으로 시작)");
    return ctx as Ctx & { epic: string; worktree: string };
  };
  const run = (name: string, fn: (...a: any[]) => Promise<unknown>) =>
    vscode.commands.registerCommand(name, async (...a: any[]) => {
      try {
        await fn(...a);
      } catch (err) {
        out.appendLine(`[${name}] ${(err as Error).stack ?? err}`);
        vscode.window.showErrorMessage(`Flightdeck: ${(err as Error).message}`);
      }
    });

  let view: ThreadView | null = null;
  const refresh = async () => {
    if (!ctx?.epic) {
      status.text = "$(rocket) Flightdeck";
      status.tooltip = "Flightdeck: 새 에픽";
      status.command = "flightdeck.newEpic";
      status.show();
      return;
    }
    const s = await ctx.wf.sync(ctx.epic);
    const open = [...s.threads.values()].filter((t) => t.status === "open").length;
    status.text = `$(rocket) Flightdeck · ${ctx.epic} · ${s.phase}${open ? ` · 열린 쓰레드 ${open}` : ""}`;
    status.tooltip = "Flightdeck: 단계 완료 / 초안 / 이어서 작업";
    status.command = "flightdeck.menu";
    status.show();
    await view?.refresh(s);
  };

  if (ctx?.epic && ctx.worktree) {
    view = new ThreadView(ctx);
    ext.subscriptions.push(view);
    const dataDir = await ctx.wf.eng.dataDir();
    ext.subscriptions.push(new HumanEdits(ctx, dataDir, ctx.wf.cfg.member, refresh));
    // 에이전트가 산출물을 고치면(디스크 변경) 문단 ID를 붙이고 쓰레드를 다시 그린다
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(ctx.worktree, ".flightdeck", "epics", ctx.epic), "{analysis,design}.md"));
    let t: NodeJS.Timeout | null = null;
    const later = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void refresh().catch((e) => out.appendLine(String(e))), 800);
    };
    watcher.onDidChange(later);
    watcher.onDidCreate(later);
    ext.subscriptions.push(watcher);
  }

  ext.subscriptions.push(
    run("flightdeck.newEpic", async () => {
      if (!ctx) throw new Error("git 레포 폴더를 연 창에서 실행하세요.");
      const epic = await vscode.window.showInputBox({ title: "새 에픽 (1/3)", prompt: "에픽 ID (일감 도구의 ID. 예: CU-86abc123)", validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v) ? null : "영문·숫자·-·_만") });
      if (!epic) return;
      const title = await vscode.window.showInputBox({ title: "새 에픽 (2/3)", prompt: "제목" });
      if (!title) return;
      const body = await vscode.window.showInputBox({ title: "새 에픽 (3/3)", prompt: "일감 본문 (M1은 일감 도구 대신 직접 입력)" });
      if (body === undefined) return;
      const { worktree } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${epic} 시작` }, () => ctx.wf.start(epic, title, body));
      const pick = await vscode.window.showInformationMessage(`${epic} 작업 폴더를 만들었습니다. 분석 초안을 에이전트에게 맡길까요?`, "초안 작성 후 열기", "바로 열기");
      if (pick === "초안 작성 후 열기") await draftWithProgress(ctx.wf, epic, out);
      // 설계 §9.1은 새 창. 단 개발 모드(Extension Development Host)의 새 창에는 개발 중인 확장이 실리지 않아 같은 창에서 연다
      const newWindow = ext.extensionMode !== vscode.ExtensionMode.Development;
      if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktree), { forceNewWindow: newWindow });
    }),

    run("flightdeck.draft", async () => {
      const c = need();
      await draftWithProgress(c.wf, c.epic, out);
      await refresh();
      const pick = await vscode.window.showInformationMessage("초안을 작성했습니다. 같은 세션을 이어서 대화형으로 계속할 수 있습니다.", "이어서 작업");
      if (pick) await vscode.commands.executeCommand("flightdeck.resume");
    }),

    run("flightdeck.resume", async () => {
      const c = need();
      const s = await readState(await c.wf.eng.dataDir(), c.epic);
      const cmd = s.draft_session ? c.wf.cfg.adapter.resumeCommand!({ sessionId: s.draft_session, cwd: c.worktree }) : [c.wf.cfg.adapter.id === "claude-code" ? "claude" : c.wf.cfg.adapter.id];
      // 부모 프로세스의 CLAUDECODE·CLAUDE_CODE_* 를 지운 환경으로 연다 (§6.1)
      const env = Object.fromEntries(Object.keys(process.env).filter((k) => !(k in cleanEnv())).map((k) => [k, null]));
      const term = vscode.window.createTerminal({ name: `Flightdeck ${c.epic}`, cwd: c.worktree, env: env as Record<string, null> });
      term.show();
      term.sendText(cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
    }),

    run("flightdeck.completePhase", async () => {
      const c = need();
      const r = await c.wf.completePhase(c.epic);
      if (!r.ok) {
        vscode.window.showWarningMessage(`아직 단계를 완료할 수 없습니다:\n${r.problems.map((p) => `• ${p}`).join("\n")}`, { modal: true });
        return;
      }
      await refresh();
      const pick = await vscode.window.showInformationMessage(`${c.epic}: ${r.phase} 단계로 넘어갔습니다${r.commit ? ` (커밋 ${r.commit.slice(0, 7)})` : ""}.`, r.phase === "DESIGN" ? "설계 초안 작성" : "확인");
      if (pick === "설계 초안 작성") await vscode.commands.executeCommand("flightdeck.draft");
    }),

    run("flightdeck.menu", async () => {
      const items = [
        { label: "$(check) 단계 완료", cmd: "flightdeck.completePhase" },
        { label: "$(sparkle) 에이전트 초안 작성", cmd: "flightdeck.draft" },
        { label: "$(terminal) 이어서 작업 (Claude Code)", cmd: "flightdeck.resume" },
        { label: "$(refresh) 새로 고침", cmd: "flightdeck.refresh" },
      ];
      const p = await vscode.window.showQuickPick(items, { title: "Flightdeck" });
      if (p) await vscode.commands.executeCommand(p.cmd);
    }),

    run("flightdeck.refresh", refresh),

    // Comments: 새 쓰레드 또는 답글 (§3.4)
    run("flightdeck.reply", async (reply: vscode.CommentReply) => {
      const c = need();
      const id = view?.idOf(reply.thread);
      if (id) {
        await c.wf.reply(c.epic, id, reply.text);
      } else {
        const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
        const pid = pidAt(doc, reply.thread.range?.start.line ?? 0);
        if (!pid) throw new Error("문단 ID가 없는 줄입니다. 저장하면 ID가 붙습니다.");
        const kind = await vscode.window.showQuickPick(
          [
            { label: "질문", value: "question" as const },
            { label: "수정 요청", value: "change_request" as const },
            { label: "메모", value: "note" as const },
          ],
          { title: "쓰레드 종류" },
        );
        if (!kind) return;
        const to = [...reply.text.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)].map((m) => m[1]!.toLowerCase());
        await c.wf.createThread(c.epic, { file: path.basename(doc.uri.fsPath), pid, kind: kind.value, to, body: reply.text });
        reply.thread.dispose();
      }
      await refresh();
    }),
    run("flightdeck.resolve", async (thread: vscode.CommentThread) => {
      const c = need();
      const id = view?.idOf(thread);
      if (id) await c.wf.setThreadStatus(c.epic, id, true);
      await refresh();
    }),
    run("flightdeck.reopen", async (thread: vscode.CommentThread) => {
      const c = need();
      const id = view?.idOf(thread);
      if (id) await c.wf.setThreadStatus(c.epic, id, false);
      await refresh();
    }),
  );

  await refresh().catch((e) => out.appendLine(String(e)));

  // 자동 점검: FLIGHTDECK_SMOKE=<결과 파일>이면 활성화 결과를 쓰고 창을 닫는다 (개발용)
  const smoke = process.env.FLIGHTDECK_SMOKE;
  if (smoke) {
    const s = ctx?.epic ? await ctx.wf.epicState(ctx.epic) : null;
    const { writeFile } = await import("node:fs/promises");
    // 문단 ID 보호 점검: analysis.md에서 ID 줄 하나를 지우고 다른 줄도 고친 뒤 저장 → ID만 복원되고 다른 수정은 남는가
    let pidTest: unknown = null;
    if (ctx?.epic && ctx.worktree) {
      const file = path.join(ctx.worktree, ".flightdeck", "epics", ctx.epic, "analysis.md");
      if (existsSync(file)) {
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        const lines = doc.getText().split(/\r?\n/);
        const idLine = lines.findIndex((l) => PID_LINE.test(l));
        const pidLine = lines[idLine]!;
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(idLine, 0, idLine + 1, 0));
        edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "\n스모크 점검 문장\n");
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await new Promise((r) => setTimeout(r, 1500));
        const after = doc.getText();
        pidTest = { pidLine, restored: after.split(/\r?\n/).includes(pidLine), otherEditKept: after.includes("스모크 점검 문장"), dirty: doc.isDirty };
      }
    }
    await writeFile(
      smoke,
      JSON.stringify({ epic: ctx?.epic ?? null, repo: ctx?.repo ?? null, member: ctx?.wf.cfg.member ?? null, phase: s?.phase ?? null, status: status.text, threads: s ? s.threads.size : 0, commentThreads: (view as any)?.threads?.size ?? 0, pidTest }, null, 2),
    );
    await vscode.commands.executeCommand("workbench.action.quit");
  }
}

async function draftWithProgress(wf: EpicWorkflow, epic: string, out: vscode.OutputChannel) {
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${epic} 에이전트 초안 작성 중 (백그라운드 claude -p)`, cancellable: false },
    () => wf.draft(epic),
  );
  out.appendLine(`[draft] ${epic} session=${r.sessionId}\n${r.result}`);
}

/** 줄이 속한 블록의 문단 ID. ID 줄 자체를 가리키면 다음 블록 */
function pidAt(doc: vscode.TextDocument, line: number): string | null {
  const lines = doc.getText().split(/\r?\n/);
  const blocks = parseBlocks(lines);
  const b = blocks.find((x) => line >= x.start && line <= x.end) ?? blocks.find((x) => x.start === line + 1);
  return b?.pid ?? null;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export function deactivate(): void {}

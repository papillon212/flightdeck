// Flightdeck VS Code 확장 (M2: 원격 협업). 설계 §9.
// 화면을 workflow(EpicWorkflow)에 연결만 한다. 대화 화면은 만들지 않는다(§6.1): 에이전트는 Claude Code를 그대로 쓴다.
// 서버 모드(flightdeck.serverUrl 설정): 로그인한 멤버, 서버가 서명한 설정, 원격 메타 브랜치, 일감 도구 연동.
// 개발 모드(설정 없음): M1과 같이 로컬 설정 폴더·로컬 메타 브랜치, 서명 없음.
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { ClaudeCodeAdapter, cleanEnv } from "@flightdeck/agent";
import { coalesce, nowIso, parseBlocks, PID_LINE, restoreParagraphIds, sha256, type ConfigPayload, type EpicState, type Thread } from "@flightdeck/core";
import { git, RemoteEventStore } from "@flightdeck/git";
import { appendEditRecords, readState } from "@flightdeck/hook";
import { parsePipeline, type EditRecord, type LocalEpicState, type Phase } from "@flightdeck/schema";
import { ClickUpTracker, type TrackerAdapter } from "@flightdeck/tracker";
import { cacheConfig, loadCachedConfig, ServerClient, ServerRequestError } from "./server-client.ts";
import { ARTIFACT_FILES, EpicWorkflow, type InboxItem } from "./workflow.ts";

// ---------------------------------------------------------------- 에픽 찾기

interface Ctx {
  wf: EpicWorkflow;
  repo: string;
  /** 이 창이 에픽 작업 폴더(또는 읽기 전용 창)면 그 에픽 */
  epic: string | null;
  worktree: string | null;
  role: "owner" | "viewer";
  mode: "server" | "dev";
  /** 서버 모드인데 로그인이 안 됐거나 서버에 닿지 못해 쓸 수 없는 이유 */
  blocked?: string;
  /** 서버에 닿지 못해 캐시한 설정으로 동작 중 */
  offline?: boolean;
}

const EXT_ID = "flightdeck.flightdeck";
const tokenKey = (url: string) => `flightdeck.session:${url}`;
const TRACKER_TOKEN_KEY = "flightdeck.trackerToken";

/** 서버 모드: 로그인 → 나 → 설정(지문 검증, 캐시) → 일감 도구. 실패하면 이유를 담아 돌려준다 */
async function serverSetup(
  ext: vscode.ExtensionContext,
  dataDir: string,
): Promise<{ server: ServerClient; member: string; config: ConfigPayload; product: string; tracker?: TrackerAdapter; offline: boolean } | { blocked: string }> {
  const cfg = vscode.workspace.getConfiguration("flightdeck");
  const url = cfg.get<string>("serverUrl")!;
  const fp = cfg.get<string>("serverKeyFingerprint") ?? "";
  const product = cfg.get<string>("product") ?? "";
  if (!fp) return { blocked: "flightdeck.serverKeyFingerprint 설정이 없습니다 (관리자가 배포)" };
  if (!product) return { blocked: "flightdeck.product 설정이 없습니다" };
  const server = new ServerClient(url, (await ext.secrets.get(tokenKey(url))) ?? null, fp);
  let member: string;
  let config: ConfigPayload;
  let offline = false;
  try {
    // 개발용 로그인 멤버가 정해져 있으면 바로 로그인한다 (서버가 루프백에서 개발용 로그인을 켰을 때만 된다)
    const dev = cfg.get<string>("devLoginMember");
    if (!server.loggedIn && dev) await ext.secrets.store(tokenKey(url), await server.devLogin(dev));
    if (!server.loggedIn) return { blocked: "서버에 로그인하세요 (Flightdeck: 서버 로그인)" };
    member = (await server.me()).id;
    config = await server.config(product);
    await cacheConfig(dataDir, config);
    await ext.globalState.update(`flightdeck.member:${url}`, member);
  } catch (e) {
    if (e instanceof ServerRequestError && e.status === 401) {
      await ext.secrets.delete(tokenKey(url));
      return { blocked: `서버 로그인이 필요합니다: ${e.message}` };
    }
    if (!(e instanceof ServerRequestError && e.status === 0)) return { blocked: `서버 설정을 받지 못했습니다: ${(e as Error).message}` };
    // 서버 장애: 캐시한 설정으로 계속한다. 단계 통과(시작·완료)는 서버가 있어야 한다 (§2.5)
    const cached = await loadCachedConfig(dataDir, product);
    const last = ext.globalState.get<string>(`flightdeck.member:${url}`);
    if (!cached || !last) return { blocked: `서버에 닿지 못했고 캐시한 설정도 없습니다: ${(e as Error).message}` };
    [config, member, offline] = [cached, last, true];
  }
  let tracker: TrackerAdapter | undefined;
  // 개발 모드(Extension Development Host)에서만 환경변수 토큰을 받는다 (자동 점검용)
  const devTok = ext.extensionMode === vscode.ExtensionMode.Development ? process.env.FLIGHTDECK_TRACKER_TOKEN : undefined;
  const tok = devTok || (await ext.secrets.get(TRACKER_TOKEN_KEY));
  const tcfg = parsePipeline(config.pipeline_yaml).tracker as { provider: string; clickup?: { list_ids?: string[]; tag?: string; status_map?: Partial<Record<Phase, string>> } };
  if (tok && tcfg.provider === "clickup" && tcfg.clickup) {
    tracker = new ClickUpTracker({ token: tok, list_ids: tcfg.clickup.list_ids ?? [], tag: tcfg.clickup.tag, status_map: tcfg.clickup.status_map ?? {} });
  }
  return { server, member, config, product, ...(tracker ? { tracker } : {}), offline };
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
  const dataDir = path.join(common, "flightdeck");
  const cfg = vscode.workspace.getConfiguration("flightdeck");
  const base = {
    repo,
    distDir: path.join(ext.extensionPath, "dist"),
    adapter: new ClaudeCodeAdapter(cfg.get<string>("claudePath") || "claude"),
    model: cfg.get<string>("model") || undefined,
    maxTurns: cfg.get<number>("maxTurns") || 40,
  };
  let wf: EpicWorkflow;
  let mode: Ctx["mode"] = "dev";
  let blocked: string | undefined;
  let offline = false;
  if (cfg.get<string>("serverUrl")) {
    mode = "server";
    const r = await serverSetup(ext, dataDir);
    if ("blocked" in r) {
      blocked = r.blocked;
      wf = new EpicWorkflow({ ...base, member: "unknown", configDir: path.join(ext.extensionPath, "config", "sample") });
    } else {
      offline = r.offline;
      wf = new EpicWorkflow({
        ...base,
        member: r.member,
        configDir: path.join(dataDir, "config", r.product, r.config.version),
        excludeSecrets: parsePipeline(r.config.pipeline_yaml).checkpoint.exclude_secrets,
        remote: {
          server: r.server,
          product: r.product,
          config: r.config,
          gitRemote: cfg.get<string>("gitRemote") || "origin",
          ...(r.tracker ? { tracker: r.tracker } : {}),
          linkFor: (e, t) => `${vscode.env.uriScheme}://${EXT_ID}/open?epic=${encodeURIComponent(e)}${t ? `&thread=${t}` : ""}`,
        },
      });
    }
  } else {
    wf = new EpicWorkflow({ ...base, member: await member(top), configDir: cfg.get<string>("configDir") || path.join(ext.extensionPath, "config", "sample") });
  }
  // 이 폴더가 어느 에픽의 작업 폴더(또는 읽기 전용 창)인가
  const stateDir = path.join(dataDir, "state");
  const real = realpathSync(top);
  let epic: string | null = null;
  let role: Ctx["role"] = "owner";
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir).filter((n) => n.endsWith(".json"))) {
      try {
        const s = JSON.parse(await readFile(path.join(stateDir, f), "utf8")) as LocalEpicState;
        if (existsSync(s.worktree) && realpathSync(s.worktree) === real) [epic, role] = [s.epic, s.role ?? "owner"];
      } catch {
        /* 다른 파일 */
      }
    }
  }
  return { wf, repo, epic, worktree: epic ? top : null, role, mode, ...(blocked ? { blocked } : {}), offline };
}

// ---------------------------------------------------------------- 쓰레드 화면 (Comments API, §3.3·§9.2)

class ThreadView implements vscode.Disposable {
  private controller = vscode.comments.createCommentController("flightdeck", "Flightdeck");
  private threads = new Map<string, vscode.CommentThread>();

  constructor(private ctx: Ctx) {
    this.controller.commentingRangeProvider = {
      // 읽기 전용 창(질문 대상)은 새 쓰레드를 만들 수 없다. 받은 쓰레드에 답글만 단다 (§3.4)
      provideCommentingRanges: (doc) => (this.ctx.role === "owner" && this.isArtifact(doc.uri) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
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
        ct.canReply = this.ctx.role === "owner" || t.to.includes(this.ctx.wf.cfg.member) || t.replies.some((r) => r.author === this.ctx.wf.cfg.member);
        this.threads.set(t.id, ct);
      }
    }
  }

  get(id: string): vscode.CommentThread | undefined {
    return this.threads.get(id);
  }

  get size(): number {
    return this.threads.size;
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
  const needOwner = () => {
    const c = need();
    if (c.role !== "owner") throw new Error("읽기 전용 창입니다. 담당자의 작업 폴더에서만 할 수 있습니다.");
    return c;
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
  /** 부가 동작(일감 멘션·상태, 원격 맞추기)의 경고를 보여 준다 */
  const flushWarnings = () => {
    for (const w of ctx?.wf.warnings.splice(0) ?? []) {
      out.appendLine(`[경고] ${w}`);
      vscode.window.showWarningMessage(`Flightdeck: ${w}`);
    }
  };
  /** 띄운 알림 문구 (출력 창에도 남긴다. 시나리오 자동 진행이 읽는다) */
  const notified: string[] = [];
  const notify = (text: string, ...buttons: string[]) => {
    notified.push(text);
    out.appendLine(`[알림] ${text}`);
    return vscode.window.showInformationMessage(text, ...buttons);
  };
  /** 내 에픽 쓰레드에 남이 단 새 답글 알림용 (쓰레드 → 답글 수) */
  let replyCounts: Map<string, number> | null = null;
  const refresh = async () => {
    if (ctx?.blocked) {
      status.text = "$(rocket) Flightdeck · 로그인 필요";
      status.tooltip = ctx.blocked;
      status.command = "flightdeck.login";
      status.show();
      return;
    }
    if (!ctx?.epic) {
      status.text = `$(rocket) Flightdeck${ctx?.mode === "server" ? ` · @${ctx.wf.cfg.member}` : ""}${ctx?.offline ? " · 서버 연결 안 됨" : ""}`;
      status.tooltip = ctx?.mode === "server" ? "Flightdeck: 내 일감 / 받은 질문" : "Flightdeck: 새 에픽";
      status.command = "flightdeck.menu";
      status.show();
      return;
    }
    const s = await ctx.wf.sync(ctx.epic);
    flushWarnings();
    for (const r of ctx.wf.lastRender.filter((x) => x.external)) {
      // §7.4 외부 변경 감지: 편집 기록에 없던 변경(셸·다른 에디터 등)
      vscode.window.showWarningMessage(
        `Flightdeck 밖에서 ${r.file}이(가) 수정됐습니다. 출처 external로 기록했습니다${r.restoredIds ? `. 지워지거나 바뀐 문단 ID ${r.restoredIds}개를 복원했습니다` : ""}.`,
      );
    }
    // 새 답글 알림 (§3.7 VS Code 실행 중): 남이 단 것만
    const me = ctx.wf.cfg.member;
    if (replyCounts) {
      for (const t of s.threads.values()) {
        const fresh = t.replies.slice(replyCounts.get(t.id) ?? 0).filter((r) => r.author !== me);
        for (const r of fresh) void notify(`Flightdeck: @${r.author}이(가) 답했습니다 (${t.id}): ${r.body.split("\n")[0]!.slice(0, 80)}`);
      }
    }
    replyCounts = new Map([...s.threads.values()].map((t) => [t.id, t.replies.length]));
    const open = [...s.threads.values()].filter((t) => t.status === "open").length;
    const ro = ctx.role === "viewer" ? " · 읽기 전용" : "";
    status.text = `$(rocket) Flightdeck · ${ctx.epic} · ${s.phase}${ro}${open ? ` · 열린 쓰레드 ${open}` : ""}${ctx.offline ? " · 서버 연결 안 됨" : ""}`;
    status.tooltip = ctx.role === "viewer" ? "질문 대상의 읽기 전용 창: 받은 쓰레드에 답글만 답니다" : "Flightdeck: 단계 완료 / 초안 / 이어서 작업";
    status.command = "flightdeck.menu";
    status.show();
    await view?.refresh(s);
  };

  // 받은 질문 알림 (§3.7): 처음 보는 것만. 알린 쓰레드는 모든 창이 공유하는 globalState에 남긴다
  const notifyInbox = async (items: InboxItem[]) => {
    const seen = new Set(ext.globalState.get<string[]>("flightdeck.notified") ?? []);
    const fresh = items.filter((i) => !seen.has(`${i.thread.id}#${i.thread.replies.length}`));
    if (!fresh.length) return;
    await ext.globalState.update("flightdeck.notified", [...seen, ...fresh.map((i) => `${i.thread.id}#${i.thread.replies.length}`)].slice(-500));
    for (const i of fresh) {
      const last = i.thread.replies.at(-1);
      void notify(`Flightdeck: ${last ? `@${last.author}의 답글` : `@${i.thread.author}의 질문`} (${i.epic}): ${(last?.body ?? i.thread.body).split("\n")[0]!.slice(0, 80)}`, "열기")
        .then((pick) => (pick ? openViewer(i.epic, i.commit) : undefined))
        .then(undefined, (e) => vscode.window.showErrorMessage(`Flightdeck: ${(e as Error).message}`));
    }
  };

  const sameWindow = ext.extensionMode === vscode.ExtensionMode.Development; // 개발 모드의 새 창에는 개발 중인 확장이 실리지 않는다
  const openViewer = async (epic: string, commit?: string) => {
    if (!ctx) throw new Error("git 레포 폴더를 연 창에서 실행하세요.");
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${epic} 읽기 전용 창 준비` }, () => ctx.wf.openAsViewer(epic, commit));
    if (ctx.worktree && samePath(ctx.worktree, r.worktree)) return void (await refresh());
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: !sameWindow });
  };

  // 원격 메타 브랜치 감시 (§3.7: 20초 ls-remote). 바뀌면 이 창을 다시 그리고 받은 질문을 알린다
  if (ctx && !ctx.blocked && ctx.wf.store instanceof RemoteEventStore) {
    const interval = Number(process.env.FLIGHTDECK_POLL_MS) || 20_000;
    const onChange = async () => {
      try {
        if (ctx.epic && ctx.role === "viewer") await ctx.wf.openAsViewer(ctx.epic); // 최신 공유 커밋으로
        await refresh();
        await notifyInbox(await ctx.wf.inbox());
      } catch (e) {
        out.appendLine(`[watch] ${(e as Error).stack ?? e}`);
      }
    };
    const w = ctx.wf.store.watch(() => void onChange(), { intervalMs: interval, onError: (e) => out.appendLine(`[watch] ${e}`) });
    ext.subscriptions.push({ dispose: () => w.dispose() });
    setTimeout(() => void ctx.wf.inbox().then(notifyInbox, (e) => out.appendLine(`[inbox] ${e}`)), 1000);
  }

  // 읽기 전용 창: 파일을 읽기 전용으로 연다 (§2.4). 이 창의 변경은 다음 공유 커밋으로 옮길 때 버려진다
  if (ctx?.epic && ctx.role === "viewer") {
    await vscode.workspace.getConfiguration("files").update("readonlyInclude", { "**": true }, vscode.ConfigurationTarget.Workspace).then(undefined, () => undefined);
  }

  if (ctx?.epic && ctx.worktree && ctx.role === "viewer") {
    view = new ThreadView(ctx);
    ext.subscriptions.push(view);
  } else if (ctx?.epic && ctx.worktree) {
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
      if (ctx.blocked) throw new Error(ctx.blocked);
      if (ctx.mode === "server") {
        // 서버 모드: 나에게 배정된 일감에서 고른다 (§1.4, §9.1)
        if (!ctx.wf.cfg.remote?.tracker) {
          const pick = await vscode.window.showWarningMessage("일감 도구 개인 토큰이 없습니다. 먼저 설정하세요.", "토큰 설정");
          if (pick) await vscode.commands.executeCommand("flightdeck.setTrackerToken");
          return;
        }
        const list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Flightdeck: 내 일감 불러오는 중" }, () => ctx.wf.assignedEpics());
        if (!list.length) return void vscode.window.showInformationMessage("시작할 일감이 없습니다 (나에게 배정되고 태그가 붙은, 아직 시작하지 않은 일감).");
        const t = await vscode.window.showQuickPick(
          list.map((e) => ({ label: e.title, description: `${e.epicId} · ${e.status}`, detail: e.body.split("\n")[0], e })),
          { title: "내 일감에서 에픽 시작" },
        );
        if (!t) return;
        const { worktree } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${t.e.epicId} 시작 (서버 서명 요청)` }, () => ctx.wf.startFromTracker(t.e));
        flushWarnings();
        const pick = await vscode.window.showInformationMessage(`${t.e.epicId} 작업 폴더를 만들었습니다. 분석 초안을 에이전트에게 맡길까요?`, "초안 작성 후 열기", "바로 열기");
        if (pick === "초안 작성 후 열기") await draftWithProgress(ctx.wf, t.e.epicId, out);
        if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktree), { forceNewWindow: !sameWindow });
        return;
      }
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
      const c = needOwner();
      await draftWithProgress(c.wf, c.epic, out);
      await refresh();
      const pick = await vscode.window.showInformationMessage("초안을 작성했습니다. 같은 세션을 이어서 대화형으로 계속할 수 있습니다.", "이어서 작업");
      if (pick) await vscode.commands.executeCommand("flightdeck.resume");
    }),

    run("flightdeck.resume", async () => {
      const c = needOwner();
      const s = await readState(await c.wf.eng.dataDir(), c.epic);
      const cmd = s.draft_session ? c.wf.cfg.adapter.resumeCommand!({ sessionId: s.draft_session, cwd: c.worktree }) : [c.wf.cfg.adapter.id === "claude-code" ? "claude" : c.wf.cfg.adapter.id];
      // 부모 프로세스의 CLAUDECODE·CLAUDE_CODE_* 를 지운 환경으로 연다 (§6.1)
      const env = Object.fromEntries(Object.keys(process.env).filter((k) => !(k in cleanEnv())).map((k) => [k, null]));
      const term = vscode.window.createTerminal({ name: `Flightdeck ${c.epic}`, cwd: c.worktree, env: env as Record<string, null> });
      term.show();
      term.sendText(cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
    }),

    run("flightdeck.completePhase", async () => {
      const c = needOwner();
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
      const owner = !!ctx?.epic && ctx.role === "owner";
      const server = ctx?.mode === "server";
      const items = [
        ...(owner
          ? [
              { label: "$(check) 단계 완료", cmd: "flightdeck.completePhase" },
              { label: "$(sparkle) 에이전트 초안 작성", cmd: "flightdeck.draft" },
              { label: "$(terminal) 이어서 작업 (Claude Code)", cmd: "flightdeck.resume" },
            ]
          : []),
        ...(!ctx?.epic ? [{ label: server ? "$(tasklist) 내 일감에서 에픽 시작" : "$(add) 새 에픽", cmd: "flightdeck.newEpic" }] : []),
        ...(server ? [{ label: "$(mail) 받은 질문", cmd: "flightdeck.inbox" }] : []),
        { label: "$(refresh) 새로 고침", cmd: "flightdeck.refresh" },
        ...(server ? [{ label: "$(key) 일감 도구 개인 토큰 설정", cmd: "flightdeck.setTrackerToken" }, { label: "$(sign-out) 서버 로그아웃", cmd: "flightdeck.logout" }] : []),
      ];
      const p = await vscode.window.showQuickPick(items, { title: `Flightdeck${server ? ` · @${ctx!.wf.cfg.member}` : ""}` });
      if (p) await vscode.commands.executeCommand(p.cmd);
    }),

    run("flightdeck.inbox", async () => {
      if (!ctx || ctx.blocked) throw new Error(ctx?.blocked ?? "git 레포 폴더를 연 창에서 실행하세요.");
      const items = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Flightdeck: 받은 질문 확인" }, () => ctx.wf.inbox());
      flushWarnings();
      if (!items.length) return void vscode.window.showInformationMessage("답할 질문이 없습니다.");
      const p = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.thread.body.split("\n")[0]!.slice(0, 80), description: `${i.epic} · ${i.thread.id} · @${i.thread.author}`, detail: i.thread.replies.length ? `마지막 답글: @${i.thread.replies.at(-1)!.author}` : undefined, i })),
        { title: "받은 질문" },
      );
      if (p) await openViewer(p.i.epic, p.i.commit);
    }),

    run("flightdeck.login", async () => {
      const cfg = vscode.workspace.getConfiguration("flightdeck");
      const url = cfg.get<string>("serverUrl");
      if (!url) throw new Error("flightdeck.serverUrl 설정이 없습니다 (개발 모드에서는 로그인하지 않습니다)");
      const client = new ServerClient(url, null, cfg.get<string>("serverKeyFingerprint") ?? "");
      const dev = cfg.get<string>("devLoginMember");
      let token: string;
      if (dev) token = await client.devLogin(dev);
      else token = await googleLogin(url);
      await ext.secrets.store(tokenKey(url), token);
      const me = await new ServerClient(url, token, "").me();
      const pick = await vscode.window.showInformationMessage(`Flightdeck: @${me.id}(으)로 로그인했습니다. 창을 다시 불러옵니다.`, "다시 불러오기");
      if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),

    run("flightdeck.logout", async () => {
      const url = vscode.workspace.getConfiguration("flightdeck").get<string>("serverUrl");
      if (url) await ext.secrets.delete(tokenKey(url));
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),

    run("flightdeck.setTrackerToken", async () => {
      const t = await vscode.window.showInputBox({ title: "일감 도구(ClickUp) 개인 토큰", prompt: "ClickUp 설정 → Apps → API Token. VS Code 비밀 저장소에만 둡니다 (§1.4)", password: true, ignoreFocusOut: true });
      if (!t) return;
      await ext.secrets.store(TRACKER_TOKEN_KEY, t.trim());
      const pick = await vscode.window.showInformationMessage("토큰을 저장했습니다. 창을 다시 불러오면 적용됩니다.", "다시 불러오기");
      if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
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

  // 일감 멘션의 링크 (§3.7): vscode://flightdeck.flightdeck/open?epic=…&thread=…
  ext.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        try {
          const epic = new URLSearchParams(uri.query).get("epic");
          if (uri.path !== "/open" || !epic || !ctx) return;
          const st = await readState(await ctx.wf.eng.dataDir(), epic).catch(() => null);
          if (st?.role === "owner") return void (await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(st.worktree), { forceNewWindow: !sameWindow }));
          await openViewer(epic);
        } catch (e) {
          vscode.window.showErrorMessage(`Flightdeck: ${(e as Error).message}`);
        }
      },
    }),
  );

  await refresh().catch((e) => out.appendLine(String(e)));

  // M2 시나리오 자동 진행 (개발 모드에서만, scenario.ts)
  const scenario = process.env.FLIGHTDECK_SCENARIO;
  if (scenario && ext.extensionMode === vscode.ExtensionMode.Development && ctx && !ctx.blocked) {
    const { runScenario } = await import("./scenario.ts");
    void runScenario(
      {
        wf: ctx.wf, epic: ctx.epic, worktree: ctx.worktree, role: ctx.role,
        commentThread: (id) => view?.get(id), commentThreadCount: () => view?.size ?? 0, statusText: () => status.text,
        notifications: notified, refresh, openViewer,
      },
      scenario,
    );
  }

  // 자동 점검: FLIGHTDECK_SMOKE=<결과 파일>이면 활성화 결과를 쓰고 창을 닫는다 (개발용)
  const smoke = process.env.FLIGHTDECK_SMOKE;
  if (smoke) {
    const s = ctx?.epic ? await ctx.wf.epicState(ctx.epic) : null;
    const { writeFile } = await import("node:fs/promises");
    // 문단 ID 보호 점검: analysis.md에서 ID 줄 하나를 지우고 다른 줄도 고친 뒤 저장 → ID만 복원되고 다른 수정은 남는가
    let pidTest: unknown = null;
    if (ctx?.epic && ctx.worktree && ctx.role === "owner" && !process.env.FLIGHTDECK_SMOKE_SKIP_PID) {
      const file = path.join(ctx.worktree, ".flightdeck", "epics", ctx.epic, "analysis.md");
      if (existsSync(file)) {
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        const settle = () => new Promise((r) => setTimeout(r, 1500));
        // A: 첫 ID 줄의 내용만 지우고(빈 줄 남김) 다른 줄도 고친 뒤 저장
        const original = doc.getText();
        let lines = original.split(/\r?\n/);
        const idLine = lines.findIndex((l) => PID_LINE.test(l));
        const pidLine = lines[idLine]!;
        let edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(idLine, 0, idLine, pidLine.length));
        edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "\n스모크 점검 문장\n");
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await settle();
        const a = doc.getText();
        const blanks = (t: string) => t.split(/\r?\n/).filter((l) => l === "").length;
        // 새 문장을 붙이며 생긴 빈 줄 1개 말고는 빈 줄이 늘지 않아야 한다
        const caseA = { pidLine, restored: a.split(/\r?\n/)[idLine] === pidLine, noExtraBlank: blanks(a) === blanks(original) + 1, otherEditKept: a.includes("스모크 점검 문장") };
        // B: 두 줄 이상인 블록의 ID 줄과 첫 줄을 함께 지우고 저장
        lines = doc.getText().split(/\r?\n/);
        const blocks = parseBlocks(lines);
        const multi = blocks.find((b) => b.pid && b.end > b.start);
        let caseB: unknown = "두 줄 블록 없음";
        if (multi) {
          const pidB = lines[multi.start - 1]!;
          const rest = lines[multi.start + 1]!;
          edit = new vscode.WorkspaceEdit();
          edit.delete(doc.uri, new vscode.Range(multi.start - 1, 0, multi.start + 1, 0));
          await vscode.workspace.applyEdit(edit);
          await doc.save();
          await settle();
          const b = doc.getText().split(/\r?\n/);
          caseB = { pidLine: pidB, restoredBeforeRest: b[b.indexOf(rest) - 1] === pidB };
        }
        pidTest = { caseA, caseB, dirty: doc.isDirty };
      }
    }
    await writeFile(
      smoke,
      JSON.stringify(
        {
          epic: ctx?.epic ?? null, repo: ctx?.repo ?? null, member: ctx?.wf.cfg.member ?? null, phase: s?.phase ?? null, status: status.text,
          threads: s ? s.threads.size : 0, commentThreads: (view as any)?.threads?.size ?? 0, pidTest,
          mode: ctx?.mode ?? null, role: ctx?.role ?? null, blocked: ctx?.blocked ?? null, offline: ctx?.offline ?? null,
          configVersion: ctx?.wf.cfg.remote?.config.version ?? null, tracker: !!ctx?.wf.cfg.remote?.tracker,
          inbox: ctx?.mode === "server" && !ctx.blocked ? (await ctx.wf.inbox()).map((i) => `${i.epic}/${i.thread.id}`) : null,
          assigned: ctx?.wf.cfg.remote?.tracker && !ctx.epic ? (await ctx.wf.assignedEpics()).map((e) => e.epicId) : null,
        },
        null,
        2,
      ),
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

/**
 * Google 로그인 (§12): 브라우저로 서버의 /auth/login을 열고, 서버가 루프백 주소로 돌려주는 세션 토큰을 받는다.
 * M2에서는 OAuth 클라이언트가 없어 실제로 확인하지 못했다 (개발용 로그인으로 진행).
 */
function googleLogin(serverUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const token = u.searchParams.get("token");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(token ? "<p>Flightdeck 로그인 완료. 이 탭을 닫고 VS Code로 돌아가세요.</p>" : "<p>로그인 실패</p>");
      srv.close();
      if (token) resolve(token);
      else reject(new Error("로그인 응답에 토큰이 없습니다"));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      void vscode.env.openExternal(vscode.Uri.parse(`${serverUrl.replace(/\/$/, "")}/auth/login?port=${port}`));
    });
    setTimeout(() => {
      srv.close();
      reject(new Error("로그인 시간이 지났습니다 (5분)"));
    }, 5 * 60_000);
  });
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export function deactivate(): void {}

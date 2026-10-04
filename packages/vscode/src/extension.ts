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
import { coalesce, linesLabel, nowIso, parseBlocks, parseDrafts, PID_LINE, restoreParagraphIds, reviewOf, sha256, type ConfigPayload, type EpicState, type Thread } from "@flightdeck/core";
import { git, RemoteEventStore } from "@flightdeck/git";
import { appendEditRecords, readEditLog, readState } from "@flightdeck/hook";
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
  /** 쓰레드 초안 (§3.2 v0.13): Comments 쓰레드 → 파일·초안 키 */
  private draftThreads = new Map<vscode.CommentThread, { file: string; key: string }>();
  /** 지금 이 창에서 새 쓰레드를 만들 수 있는가: 담당자, 또는 현재 티어 리뷰어 (§3.4) */
  private canCreate = false;

  constructor(private ctx: Ctx) {
    this.controller.commentingRangeProvider = {
      // 질문 대상은 새 쓰레드를 만들 수 없다(답글만). 리뷰어는 자기 차례에 수정 요청·질문을 단다 (§3.4)
      provideCommentingRanges: (doc) => (this.canCreate && this.isArtifact(doc.uri) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
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
    for (const t of this.draftThreads.keys()) t.dispose();
    this.draftThreads.clear();
    const me = this.ctx.wf.cfg.member;
    const cur = state.review.requested ? reviewOf(state)?.current : null;
    this.canCreate = this.ctx.role === "owner" || !!cur?.reviewers.includes(me);
    for (const name of ARTIFACT_FILES) {
      const file = path.join(this.ctx.worktree, ".flightdeck", "epics", this.ctx.epic, name);
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8");
      const lines = text.split(/\r?\n/);
      const blocks = parseBlocks(lines);
      // 에이전트가 쓴 초안: 확인 후 올린다
      for (const d of parseDrafts(text)) {
        const head = d.reply ? `답글 → ${d.reply}` : `${KIND_LABEL[d.kind as keyof typeof KIND_LABEL] ?? d.kind}${d.to.length ? ` → ${d.to.map((m) => "@" + m).join(" ")}` : ""}`;
        const ct = this.controller.createCommentThread(vscode.Uri.file(file), new vscode.Range(d.start, 0, d.end, 0), [
          { author: { name: `초안 (@${me}의 에이전트)` }, body: new vscode.MarkdownString(`**${head}**\n\n${d.body}${d.error ? `\n\n⚠️ 올릴 수 없음: ${d.error}` : ""}`), mode: vscode.CommentMode.Preview },
        ]);
        ct.label = `초안 · ${head}`;
        ct.contextValue = d.error ? "fd-draft-bad" : "fd-draft";
        ct.canReply = false;
        ct.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.draftThreads.set(ct, { file: name, key: d.key });
      }
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

  draftOf(thread: vscode.CommentThread): { file: string; key: string } | undefined {
    return this.draftThreads.get(thread);
  }

  get draftCount(): number {
    return this.draftThreads.size;
  }

  draftList(): vscode.CommentThread[] {
    return [...this.draftThreads.keys()];
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
  let human: HumanEdits | null = null;
  /** 구현 단계 상태 표시 (Step·설명 필요 수). 저장하지 않은 편집이 있으면 계산하지 않고 직전 값을 쓴다 */
  let implLabel = "";
  /** 저장하고 사람 편집 기록을 비운다. 그래야 편집 기록 재적용 = 디스크 비교(외부 변경 감지)가 맞다 */
  const saveAll = async () => {
    await vscode.workspace.saveAll(false);
    await human?.flush();
  };
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
      if (ctx.role === "viewer") {
        // §6.2 v0.13: 읽기 전용 창에서는 쓰레드 초안 밖의 변경을 되돌린다
        vscode.window.showWarningMessage(`Flightdeck: 읽기 전용 창이라 ${r.file}의 내용 변경을 되돌렸습니다. 질문·코멘트는 쓰레드 초안(<!-- flightdeck:draft … -->)으로 쓰세요.`);
        continue;
      }
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
    // 티어 리뷰 중이면 현재 티어 (§9.2 상태 바: DESIGN(architect))
    const rv = s.review.requested ? reviewOf(s) : null;
    const tier = rv?.current ? `(${rv.current.name})` : "";
    const myTurn = !!rv?.current?.reviewers.includes(me) && !rv.current.approvedBy.includes(me) && s.owner !== me;
    const drafts = (await ctx.wf.drafts(ctx.epic).catch(() => [])).length;
    // 구현 단계 (§9.2): 지금 열린 Step과 설명이 필요한 변경 수
    if (s.phase === "IMPLEMENTATION" && ctx.role === "owner" && !unsavedIn(ctx.worktree!)) {
      const st = await ctx.wf.implementationStatus(ctx.epic).catch((e) => (out.appendLine(`[impl] ${e}`), null));
      if (st) implLabel = ` · Step ${st.step + 1}${st.coverage.unexplained.length ? ` · 설명 필요 ${st.coverage.unexplained.length}` : ""}`;
    } else if (s.phase !== "IMPLEMENTATION") implLabel = "";
    status.text = `$(rocket) Flightdeck · ${ctx.epic} · ${s.phase}${tier}${implLabel}${ro}${myTurn ? " · 내 리뷰 차례" : ""}${open ? ` · 열린 쓰레드 ${open}` : ""}${drafts ? ` · 초안 ${drafts}` : ""}${ctx.offline ? " · 서버 연결 안 됨" : ""}`;
    status.tooltip = ctx.role === "viewer" ? "읽기 전용 창: 받은 쓰레드에 답글, 리뷰 차례면 수정 요청·승인" : "Flightdeck: 단계 완료·리뷰 요청 / 초안 / 이어서 작업";
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
      void notify(`Flightdeck: ${last ? `@${last.author}의 답글` : `@${i.thread.author}의 ${KIND_LABEL[i.thread.kind]}`} (${i.epic}): ${(last?.body ?? i.thread.body).split("\n")[0]!.slice(0, 80)}`, "열기")
        .then((pick) => (pick ? openViewer(i.epic, i.commit) : undefined))
        .then(undefined, (e) => vscode.window.showErrorMessage(`Flightdeck: ${(e as Error).message}`));
    }
  };

  const sameWindow = ext.extensionMode === vscode.ExtensionMode.Development; // 개발 모드의 새 창에는 개발 중인 확장이 실리지 않는다
  const openViewer = async (epic: string, commit?: string) => {
    if (!ctx) throw new Error("git 레포 폴더를 연 창에서 실행하세요.");
    // 내가 담당한 에픽(리뷰어가 단 쓰레드)은 내 작업 폴더에서 연다
    const mine = await readState(await ctx.wf.eng.dataDir(), epic).catch(() => null);
    if (mine?.role === "owner") {
      if (ctx.worktree && samePath(ctx.worktree, mine.worktree)) return void (await refresh());
      return void (await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(mine.worktree), { forceNewWindow: !sameWindow }));
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${epic} 읽기 전용 창 준비` }, () => ctx.wf.openAsViewer(epic, commit));
    if (ctx.worktree && samePath(ctx.worktree, r.worktree)) return void (await refresh());
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.worktree), { forceNewWindow: !sameWindow });
  };

  // 리뷰 차례 알림 (§4.2): 리뷰 요청마다 한 번
  const notifyReviews = async (items: Awaited<ReturnType<EpicWorkflow["reviewInbox"]>>) => {
    const seen = new Set(ext.globalState.get<string[]>("flightdeck.notified") ?? []);
    const fresh = items.filter((i) => !seen.has(`review#${i.epic}#${i.commit}#${i.tier}`));
    if (!fresh.length) return;
    await ext.globalState.update("flightdeck.notified", [...seen, ...fresh.map((i) => `review#${i.epic}#${i.commit}#${i.tier}`)].slice(-500));
    for (const i of fresh) {
      void notify(`Flightdeck: 리뷰 차례입니다 (${i.epic} · ${i.phase} · ${i.tier} 티어)`, "열기")
        .then((pick) => (pick ? openViewer(i.epic, i.commit) : undefined))
        .then(undefined, (e) => vscode.window.showErrorMessage(`Flightdeck: ${(e as Error).message}`));
    }
  };

  // 원격 메타 브랜치 감시 (§3.7: 20초 ls-remote). 바뀌면 이 창을 다시 그리고 받은 질문·리뷰 차례를 알린다
  if (ctx && !ctx.blocked && ctx.wf.store instanceof RemoteEventStore) {
    const interval = Number(process.env.FLIGHTDECK_POLL_MS) || 20_000;
    const onChange = async () => {
      try {
        if (ctx.epic && ctx.role === "viewer") await ctx.wf.openAsViewer(ctx.epic); // 리뷰 요청된(없으면 최신 공유) 커밋으로
        await refresh();
        await notifyInbox(await ctx.wf.inbox());
        await notifyReviews(await ctx.wf.reviewInbox());
      } catch (e) {
        out.appendLine(`[watch] ${(e as Error).stack ?? e}`);
      }
    };
    const w = ctx.wf.store.watch(() => void onChange(), { intervalMs: interval, onError: (e) => out.appendLine(`[watch] ${e}`) });
    ext.subscriptions.push({ dispose: () => w.dispose() });
    setTimeout(() => {
      void ctx.wf.inbox().then(notifyInbox, (e) => out.appendLine(`[inbox] ${e}`));
      void ctx.wf.reviewInbox().then(notifyReviews, (e) => out.appendLine(`[review] ${e}`));
    }, 1000);
  }

  // 읽기 전용 창: 파일을 읽기 전용으로 연다 (§2.4). 이 창의 변경은 다음 공유 커밋으로 옮길 때 버려진다
  if (ctx?.epic && ctx.role === "viewer") {
    await vscode.workspace.getConfiguration("files").update("readonlyInclude", { "**": true }, vscode.ConfigurationTarget.Workspace).then(undefined, () => undefined);
  }

  if (ctx?.epic && ctx.worktree) {
    view = new ThreadView(ctx);
    ext.subscriptions.push(view);
    // 읽기 전용 창은 편집 기록을 남기지 않는다 (§2.4)
    if (ctx.role === "owner") {
      human = new HumanEdits(ctx, await ctx.wf.eng.dataDir(), ctx.wf.cfg.member, refresh);
      ext.subscriptions.push(human);
      ext.subscriptions.push(checkpointTimers(ctx as Ctx & { epic: string; worktree: string }, out, refresh));
    }
    // 에이전트가 산출물을 고치면(디스크 변경) 다시 그린다: 담당자 창은 문단 ID·쓰레드, 읽기 전용 창은 초안만 남기고 되돌림
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
      const impl = (await c.wf.epicState(c.epic)).phase === "IMPLEMENTATION";
      if (impl) {
        await saveAll();
        out.show(true);
        out.appendLine(`[구현 완료] ${c.epic}: 관문 검사 → 커밋·공유 → 명령 실행 → 보고`);
      }
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${c.epic} ${impl ? "구현 완료 (관문 검사·명령 실행)" : "단계 완료"}` }, () =>
        c.wf.completePhase(c.epic, { onOutput: (s) => out.append(s) }),
      );
      flushWarnings();
      if (!r.ok) {
        for (const p of r.problems) out.appendLine(`  • ${p}`);
        const more = "coverage" in r && r.coverage?.unexplained.length ? "설명 필요 변경 보기" : undefined;
        const pick = await vscode.window.showWarningMessage(`아직 ${impl ? "구현을 제출할" : "단계를 완료할"} 수 없습니다:\n${r.problems.map((p) => `• ${p}`).join("\n")}`, { modal: true }, ...(more ? [more] : []));
        if (pick === more) await vscode.commands.executeCommand("flightdeck.unexplained");
        await refresh();
        return;
      }
      await refresh();
      const pick = await vscode.window.showInformationMessage(`${c.epic}: ${r.phase} 단계로 넘어갔습니다${r.commit ? ` (커밋 ${r.commit.slice(0, 7)})` : ""}.`, r.phase === "DESIGN" ? "설계 초안 작성" : "확인");
      if (pick === "설계 초안 작성") await vscode.commands.executeCommand("flightdeck.draft");
    }),

    // 설명 필요 변경 (§7.3, §7.4): 메모가 필요한 수정 묶음에 메모를 쓰고, Step 기록이 필요한 에이전트 편집을 알려 준다
    run("flightdeck.unexplained", async () => {
      const c = needOwner();
      await saveAll();
      const st = await c.wf.implementationStatus(c.epic);
      if (st.drift.length) vscode.window.showWarningMessage(`Flightdeck 밖에서 바뀐 파일을 외부 변경으로 기록했습니다: ${st.drift.join(", ")}`);
      const groups = st.coverage.groups;
      if (!groups.length) {
        await refresh();
        return void vscode.window.showInformationMessage(`설명이 필요한 변경이 없습니다 (coverage ${(st.coverage.ratio * 100).toFixed(0)}%).`);
      }
      const KIND = { human: "직접 수정", external: "Flightdeck 밖 변경", restore: "복원", agent: "에이전트 편집 (Step 기록 필요)" } as const;
      const p = await vscode.window.showQuickPick(
        groups.map((g) => ({
          label: `${g.kind === "agent" ? "$(hubot)" : "$(edit)"} ${g.file}:${linesLabel(g.lines)}`,
          description: `${KIND[g.kind]} · ${g.who}`,
          detail: g.kind === "agent" ? "메모 대신 에이전트에게 flightdeck_log_step으로 Step을 기록하게 하세요" : "골라서 한 줄 메모를 씁니다",
          g,
        })),
        { title: `설명 필요 변경 ${st.coverage.unexplained.length}건 (coverage ${(st.coverage.ratio * 100).toFixed(0)}%)` },
      );
      if (!p) return;
      const line = Math.max(0, p.g.lines[0]![0] - 1);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(c.worktree, p.g.file)), { selection: new vscode.Range(line, 0, line, 0), preview: true }).then(undefined, () => undefined);
      if (p.g.kind === "agent") return;
      const memo = await vscode.window.showInputBox({ title: `메모: ${p.g.file}:${linesLabel(p.g.lines)} (${KIND[p.g.kind]})`, prompt: "왜 고쳤는지 한 줄 (관련 쓰레드나 design.md#p:xxxx를 적어도 됩니다)", validateInput: (v) => (v.trim() ? null : "한 줄 이상") });
      if (!memo) return;
      await c.wf.addMemo(c.epic, p.g, memo);
      await refresh();
      vscode.window.showInformationMessage("메모를 남겼습니다 (impl-log의 직접 수정 메모).");
    }),

    run("flightdeck.restoreCheckpoint", async () => {
      const c = needOwner();
      await saveAll();
      const p = await pickCheckpoint(c.wf, c.epic, "이 시점으로 복원");
      if (!p) return;
      const ok = await vscode.window.showWarningMessage(`작업 폴더의 코드를 ${p.sha.slice(0, 7)} 시점으로 되돌립니다. 지금 상태는 체크포인트로 남기므로 복원을 취소할 수 있습니다. 구현 기록(impl-log)은 그대로 둡니다.`, { modal: true }, "복원");
      if (ok !== "복원") return;
      const r = await c.wf.restore(c.epic, p.sha);
      await refresh();
      vscode.window.showInformationMessage(`복원했습니다 (${r.files.length}개 파일). 복원 직전: ${r.before.slice(0, 7)}`);
    }),

    run("flightdeck.compareCheckpoint", async () => {
      const c = needOwner();
      const a = await pickCheckpoint(c.wf, c.epic, "비교할 체크포인트 (이전)");
      if (!a) return;
      const b = await pickCheckpoint(c.wf, c.epic, "비교 대상 (이후)", true);
      if (!b) return;
      const diff = await gitOut(["diff", "--stat", "-p", a.sha, ...(b.sha === "WORKTREE" ? [] : [b.sha]), "--", ".", ":(exclude).flightdeck/.runtime"], c.worktree);
      const doc = await vscode.workspace.openTextDocument({ language: "diff", content: diff || "(차이 없음)" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    run("flightdeck.menu", async () => {
      const owner = !!ctx?.epic && ctx.role === "owner";
      const server = ctx?.mode === "server";
      const s = ctx?.epic ? await ctx.wf.epicState(ctx.epic) : null;
      const reviewPhase = !!s && !!reviewOf(s);
      const cur = s?.review.requested ? reviewOf(s)?.current : null;
      const myTurn = !!cur?.reviewers.includes(ctx!.wf.cfg.member) && !cur.approvedBy.includes(ctx!.wf.cfg.member);
      const drafts = view?.draftCount ?? 0;
      const items = [
        ...(owner && s?.phase === "IMPLEMENTATION"
          ? [
              { label: "$(check) 구현 완료 (관문 검사·테스트·제출)", cmd: "flightdeck.completePhase" },
              { label: "$(note) 설명 필요 변경 (메모 쓰기)", cmd: "flightdeck.unexplained" },
              { label: "$(terminal) 이어서 작업 (Claude Code)", cmd: "flightdeck.resume" },
              { label: "$(history) 체크포인트로 복원", cmd: "flightdeck.restoreCheckpoint" },
              { label: "$(diff) 체크포인트 비교", cmd: "flightdeck.compareCheckpoint" },
            ]
          : owner
            ? [
                reviewPhase ? { label: "$(git-pull-request) 리뷰 요청", cmd: "flightdeck.requestReview" } : { label: "$(check) 단계 완료", cmd: "flightdeck.completePhase" },
                { label: "$(sparkle) 에이전트 초안 작성", cmd: "flightdeck.draft" },
                { label: "$(terminal) 이어서 작업 (Claude Code)", cmd: "flightdeck.resume" },
              ]
            : []),
        ...(ctx?.epic && myTurn ? [{ label: `$(pass) 승인 (${cur!.name} 티어)`, cmd: "flightdeck.approve" }] : []),
        ...(drafts ? [{ label: `$(cloud-upload) 쓰레드 초안 모두 올리기 (${drafts})`, cmd: "flightdeck.postAllDrafts" }] : []),
        ...(ctx?.epic && ctx.role === "viewer" ? [{ label: "$(comment-discussion) 내 에이전트에게 묻기", cmd: "flightdeck.askAgent" }] : []),
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
      const [items, reviews] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Flightdeck: 받은 질문·리뷰 차례 확인" }, () => Promise.all([ctx.wf.inbox(), ctx.wf.reviewInbox()]));
      flushWarnings();
      if (!items.length && !reviews.length) return void vscode.window.showInformationMessage("답할 질문도, 리뷰 차례도 없습니다.");
      const p = await vscode.window.showQuickPick(
        [
          ...reviews.map((r) => ({ label: `$(eye) 리뷰 차례: ${r.epic}`, description: `${r.phase} · ${r.tier} 티어`, epic: r.epic, commit: r.commit as string | undefined })),
          ...items.map((i) => ({ label: i.thread.body.split("\n")[0]!.slice(0, 80), description: `${i.epic} · ${i.thread.id} · @${i.thread.author}`, detail: i.thread.replies.length ? `마지막 답글: @${i.thread.replies.at(-1)!.author}` : undefined, epic: i.epic, commit: i.commit })),
        ],
        { title: "받은 질문·리뷰 차례" },
      );
      if (p) await openViewer(p.epic, p.commit);
    }),

    run("flightdeck.requestReview", async () => {
      const c = needOwner();
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flightdeck: ${c.epic} 리뷰 요청 (공유 → 서버 서명)` }, () => c.wf.requestReview(c.epic));
      if (!r.ok) return void vscode.window.showWarningMessage(`아직 리뷰를 요청할 수 없습니다:\n${r.problems.map((p) => `• ${p}`).join("\n")}`, { modal: true });
      await refresh();
      const cur = reviewOf(r.state)?.current;
      vscode.window.showInformationMessage(cur ? `Flightdeck: 리뷰를 요청했습니다. 지금 차례: ${cur.name} 티어 (${cur.reviewers.map((m) => "@" + m).join(" ")})` : `Flightdeck: 리뷰어가 있는 티어가 없어 ${r.state.phase}로 넘어갔습니다.`);
    }),

    run("flightdeck.approve", async () => {
      const c = need();
      const s0 = await c.wf.epicState(c.epic);
      const cur = reviewOf(s0)?.current;
      const ok = await vscode.window.showInformationMessage(`${c.epic} ${s0.phase}를 ${cur?.name ?? ""} 티어로 승인할까요? 리뷰 요청된 문서에 대한 승인으로 서버가 서명합니다.`, { modal: true }, "승인");
      if (!ok) return;
      const s = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Flightdeck: 승인 (서버 서명)" }, () => c.wf.approve(c.epic));
      await refresh();
      vscode.window.showInformationMessage(s.phase !== s0.phase ? `Flightdeck: 모든 티어가 승인해 ${s.phase}로 넘어갔습니다.` : `Flightdeck: 승인했습니다. 다음 차례: ${reviewOf(s)?.current?.name ?? "-"} 티어`);
    }),

    // 쓰레드 초안 (§3.2 v0.13): 에이전트가 쓴 것을 확인해 올리거나 버린다
    run("flightdeck.postDraft", async (thread: vscode.CommentThread) => {
      const c = need();
      const d = view?.draftOf(thread);
      if (!d) return;
      const id = await c.wf.postDraft(c.epic, d.file, d.key);
      await refresh();
      vscode.window.showInformationMessage(`Flightdeck: 초안을 올렸습니다 (${id}).`);
    }),
    run("flightdeck.discardDraft", async (thread: vscode.CommentThread) => {
      const c = need();
      const d = view?.draftOf(thread);
      if (d) await c.wf.discardDraft(c.epic, d.file, d.key);
      await refresh();
    }),
    run("flightdeck.postAllDrafts", async () => {
      const c = need();
      const all = await c.wf.drafts(c.epic);
      const ok = all.filter((x) => !x.draft.error);
      const pick = await vscode.window.showInformationMessage(`쓰레드 초안 ${ok.length}개를 @${c.wf.cfg.member} 이름으로 올릴까요?${all.length > ok.length ? ` (형식 오류 ${all.length - ok.length}개는 건너뜀)` : ""}`, { modal: true }, "모두 올리기");
      if (!pick) return;
      const failed: string[] = [];
      for (const x of ok) await c.wf.postDraft(c.epic, x.file, x.draft.key).catch((e) => failed.push(`${x.draft.body.slice(0, 30)}…: ${(e as Error).message}`));
      await refresh();
      if (failed.length) vscode.window.showWarningMessage(`Flightdeck: ${failed.length}개를 올리지 못했습니다:\n${failed.join("\n")}`, { modal: true });
      else vscode.window.showInformationMessage(`Flightdeck: 초안 ${ok.length}개를 올렸습니다.`);
    }),

    // 내 에이전트에게 묻기 (§3.6): 이 창에서 Claude Code를 연다. 리뷰 정책 훅이 걸려 있어 기록되지 않고 초안만 쓴다
    run("flightdeck.askAgent", async (thread?: vscode.CommentThread) => {
      const c = need();
      const id = thread ? view?.idOf(thread) : null;
      const q = await vscode.window.showInputBox({ title: "내 에이전트에게 묻기", prompt: id ? `${id} 쓰레드에 대해` : "예: 설계 문서에 재사용 탐지 처리가 담겼는지 검사하고, 빠졌으면 리스크 문단에 수정 요청 초안을 달아 줘", ignoreFocusOut: true });
      if (q === undefined) return;
      const prompt = id ? `${id} 쓰레드(flightdeck_list_threads)에 대해: ${q}` : q;
      const env = Object.fromEntries(Object.keys(process.env).filter((k) => !(k in cleanEnv())).map((k) => [k, null]));
      const term = vscode.window.createTerminal({ name: `Flightdeck 묻기 ${c.epic}`, cwd: c.worktree, env: env as Record<string, null> });
      term.show();
      term.sendText(`${c.wf.cfg.adapter.id === "claude-code" ? "claude" : c.wf.cfg.adapter.id} ${JSON.stringify(prompt)}`);
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
        commentThread: (id) => view?.get(id), draftThreads: () => view?.draftList() ?? [], commentThreadCount: () => view?.size ?? 0, statusText: () => status.text,
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

/** 작업 폴더 안에 디스크와 내용이 다른(저장하지 않은) 문서가 있는가. 있으면 외부 변경 감지를 미룬다 */
function unsavedIn(worktree: string): boolean {
  return vscode.workspace.textDocuments.some((d) => {
    if (d.uri.scheme !== "file") return false;
    const rel = path.relative(worktree, d.uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    try {
      return readFileSync(d.uri.fsPath, "utf8") !== d.getText();
    } catch {
      return true; // 아직 디스크에 없는 새 파일
    }
  });
}

/**
 * 체크포인트 시점 (§8.1): 사람은 저장 후 10초(디바운스), 에이전트는 마지막 편집 후 idle_seconds(기본 30초) 유휴.
 * Step 끝(flightdeck_log_step)과 턴 종료(Stop 훅)의 체크포인트는 훅·MCP가 만든다
 */
function checkpointTimers(ctx: Ctx & { epic: string; worktree: string }, out: vscode.OutputChannel, refresh: () => Promise<void>): vscode.Disposable {
  const wf = ctx.wf;
  const make = async (why: string, source: "human" | "agent") => {
    if (unsavedIn(ctx.worktree)) return;
    try {
      const sha = await wf.checkpoint(ctx.epic, why, source);
      if (sha) out.appendLine(`[체크포인트] ${sha.slice(0, 10)} (${why})`);
      await refresh();
    } catch (e) {
      out.appendLine(`[체크포인트] ${(e as Error).message}`);
    }
  };
  let saveTimer: NodeJS.Timeout | null = null;
  const onSave = vscode.workspace.onDidSaveTextDocument((d) => {
    const rel = path.relative(ctx.worktree, d.uri.fsPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void make("저장", "human"), 10_000);
  });
  // 에이전트 유휴: 편집 기록 끝이 에이전트 편집이고 idle_seconds 동안 늘지 않으면
  let lastSeq = -1;
  let changedAt = 0;
  let idleMs = 30_000;
  void wf.epicState(ctx.epic).then((s) => wf.pipelineFor(s.config_version)).then((p) => (idleMs = (p?.checkpoint.idle_seconds ?? 30) * 1000), () => undefined);
  const poll = setInterval(() => {
    void (async () => {
      const log = await readEditLog(await wf.eng.dataDir(), ctx.epic);
      const last = log.at(-1);
      const seq = last?.seq ?? 0;
      if (lastSeq === -1) lastSeq = seq;
      if (seq !== lastSeq) {
        lastSeq = seq;
        changedAt = Date.now();
        return;
      }
      if (changedAt && Date.now() - changedAt >= idleMs && (last?.source.kind === "agent" || last?.source.kind === "agent_shell")) {
        changedAt = 0;
        await make("에이전트 유휴", "agent");
      }
    })().catch((e) => out.appendLine(`[체크포인트] ${e}`));
  }, 5_000);
  return {
    dispose: () => {
      onSave.dispose();
      clearInterval(poll);
      if (saveTimer) clearTimeout(saveTimer);
    },
  };
}

/** 체크포인트 고르기 (최신부터). withWorktree: 맨 위에 "지금 작업 폴더" */
async function pickCheckpoint(wf: EpicWorkflow, epic: string, title: string, withWorktree = false): Promise<{ sha: string } | undefined> {
  const list = await wf.checkpoints(epic);
  if (!list.length && !withWorktree) {
    vscode.window.showInformationMessage("아직 체크포인트가 없습니다.");
    return undefined;
  }
  const items = [
    ...(withWorktree ? [{ label: "$(file-code) 지금 작업 폴더", description: "", detail: undefined, sha: "WORKTREE" }] : []),
    ...list.map((c) => ({
      label: `$(git-commit) ${c.message.split("\n")[0]}`,
      description: `${c.sha.slice(0, 7)}${c.trailers["Flightdeck-Step"] ? ` · Step ${c.trailers["Flightdeck-Step"]}` : ""} · ${c.trailers["Flightdeck-Source"] ?? ""}`,
      detail: c.trailers["Flightdeck-Run"] ? `실행 ${c.trailers["Flightdeck-Run"]}` : undefined,
      sha: c.sha,
    })),
  ];
  return vscode.window.showQuickPick(items, { title });
}

export function deactivate(): void {}

// 메타 브랜치 이벤트 저장소 (설계 §1.3, §2.3, §3.1).
// 이벤트 파일 1개 = 이벤트 1개, append-only. 경로: epics/<epic>/events/<ULID>-<member>.json
// 작업 폴더 없이 git 저수준 명령으로 커밋한다: blob 작성 → 임시 index에 추가 → write-tree → commit-tree → update-ref(CAS).
// CAS가 실패하면(다른 프로세스가 먼저 추가) 새 끝 위에 다시 만든다. 원격과 맞추는 것은 RemoteEventStore.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Event, eventFileName } from "@flightdeck/schema";
import { git, GitError, isMissingRemoteRef } from "./exec.ts";

export const META_BRANCH = "flightdeck-meta";
const META_REF = `refs/heads/${META_BRANCH}`;
const ZERO = "0000000000000000000000000000000000000000";

export interface EventStore {
  append(event: Event): Promise<void>;
  list(epic: string): Promise<Event[]>;
}

export interface ListResult {
  events: Event[];
  /** 스키마에 맞지 않아 버린 파일 (reducer 입력에서 빠진다) */
  invalid: { path: string; error: string }[];
}

export class LocalEventStore implements EventStore {
  constructor(
    readonly repo: string,
    readonly opts: { maxRetries?: number; author?: { name: string; email: string } } = {},
  ) {}

  protected g(args: string[], extra: { env?: Record<string, string>; input?: string } = {}) {
    return git(args, { cwd: this.repo, ...extra });
  }

  async head(): Promise<string | null> {
    try {
      return (await this.g(["rev-parse", "-q", "--verify", META_REF])).trim() || null;
    } catch {
      return null;
    }
  }

  async append(event: Event): Promise<void> {
    const parsed = Event.parse(event); // 형식이 틀린 이벤트는 쓰지 않는다
    const file = `epics/${parsed.epic}/events/${eventFileName(parsed)}`;
    const blob = (await this.g(["hash-object", "-w", "--stdin"], { input: JSON.stringify(parsed, null, 2) + "\n" })).trim();
    const env: Record<string, string> = this.opts.author
      ? { GIT_AUTHOR_NAME: this.opts.author.name, GIT_AUTHOR_EMAIL: this.opts.author.email, GIT_COMMITTER_NAME: this.opts.author.name, GIT_COMMITTER_EMAIL: this.opts.author.email }
      : {};
    const max = this.opts.maxRetries ?? 20;
    for (let attempt = 1; ; attempt++) {
      const old = await this.head();
      const dir = await mkdtemp(path.join(tmpdir(), "fd-meta-"));
      const idxEnv = { GIT_INDEX_FILE: path.join(dir, "index") };
      try {
        if (old) await this.g(["read-tree", old], { env: idxEnv });
        await this.g(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env: idxEnv });
        const tree = (await this.g(["write-tree"], { env: idxEnv })).trim();
        const commit = (await this.g(["commit-tree", tree, ...(old ? ["-p", old] : [])], { env, input: `event ${parsed.type} ${parsed.id}\n` })).trim();
        await this.g(["update-ref", "-m", "flightdeck event", META_REF, commit, old ?? ZERO]);
        return;
      } catch (e) {
        if (!(e instanceof GitError) || attempt >= max) throw e;
        await new Promise((r) => setTimeout(r, Math.random() * Math.min(200, 10 * 2 ** attempt)));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  async list(epic: string): Promise<Event[]> {
    return (await this.listDetailed(epic)).events;
  }

  /** 메타 브랜치에 이벤트가 있는 에픽 ID 목록 */
  async listEpics(): Promise<string[]> {
    const head = await this.head();
    if (!head) return [];
    const out = await this.g(["ls-tree", "-d", "-z", "--name-only", head, "epics/"]).catch(() => "");
    return out
      .split("\0")
      .filter(Boolean)
      .map((p) => p.slice("epics/".length))
      .sort();
  }

  async listDetailed(epic: string): Promise<ListResult> {
    const head = await this.head();
    if (!head) return { events: [], invalid: [] };
    const prefix = `epics/${epic}/events/`;
    const entries = (await this.g(["ls-tree", "-r", "-z", head, "--", prefix]))
      .split("\0")
      .filter(Boolean)
      .map((l) => {
        const [meta, p] = l.split("\t") as [string, string];
        return { sha: meta.split(" ")[2]!, path: p };
      });
    if (!entries.length) return { events: [], invalid: [] };
    const batch = await this.g(["cat-file", "--batch"], { input: entries.map((e) => e.sha).join("\n") + "\n" });
    const bodies = splitBatch(batch);
    const events: Event[] = [];
    const invalid: ListResult["invalid"] = [];
    entries.forEach((e, i) => {
      try {
        const ev = Event.parse(JSON.parse(bodies[i]!));
        if (eventFileName(ev) !== path.posix.basename(e.path)) throw new Error("파일 이름과 내용이 다름");
        events.push(ev as Event);
      } catch (err) {
        invalid.push({ path: e.path, error: String(err instanceof Error ? err.message : err) });
      }
    });
    events.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { events, invalid };
  }
}

/** 원격 메타 브랜치가 이전에 본 끝을 포함하지 않는다 (force push 등 이력 재작성, 설계 §2.1) */
export class MetaRewriteError extends Error {
  constructor(
    readonly seen: string,
    readonly remote: string | null,
  ) {
    super(`원격 메타 브랜치 이력이 바뀌었다: 이전에 본 ${seen.slice(0, 8)}이(가) 원격 ${remote?.slice(0, 8) ?? "(없음)"}에 없다. 받아들이지 않는다`);
  }
}

export interface SyncResult {
  /** 이번에 원격에서 새로 받은 커밋이 있었다 */
  received: boolean;
  /** 이번에 원격으로 보낸 이벤트 커밋 수 */
  pushed: number;
  /** 아직 보내지 못한 이벤트 커밋 수 (다음 sync에서 다시 보낸다) */
  pending: number;
}

export interface Disposable {
  dispose(): void;
}

/**
 * 원격 메타 브랜치와 맞추는 EventStore (설계 §1.3, §2.1, §3.1, §3.7).
 * - append: 로컬 커밋(LocalEventStore) 후 sync. sync가 실패해도 이벤트는 로컬에 남아 다음 sync에서 묶어 보낸다.
 * - sync: fetch → 이력 재작성 검사 → (원격이 앞섬) fast-forward / (로컬이 앞섬) push / (갈라짐) 로컬에만 있는 이벤트 파일을 원격 끝 위에 다시 쌓고 push.
 *   push가 거절되면 지수 백오프 + 지터로 처음부터 다시 한다. 이벤트 커밋은 파일 하나 추가뿐이라 다시 쌓을 때 충돌이 없다.
 * - watch: 주기적으로 ls-remote → 원격 끝이 바뀌었으면 sync → onChange.
 */
export class RemoteEventStore extends LocalEventStore {
  constructor(
    repo: string,
    readonly remote = "origin",
    opts: { maxRetries?: number; author?: { name: string; email: string }; pushRetries?: number; backoffMs?: number } = {},
  ) {
    super(repo, opts);
    this.pushRetries = opts.pushRetries ?? 8;
    this.backoffMs = opts.backoffMs ?? 50;
  }
  private readonly pushRetries: number;
  private readonly backoffMs: number;
  /** fetch한 원격 끝 */
  get trackingRef() {
    return `refs/flightdeck/remote/${this.remote}/meta`;
  }
  /** 마지막으로 받아들인 원격 끝. 이력 재작성 검사 기준 */
  get seenRef() {
    return `refs/flightdeck/seen/${this.remote}/meta`;
  }
  private syncing: Promise<SyncResult> | null = null;

  override async append(event: Event): Promise<void> {
    await super.append(event);
    await this.sync().catch(() => undefined); // 실패분은 로컬에 남는다. 다음 sync·watch가 보낸다
  }

  private rev(ref: string) {
    return this.g(["rev-parse", "-q", "--verify", ref]).then((s) => s.trim() || null, () => null);
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await this.g(["merge-base", "--is-ancestor", a, b]);
      return true;
    } catch {
      return false;
    }
  }

  /** 원격 끝을 받아 trackingRef에 둔다. 원격에 브랜치가 없으면 null */
  async fetch(): Promise<string | null> {
    // 원격 왕복(SSH 연결)을 한 번으로: ls-remote 없이 바로 fetch하고, 브랜치가 없다는 오류만 "없음"으로 본다
    try {
      await this.g(["fetch", "-q", "--no-tags", this.remote, `+${META_REF}:${this.trackingRef}`]);
    } catch (e) {
      if (!(e instanceof GitError && isMissingRemoteRef(e))) throw e;
      await this.g(["update-ref", "-d", this.trackingRef]).catch(() => undefined);
      return null;
    }
    return this.rev(this.trackingRef);
  }

  /** 동시에 여러 번 불려도 한 번에 하나만 돈다 */
  sync(): Promise<SyncResult> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(): Promise<SyncResult> {
    let received = false;
    let pushed = 0;
    // 빠른 길: 마지막으로 본 원격 끝 위에 로컬 이벤트만 쌓여 있으면 fetch 없이 바로 push (원격 왕복 1회).
    // 원격이 그 사이 바뀌었거나 이력이 재작성됐으면 push가 거절되고, 아래 일반 경로가 fetch해서 처리·감지한다.
    const [tracked, seen0, local0] = await Promise.all([this.rev(this.trackingRef), this.rev(this.seenRef), this.head()]);
    if (tracked && seen0 === tracked && local0 && local0 !== tracked && (await this.isAncestor(tracked, local0))) {
      const count = Number((await this.g(["rev-list", "--count", local0, `^${tracked}`])).trim());
      try {
        // lease: 원격이 마지막으로 본 끝 그대로일 때만. 원격이 과거로 되돌려졌으면 fast-forward로 덮지 않고 거절되어 아래에서 감지된다
        await this.g(["push", "-q", "--no-verify", `--force-with-lease=${META_REF}:${tracked}`, this.remote, `${local0}:${META_REF}`]);
        await this.g(["update-ref", this.trackingRef, local0]);
        await this.g(["update-ref", this.seenRef, local0]);
        return { received, pushed: count, pending: 0 };
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
      }
    }
    for (let attempt = 1; ; attempt++) {
      const remote = await this.fetch();
      const seen = await this.rev(this.seenRef);
      if (seen && !(remote && (await this.isAncestor(seen, remote)))) throw new MetaRewriteError(seen, remote);
      const local = await this.head();

      if (remote && (!local || (await this.isAncestor(local, remote)))) {
        // 원격이 앞서거나 같다: 로컬을 원격으로 (CAS)
        if (local !== remote) {
          await this.g(["update-ref", META_REF,remote, local ?? ZERO]);
          received = true;
        }
        await this.g(["update-ref", this.seenRef, remote]);
        return { received, pushed, pending: 0 };
      }
      if (!local) return { received, pushed, pending: 0 }; // 양쪽 다 없음

      let tip = local;
      if (remote && !(await this.isAncestor(remote, local))) {
        // 갈라짐: 로컬에만 있는 이벤트 커밋을 원격 끝 위에 다시 쌓는다
        tip = await this.replay(remote, local);
        await this.g(["update-ref", META_REF,tip, local]); // 그 사이 로컬 append가 있었으면 실패 → 재시도
        received = true;
      }
      const count = Number((await this.g(["rev-list", "--count", tip, ...(remote ? [`^${remote}`] : [])])).trim());
      try {
        await this.g(["push", "-q", "--no-verify", this.remote, `${tip}:${META_REF}`]);
        await this.g(["update-ref", this.trackingRef, tip]);
        await this.g(["update-ref", this.seenRef, tip]);
        pushed += count;
        return { received, pushed, pending: 0 };
      } catch (e) {
        if (attempt >= this.pushRetries) return { received, pushed, pending: count };
        if (!(e instanceof GitError)) throw e;
        await new Promise((r) => setTimeout(r, Math.random() * Math.min(2000, this.backoffMs * 2 ** attempt)));
      }
    }
  }

  /** base 위에 (base..local)의 이벤트 커밋들이 추가한 파일을 순서대로 다시 쌓는다. 이미 base에 있는 파일은 건너뛴다 */
  private async replay(base: string, local: string): Promise<string> {
    const commits = (await this.g(["rev-list", "--reverse", "--topo-order", local, `^${base}`])).split("\n").filter(Boolean);
    const dir = await mkdtemp(path.join(tmpdir(), "fd-meta-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    try {
      await this.g(["read-tree", base], { env });
      let tip = base;
      for (const c of commits) {
        const added = (await this.g(["diff-tree", "-r", "--no-commit-id", "--diff-filter=A", "--root", c]))
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [meta, file] = l.split("\t") as [string, string];
            return { blob: meta.split(" ")[3]!, file };
          });
        if (!added.length) continue;
        const have = new Set((await this.g(["ls-files", "--", ...added.map((a) => a.file)], { env })).split("\n").filter(Boolean));
        const fresh = added.filter((a) => !have.has(a.file));
        if (!fresh.length) continue; // 이미 원격에 있음 (push 응답을 못 받은 경우 등)
        for (const a of fresh) await this.g(["update-index", "--add", "--cacheinfo", `100644,${a.blob},${a.file}`], { env });
        const tree = (await this.g(["write-tree"], { env })).trim();
        const [name, email, date, msg] = (await this.g(["show", "-s", "--format=%an%x00%ae%x00%ad%x00%B", "--date=raw", c])).split("\0") as [string, string, string, string];
        const authorEnv = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
        tip = (await this.g(["commit-tree", tree, "-p", tip], { env: authorEnv, input: msg })).trim();
      }
      return tip;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 원격 끝을 주기적으로 확인한다 (§3.7: 20초). 바뀌었거나 보낼 이벤트가 남았으면 sync 후 onChange */
  watch(onChange: (r: SyncResult) => void, opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): Disposable {
    let stopped = false;
    let lastPending = 0;
    const tick = async () => {
      try {
        const out = (await this.g(["ls-remote", this.remote, META_REF])).trim();
        const remote = out ? out.split(/\s+/)[0]! : null;
        const tracked = await this.rev(this.trackingRef);
        const local = await this.head();
        if (remote === tracked && local === tracked && !lastPending) return;
        const r = await this.sync();
        lastPending = r.pending;
        if (r.received || r.pushed) onChange(r);
      } catch (e) {
        opts.onError?.(e);
      }
    };
    const timer = setInterval(() => void (stopped || tick()), opts.intervalMs ?? 20_000);
    return { dispose: () => ((stopped = true), clearInterval(timer)) };
  }
}

/** `git cat-file --batch` 출력에서 내용만 순서대로 꺼낸다 */
function splitBatch(out: string): string[] {
  const buf = Buffer.from(out, "utf8");
  const bodies: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    bodies.push(buf.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    pos = nl + 1 + size + 1;
  }
  return bodies;
}

// 메타 브랜치 이벤트 저장소 (설계 §1.3, §2.3, §3.1).
// 이벤트 파일 1개 = 서명된 이벤트 1개, append-only. 경로: epics/<epic>/events/<ULID>-<member>.json
// 작업 폴더 없이 git 저수준 명령으로 커밋한다: blob 작성 → 임시 index에 추가 → write-tree → commit-tree → update-ref(CAS).
// CAS가 실패하면(다른 프로세스가 먼저 추가) 새 끝 위에 다시 만든다. M2에서 push·fetch를 붙인다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Event, eventFileName } from "@flightdeck/schema";
import { git, GitError } from "./exec.ts";

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

  private g(args: string[], extra: { env?: Record<string, string>; input?: string } = {}) {
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

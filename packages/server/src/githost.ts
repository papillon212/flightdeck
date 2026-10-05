// 내장 git 서버 (설계 D21, §1.5, M5.5).
// - git smart HTTP: `git http-backend`를 CGI로 실행해 /git/<product>.git 을 제공한다. 인증은 git 전용 토큰(Z3).
// - pre-receive: 레포의 훅은 서버에 판정을 요청하는 작은 스크립트이고, 판정은 서버 안에서 한다(Z4).
//   push한 사람은 서버가 CGI 환경에 넣은 push ID로 안다. 서버 자신의 push(작업 사본 → 내장 레포)는 서버 push ID를 쓴다(Z2).
// - 외부 미러(Z5), 백업(Z6).
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { reduce, writerOf } from "@flightdeck/core";
import { EMPTY_TREE, git, GitError, LocalEventStore, META_BRANCH } from "@flightdeck/git";
import { Event, eventFileName, SERVER_SIGNED_TYPES, type Trust } from "@flightdeck/schema";

export const BUILTIN_REPO = "builtin";
const ZERO = "0000000000000000000000000000000000000000";
const PRODUCT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const TOKEN_TTL_MS = 7 * 24 * 3600_000;
/** 서버 자신을 뜻하는 push한 사람 */
export const SERVER_PUSHER = "@server";

export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

export interface GitHostDeps {
  dataDir: string;
  /** git 전용 토큰 HMAC 키를 만들 비밀 (서버 개인키) */
  secret: string;
  trust: () => Promise<Trust>;
  /** 활성 멤버인가 */
  isActive: (member: string) => Promise<boolean>;
  /** 제품의 반영 대상 브랜치 (pipeline landing.target) */
  target: (product: string) => Promise<string>;
}

export class GitHost {
  readonly root: string;
  private readonly key: Buffer;
  private readonly serverPushId = randomBytes(24).toString("hex");
  private readonly pushes = new Map<string, string>();
  private hookUrl: string | null = null;

  constructor(private deps: GitHostDeps) {
    this.root = path.join(deps.dataDir, "hosted");
    this.key = createHash("sha256").update("flightdeck-git-token\0").update(deps.secret).digest();
  }

  /**
   * 서버가 HTTP를 열었을 때 부른다. 훅이 판정을 요청할 주소를 정하고,
   * 이 프로세스가 실행하는 git(작업 사본 → 내장 레포 push)이 서버 push ID를 갖게 한다
   */
  attach(baseUrl: string): void {
    this.hookUrl = `${baseUrl.replace(/\/$/, "")}/internal/git/pre-receive`;
    process.env.FD_HOOK_URL = this.hookUrl;
    process.env.FD_PUSH_ID = this.serverPushId;
  }

  repoDir(product: string): string {
    if (!PRODUCT_RE.test(product)) throw new Error(`제품 이름 형식: ${product}`);
    return path.join(this.root, `${product}.git`);
  }

  async products(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    return (await readdir(this.root)).filter((n) => n.endsWith(".git")).map((n) => n.slice(0, -4));
  }

  /** 내장 레포 상태 (어드민 화면) */
  async repoInfo(product: string): Promise<{ exists: false } | { exists: true; refs: number; target: string | null }> {
    const dir = this.repoDir(product);
    if (!existsSync(dir)) return { exists: false };
    const refs = (await git(["for-each-ref", "--format=%(refname)"], { cwd: dir })).split("\n").filter(Boolean).length;
    const target = (await git(["rev-parse", "-q", "--verify", `refs/heads/${await this.deps.target(product)}`], { cwd: dir }).catch(() => "")).trim() || null;
    return { exists: true, refs, target };
  }

  /** 내장 레포를 만든다(없으면). importUrl이 있으면 그 레포의 모든 ref를 가져오고, 없으면 빈 첫 커밋으로 target을 만든다. 훅은 매번 다시 설치한다 */
  async ensureRepo(product: string, opts: { importUrl?: string; target?: string } = {}): Promise<string> {
    const dir = this.repoDir(product);
    const target = opts.target ?? (await this.deps.target(product));
    if (!existsSync(dir)) {
      await mkdir(this.root, { recursive: true });
      if (opts.importUrl) {
        if (opts.importUrl.startsWith("-")) throw new Error(`레포 주소 형식: ${opts.importUrl}`);
        // ext:: 같은 명령 실행 전송은 막는다
        await git(["-c", "protocol.ext.allow=never", "clone", "-q", "--mirror", "--", opts.importUrl, dir], { cwd: this.root, env: { GIT_TERMINAL_PROMPT: "0" } });
        await git(["remote", "remove", "origin"], { cwd: dir });
      } else {
        await git(["init", "-q", "--bare", "-b", target, dir], { cwd: this.root });
        const env = { GIT_AUTHOR_NAME: "flightdeck-server", GIT_AUTHOR_EMAIL: "flightdeck-server@localhost", GIT_COMMITTER_NAME: "flightdeck-server", GIT_COMMITTER_EMAIL: "flightdeck-server@localhost" };
        const c = (await git(["commit-tree", EMPTY_TREE], { cwd: dir, env, input: `${product} 시작\n` })).trim();
        await git(["update-ref", `refs/heads/${target}`, c, ZERO], { cwd: dir });
      }
      await git(["symbolic-ref", "HEAD", `refs/heads/${target}`], { cwd: dir });
    }
    // fetch by SHA (GitHub와 같게), 받기만 하는 쪽 설정
    for (const [k, v] of [["uploadpack.allowAnySHA1InWant", "true"], ["http.receivepack", "true"], ["receive.fsckObjects", "true"]] as const) await git(["config", k, v], { cwd: dir });
    await this.installHook(dir);
    return dir;
  }

  private async installHook(dir: string): Promise<void> {
    const hooks = path.join(dir, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, "fd-pre-receive.cjs"), HOOK_JS);
    const sh = `#!/bin/sh\n# flightdeck pre-receive (설계 §1.5): 판정은 flightdeck-server가 한다\nexec ${shq(process.execPath)} hooks/fd-pre-receive.cjs\n`;
    await writeFile(path.join(hooks, "pre-receive"), sh);
    await chmod(path.join(hooks, "pre-receive"), 0o755);
  }

  // ---- git 전용 토큰 (Z3) ----

  issueToken(member: string, ttlMs = TOKEN_TTL_MS): { token: string; expires_at: string } {
    const exp = Date.now() + ttlMs;
    const body = `fdg1.${Buffer.from(member).toString("base64url")}.${exp}`;
    return { token: `${body}.${this.mac(body)}`, expires_at: new Date(exp).toISOString() };
  }

  /** 서명·만료가 맞으면 멤버 ID. 활성 여부는 따로 본다 */
  verifyToken(token: string): string | null {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "fdg1") return null;
    const body = parts.slice(0, 3).join(".");
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(parts[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (!(Number(parts[2]) > Date.now())) return null;
    return Buffer.from(parts[1]!, "base64url").toString("utf8");
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  // ---- smart HTTP (CGI) ----

  /** /git/<product>.git/<rest> 요청. 인증을 거친 멤버만 */
  async serve(req: IncomingMessage, res: ServerResponse, product: string, rest: string, member: string): Promise<void> {
    const dir = this.repoDir(product);
    if (!existsSync(dir)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(`없는 레포: ${product}\n`);
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pushId = randomBytes(24).toString("hex");
    this.pushes.set(pushId, member);
    const h = req.headers;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: this.root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${product}.git${rest}`,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      REMOTE_USER: member,
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      FD_PUSH_ID: pushId,
      FD_HOOK_URL: this.hookUrl ?? "",
    };
    if (h["content-type"]) env.CONTENT_TYPE = String(h["content-type"]);
    if (h["content-length"]) env.CONTENT_LENGTH = String(h["content-length"]);
    if (h["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(h["content-encoding"]);
    if (h["git-protocol"]) env.GIT_PROTOCOL = String(h["git-protocol"]);
    await new Promise<void>((resolve) => {
      const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let head = Buffer.alloc(0);
      let sent = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (sent) return void res.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]) || 200;
          else headers[k] = v;
        }
        res.writeHead(status, headers);
        sent = true;
        res.write(head.subarray(end + 4));
      });
      let err = "";
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("close", (code) => {
        this.pushes.delete(pushId);
        if (!sent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.write(`git http-backend 실패 (${code}): ${err}`);
        }
        res.end();
        resolve();
      });
      child.on("error", () => undefined);
      req.pipe(child.stdin);
      child.stdin.on("error", () => undefined);
    });
  }

  // ---- pre-receive 판정 (Z4) ----

  /** 훅이 보낸 판정 요청. 모르는 push ID는 거부 */
  async preReceive(body: { push_id?: string; repo?: string; quarantine?: string | null; updates?: string }): Promise<{ ok: boolean; messages: string[] }> {
    const pusher = body.push_id === this.serverPushId ? SERVER_PUSHER : body.push_id ? this.pushes.get(body.push_id) : undefined;
    if (!pusher) return { ok: false, messages: ["flightdeck: 서버를 거치지 않은 push는 받지 않는다"] };
    const dir = path.resolve(body.repo ?? "");
    // 훅의 작업 폴더는 실제 경로다(macOS /tmp → /private/tmp)
    if (!existsSync(dir) || realpathSync(path.dirname(dir)) !== realpathSync(this.root) || !dir.endsWith(".git")) return { ok: false, messages: ["flightdeck: 내장 레포가 아니다"] };
    const product = path.basename(dir, ".git");
    const updates = (body.updates ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [o, n, ref] = l.split(" ") as [string, string, string];
        return { old: o, new: n, ref };
      });
    const env: Record<string, string> = body.quarantine ? { GIT_OBJECT_DIRECTORY: body.quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(dir, "objects") } : {};
    try {
      const problems = await judgePush({ dir, env, pusher, updates, target: await this.deps.target(product), trust: await this.deps.trust(), isActive: this.deps.isActive });
      return problems.length ? { ok: false, messages: problems.map((p) => `flightdeck: ${p}`) } : { ok: true, messages: [] };
    } catch (e) {
      return { ok: false, messages: [`flightdeck: 판정 실패 (${e instanceof Error ? e.message : e})`] };
    }
  }

  // ---- 외부 미러 (Z5) ----

  /** 내장 레포의 target(과 태그)을 미러에 올린다. 미러 쪽이 갈라졌으면 덮지 않고 이유를 돌려준다 */
  async syncMirror(product: string, mirror: { url: string; refs: string[] }): Promise<{ pushed: string[]; problems: string[] }> {
    const dir = this.repoDir(product);
    const pushed: string[] = [];
    const problems: string[] = [];
    const remote = new Map(
      (await git(["ls-remote", mirror.url], { cwd: dir }))
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, ref] = l.split("\t") as [string, string];
          return [ref, sha] as const;
        }),
    );
    const specs: string[] = [];
    for (const r of mirror.refs) {
      const pattern = r.startsWith("refs/") ? r : r.startsWith("tags/") ? `refs/${r}` : `refs/heads/${r}`;
      const local = (await git(["for-each-ref", "--format=%(objectname) %(refname)", pattern], { cwd: dir })).split("\n").filter(Boolean);
      for (const l of local) {
        const [sha, ref] = l.split(" ") as [string, string];
        const theirs = remote.get(ref);
        if (theirs === sha) continue;
        if (theirs && !ref.startsWith("refs/tags/") && !(await isAncestor(dir, theirs, sha))) {
          problems.push(`미러의 ${ref}(${theirs.slice(0, 10)})가 내장 레포와 갈라졌다. 덮지 않는다`);
          continue;
        }
        if (theirs && ref.startsWith("refs/tags/")) {
          problems.push(`미러의 태그 ${ref}가 다르다. 덮지 않는다`);
          continue;
        }
        specs.push(`${sha}:${ref}`);
        pushed.push(ref);
      }
    }
    if (specs.length) await git(["push", "-q", mirror.url, ...specs], { cwd: dir });
    return { pushed, problems };
  }

  // ---- 백업 (Z6) ----

  /** 내장 레포마다 bundle을 만들고 검증한다 */
  async backup(outDir: string): Promise<string[]> {
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out: string[] = [];
    for (const product of await this.products()) {
      const file = path.join(path.resolve(outDir), `${product}-${stamp}.bundle`);
      await git(["bundle", "create", "-q", file, "--all"], { cwd: this.repoDir(product) });
      await git(["bundle", "verify", "-q", file], { cwd: this.repoDir(product) });
      out.push(file);
    }
    return out;
  }
}

/**
 * push 판정 (§1.5 pre-receive 규칙, M5.5 Z4). 문제 목록이 비면 허용.
 * env: 격리된(quarantine) 새 객체를 읽기 위한 환경
 */
export async function judgePush(p: {
  dir: string;
  env: Record<string, string>;
  pusher: string;
  updates: RefUpdate[];
  target: string;
  trust: Trust;
  isActive: (m: string) => Promise<boolean>;
}): Promise<string[]> {
  const server = p.pusher === SERVER_PUSHER;
  if (!server && !(await p.isActive(p.pusher))) return [`비활성 멤버: ${p.pusher}`];
  const g = (args: string[], input?: string) => git(args, { cwd: p.dir, env: p.env, ...(input !== undefined ? { input } : {}) });
  // 에픽 브랜치·세션 원본에 쓰는 사람 = 현재 조종수 (처음은 담당자, M8 L2·L3)
  const writers = new Map<string, string | null>();
  const ownerOf = async (epic: string) => {
    if (!writers.has(epic)) {
      const events = await new LocalEventStore(p.dir).list(epic);
      writers.set(epic, writerOf(reduce(epic, events, p.trust)));
    }
    return writers.get(epic)!;
  };
  const ff = async (u: RefUpdate) => u.old === ZERO || (u.new !== ZERO && (await isAncestor(p.dir, u.old, u.new, p.env)));
  const problems: string[] = [];
  for (const u of p.updates) {
    const del = u.new === ZERO;
    const who = server ? "서버" : `@${p.pusher}`;
    let m: RegExpExecArray | null;
    if (u.ref === `refs/heads/${p.target}` || u.ref.startsWith("refs/tags/")) {
      if (!server) problems.push(`${u.ref}: 반영 서버만 쓸 수 있다 (main 직접 push 금지, §11.4)`);
    } else if (u.ref === `refs/heads/${META_BRANCH}`) {
      if (del) problems.push(`${u.ref}: 메타 브랜치는 지울 수 없다`);
      else if (u.old === ZERO && !server) problems.push(`${u.ref}: 메타 브랜치는 서버가 만든다`);
      else if (!(await ff(u))) problems.push(`${u.ref}: 메타 브랜치는 fast-forward만 (이력 재작성 금지, §2.1)`);
      else problems.push(...(await metaProblems(g, u, server ? null : p.pusher)));
    } else if ((m = /^refs\/heads\/flightdeck\/([^/]+)$/.exec(u.ref))) {
      if (server) continue;
      const owner = await ownerOf(m[1]!);
      if (owner !== p.pusher) problems.push(`${u.ref}: 에픽 조종수(@${owner ?? "없음"})만 쓸 수 있다 (${who})`);
      else if (del) problems.push(`${u.ref}: 에픽 브랜치는 반영 서버만 지운다`);
      else if (!(await ff(u))) problems.push(`${u.ref}: 에픽 브랜치는 fast-forward만`);
    } else if ((m = /^refs\/flightdeck\/ckpt\/([^/]+)\/([^/]+)$/.exec(u.ref))) {
      if (!server && m[2] !== p.pusher) problems.push(`${u.ref}: 그 멤버(@${m[2]})의 체크포인트만 쓸 수 있다 (${who})`);
    } else if ((m = /^refs\/flightdeck\/runs\/([^/]+)$/.exec(u.ref))) {
      if (server) continue;
      const owner = await ownerOf(m[1]!);
      if (owner !== p.pusher) problems.push(`${u.ref}: 에픽 조종수(@${owner ?? "없음"})만 세션 원본을 올린다 (${who})`);
      else if (del || !(await ff(u))) problems.push(`${u.ref}: 세션 원본은 fast-forward만`);
    } else {
      problems.push(`${u.ref}: Flightdeck이 쓰지 않는 ref`);
    }
  }
  return problems;
}

/** 메타 브랜치 새 커밋: 병합 없음, 이벤트 파일 추가만, (멤버면) 자기 이름의 일반 이벤트만 */
async function metaProblems(g: (args: string[], input?: string) => Promise<string>, u: RefUpdate, member: string | null): Promise<string[]> {
  const range = u.old === ZERO ? [u.new] : [u.new, `^${u.old}`];
  const commits = (await g(["rev-list", "--parents", ...range])).split("\n").filter(Boolean);
  const out: string[] = [];
  for (const line of commits) {
    const [c, ...parents] = line.split(" ");
    if (parents.length > 1) {
      out.push(`메타 커밋 ${c!.slice(0, 10)}: 병합 커밋은 받지 않는다`);
      continue;
    }
    const entries = (await g(["diff-tree", "-r", "-z", "--no-commit-id", "--root", "--no-renames", c!])).split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i += 2) {
      const [meta, file] = [entries[i]!, entries[i + 1]!];
      const [, , , blob, status] = meta.split(" ") as [string, string, string, string, string];
      const fm = /^epics\/([^/]+)\/events\/([^/]+)$/.exec(file);
      if (status !== "A") {
        out.push(`메타 커밋 ${c!.slice(0, 10)}: ${file} ${status === "D" ? "삭제" : "수정"} — 이벤트는 추가만 할 수 있다 (append-only)`);
        continue;
      }
      if (!fm) {
        out.push(`메타 커밋 ${c!.slice(0, 10)}: ${file} — 이벤트 경로가 아니다`);
        continue;
      }
      let ev: Event;
      try {
        ev = Event.parse(JSON.parse(await g(["cat-file", "blob", blob]))) as Event;
      } catch (e) {
        out.push(`${file}: 이벤트 형식이 아니다 (${e instanceof Error ? e.message.split("\n")[0] : e})`);
        continue;
      }
      if (eventFileName(ev) !== fm[2] || ev.epic !== fm[1]) out.push(`${file}: 파일 이름·에픽이 이벤트 내용과 다르다`);
      if (member === null) continue;
      if (ev.author !== member) out.push(`${file}: 남의 이름(@${ev.author})으로 된 이벤트 (push: @${member})`);
      if (SERVER_SIGNED_TYPES.has(ev.type)) out.push(`${file}: ${ev.type}는 서버만 기록한다`);
    }
  }
  return out;
}

async function isAncestor(cwd: string, a: string, b: string, env: Record<string, string> = {}): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", a, b], { cwd, env });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 레포 훅: 표준 입력(ref 갱신 목록)을 서버에 보내 판정을 받는다. 서버를 거치지 않은 push(환경 없음)는 거부 */
const HOOK_JS = `// flightdeck pre-receive (설계 §1.5, M5.5 Z4). flightdeck-server가 설치한다. 고치지 마세요
"use strict";
(async () => {
  const url = process.env.FD_HOOK_URL, id = process.env.FD_PUSH_ID;
  if (!url || !id) { console.error("flightdeck: 서버를 거치지 않은 push는 받지 않는다"); process.exit(1); }
  let updates = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) updates += c;
  let r;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ push_id: id, repo: process.cwd(), quarantine: process.env.GIT_QUARANTINE_PATH || null, updates }) });
    r = await res.json();
  } catch (e) {
    r = { ok: false, messages: ["flightdeck: 판정 요청 실패 (" + (e && e.message) + ")"] };
  }
  for (const m of r.messages || []) console.error(m);
  process.exit(r.ok ? 0 : 1);
})();
`;

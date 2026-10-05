// GitEngine (설계 §1.2, §2, §8.1). 사용자는 git을 보지 않는다. 확장만 이 모듈로 git을 다룬다.
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, GitError, isMissingRemoteRef, RAW_ARGS, RAW_ENV } from "./exec.ts";

const ZERO = "0000000000000000000000000000000000000000";

/** worktree에서 git 추적을 빼는 경로 (설계 §6.1 설정 배치, §2.2 .runtime) */
export const EXCLUDE_ENTRIES = [".claude/settings.local.json", ".mcp.json", ".flightdeck/.runtime/"];

export interface CheckpointInfo {
  sha: string;
  parent: string;
  message: string;
  trailers: Record<string, string>;
}

/** 체크포인트에 넣지 않는 비밀 파일 기본 패턴 (설계 §5 checkpoint.exclude_secrets) */
export const DEFAULT_EXCLUDE_SECRETS = [".env", ".env.*", "*.pem", "*.key"];

export class GitEngine {
  /** 체크포인트·복원이 항상 같은 패턴을 쓰도록 엔진에 한 번만 정한다 */
  readonly excludeSecrets: string[];

  /**
   * @param repo 제품 레포의 main worktree 경로
   * @param opts.excludeSecrets pipeline.yaml checkpoint.exclude_secrets
   */
  constructor(
    readonly repo: string,
    opts: { excludeSecrets?: string[] } = {},
  ) {
    this.excludeSecrets = opts.excludeSecrets ?? DEFAULT_EXCLUDE_SECRETS;
  }

  private g(args: string[], cwd = this.repo, extra: { env?: Record<string, string>; input?: string } = {}) {
    return git(args, { cwd, ...extra });
  }

  async commonDir(): Promise<string> {
    return path.resolve(this.repo, (await this.g(["rev-parse", "--git-common-dir"])).trim());
  }

  /** Flightdeck 로컬 데이터(편집 기록·상태). 모든 worktree가 공유한다 */
  async dataDir(): Promise<string> {
    const d = path.join(await this.commonDir(), "flightdeck");
    await mkdir(d, { recursive: true });
    return d;
  }

  /** ../<repo>.flightdeck/<name> (설계 §2.4) */
  worktreePath(name: string): string {
    return path.join(path.dirname(this.repo), `${path.basename(this.repo)}.flightdeck`, name);
  }

  static epicBranch(epic: string): string {
    return `flightdeck/${epic}`;
  }

  async revParse(rev: string, cwd = this.repo): Promise<string> {
    return (await this.g(["rev-parse", "--verify", rev], cwd)).trim();
  }

  async tryRevParse(rev: string, cwd = this.repo): Promise<string | null> {
    try {
      return (await this.g(["rev-parse", "-q", "--verify", rev], cwd)).trim() || null;
    } catch {
      return null;
    }
  }

  /** 에픽 브랜치와 작업 폴더를 만든다. 이미 있으면 그대로 돌려준다 */
  async createEpicWorktree(epic: string, base = "HEAD"): Promise<{ path: string; branch: string; baseSha: string }> {
    const wt = this.worktreePath(epic);
    const branch = GitEngine.epicBranch(epic);
    const baseSha = await this.revParse(base);
    await this.ensureExcludes();
    if (existsSync(wt)) return { path: wt, branch, baseSha: (await this.g(["merge-base", branch, baseSha])).trim() };
    await mkdir(path.dirname(wt), { recursive: true });
    const exists = await this.tryRevParse(`refs/heads/${branch}`);
    if (exists) await this.g(["worktree", "add", "-q", wt, branch]);
    else await this.g(["worktree", "add", "-q", "-b", branch, wt, baseSha]);
    return { path: wt, branch, baseSha };
  }

  static remoteEpicRef(epic: string, remote = "origin"): string {
    return `refs/remotes/${remote}/${GitEngine.epicBranch(epic)}`;
  }

  /** 에픽 브랜치를 원격에 올린다 (문서 공유 커밋, 설계 §3.1 thread.created.commit). fast-forward만 */
  async pushEpicBranch(epic: string, remote = "origin"): Promise<string> {
    const branch = GitEngine.epicBranch(epic);
    const sha = await this.revParse(`refs/heads/${branch}`);
    await this.g(["push", "-q", "--no-verify", remote, `${sha}:refs/heads/${branch}`]);
    await this.g(["update-ref", GitEngine.remoteEpicRef(epic, remote), sha]);
    return sha;
  }

  /** 원격 에픽 브랜치를 받는다. 없으면 null */
  async fetchEpicBranch(epic: string, remote = "origin"): Promise<string | null> {
    const branch = GitEngine.epicBranch(epic);
    try {
      await this.g(["fetch", "-q", "--no-tags", remote, `+refs/heads/${branch}:${GitEngine.remoteEpicRef(epic, remote)}`]);
    } catch (e) {
      if (e instanceof GitError && isMissingRemoteRef(e)) return null;
      throw e;
    }
    return this.revParse(GitEngine.remoteEpicRef(epic, remote));
  }

  /**
   * 질문 대상의 읽기 전용 창 (설계 §2.4): 에픽 브랜치의 지정 커밋(없으면 원격 끝)을 분리(detached) 상태로 연다.
   * 이 창의 파일은 렌더링만 바뀌므로, 다시 열 때는 그 변경을 버리고 새 커밋으로 옮긴다.
   */
  async openViewWorktree(epic: string, commit?: string, remote = "origin"): Promise<{ path: string; commit: string }> {
    const target = commit ?? (await this.fetchEpicBranch(epic, remote));
    if (!target) throw new Error(`원격에 에픽 브랜치가 없다: ${GitEngine.epicBranch(epic)}`);
    if (!(await this.tryRevParse(`${target}^{commit}`))) await this.fetchEpicBranch(epic, remote);
    const wt = this.worktreePath(epic);
    await this.ensureExcludes();
    if (existsSync(wt)) {
      await this.g(["checkout", "-q", "-f", "--detach", target], wt);
    } else {
      await mkdir(path.dirname(wt), { recursive: true });
      await this.g(["worktree", "add", "-q", "--detach", wt, target]);
    }
    return { path: wt, commit: target };
  }

  /**
   * 관찰자의 읽기 전용 창 `<epic>@live` (설계 §2.4, §8.3, M8 L8): 조종수의 체크포인트 커밋을 분리 상태로 연다.
   * 이미 있으면 그 커밋으로 옮기고 그 사이 실시간으로 적용한 변경은 버린다
   */
  async openLiveWorktree(epic: string, commit: string): Promise<string> {
    const wt = this.worktreePath(`${epic}@live`);
    await this.ensureExcludes();
    if (existsSync(wt)) {
      await this.g(["checkout", "-q", "-f", "--detach", commit], wt);
      await this.g(["clean", "-fdq", "-e", ".flightdeck/.runtime"], wt);
    } else {
      await mkdir(path.dirname(wt), { recursive: true });
      await this.g(["worktree", "add", "-q", "--detach", wt, commit]);
    }
    return wt;
  }

  /** 원격의 그 멤버 체크포인트를 받는다. 없으면 null (M8: 관찰·조종 인계의 시작점) */
  async fetchCheckpoint(epic: string, member: string, remote = "origin"): Promise<string | null> {
    const ref = GitEngine.checkpointRef(epic, member);
    try {
      await this.g(["fetch", "-q", "--no-tags", remote, `+${ref}:${ref}`]);
    } catch (e) {
      if (e instanceof GitError && isMissingRemoteRef(e)) return null;
      throw e;
    }
    return this.tryRevParse(ref);
  }

  /**
   * 조종을 넘겨받은 사람의 작업 폴더 (M8 L4): 에픽 브랜치 끝(head)을 꺼내고, 작업 트리를 이전 조종수의 체크포인트 트리로 바꾼다.
   * 체크포인트에 있는 공유 안 된 작업이 그대로 이어진다. 이미 그 폴더가 있으면(읽기 전용 창이었으면) 브랜치로 바꿔 쓴다
   */
  async adoptEpicWorktree(epic: string, head: string, ckpt: string): Promise<string> {
    const wt = this.worktreePath(epic);
    const branch = GitEngine.epicBranch(epic);
    await this.ensureExcludes();
    if (existsSync(wt)) {
      await this.g(["checkout", "-q", "-f", "-B", branch, head], wt);
      await this.g(["clean", "-fdq", "-e", ".flightdeck/.runtime"], wt);
    } else {
      await mkdir(path.dirname(wt), { recursive: true });
      await this.g(["worktree", "add", "-q", "-B", branch, wt, head]);
    }
    const headTree = (await this.g(["rev-parse", `${head}^{tree}`], wt)).trim();
    const dir = await mkdtemp(path.join(tmpdir(), "fd-idx-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index"), ...RAW_ENV };
    try {
      await this.g([...RAW_ARGS, "read-tree", headTree], wt, { env });
      await this.g([...RAW_ARGS, "update-index", "-q", "--refresh"], wt, { env }).catch(() => "");
      await this.g([...RAW_ARGS, "read-tree", "-m", "-u", headTree, `${ckpt}^{tree}`], wt, { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return wt;
  }

  async removeWorktree(name: string, force = false): Promise<void> {
    await this.g(["worktree", "remove", ...(force ? ["--force"] : []), this.worktreePath(name)]);
  }

  /** 모든 worktree가 공유하는 info/exclude에 Flightdeck 설정 파일을 추가한다 */
  async ensureExcludes(): Promise<void> {
    const file = path.join(await this.commonDir(), "info", "exclude");
    await mkdir(path.dirname(file), { recursive: true });
    const cur = existsSync(file) ? await readFile(file, "utf8") : "";
    const have = new Set(cur.split(/\r?\n/));
    const missing = EXCLUDE_ENTRIES.filter((e) => !have.has(e));
    if (!missing.length) return;
    await writeFile(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "# flightdeck\n" + missing.join("\n") + "\n");
  }

  /** 에픽 브랜치에 지정한 파일만 커밋한다 (단계 전환·제출 시, §1.2). 바뀐 것이 없으면 null */
  async commit(wt: string, paths: string[], message: string, trailers: Record<string, string> = {}): Promise<string | null> {
    await this.g(["add", "--", ...paths], wt);
    const staged = (await this.g(["diff", "--cached", "--name-only", "--", ...paths], wt)).trim();
    if (!staged) return null;
    const msg = withTrailers(message, trailers);
    await this.g(["commit", "-q", "-F", "-", "--", ...paths], wt, { input: msg });
    return this.revParse("HEAD", wt);
  }

  /** 작업 트리 전체를 에픽 브랜치에 커밋한다 (구현 제출). 비밀 파일 패턴은 넣지 않는다. 바뀐 것이 없으면 null */
  async commitAll(wt: string, message: string, trailers: Record<string, string> = {}): Promise<string | null> {
    await this.g(["add", "-A", "."], wt);
    const staged = (await this.g(["diff", "--cached", "--name-only", "-z"], wt)).split("\0").filter(Boolean);
    const secret = staged.filter((f) => isSecret(f, this.excludeSecrets));
    if (secret.length) await this.g(["reset", "-q", "--", ...secret], wt);
    if (staged.length === secret.length) return null;
    await this.g(["commit", "-q", "-F", "-"], wt, { input: withTrailers(message, trailers) });
    return this.revParse("HEAD", wt);
  }

  /** 체크포인트 ref를 원격에 올린다 (§8.1) */
  async pushCheckpoint(epic: string, member: string, remote = "origin"): Promise<void> {
    const ref = GitEngine.checkpointRef(epic, member);
    if (await this.tryRevParse(ref)) await this.g(["push", "-q", "--no-verify", remote, `${ref}:${ref}`]);
  }

  static checkpointRef(epic: string, member: string): string {
    return `refs/flightdeck/ckpt/${epic}/${member}`;
  }

  /**
   * 체크포인트 (설계 §8.1): 브랜치·index·작업 트리를 건드리지 않는 숨은 커밋.
   * - 사용자 index를 복사한 임시 index에 작업 트리 전체를 디스크 바이트 그대로 담는다.
   * - 비밀 파일 패턴(this.excludeSecrets)의 파일은 넣지 않는다.
   * - update-ref는 이전 값을 지정한다(CAS). 다른 쪽이 먼저 바꿨으면 GitError.
   */
  async checkpoint(wt: string, opts: { epic: string; member: string; message: string; trailers?: Record<string, string> }): Promise<string> {
    const ref = GitEngine.checkpointRef(opts.epic, opts.member);
    const tree = await this.snapshotTree(wt);
    const old = await this.tryRevParse(ref, wt);
    const parent = old ?? (await this.revParse("HEAD", wt));
    const msg = withTrailers(opts.message, opts.trailers ?? {});
    const sha = (await this.g(["commit-tree", tree, "-p", parent], wt, { input: msg })).trim();
    await this.g(["update-ref", "-m", "flightdeck checkpoint", ref, sha, old ?? ZERO], wt);
    return sha;
  }

  /** 마지막 체크포인트(없으면 HEAD)와 작업 트리가 같으면 만들지 않고 null을 돌려준다 */
  async checkpointIfChanged(wt: string, opts: { epic: string; member: string; message: string; trailers?: Record<string, string> }): Promise<string | null> {
    const ref = GitEngine.checkpointRef(opts.epic, opts.member);
    const last = (await this.tryRevParse(ref, wt)) ?? (await this.revParse("HEAD", wt));
    const lastTree = (await this.g(["rev-parse", `${last}^{tree}`], wt)).trim();
    if ((await this.snapshotTree(wt)) === lastTree) return null;
    return this.checkpoint(wt, opts);
  }

  /** 작업 트리 전체를 tree 객체로 (디스크 바이트 그대로, 비밀 파일 제외) */
  async snapshotTree(wt: string): Promise<string> {
    const excludeSecrets = this.excludeSecrets;
    const dir = await mkdtemp(path.join(tmpdir(), "fd-idx-"));
    const idx = path.join(dir, "index");
    try {
      const userIndex = path.resolve(wt, (await this.g(["rev-parse", "--git-path", "index"], wt)).trim());
      if (existsSync(userIndex)) {
        await copyFile(userIndex, idx);
        // index 파일의 수정 시각을 원본과 같게 둔다. 복사로 시각이 새로 찍히면 git의 racy 검사가 꺼져서,
        // 같은 1초 안에 같은 크기로 바뀐 파일을 "안 바뀜"으로 보고 예전 내용을 담는다 (설계 제안 T6)
        const st = await stat(userIndex);
        await utimes(idx, st.atime, st.mtime);
      }
      const env = { GIT_INDEX_FILE: idx, ...RAW_ENV };
      await this.g([...RAW_ARGS, "add", "-A", "."], wt, { env });
      if (excludeSecrets.length) {
        const files = (await this.g(["ls-files", "-z", "--cached"], wt, { env })).split("\0").filter(Boolean);
        const secret = files.filter((f) => isSecret(f, excludeSecrets));
        if (secret.length) await this.g(["rm", "-q", "--cached", "--", ...secret], wt, { env });
      }
      return (await this.g(["write-tree"], wt, { env })).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * 이 시점으로 복원 (설계 §8.1). 복원 직전 상태를 먼저 체크포인트로 남긴다.
   * 임시 index로 두 트리 병합(read-tree -m -u)을 해서 작업 트리만 바꾼다. 사용자 index·HEAD는 그대로다.
   * 비밀 파일은 현재 트리·대상 트리 모두에서 빠져 있으므로 병합 대상이 아니다. 그래서 복원해도 지워지지 않는다.
   */
  async restoreCheckpoint(wt: string, target: string, opts: { epic: string; member: string }): Promise<{ before: string }> {
    const before = await this.checkpoint(wt, { ...opts, message: `복원 직전 (→ ${target.slice(0, 7)})`, trailers: { "Flightdeck-Source": "restore" } });
    const curTree = (await this.g(["rev-parse", `${before}^{tree}`], wt)).trim();
    const dir = await mkdtemp(path.join(tmpdir(), "fd-idx-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index"), ...RAW_ENV };
    try {
      await this.g([...RAW_ARGS, "read-tree", curTree], wt, { env });
      await this.g([...RAW_ARGS, "update-index", "-q", "--refresh"], wt, { env }).catch(() => "");
      await this.g([...RAW_ARGS, "read-tree", "-m", "-u", curTree, target], wt, { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { before };
  }

  /** 체크포인트 체인 (최신부터) */
  async listCheckpoints(epic: string, member: string, limit = 100): Promise<CheckpointInfo[]> {
    const ref = GitEngine.checkpointRef(epic, member);
    if (!(await this.tryRevParse(ref))) return [];
    const out = await this.g(["log", `-${limit}`, "--format=%H%x00%P%x00%B%x01", ref, "--not", "--branches", "--tags"]);
    return out
      .split("\x01")
      .map((s) => s.replace(/^\n/, ""))
      .filter(Boolean)
      .map((rec) => {
        const [sha, parent, message] = rec.split("\0") as [string, string, string];
        return { sha, parent: parent.split(" ")[0] ?? "", message: message.trim(), trailers: parseTrailers(message) };
      });
  }
}

function withTrailers(message: string, trailers: Record<string, string>): string {
  const t = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
  return t.length ? `${message.trim()}\n\n${t.join("\n")}\n` : `${message.trim()}\n`;
}

function parseTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of message.matchAll(/^([A-Za-z][A-Za-z0-9-]*): (.+)$/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** 비밀 파일 패턴 비교. 슬래시가 없는 패턴은 파일 이름에만 맞춘다 (.gitignore와 같은 감각) */
export function isSecret(file: string, patterns: string[]): boolean {
  const base = path.posix.basename(file);
  return patterns.some((p) => (p.includes("/") ? path.matchesGlob(file, p) : path.matchesGlob(base, p)));
}

/** coverage 대상 파일인가: Flightdeck 기록(.flightdeck/)·coverage_ignore·비밀 파일은 뺀다 (§7.3, M4 X3). 확장·훅·반영 서버가 같이 쓴다 */
export function isCoverageTarget(file: string, excludeSecrets: string[], coverageIgnore: string[]): boolean {
  if (file.startsWith(".flightdeck/")) return false;
  if (isSecret(file, excludeSecrets)) return false;
  return !coverageIgnore.some((g) => path.matchesGlob(file, g) || path.matchesGlob(path.posix.basename(file), g));
}

/** 커밋 메시지의 편집 기록 위치 trailer (M7 제안 E3). 없으면 null */
export function seqTrailer(message: string): number | null {
  const m = /^Flightdeck-Seq: (\d+)$/m.exec(message);
  return m ? Number(m[1]) : null;
}

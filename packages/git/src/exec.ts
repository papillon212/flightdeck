import { execFile, spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
    /** 실패해도 표준 출력을 쓰는 명령이 있다 (merge-tree의 충돌 목록) */
    readonly stdout = "",
  ) {
    super(`git ${args.join(" ")} 실패 (${code}): ${stderr.trim()}`);
  }
}

/** fetch 대상 ref가 원격에 없다는 오류인가 */
export function isMissingRemoteRef(e: GitError): boolean {
  return /couldn't find remote ref/i.test(e.stderr);
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}

/** git 명령 실행. 표준 출력을 돌려주고, 실패하면 GitError를 던진다 */
export function git(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 1 << 28, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(args, typeof err.code === "number" ? err.code : null, stderr, stdout));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** 바이너리 출력용 git 실행 (압축한 세션 원본 blob 등) */
export function gitBuffer(args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 1 << 28, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, typeof err.code === "number" ? err.code : null, stderr.toString("utf8")));
      else resolve(stdout);
    });
  });
}

/**
 * ref를 원격에 올리는 git push를 분리된 백그라운드 프로세스로 띄운다 (M4 제안 X7).
 * 훅 안에서 push를 기다리면 에이전트가 원격 왕복(GitHub 약 4초)만큼 멈춘다. 실패하면 다음 push가 다시 올린다
 */
export function pushDetached(cwd: string, remote: string, refs: string[]): void {
  if (!refs.length) return;
  const child = spawn("git", ["push", "-q", "--no-verify", remote, ...refs.map((r) => `${r}:${r}`)], { cwd, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * 디스크 바이트를 그대로 담는 git 호출용 설정 (설계 §8.1 v0.10).
 * 줄바꿈 변환(core.autocrlf)과 레포 .gitattributes(filter 포함)를 끈다.
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const RAW_ARGS = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
export const RAW_ENV = { GIT_ATTR_SOURCE: EMPTY_TREE };

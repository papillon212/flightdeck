import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
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
        if (err) reject(new GitError(args, typeof err.code === "number" ? err.code : null, stderr));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/**
 * 디스크 바이트를 그대로 담는 git 호출용 설정 (설계 §8.1 v0.10).
 * 줄바꿈 변환(core.autocrlf)과 레포 .gitattributes(filter 포함)를 끈다.
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const RAW_ARGS = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
export const RAW_ENV = { GIT_ATTR_SOURCE: EMPTY_TREE };

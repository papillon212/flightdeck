// 내장 git 서버 접근 (설계 §1.2 원격 인증, §1.5, M5.5 Z3·Z7). VS Code API를 쓰지 않는다.
// - git 전용 토큰을 <git 공용 폴더>/flightdeck/git-credentials(0600)에 두고, 레포 설정의 credential helper가 그 파일을 읽는다.
//   훅의 백그라운드 push(에이전트 실행 중)도 같은 helper로 인증된다.
// - 다른 helper(osxkeychain 등)가 토큰을 저장·재사용하지 않게 서버 주소의 helper 목록을 비우고 이것만 둔다.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "@flightdeck/git";

export const BUILTIN_REPO = "builtin";
export const CREDENTIALS_FILE = "git-credentials";
/** 이보다 적게 남으면 토큰을 새로 받는다 */
const RENEW_BEFORE_MS = 24 * 3600_000;

export function hostedUrl(serverUrl: string, product: string): string {
  return `${serverUrl.replace(/\/$/, "")}/git/${product}.git`;
}

/** 서버 주소의 scheme://host[:port] (credential.<url>.helper 키) */
function credentialKey(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `credential.${u.protocol}//${u.host}.helper`;
}

/** git 토큰(fdg1.<멤버>.<만료 ms>.<mac>)의 만료 시각 */
export function tokenExpiry(token: string): number {
  return Number(token.split(".")[2]) || 0;
}

/** 저장된 토큰 (없으면 null) */
export async function storedToken(dataDir: string): Promise<{ member: string; token: string } | null> {
  const f = path.join(dataDir, CREDENTIALS_FILE);
  if (!existsSync(f)) return null;
  const text = await readFile(f, "utf8");
  const member = /^username=(.*)$/m.exec(text)?.[1];
  const token = /^password=(.*)$/m.exec(text)?.[1];
  return member && token ? { member, token } : null;
}

export function needsRenew(t: { member: string; token: string } | null, member: string, now = Date.now()): boolean {
  return !t || t.member !== member || tokenExpiry(t.token) - now < RENEW_BEFORE_MS;
}

/**
 * 레포가 내장 git 서버에 인증하도록 설정한다.
 * repo: 레포 최상위(또는 아무 작업 폴더), dataDir: <git 공용 폴더>/flightdeck
 */
export async function configureGitAccess(o: { repo: string; dataDir: string; serverUrl: string; member: string; token: string }): Promise<void> {
  await mkdir(o.dataDir, { recursive: true });
  const f = path.join(o.dataDir, CREDENTIALS_FILE);
  await writeFile(f, `username=${o.member}\npassword=${o.token}\n`, { mode: 0o600 });
  await chmod(f, 0o600);
  const key = credentialKey(o.serverUrl);
  await git(["config", "--local", "--unset-all", key], { cwd: o.repo }).catch(() => undefined);
  await git(["config", "--local", "--add", key, ""], { cwd: o.repo }); // 앞선 helper(osxkeychain 등)를 지운다
  const helper = `!f() { test "$1" = get && cat "$(git rev-parse --path-format=absolute --git-common-dir)/flightdeck/${CREDENTIALS_FILE}"; }; f`;
  await git(["config", "--local", "--add", key, helper], { cwd: o.repo });
}

/** 원격 주소가 서버 레포가 아니면 지금 주소(없으면 "")를 돌려준다 */
export async function remoteMismatch(repo: string, remote: string, want: string): Promise<string | null> {
  const cur = (await git(["remote", "get-url", remote], { cwd: repo }).catch(() => "")).trim();
  return cur === want ? null : cur;
}

export async function useHostedRemote(repo: string, remote: string, want: string): Promise<void> {
  const cur = await git(["remote", "get-url", remote], { cwd: repo }).catch(() => null);
  await git(["remote", cur === null ? "add" : "set-url", remote, want], { cwd: repo });
}

/** 서버 레포 받기 (Z7): clone 후 인증 설정까지. 이미 있으면 거부 */
export async function cloneFromServer(o: { serverUrl: string; product: string; member: string; token: string; dest: string }): Promise<string> {
  if (existsSync(o.dest)) throw new Error(`이미 있는 폴더: ${o.dest}`);
  await mkdir(path.dirname(o.dest), { recursive: true });
  const key = credentialKey(o.serverUrl);
  // 토큰은 명령줄이 아니라 환경변수로 helper에 넘긴다
  await git(["-c", `${key}=`, "-c", `${key}=!f() { test "$1" = get && echo username=$FD_GIT_USER && echo password=$FD_GIT_TOKEN; }; f`, "clone", "-q", hostedUrl(o.serverUrl, o.product), o.dest], {
    cwd: path.dirname(o.dest),
    env: { FD_GIT_USER: o.member, FD_GIT_TOKEN: o.token, GIT_TERMINAL_PROMPT: "0" },
  });
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: o.dest })).trim();
  await configureGitAccess({ repo: o.dest, dataDir: path.join(common, "flightdeck"), serverUrl: o.serverUrl, member: o.member, token: o.token });
  return o.dest;
}

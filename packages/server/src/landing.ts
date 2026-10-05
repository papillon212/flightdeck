// 반영 (설계 §11.3, M5 제안 Y5·Y6·Y7·Y9). 서버가 클라이언트 계산을 믿지 않고 다시 확인한 뒤 main에 squash로 반영한다.
// 1. 메타 브랜치·에픽 브랜치를 받아 reducer로 상태 계산(서명 검증 포함). LANDING·반영 대기(pending)여야 한다
// 2. 에픽 브랜치 끝 = 검증한 커밋, 그 커밋의 통과 보고, impl-log 형식
// 3. main이 그 커밋의 조상이 아니면(main이 움직임): main을 에픽 브랜치에 병합한 커밋을 올리고 needs_report(재보고 대기).
//    충돌이면 conflict → IMPLEMENTATION (§11.3 7)
// 4. 에픽 기록을 정리한 squash 커밋을 main 위에 만들어 push (경합으로 거절되면 처음부터 다시, 최대 3회)
// 5. epic.landed(서버 서명), 에픽 브랜치 삭제
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkImplLog, keepRecord, nowIso, ulid, type EpicState } from "@flightdeck/core";
import { git, GitEngine, GitError, type RemoteEventStore } from "@flightdeck/git";
import { Event as EventSchema, type EditMemo, type EditRecord, type Event, type Trust } from "@flightdeck/schema";
import { serverCoverage } from "./editlog.ts";
import type { ConfigVersion } from "./store.ts";

export interface LandDeps {
  load(product: string): Promise<{ dir: string; target: string; store: RemoteEventStore; trust: Trust; state(epic: string): Promise<EpicState & { events: Event[] }> }>;
  sign(e: Event): Event;
  config(product: string, version: string): Promise<ConfigVersion | null>;
  /** 서버 편집 기록과 메모 (M7) */
  editlog(product: string, epic: string): Promise<{ records: EditRecord[]; memos: EditMemo[] }>;
}

export interface LandResult {
  status: "landed" | "rejected" | "skipped" | "error";
  main_commit?: string;
  reason?: string;
  message?: string;
}

const SERVER = "flightdeck-server";
const IDENTITY_ENV = { GIT_AUTHOR_NAME: SERVER, GIT_AUTHOR_EMAIL: `${SERVER}@localhost`, GIT_COMMITTER_NAME: SERVER, GIT_COMMITTER_EMAIL: `${SERVER}@localhost` };

export async function landEpic(deps: LandDeps, product: string, epic: string): Promise<LandResult> {
  for (let attempt = 1; ; attempt++) {
    const ctx = await deps.load(product);
    const s = await ctx.state(epic);
    if (s.config_mismatch) return { status: "error", message: `설정 불일치: ${s.config_mismatch.version}의 내용이 에픽 시작 때와 다르다 (반영하지 않음, M5.5 Z9)` };
    if (s.phase !== "LANDING") return { status: "skipped", message: `${s.phase} 단계 (반영 대기가 아님)` };
    if (s.landing?.status !== "pending") return { status: "skipped", message: "main 이동 뒤 테스트 재보고를 기다리는 중 (needs_report)" };
    const dir = ctx.dir;
    const g = (args: string[], env?: Record<string, string>, input?: string) => git(args, { cwd: dir, ...(env ? { env } : {}), ...(input !== undefined ? { input } : {}) });
    const emit = async (type: "epic.landed" | "land.rejected", data: Record<string, unknown>) => {
      const e = deps.sign(EventSchema.parse({ v: 1, id: ulid(), type, epic, author: SERVER, at: nowIso(), data }) as Event);
      await ctx.store.append(e);
      await ctx.store.sync().catch(() => undefined); // push 실패분은 다음 sync에서 다시 보낸다
    };
    const reject = async (reason: string, message: string, extra: Record<string, unknown> = {}): Promise<LandResult> => {
      await emit("land.rejected", { reason, details: { message, ...extra }, ...(typeof extra.rebased_sha === "string" ? { rebased_sha: extra.rebased_sha } : {}) });
      return { status: "rejected", reason, message };
    };

    const commit = s.landing.commit;
    const head = await new GitEngine(dir).fetchEpicBranch(epic);
    if (head !== commit) return reject("invalid", `에픽 브랜치 끝(${head?.slice(0, 10) ?? "없음"})이 검증한 커밋(${commit.slice(0, 10)})과 다르다`);

    // 재검증 (§11.3 3·4·5·6)
    const problems: string[] = [];
    const gate = s.gates.get(commit);
    if (!gate?.ok) problems.push("검증한 커밋의 통과 테스트 보고가 없다");
    const show = (f: string) => g(["show", `${commit}:.flightdeck/epics/${epic}/${f}`]).catch(() => null);
    problems.push(...checkImplLog(await show("impl-log.md"), await show("design.md")).map((p) => `impl-log: ${p}`));
    // coverage 재계산: 서버 편집 기록으로 (M7 제안 E3)
    if (s.pipeline && s.base_sha) {
      const log = await deps.editlog(product, epic);
      const cov = await serverCoverage({ dir, epic, base: s.base_sha, commit, pipeline: s.pipeline, records: log.records, memos: log.memos });
      problems.push(...cov.problems.map((p) => `coverage: ${p}`));
      if (!cov.checked && cov.note) console.log(`[land ${epic}] ${cov.note}`);
    }
    if (problems.length) return reject("invalid", problems.join("; "), { problems });

    const target = ctx.target;
    await g(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`]);
    const main = (await g(["rev-parse", `refs/remotes/origin/${target}`])).trim();

    if (!(await isAncestor(dir, main, commit))) {
      // main이 움직였다: main을 에픽 브랜치에 병합한다(Y9). 에픽 브랜치는 fast-forward라 담당자 작업 폴더도 그대로 따라온다
      const merged = await mergeTree(dir, commit, main);
      if ("conflicts" in merged) return reject("conflict", `main과 충돌: ${merged.conflicts.join(", ")}`, { files: merged.conflicts });
      const m = (await g(["commit-tree", merged.tree, "-p", commit, "-p", main], IDENTITY_ENV, `${target} 반영 (flightdeck-server)\n\nFlightdeck-Epic: ${epic}\n`)).trim();
      await g(["push", "-q", "origin", `${m}:refs/heads/${GitEngine.epicBranch(epic)}`]);
      return reject("needs_report", `${target}이 움직여 에픽 브랜치에 병합했다. ${m.slice(0, 10)}로 테스트를 다시 보고해야 한다`, { rebased_sha: m, main });
    }

    // squash (§11.3 8, Y7)
    const pipeline = s.pipeline;
    const keep = pipeline?.landing.records.keep ?? [];
    const tree = await squashTree(dir, commit, epic, keep, s);
    const title = ((await show("epic.md")) ?? "").split("\n")[0]?.replace(/^#\s*/, "").trim() || epic;
    const msg = [title, "", `Flightdeck-Epic: ${epic}`, `Flightdeck-Config: ${s.config_version}`, `Flightdeck-Approvals: ${s.verifiedApprovals.join(",")}`, `Flightdeck-Landed-By: ${SERVER}`, ""].join("\n");
    const sq = (await g(["commit-tree", tree, "-p", main], IDENTITY_ENV, msg)).trim();
    try {
      await g(["push", "-q", "origin", `${sq}:refs/heads/${target}`]);
    } catch (e) {
      if (e instanceof GitError && attempt < 3) continue; // 그 사이 main이 움직였다: 처음부터 (§11.3 9)
      throw e;
    }
    await emit("epic.landed", { main_commit: sq, approvals: s.verifiedApprovals });
    // 정리: 에픽 브랜치 삭제 (체크포인트·세션 원본 ref는 retention 뒤)
    await g(["push", "-q", "origin", `:refs/heads/${GitEngine.epicBranch(epic)}`]).catch(() => undefined);
    return { status: "landed", main_commit: sq };
  }
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", a, b], { cwd });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

/** 두 커밋의 3-way 병합 결과 tree (작업 폴더 없이). 충돌이면 파일 목록 */
async function mergeTree(cwd: string, a: string, b: string): Promise<{ tree: string } | { conflicts: string[] }> {
  try {
    return { tree: (await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b], { cwd })).trim().split("\n")[0]! };
  } catch (e) {
    // 종료 코드 1 = 충돌. 표준 출력: 첫 줄 tree, 그 뒤 충돌 파일
    if (e instanceof GitError && e.code === 1) return { conflicts: e.stdout.trim().split("\n").slice(1).filter(Boolean) };
    throw e;
  }
}

/** 반영 tree: 에픽 기록은 keep에 맞는 것만 남기고, 코드 쓰레드 스냅샷 threads/code.json을 넣는다 (Y7) */
async function squashTree(cwd: string, commit: string, epic: string, keep: string[], s: EpicState): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "fd-squash-"));
  const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
  const g = (args: string[], input?: string) => git(args, { cwd, env, ...(input !== undefined ? { input } : {}) });
  try {
    await g(["read-tree", commit]);
    const prefix = `.flightdeck/epics/${epic}/`;
    const files = (await g(["ls-files", "-z", "--", prefix])).split("\0").filter(Boolean);
    const drop = files.filter((f) => !keepRecord(f.slice(prefix.length), keep));
    if (drop.length) await g(["rm", "-q", "--cached", "--", ...drop]);
    const code = [...s.threads.values()]
      .filter((t) => t.anchor.type === "code")
      .map((t) => ({ id: t.id, kind: t.kind, status: t.status, author: t.author, to: t.to, anchor: t.anchor, body: t.body, replies: t.replies.map((r) => ({ author: r.author, at: r.at, body: r.body })), applied: t.applied.length > 0 }));
    if (code.length && keepRecord("threads/code.json", keep)) {
      const blob = (await g(["hash-object", "-w", "--stdin"], JSON.stringify(code, null, 2) + "\n")).trim();
      await g(["update-index", "--add", "--cacheinfo", `100644,${blob},${prefix}threads/code.json`]);
    }
    return (await g(["write-tree"])).trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

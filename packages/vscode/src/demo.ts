// M1 데모·통합 확인 스크립트. 묶어서 dist/fd-demo.mjs로 실행한다.
//   node dist/fd-demo.mjs setup <root>   견본 제품 레포를 만들고 에픽 CU-DEMO 시작
//   node dist/fd-demo.mjs draft <root>   현재 단계 자동 초안 (claude -p, haiku)
//   node dist/fd-demo.mjs check <root>   상태·형식·편집 기록·체크포인트 점검
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeCodeAdapter } from "@flightdeck/agent";
import { replay } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { readEditLog } from "@flightdeck/hook";
import { EpicWorkflow } from "./workflow.ts";

const [cmd, rootArg] = process.argv.slice(2);
if (!cmd || !rootArg) throw new Error("사용: fd-demo.mjs <setup|draft|check> <root>");
const root = path.resolve(rootArg);
const repo = path.join(root, "product");
const here = path.dirname(new URL(import.meta.url).pathname);
const EPIC = "CU-DEMO";
const wf = new EpicWorkflow({
  repo,
  member: "dh.lee",
  configDir: path.resolve(here, "../examples/flightdeck-config/products/sample"),
  distDir: here,
  adapter: new ClaudeCodeAdapter(),
  model: "haiku",
  maxTurns: 30,
});

if (cmd === "setup" || cmd === "repo") {
  await mkdir(path.join(repo, "src/auth"), { recursive: true });
  await git(["init", "-q", "-b", "main"], { cwd: repo });
  // 사용자의 전역 git 신원을 쓴다 (확장이 멤버 ID를 user.email에서 얻는다). 전역 설정이 없을 때만 임시 신원
  if (!(await git(["config", "user.email"], { cwd: repo }).catch(() => "")).trim()) {
    await git(["config", "user.name", "dh.lee"], { cwd: repo });
    await git(["config", "user.email", "dh.lee@example.com"], { cwd: repo });
  }
  await writeFile(
    path.join(repo, "src/auth/token.ts"),
    [
      "// 액세스 토큰 발급과 갱신",
      "export const ACCESS_TTL_SEC = 15 * 60;",
      "const store = new Map<string, { userId: string; exp: number }>();",
      "",
      "export function issue(userId: string, now = Date.now()) {",
      "  const token = crypto.randomUUID();",
      "  store.set(token, { userId, exp: now + ACCESS_TTL_SEC * 1000 });",
      "  return token;",
      "}",
      "",
      "/** 리프레시 토큰으로 새 액세스 토큰을 발급한다. 리프레시 토큰은 재사용된다. */",
      "export function refresh(refreshToken: string, userId: string) {",
      "  return issue(userId);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repo, "README.md"), "# demo product\n인증 모듈: src/auth/token.ts\n");
  // 데모에서는 가벼운 모델로 (에픽 작업 폴더에도 그대로 들어간다)
  await mkdir(path.join(repo, ".vscode"), { recursive: true });
  await writeFile(path.join(repo, ".vscode/settings.json"), JSON.stringify({ "flightdeck.model": "haiku" }, null, 2) + "\n");
  await git(["add", "."], { cwd: repo });
  await git(["commit", "-q", "-m", "init"], { cwd: repo });
}

if (cmd === "setup") {
  const r = await wf.start(EPIC, "리프레시 토큰 회전", "리프레시 토큰을 재사용하지 말고, 갱신할 때마다 새 리프레시 토큰을 발급하고 이전 것은 폐기한다. 탈취된 리프레시 토큰의 재사용을 탐지하면 해당 사용자의 모든 세션을 끊는다.");
  console.log(JSON.stringify({ worktree: r.worktree, phase: r.state.phase }, null, 2));
}

if (cmd === "draft") {
  const t0 = Date.now();
  const r = await wf.draft(EPIC);
  console.log(JSON.stringify({ sessionId: r.sessionId, seconds: Math.round((Date.now() - t0) / 1000), result: r.result.slice(0, 600) }, null, 2));
}

if (cmd === "thread") {
  // "불명확한 점" 섹션의 첫 목록 항목에 질문 쓰레드를 단다
  const { parseBlocks } = await import("@flightdeck/core");
  const file = path.join(await wf.worktree(EPIC), ".flightdeck/epics", EPIC, "analysis.md");
  const blocks = parseBlocks((await readFile(file, "utf8")).split("\n"));
  const sec = blocks.findIndex((b) => b.text.startsWith("## 불명확한 점"));
  const item = blocks.slice(sec + 1).find((b) => b.text.startsWith("- "));
  if (!item?.pid) throw new Error("불명확한 점 항목을 찾지 못함");
  const id = await wf.createThread(EPIC, { file: "analysis.md", pid: item.pid, kind: "question", to: ["park"], body: process.argv[4] ?? "리프레시 토큰은 메모리 Map에 두나요, DB에 두나요?" });
  console.log(JSON.stringify({ thread: id, pid: item.pid }));
}

if (cmd === "check") {
  const wt = await wf.worktree(EPIC);
  const s = await wf.epicState(EPIC);
  const dataDir = await wf.eng.dataDir();
  const check = await wf.checkPhase(EPIC);
  const log = await readEditLog(dataDir, EPIC);
  const files = [...new Set(log.map((r) => r.file))];
  const base = new Map<string, string | null>();
  for (const f of files) base.set(f, null);
  const rp = replay(base, log);
  const replayMatch = Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, existsSync(path.join(wt, f)) ? rp.files.get(f) === (await readFile(path.join(wt, f), "utf8")) : rp.files.get(f) === null])),
  );
  const hookLogFile = path.join(dataDir, "hook", EPIC, "hook-log.jsonl");
  const hookLog = existsSync(hookLogFile) ? (await readFile(hookLogFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l)) : [];
  const ckpts = (await git(["log", "--format=%h %s", `refs/flightdeck/ckpt/${EPIC}/dh.lee`, "--not", "--branches"], { cwd: repo }).catch(() => "")).trim();
  console.log(
    JSON.stringify(
      {
        phase: s.phase,
        events: (await wf.store.list(EPIC)).map((e) => e.type),
        runs: [...s.runs.values()].map((r) => ({ run: r.run_id, finished: r.finished, handoff: existsSync(path.join(wt, ".flightdeck/epics", EPIC, "runs", r.run_id, "handoff.md")) })),
        phaseProblems: check.problems,
        editlog: { records: log.length, files, mismatches: rp.mismatches.length, replayMatchesDisk: replayMatch },
        hook: hookLog.reduce((acc: Record<string, number>, e: any) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {}),
        denies: hookLog.filter((e: any) => e.kind === "deny").map((e: any) => e.reason.slice(0, 120)),
        errors: hookLog.filter((e: any) => e.kind === "error").map((e: any) => e.message.slice(0, 200)),
        checkpoints: ckpts.split("\n").filter(Boolean),
      },
      null,
      2,
    ),
  );
}

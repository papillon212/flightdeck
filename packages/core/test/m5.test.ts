// M5 core: VERIFICATION 티어 리뷰, 수정 제안, 구현 재개, 반영(LANDING → DONE), main 감사, 코드 쓰레드 줄 옮기기
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_TRUST, Event as EventSchema, parsePipeline, type Event } from "@flightdeck/schema";
import { auditMain, keepRecord, mapLines, reduce, reviewOf, ulid, type MainCommit } from "../src/index.ts";

const P = parsePipeline(readFileSync(path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample/pipeline.yaml"), "utf8"));
// 설계: 리뷰어 없음(바로 통과). 검증: lead park → qa choi
P.members.groups = { qa: ["choi"], verifiers: ["park"] };
P.phases.verification.review.tiers[0]!.reviewers = { group: "verifiers" };

const C1 = "c".repeat(40);
const C2 = "d".repeat(40);
let t = 1_790_000_000_000;
const ev = (type: Event["type"], author: string, data: unknown): Event => {
  t += 1000;
  return EventSchema.parse({ v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data }) as Event;
};
const cmd = (exit: number) => ({ cmd: "node check.js", exit, summary: "", log_hash: "e".repeat(64) });
const toVerification = () => [
  ev("epic.started", "dh.lee", { tracker_ref: "1", owner: "dh.lee", base_sha: "a".repeat(40), config_version: "v1" }),
  ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }),
  ev("review.requested", "dh.lee", { phase: "DESIGN", artifact_hash: "sha256:x", commit: "a".repeat(40) }),
  ev("gate.reported", "dh.lee", { commit: C1, commands: [cmd(0)] }),
  ev("phase.completed", "dh.lee", { phase: "IMPLEMENTATION", commit: C1 }),
];
const request = (commit = C1) => ev("review.requested", "dh.lee", { phase: "VERIFICATION", artifact_hash: `tree:${commit}`, commit });
const approve = (who: string, tier: string, commit = C1) => ev("review.approved", who, { phase: "VERIFICATION", tier, artifact_hash: `tree:${commit}` });
const run = (events: Event[]) => reduce("CU-1", events, DEV_TRUST, { pipelines: new Map([["v1", P]]) });
const reasons = (s: ReturnType<typeof run>) => s.ignored.map((i) => i.reason);

describe("VERIFICATION 티어 리뷰 (Y1)", () => {
  it("테스트가 통과한 커밋만 리뷰 요청 → lead → qa → LANDING", () => {
    const s = run([...toVerification(), request(C2), request(), approve("park", "lead"), approve("choi", "qa")]);
    expect(reasons(s)).toEqual(["이 커밋의 테스트 결과 보고(gate.reported)가 없음"]);
    expect(s.phase).toBe("LANDING");
    expect(s.landing).toEqual({ status: "pending", commit: C1 });
    expect(s.verifiedApprovals).toHaveLength(2);
  });

  it("수정 제안 → 담당자 반영 → 다시 보고·요청하면 lead부터 다시", () => {
    const patch = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n";
    const anchor = { type: "code", file: "src/a.js", rev: C1, range: [1, 1], context: [] };
    const s = run([
      ...toVerification(),
      request(),
      approve("park", "lead"),
      ev("thread.created", "choi", { thread: "t-AAAAAAAA", phase: "VERIFICATION", file: "src/a.js", anchor, kind: "question", to: ["dh.lee"], body: "?", patch }),
      ev("thread.created", "choi", { thread: "t-BBBBBBBB", phase: "VERIFICATION", file: "src/a.js", anchor, kind: "change_request", to: ["dh.lee"], body: "b로", patch }),
      ev("patch.applied", "park", { thread: "t-BBBBBBBB", commit: C1 }),
      ev("patch.applied", "dh.lee", { thread: "t-BBBBBBBB", commit: C1 }),
      ev("gate.reported", "dh.lee", { commit: C2, commands: [cmd(0)] }),
      request(C2),
      ev("thread.resolved", "choi", { thread: "t-BBBBBBBB" }),
    ]);
    expect(reasons(s)).toEqual(["수정 제안은 수정 요청 쓰레드에만 붙인다", "담당자만 수정 제안을 반영할 수 있음"]);
    expect(s.threads.get("t-BBBBBBBB")).toMatchObject({ patch, applied: [expect.any(String)] });
    expect(reviewOf(s)?.current?.name).toBe("lead"); // 새 해시: 앞 승인 무효
  });

  it("구현 재개: VERIFICATION → IMPLEMENTATION", () => {
    const s = run([...toVerification(), request(), ev("phase.reverted", "dh.lee", { from: "VERIFICATION", to: "IMPLEMENTATION", reason: "수정 요청 반영" })]);
    expect(s.phase).toBe("IMPLEMENTATION");
  });
});

describe("반영 (§11, Y5·Y6)", () => {
  const landing = () => [...toVerification(), request(), approve("park", "lead"), approve("choi", "qa")];
  it("epic.landed → DONE", () => {
    const s = run([...landing(), ev("epic.landed", "dh.lee", { main_commit: C2, approvals: [] })]);
    expect([s.phase, s.landed?.main_commit, s.landing]).toEqual(["DONE", C2, null]);
  });
  it("needs_report: rebase 결과로 다시 보고하면 다시 pending. conflict → IMPLEMENTATION", () => {
    const s = run([...landing(), ev("land.rejected", "dh.lee", { reason: "needs_report", rebased_sha: C2 })]);
    expect(s.landing).toMatchObject({ status: "needs_report", commit: C2 });
    const s2 = run([...landing(), ev("land.rejected", "dh.lee", { reason: "needs_report", rebased_sha: C2 }), ev("gate.reported", "dh.lee", { commit: C2, commands: [cmd(0)] })]);
    expect(s2.landing).toMatchObject({ status: "pending", commit: C2 });
    const s3 = run([...landing(), ev("land.rejected", "dh.lee", { reason: "conflict", details: { files: ["src/a.js"] } })]);
    expect(s3.phase).toBe("IMPLEMENTATION");
  });
});

describe("반영 도우미", () => {
  it("squash에 남길 기록 (Y7)", () => {
    const keep = ["epic.md", "analysis.md", "design.md", "impl-log.md", "runs/", "threads/", "sessions/"];
    expect(["epic.md", "runs/R/handoff.md", "threads/code.json", "trace.jsonl", "state.json", "notes.md"].filter((f) => keepRecord(f, keep))).toEqual(["epic.md", "runs/R/handoff.md", "threads/code.json"]);
  });

  it("main 감사 (Y8)", () => {
    const commits: MainCommit[] = [
      { sha: "1111111aaa", subject: "반영", trailers: { "Flightdeck-Epic": "CU-1" } },
      { sha: "2222222bbb", subject: "직접 push", trailers: {} },
      { sha: "3333333ccc", subject: "위조", trailers: { "Flightdeck-Epic": "CU-2" } },
      { sha: "4444444ddd", subject: "예외", trailers: {} },
    ];
    expect(auditMain(commits, new Map([["CU-1", "1111111aaa"]]), ["4444444"]).map((f) => f.sha)).toEqual(["2222222bbb", "3333333ccc"]);
  });

  it("코드 쓰레드 줄 옮기기 (Y2)", () => {
    const diff = ["@@ -2,0 +3,2 @@", "+x", "+y", "@@ -10,2 +12,1 @@", "-a", "-b", "+c"].join("\n");
    expect(mapLines(diff, [5, 6])).toEqual({ range: [7, 8], lost: false }); // 앞에 2줄 들어옴
    expect(mapLines(diff, [1, 1])).toEqual({ range: [1, 1], lost: false });
    expect(mapLines(diff, [11, 11])).toEqual({ range: [13, 13], lost: true }); // 바뀐 줄
    expect(mapLines(diff, [20, 20])).toEqual({ range: [21, 21], lost: false }); // +2 -1
  });
});

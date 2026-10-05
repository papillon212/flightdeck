// 서버 ③ 편집 기록 (설계 §8.6, §7.3 6, m7-plan E2·E3·E6): 반영 coverage 재계산, 출처 조회, 저장소 seq 연속
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffRecords, renderImplLog } from "@flightdeck/core";
import { git } from "@flightdeck/git";
import { parsePipeline, type EditMemo, type EditRecord, type EditSource } from "@flightdeck/schema";
import { MemoryStore, seqCommit, serverBlame, serverCoverage } from "../src/index.ts";

const EPIC = "CU-7";
const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAA";
const P = parsePipeline(readFileSync(path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample/pipeline.yaml"), "utf8"));
const agent = (step: number): EditSource => ({ kind: "agent", member: "dh.lee", adapter: "claude-code", run: RUN, step });
let root: string, repo: string, base: string;
let t = Date.parse("2026-10-05T00:00:00Z");

function log(records: EditRecord[], file: string, before: string | null, after: string | null, source: EditSource) {
  for (const r of diffRecords(EPIC, file, before, after, source, new Date((t += 1000)).toISOString())) records.push({ ...r, seq: records.length + 1 });
}

async function commit(files: Record<string, string>, msg: string): Promise<string> {
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, f)), { recursive: true });
    await writeFile(path.join(repo, f), c);
  }
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.name=x", "-c", "user.email=x@test.local", "commit", "-q", "-m", msg], { cwd: repo });
  return (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();
}

const implLog = (steps: number[]) =>
  renderImplLog(EPIC, steps.map((n) => ({ n, title: `s${n}`, design_ref: "design.md#p:0001", ckpt: "", changes: [], verification: "ok", intent: "i", decision: "d", alternatives: "a", review_points: "r" })));

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-editlog-"));
  repo = path.join(root, "repo");
  await git(["init", "-q", "-b", "main", repo], { cwd: root });
  base = await commit({ "src/a.js": "one\ntwo\n" }, "init");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("반영 서버의 coverage 재계산 (E3)", () => {
  it("공유 커밋의 Flightdeck-Seq까지 재적용: 모두 설명되면 통과, 그 뒤 기록은 보지 않는다", async () => {
    const recs: EditRecord[] = [];
    log(recs, "src/a.js", "one\ntwo\n", "one\nTWO\nthree\n", agent(1));
    const n = recs.length;
    const c = await commit({ "src/a.js": "one\nTWO\nthree\n", [`.flightdeck/epics/${EPIC}/impl-log.md`]: implLog([1]) }, `${EPIC}: 구현\n\nFlightdeck-Seq: ${n}\n`);
    log(recs, "src/a.js", "one\nTWO\nthree\n", "one\nTWO\nthree\nlater\n", { kind: "human", member: "dh.lee" }); // 커밋 뒤의 편집
    expect(await seqCommit(repo, c)).toEqual({ commit: c, upto: n });
    const r = await serverCoverage({ dir: repo, epic: EPIC, base, commit: c, pipeline: P, records: recs, memos: [] });
    expect(r).toMatchObject({ checked: true, problems: [], upto: n, hunks: 1 });
  });

  it("기록되지 않은 Step·메모 없는 직접 수정은 막고, 메모가 있으면 통과", async () => {
    const recs: EditRecord[] = [];
    log(recs, "src/a.js", "one\ntwo\n", "one\ntwo\nagent2\n", agent(2)); // impl-log에 Step 2 없음
    log(recs, "src/b.js", null, "human\n", { kind: "human", member: "dh.lee" });
    const c = await commit({ "src/a.js": "one\ntwo\nagent2\n", "src/b.js": "human\n", [`.flightdeck/epics/${EPIC}/impl-log.md`]: implLog([1]) }, `x\n\nFlightdeck-Seq: ${recs.length}\n`);
    const r = await serverCoverage({ dir: repo, epic: EPIC, base, commit: c, pipeline: P, records: recs, memos: [] });
    expect(r.problems).toEqual([expect.stringContaining("src/a.js:3-3 — 기록되지 않은 Step 2"), expect.stringContaining("src/b.js:1-1 — 메모 없는 직접 수정")]);
    const memo: EditMemo = { epic: EPIC, file: "src/b.js", seqs: [recs.length, recs.length], memo: "설정 파일", member: "dh.lee", at: new Date(t).toISOString() };
    const r2 = await serverCoverage({ dir: repo, epic: EPIC, base, commit: c, pipeline: P, records: recs, memos: [memo] });
    expect(r2.problems).toHaveLength(1);
  });

  it("편집 기록과 커밋이 다르면 기록 불일치, 서버에 기록이 모자라면 막는다, 위치가 없는 커밋은 계산하지 않는다", async () => {
    const recs: EditRecord[] = [];
    log(recs, "src/a.js", "one\ntwo\n", "one\ntwo\nx\n", agent(1));
    const c = await commit({ "src/a.js": "one\ntwo\nx\nsneaky\n", [`.flightdeck/epics/${EPIC}/impl-log.md`]: implLog([1]) }, `x\n\nFlightdeck-Seq: ${recs.length}\n`);
    expect((await serverCoverage({ dir: repo, epic: EPIC, base, commit: c, pipeline: P, records: recs, memos: [] })).problems[0]).toContain("기록 불일치");
    expect((await serverCoverage({ dir: repo, epic: EPIC, base, commit: c, pipeline: P, records: [], memos: [] })).problems[0]).toContain("서버 편집 기록이 커밋의 위치까지 없다");
    const old = await commit({ "src/a.js": "old\n" }, "M7 이전 커밋");
    expect(await serverCoverage({ dir: repo, epic: EPIC, base, commit: old, pipeline: P, records: [], memos: [] })).toMatchObject({ checked: false });
  });

  it("반영 서버의 main 병합 커밋은 첫 부모(검증한 커밋)의 위치를 쓴다", async () => {
    const verified = await commit({ "src/c.js": "c\n" }, "검증\n\nFlightdeck-Seq: 9\n");
    const tree = (await git(["rev-parse", `${verified}^{tree}`], { cwd: repo })).trim();
    const merge = (await git(["commit-tree", tree, "-p", verified, "-p", base, "-m", "main 반영 (flightdeck-server)\n\nFlightdeck-Epic: CU-7"], { cwd: repo })).trim();
    expect(await seqCommit(repo, merge)).toEqual({ commit: verified, upto: 9 });
  });
});

describe("출처 조회 (E6)", () => {
  it("rev 커밋의 위치까지 재적용하고 커밋 내용과 같은지 알린다", async () => {
    const recs: EditRecord[] = [];
    log(recs, "src/a.js", "one\ntwo\n", "one\ntwo\nnew\n", agent(1));
    const c = await commit({ "src/a.js": "one\ntwo\nnew\n" }, `x\n\nFlightdeck-Seq: ${recs.length}\n`);
    const b = await serverBlame({ dir: repo, base, rev: c, file: "src/a.js", records: recs, memos: [] });
    expect(b).toMatchObject({ upto: recs.length, matches: true });
    expect(b.lines.map((l) => l?.kind ?? "base")).toEqual(["base", "base", "agent", "base"]);
  });
});

describe("저장소 (E1)", () => {
  it("seq가 이어질 때만 붙인다, 메모는 통째로 바꾼다", async () => {
    const s = new MemoryStore();
    const recs: EditRecord[] = [];
    log(recs, "f", null, "a\n", agent(1));
    log(recs, "f", "a\n", "ab\n", agent(1));
    expect(await s.appendEditlog("p", EPIC, recs.slice(1))).toBe(false);
    expect(await s.appendEditlog("p", EPIC, recs.slice(0, 1))).toBe(true);
    expect(await s.appendEditlog("p", EPIC, recs.slice(1))).toBe(true);
    expect(await s.editlogLast("p", EPIC)).toBe(2);
    expect((await s.editlog("p", EPIC, 2)).map((r) => r.seq)).toEqual([2]);
    expect(await s.editlogLast("other", EPIC)).toBe(0);
  });
});

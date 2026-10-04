// M4 core: impl-log, 출처 추적·coverage, 세션 원본 검색, 비밀값 가리기, IMPLEMENTATION 관문
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EditMemo, EditRecord, EditSource, Event } from "@flightdeck/schema";
import {
  checkImplLog,
  coverage,
  diffToEdits,
  dotenvValues,
  parseImplLog,
  provenance,
  reduce,
  redactSecrets,
  renderImplLog,
  searchTranscripts,
  secretEnvValues,
  sha256,
  stepChanges,
  transcriptText,
  ulid,
  type ImplStep,
} from "../src/index.ts";
import { DEV_TRUST, parsePipeline } from "@flightdeck/schema";

const CKPT = "a".repeat(40);
const step = (n: number, over: Partial<ImplStep> = {}): ImplStep => ({
  n,
  title: `단계 ${n}`,
  design_ref: "design.md#p:a91c",
  ckpt: CKPT,
  changes: ["src/a.ts:1-3"],
  verification: "node --test  # ok",
  intent: "회전 정책 구현",
  decision: "Set으로 관리",
  alternatives: "DB 테이블 — 과도",
  review_points: "a.ts:2 경쟁 조건",
  ...over,
});
const DESIGN = "<!-- p:a91c -->\n## 개요\n<!-- p:b000 -->\n회전\n";

describe("impl-log (§7.1)", () => {
  it("렌더링한 것을 다시 읽으면 같다. 메모 섹션도", () => {
    const md = renderImplLog("CU-1", [step(1), step(2, { intent: "여러 줄\n의도" })], [{ file: "src/a.ts", lines: "3-4", who: "@dh.lee", memo: "오타 수정" }]);
    const p = parseImplLog(md);
    expect(p.errors).toEqual([]);
    expect(p.steps).toEqual([step(1), step(2, { intent: "여러 줄\n의도" })]);
    expect(p.memos).toEqual([{ file: "src/a.ts", lines: "3-4", who: "@dh.lee", memo: "오타 수정" }]);
    expect(checkImplLog(md, DESIGN)).toEqual([]);
  });

  it("형식 문제: 번호 건너뜀, 빈 글, 없는 문단, 체크포인트 아님", () => {
    const md = renderImplLog("CU-1", [step(1), step(3, { decision: "", design_ref: "design.md#p:ffff", ckpt: "x" })]);
    const problems = checkImplLog(md, DESIGN);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Step 번호가 2"),
        expect.stringContaining("결정"),
        expect.stringContaining("p:ffff가 design.md에 없습니다"),
        expect.stringContaining("ckpt"),
      ]),
    );
    expect(checkImplLog(null, DESIGN)).toEqual([expect.stringContaining("impl-log.md가 없습니다")]);
  });
});

let seq = 0;
const agent = (step?: number): EditSource => ({ kind: "agent", member: "dh.lee", adapter: "claude-code", run: "01JB7AAAAAAAAAAAAAAAAAAAAA", ...(step !== undefined ? { step } : {}) });
const human: EditSource = { kind: "human", member: "dh.lee" };
/** before → after를 편집 기록으로 */
function edits(file: string, before: string | null, after: string, source: EditSource, ts = "2026-10-04T10:00:00.000+09:00"): EditRecord[] {
  let cur = before;
  return diffToEdits(before ?? "", after).map((e) => {
    const r: EditRecord = { epic: "CU-1", file, seq: ++seq, base_hash: sha256(cur), range: e.range, insert: e.insert, source, ts };
    cur = (cur ?? "").slice(0, e.range[0]) + e.insert + (cur ?? "").slice(e.range[1]);
    return r;
  });
}

describe("출처 추적과 coverage (§7.3)", () => {
  const BASE = "a\nb\nc\nd\n";
  it("Step이 기록된 에이전트 편집은 설명되고, 사람 편집은 메모가 있어야 한다", () => {
    seq = 0;
    const r1 = edits("src/a.ts", BASE, "a\nB1\nc\nd\n", agent(1));
    const r2 = edits("src/a.ts", "a\nB1\nc\nd\n", "a\nB1\nc\nD-human\n", human);
    const current = "a\nB1\nc\nD-human\n";
    const ctx = { loggedSteps: new Set([1]), memos: [] as EditMemo[] };
    const rep = coverage([{ file: "src/a.ts", base: BASE, records: [...r1, ...r2], current }], ctx);
    expect(rep.drift).toEqual([]);
    expect(rep.hunks.map((h) => [h.newLines, h.explained, h.sources.map((s) => s.why)])).toEqual([
      [[2, 2], true, ["Step 1"]],
      [[4, 4], false, ["메모 없는 직접 수정 (@dh.lee)"]],
    ]);
    expect(rep.ratio).toBe(0.5);
    expect(rep.groups).toEqual([{ file: "src/a.ts", kind: "human", seqs: [r2[0]!.seq, r2.at(-1)!.seq], lines: [[4, 4]], who: "@dh.lee" }]);
    const memo: EditMemo = { epic: "CU-1", file: "src/a.ts", seqs: rep.groups[0]!.seqs, memo: "로그 문구", member: "dh.lee", at: "2026-10-04T10:00:00.000+09:00" };
    expect(coverage([{ file: "src/a.ts", base: BASE, records: [...r1, ...r2], current }], { ...ctx, memos: [memo] }).unexplained).toEqual([]);
  });

  it("기록되지 않은 Step·Step 밖의 에이전트 편집, 지우기만 한 변경, 기록 누락(drift)", () => {
    seq = 0;
    const r1 = edits("src/a.ts", BASE, "a\nb\nc\nd\nnew\n", agent(2)); // Step 2는 기록 안 됨
    const r2 = edits("src/a.ts", "a\nb\nc\nd\nnew\n", "a\nc\nd\nnew\n", agent()); // 줄 b 삭제
    const rep = coverage([{ file: "src/a.ts", base: BASE, records: [...r1, ...r2], current: "a\nc\nd\nnew\nX\n" }], { loggedSteps: new Set([1]), memos: [] });
    expect(rep.drift).toEqual(["src/a.ts"]);
    expect(rep.hunks.map((h) => h.sources.map((s) => s.why))).toEqual([["Step 밖의 에이전트 편집"], ["기록되지 않은 Step 2의 에이전트 편집"]]);
  });

  it("자기가 넣고 자기가 지운 것은 흔적이 없고, 사람이 넣었다 지운 자리는 표시가 남는다", () => {
    seq = 0;
    const a = edits("f", BASE, "a\nb\nTMP\nc\nd\n", agent(1));
    const b = edits("f", "a\nb\nTMP\nc\nd\n", BASE, agent(1));
    expect(coverage([{ file: "f", base: BASE, records: [...a, ...b], current: BASE }], { loggedSteps: new Set([1]), memos: [] }).hunks).toEqual([]);
    const c = edits("f", BASE, "a\nc\nd\n", human);
    const rep = coverage([{ file: "f", base: BASE, records: c, current: "a\nc\nd\n" }], { loggedSteps: new Set(), memos: [] });
    expect(rep.hunks.map((h) => [h.oldLines, h.newLines, h.explained])).toEqual([[[2, 2], [2, 1], false]]);
  });

  it("새 파일과 파일 삭제", () => {
    seq = 0;
    const add = edits("n.ts", null, "x\ny\n", agent(1));
    const rep = coverage([{ file: "n.ts", base: null, records: add, current: "x\ny\n" }], { loggedSteps: new Set([1]), memos: [] });
    expect(rep.hunks.map((h) => [h.newLines, h.explained])).toEqual([[[1, 2], true]]);
    const del: EditRecord = { epic: "CU-1", file: "f", seq: ++seq, base_hash: sha256(BASE), range: [0, 0], insert: "", delete_file: true, source: human, ts: "2026-10-04T10:00:00.000+09:00" };
    const rep2 = coverage([{ file: "f", base: BASE, records: [del], current: null }], { loggedSteps: new Set(), memos: [] });
    expect(rep2.hunks.map((h) => h.sources.map((s) => s.why))).toEqual([["메모 없는 직접 수정 (@dh.lee)"]]);
  });

  it("복원은 그 체크포인트 시점의 출처를 되살린다 (X8)", () => {
    seq = 0;
    const r1 = edits("f", BASE, "a\nSTEP1\nc\nd\n", agent(1));
    const at = seq;
    const r2 = edits("f", "a\nSTEP1\nc\nd\n", "a\nSTEP1\nc\nWRONG\n", agent(2));
    const cur = "a\nSTEP1\nc\nWRONG\n";
    const restore: EditRecord = { epic: "CU-1", file: "f", seq: ++seq, base_hash: sha256(cur), range: [0, cur.length], insert: "a\nSTEP1\nc\nd\n", source: { kind: "restore", member: "dh.lee", ckpt: CKPT, seq: at }, ts: "2026-10-04T10:00:00.000+09:00" };
    const rep = coverage([{ file: "f", base: BASE, records: [...r1, ...r2, restore], current: "a\nSTEP1\nc\nd\n" }], { loggedSteps: new Set([1]), memos: [] });
    expect(rep.hunks.map((h) => h.sources.map((s) => s.why))).toEqual([["Step 1"]]);
    // 내용이 맞지 않으면 복원 자신이 출처
    const bad = { ...restore, insert: "zzz\n" };
    expect(provenance(BASE, [...r1, ...r2, bad]).segs.some((s) => s.origin?.source.kind === "restore")).toBe(true);
  });

  it("Step의 changes는 그 Step 편집이 만든 현재 줄 범위", () => {
    seq = 0;
    const r1 = edits("src/a.ts", BASE, "a\nb1\nb2\nc\nd\n", agent(1));
    const r2 = edits("src/a.ts", "a\nb1\nb2\nc\nd\n", "a\nb1\nb2\nc\nd\ne\n", agent(2));
    const files = [{ file: "src/a.ts", base: BASE, records: [...r1, ...r2] }];
    expect(stepChanges(files, 1)).toEqual(["src/a.ts:2-3"]);
    expect(stepChanges(files, 2)).toEqual(["src/a.ts:6"]);
    expect(stepChanges(files, 3)).toEqual([]);
  });
});

describe("세션 원본 검색 (§6.4)", () => {
  const items = [
    { type: "user", timestamp: "t1", message: { role: "user", content: "토큰 회전을 구현해 줘" } },
    { type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "Redis 대신 메모리 Set을 쓰기로 했습니다. 재사용탐지가 쉬워서입니다." }] } },
    { type: "assistant", timestamp: "t3", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }] } },
    { type: "user", timestamp: "t4", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  ];
  const docs = items.map((it, i) => ({ run: "R", session: "S", i, ...transcriptText(it)! }));
  it("한글 조각으로도 찾고 앞뒤 맥락을 붙인다", () => {
    expect(docs.map((d) => d.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    const hits = searchTranscripts(docs, "재사용 탐지 Redis");
    expect(hits[0]!.doc.i).toBe(1);
    expect(hits[0]!.excerpt).toContain("▶ [assistant · t2]");
    expect(hits[0]!.excerpt).toContain("토큰 회전을 구현해 줘");
    expect(searchTranscripts(docs, "없는단어xyz")).toEqual([]);
  });
});

describe("비밀값 가리기 (§6.4, X6)", () => {
  it("토큰 모양, 비밀 이름의 환경변수, .env 값", () => {
    const env = { HOME: "/Users/someone", GITHUB_TOKEN: "abcdef123456", MY_API_KEY: "zzzzzz9999" };
    const vals = [...secretEnvValues(env), ...dotenvValues("DB_URL=postgres://u:pw@h/db\nexport X='short'\n")];
    expect(vals).toEqual(["abcdef123456", "zzzzzz9999", "postgres://u:pw@h/db"]);
    const text = `home /Users/someone tok abcdef123456 key zzzzzz9999 db postgres://u:pw@h/db cu pk_123456_ABCDEFGHIJKLMNOPQRSTUVWX gh ghp_${"a".repeat(36)}`;
    expect(redactSecrets(text, vals)).toBe("home /Users/someone tok [REDACTED] key [REDACTED] db [REDACTED] cu [REDACTED] gh [REDACTED]");
  });
});

describe("IMPLEMENTATION 관문 (X5)", () => {
  // 리뷰어가 없는 티어만 있는 파이프라인: 리뷰 요청만으로 IMPLEMENTATION에 들어간다
  const p = parsePipeline(readFileSync(path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample/pipeline.yaml"), "utf8"));
  p.members.groups = {};
  let t = 1_790_000_000_000;
  const ev = (type: string, data: unknown, author = "dh.lee"): Event => {
    t += 1000;
    return { v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data } as Event;
  };
  const SHA = "b".repeat(40);
  const C2 = "c".repeat(40);
  const toImpl = () => [
    ev("epic.started", { tracker_ref: "1", owner: "dh.lee", base_sha: SHA, config_version: "v1" }),
    ev("gate.reported", { commit: SHA, commands: [] }), // 아직 ANALYSIS: 무시
    ev("phase.completed", { phase: "ANALYSIS" }),
    ev("review.requested", { phase: "DESIGN", artifact_hash: "sha256:1", commit: SHA }),
  ];
  const run = (events: Event[]) => reduce("CU-1", events, DEV_TRUST, { pipelines: new Map([["v1", p]]) });
  const cmd = (exit: number) => ({ cmd: "node --test", exit, summary: "", log_hash: "d".repeat(64) });

  it("통과 보고가 있는 커밋으로만 VERIFICATION", () => {
    const base = toImpl();
    expect(run(base).phase).toBe("IMPLEMENTATION");
    expect(run(base).ignored.map((i) => i.reason)).toEqual(["ANALYSIS 단계에서는 테스트 결과를 보고하지 않음"]);
    const s = run([
      ...base,
      ev("phase.completed", { phase: "IMPLEMENTATION" }),
      ev("phase.completed", { phase: "IMPLEMENTATION", commit: C2 }),
      ev("gate.reported", { commit: C2, commands: [cmd(0), cmd(1)] }),
      ev("phase.completed", { phase: "IMPLEMENTATION", commit: C2 }),
      ev("gate.reported", { commit: C2, commands: [cmd(0)] }, "park"),
      ev("gate.reported", { commit: C2, commands: [cmd(0), cmd(0)] }),
      ev("phase.completed", { phase: "IMPLEMENTATION", commit: C2 }),
    ]);
    expect(s.ignored.slice(1).map((i) => i.reason)).toEqual([
      "검사한 커밋(commit)이 없음",
      "이 커밋의 테스트 결과 보고(gate.reported)가 없음",
      "이 커밋의 테스트 결과 보고에 실패한 명령이 있음",
      "담당자만 테스트 결과를 보고할 수 있음",
    ]);
    expect(s.phase).toBe("VERIFICATION");
  });
});

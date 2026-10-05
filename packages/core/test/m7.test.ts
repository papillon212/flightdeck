// M7 core: 줄 단위 출처(blame), 줄 ↔ 오프셋, 편집 기록으로 줄 범위 옮기기 (설계 §8.6, §3.5, m7-plan E5·E6)
import { describe, expect, it } from "vitest";
import type { EditMemo, EditRecord, EditSource } from "@flightdeck/schema";
import { blame, diffRecords, linesToOffsets, mapLines, moveLines, offsetsToLines, replay } from "../src/index.ts";

const RUN = "01JB7AAAAAAAAAAAAAAAAAAAAA";
const agent = (step: number): EditSource => ({ kind: "agent", member: "dh.lee", adapter: "claude-code", run: RUN, step });
const human: EditSource = { kind: "human", member: "dh.lee" };
let t = Date.parse("2026-10-05T00:00:00Z");

/** before → after를 편집 기록으로 (seq를 이어 붙인다) */
function log(records: EditRecord[], file: string, before: string | null, after: string | null, source: EditSource): string | null {
  for (const r of diffRecords("CU-1", file, before, after, source, new Date((t += 1000)).toISOString())) records.push({ ...r, seq: records.length + 1 });
  return after;
}

describe("줄 단위 출처 (E6)", () => {
  it("줄마다 마지막으로 만든 편집: base 줄은 null, 에이전트 Step·사람(메모)·지운 자리", () => {
    const base = "a\nb\nc\nd\n";
    const recs: EditRecord[] = [];
    let cur = log(recs, "f.ts", base, "a\nB\nc\nd\nnew1\nnew2\n", agent(1));
    cur = log(recs, "f.ts", cur, "a\nB\nC!\nnew1\nnew2\n", human); // c 고침, d 지움
    const memos: EditMemo[] = [{ epic: "CU-1", file: "f.ts", seqs: [recs.length, recs.length], memo: "오타", member: "dh.lee", at: new Date(t).toISOString() }];
    const b = blame("f.ts", base, recs, { memos });
    expect(b.text).toBe(cur);
    expect(b.mismatches).toEqual([]);
    expect(b.lines.map((l) => (l ? `${l.kind}${l.step ?? ""}${l.memo ? "+memo" : ""}` : "base"))).toEqual(["base", "agent1", "human+memo", "agent1", "agent1", "base"]);
    // 위 마지막 "base"는 끝 줄바꿈 뒤의 빈 줄
  });

  it("upto: 그 seq까지의 상태로 계산 (서버가 공유 커밋의 seq까지)", () => {
    const recs: EditRecord[] = [];
    const v1 = log(recs, "f.ts", "x\n", "x\ny\n", agent(1));
    const upto = recs.length;
    log(recs, "f.ts", v1, "x\ny\nz\n", agent(2));
    expect(blame("f.ts", "x\n", recs, { upto }).text).toBe("x\ny\n");
  });
});

describe("줄 ↔ 오프셋", () => {
  it("양 끝 포함 줄 범위 ↔ [시작, 끝) (끝 줄의 줄바꿈 포함)", () => {
    const text = "ab\ncd\n\nef"; // 9자, 마지막 줄은 줄바꿈 없음
    expect(linesToOffsets(text, [2, 2])).toEqual([3, 6]);
    expect(linesToOffsets(text, [2, 4])).toEqual([3, 9]);
    expect(offsetsToLines(text, [3, 6])).toEqual([2, 2]);
    expect(offsetsToLines(text, [3, 5])).toEqual([2, 2]);
    expect(offsetsToLines(text, [7, 9])).toEqual([4, 4]);
  });
});

describe("편집 기록으로 쓰레드 위치 옮기기 (E5)", () => {
  const rev = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  it("큰 수정(위에 50줄, 앞 3줄 삭제) + 그 줄 자체를 고쳐도 따라간다. diff 줄 매핑은 위치 잃음", () => {
    const recs: EditRecord[] = [];
    const seq = 0;
    let cur = log(recs, "f.ts", rev, Array.from({ length: 50 }, (_, i) => `// header ${i}`).join("\n") + "\n" + rev, agent(2));
    cur = log(recs, "f.ts", cur, cur!.replace("line 5\n", "line 5 // 고침\n"), human);
    cur = log(recs, "f.ts", cur, cur!.replace("line 1\nline 2\nline 3\n", ""), agent(2));
    const m = moveLines("f.ts", rev, seq, recs, [5, 5])!;
    expect(cur!.split("\n")[m.range[0] - 1]).toBe("line 5 // 고침");
    expect(m).toMatchObject({ range: [52, 52], lost: false, touched: true });
    // 비교: diff 줄 매핑(M5)은 고친 줄을 "위치 잃음"으로 본다
    expect(mapLines(diffHunks(rev, cur!), [5, 5]).lost).toBe(true);
  });

  it("범위가 통째로 지워지면 위치 잃음, 다른 파일·rev 이전 기록은 무시, 기록이 rev와 이어지지 않으면 null", () => {
    const recs: EditRecord[] = [];
    log(recs, "other.ts", null, "zzz\n", agent(1));
    const before = recs.length;
    const cur = log(recs, "f.ts", rev, rev.replace("line 4\nline 5\nline 6\n", ""), agent(2));
    expect(moveLines("f.ts", rev, before, recs, [5, 5])).toMatchObject({ lost: true });
    expect(moveLines("f.ts", rev, before, recs, [8, 9])).toMatchObject({ range: [5, 6], lost: false, touched: false });
    expect(replay(new Map([["f.ts", rev]]), recs.filter((r) => r.file === "f.ts")).files.get("f.ts")).toBe(cur);
    expect(moveLines("f.ts", rev + "다른 내용\n", before, recs, [5, 5])).toBeNull();
  });
});

/** git diff -U0 모양의 hunk 머리만 만든다 (mapLines 입력) */
function diffHunks(a: string, b: string): string {
  const { structuredPatch } = require("diff") as typeof import("diff");
  return structuredPatch("a", "b", a, b, "", "", { context: 0 })
    .hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    .join("\n");
}

import { describe, expect, it } from "vitest";
import type { EditRecord } from "@flightdeck/schema";
import { applyTextEdits, coalesce, diffToEdits, replay, sha256, transformAnchor, transformRange } from "../src/index.ts";

const roundTrip = (a: string, b: string) => expect(applyTextEdits(a, diffToEdits(a, b))).toBe(b);

describe("diffToEdits: 변경 전후 → 편집 → 재적용 (설계 §8.6)", () => {
  it("여러 곳을 바꾸면 덩어리마다 따로 잘게 나눈다", () => {
    const before = "alpha\nbeta\nalpha\n";
    const after = "ALPHA\nbeta\nALPHA\n";
    const edits = diffToEdits(before, after);
    expect(edits).toEqual([
      { range: [0, 5], insert: "ALPHA" },
      { range: [11, 16], insert: "ALPHA" },
    ]);
    roundTrip(before, after);
  });

  it("한글·이모지·CRLF·끝 개행 없음", () => {
    roundTrip("안녕 세계 🌏\r\n둘째 줄 🍣\r\n", "안녕 world 🌏\r\n두번째 줄 🍣\r\n끝");
    roundTrip("x", "y");
    roundTrip("", "새 파일\n");
    roundTrip("지울 내용\n", "");
    roundTrip("🌏🌏", "🌏🌍");
  });

  it("서로게이트 쌍을 자르지 않는다", () => {
    for (const e of diffToEdits("a🌏b", "a🌍b")) {
      expect(e.insert).toBe("🌍");
      expect(e.range[1] - e.range[0]).toBe(2);
    }
  });

  it("무작위 변경 500건 왕복", () => {
    const alphabet = ["a", "b", "\n", "\r\n", "가", "🌏", " "];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const gen = () => Array.from({ length: rnd(40) }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let i = 0; i < 500; i++) roundTrip(gen(), gen());
  });
});

const rec = (seq: number, file: string, base: string | null, range: [number, number], insert: string, ts = "2026-10-02T10:00:00.000Z"): EditRecord => ({
  epic: "E-1",
  file,
  seq,
  base_hash: sha256(base),
  range,
  insert,
  source: { kind: "human", member: "dh.lee" },
  ts,
});

describe("replay: base_hash 순서 검증", () => {
  it("순서대로면 불일치 없음, 순서가 틀리면 잡는다", () => {
    const r1 = rec(1, "a.txt", "abc", [1, 2], "X");
    const r2 = rec(2, "a.txt", "aXc", [3, 3], "!");
    const ok = replay(new Map([["a.txt", "abc"]]), [r2, r1]); // seq로 정렬된다
    expect(ok.files.get("a.txt")).toBe("aXc!");
    expect(ok.mismatches).toEqual([]);
    const bad = replay(new Map([["a.txt", "zzz"]]), [r1]);
    expect(bad.mismatches).toHaveLength(1);
  });

  it("새 파일은 base_hash null", () => {
    const r = replay(new Map(), [rec(1, "new.txt", null, [0, 0], "hi")]);
    expect(r.files.get("new.txt")).toBe("hi");
    expect(r.mismatches).toEqual([]);
  });
});

describe("coalesce: IME 이벤트 묶음 (설계 §8.6)", () => {
  // M0 7번 수동 테스트에서 실제로 기록된 순서: 첫째 줄 끝(offset 15)에 "추가로 입력" 입력 중 조합
  const steps: [number, number, string][] = [
    [15, 15, "ㅊ"], [15, 16, "추"], [15, 16, "축"], [15, 16, "추"], [16, 16, "가"], [16, 17, "갈"], [16, 17, "가"],
    [17, 17, "로"], [17, 18, "로 "], [19, 19, "ㅇ"], [19, 20, "이"], [19, 20, "입"], [19, 20, "입"],
    [20, 20, "ㄹ"], [20, 21, "려"], [20, 21, "력"], [20, 21, "력"],
  ];
  const base = "첫째 줄\n둘째 줄\n셋째 줄\n".padEnd(15, "x").slice(0, 15) + "\n";

  it("묶은 결과의 재적용은 원래 결과와 같고 건수는 줄어든다", () => {
    let text = base;
    const records: EditRecord[] = [];
    steps.forEach(([s, e, ins], i) => {
      records.push(rec(i + 1, "ko.txt", text, [s, e], ins, new Date(Date.parse("2026-10-02T10:00:00Z") + i * 80).toISOString()));
      text = text.slice(0, s) + ins + text.slice(e);
    });
    const merged = coalesce(records);
    expect(merged.length).toBeLessThan(records.length);
    expect(merged).toHaveLength(1);
    const once = merged.reduce((t, r) => t.slice(0, r.range[0]) + r.insert + t.slice(r.range[1]), base);
    expect(once).toBe(text);
    expect(text.slice(15, 21)).toBe("추가로 입력");
  });

  it("시간 간격이 길거나 앞쪽을 지우면 묶지 않는다", () => {
    const a = rec(1, "f", "ab", [2, 2], "c", "2026-10-02T10:00:00.000Z");
    const late = rec(2, "f", "abc", [3, 3], "d", "2026-10-02T10:00:01.000Z");
    const before = rec(2, "f", "abc", [0, 1], "", "2026-10-02T10:00:00.100Z");
    expect(coalesce([a, late])).toHaveLength(2);
    expect(coalesce([a, before])).toHaveLength(2);
  });
});

describe("transformRange: 앵커 이동 (설계 §3.5)", () => {
  it("앞에서 넣으면 밀리고 뒤에서 넣으면 그대로", () => {
    expect(transformRange([10, 20], { range: [0, 0], insert: "abc" }).range).toEqual([13, 23]);
    expect(transformRange([10, 20], { range: [25, 25], insert: "abc" }).range).toEqual([10, 20]);
  });

  it("범위 시작·끝에 바로 붙여 넣은 글은 포함하지 않는다", () => {
    expect(transformRange([10, 20], { range: [10, 10], insert: "abc" }).range).toEqual([13, 23]);
    expect(transformRange([10, 20], { range: [20, 20], insert: "abc" }).range).toEqual([10, 20]);
  });

  it("안쪽 수정은 touched, 통째 삭제는 collapsed", () => {
    const inner = transformRange([10, 20], { range: [12, 15], insert: "X" });
    expect(inner).toEqual({ range: [10, 18], touched: true, collapsed: false });
    const gone = transformRange([10, 20], { range: [5, 25], insert: "" });
    expect(gone.collapsed).toBe(true);
  });

  it("편집 기록 순서열을 따라 옮긴다", () => {
    const records = [rec(5, "a", "x", [0, 0], "123"), rec(6, "b", "x", [0, 0], "zz"), rec(7, "a", "x", [100, 100], "!")];
    expect(transformAnchor({ file: "a", seq: 4, start: 10, end: 20 }, records)).toMatchObject({ start: 13, end: 23, seq: 7, touched: false });
  });
});

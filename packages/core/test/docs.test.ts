import { describe, expect, it } from "vitest";
import type { Thread } from "../src/index.ts";
import { checkParagraphIds, checkSections, ensureParagraphIds, listThreadBlocks, parseBlocks, renderThreads, stripThreads, threadIdFrom, ulid } from "../src/index.ts";

const doc = ["# 분석", "", "## 요구사항 요약", "토큰은 Redis에 저장하고", "만료 시 갱신한다.", "", "```ts", "## 코드 안 제목은 블록이 아님", "```", "", "- 목록 1", "- 목록 2", ""].join("\n");

describe("문단 ID (설계 §3.2)", () => {
  it("모든 블록에 ID를 붙이고, 다시 해도 바뀌지 않는다", () => {
    const { text, added } = ensureParagraphIds(doc);
    expect(added).toHaveLength(5); // 제목 2, 문단 1, 코드 블록 1, 목록 1
    const blocks = parseBlocks(text.split("\n"));
    expect(blocks.every((b) => b.pid)).toBe(true);
    expect(ensureParagraphIds(text)).toEqual({ text, added: [] });
  });

  it("CRLF 문서도 CRLF로 유지한다", () => {
    const { text } = ensureParagraphIds(doc.replaceAll("\n", "\r\n"));
    expect(text.split("\r\n").length).toBeGreaterThan(5);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("ID만 지우거나 바꾸면 위반, 블록을 통째로 지우면 위반 아님", () => {
    const { text } = ensureParagraphIds(doc);
    const lines = text.split("\n");
    const idLine = lines.findIndex((l) => l.startsWith("<!-- p:") && lines[lines.indexOf(l) + 1] === "토큰은 Redis에 저장하고");
    const pid = lines[idLine]!.slice(5, 11);

    const removed = lines.filter((_, i) => i !== idLine).join("\n");
    expect(checkParagraphIds(text, removed)).toEqual([expect.objectContaining({ kind: "removed", pid })]);

    const changed = lines.map((l, i) => (i === idLine ? "<!-- p:ffff -->" : l)).join("\n");
    expect(checkParagraphIds(text, changed)).toEqual([expect.objectContaining({ kind: "changed", from: pid, to: "p:ffff" })]);

    const deleted = lines.filter((_, i) => i < idLine || i > idLine + 2).join("\n");
    expect(checkParagraphIds(text, deleted)).toEqual([]);

    const dup = text + "\n<!-- " + pid + " -->\n새 문단\n";
    expect(checkParagraphIds(text, dup)).toContainEqual({ kind: "duplicate", pid });
  });
});

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t-01JB2X4K",
  phase: "ANALYSIS",
  file: "analysis.md",
  anchor: { type: "paragraph", pid: "p:a91c" },
  kind: "question",
  author: "dh.lee",
  to: ["park"],
  at: "2026-10-01T10:12:00+09:00",
  body: "TTL은 요구사항상 몇 분인가요?",
  status: "resolved",
  replies: [{ id: "x", author: "park", at: "2026-10-01T11:03:00+09:00", body: "30분, 슬라이딩 갱신입니다.", source: "human" }],
  ...over,
});

describe("쓰레드 블록 (설계 §3.2)", () => {
  const base = ["<!-- p:7f3a -->", "### 3.2 토큰 갱신", "<!-- p:a91c -->", "액세스 토큰은 Redis에 저장하고 만료 시 리프레시 토큰으로 갱신한다.", ""].join("\n");

  it("설계 문서 예시와 같은 모양으로 그린다", () => {
    const out = renderThreads(base, "analysis.md", [thread()]);
    expect(out).toContain("<!-- flightdeck:thread id=t-01JB2X4K status=resolved anchor=p:a91c -->");
    expect(out).toContain("> **❓ @dh.lee → @park** · 2026-10-01 10:12 · ✅ 해결됨");
    expect(out).toContain("> TTL은 요구사항상 몇 분인가요?\n>\n> **💬 @park** · 2026-10-01 11:03\n> 30분, 슬라이딩 갱신입니다.");
    expect(listThreadBlocks(out)).toEqual([{ id: "t-01JB2X4K", status: "resolved", anchor: "p:a91c", line: 5 }]);
  });

  it("지우면 원래 문서, 다시 그려도 같은 결과 (멱등)", () => {
    const once = renderThreads(base, "analysis.md", [thread()]);
    expect(stripThreads(once)).toBe(base);
    expect(renderThreads(once, "analysis.md", [thread()])).toBe(once);
  });

  it("문서를 직접 고쳐 쓰레드 블록을 바꿔도 다시 그리면 원래대로", () => {
    const once = renderThreads(base, "analysis.md", [thread()]);
    const tampered = once.replace("30분, 슬라이딩", "60분, 고정");
    expect(renderThreads(tampered, "analysis.md", [thread()])).toBe(once);
  });

  it("앵커 문단이 없으면 문서 끝 '위치를 잃은 쓰레드'로", () => {
    const orphan = thread({ anchor: { type: "paragraph", pid: "p:dead" } });
    const out = renderThreads(base, "analysis.md", [orphan]);
    expect(out).toContain("## 위치를 잃은 쓰레드");
    expect(stripThreads(out)).toBe(base);
    expect(renderThreads(out, "analysis.md", [orphan])).toBe(out);
  });

  it("다른 파일의 쓰레드는 그리지 않는다", () => {
    expect(renderThreads(base, "design.md", [thread()])).toBe(base);
  });
});

describe("산출물 섹션 검사 (설계 §6.3)", () => {
  const required = ["요구사항 요약", "영향 범위", "불명확한 점", "가정"];
  it("모두 있으면 통과", () => {
    const md = required.map((s) => `<!-- p:0000 -->\n## ${s}\n내용`).join("\n\n");
    expect(checkSections(md, required).ok).toBe(true);
  });
  it("빠짐·순서·빈 섹션을 잡는다", () => {
    const md = "## 영향 범위\n내용\n## 요구사항 요약\n<!-- p:1234 -->\n## 가정\n";
    const r = checkSections(md, required);
    expect(r).toMatchObject({ ok: false, missing: ["불명확한 점"], outOfOrder: true, empty: ["요구사항 요약", "가정"] });
  });
});

describe("ULID·쓰레드 ID", () => {
  it("형식과 단조 증가", () => {
    const ids = Array.from({ length: 50 }, () => ulid(1_790_000_000_000));
    expect(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it("설계의 t-<ULID 앞 8자>는 약 1초 안에 만든 쓰레드끼리 겹친다 (설계 제안 대상)", () => {
    const a = threadIdFrom(ulid(1_790_000_000_000));
    const b = threadIdFrom(ulid(1_790_000_000_500));
    expect(a).toBe(b);
  });
});

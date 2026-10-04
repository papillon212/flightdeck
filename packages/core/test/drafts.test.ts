// 쓰레드 초안 블록 (설계 §3.2 v0.13, m3-plan W8)
import { describe, expect, it } from "vitest";
import { checkSections, ensureParagraphIds, insertDrafts, parseBlocks, parseDrafts, removeDrafts, renderThreads, draftText, type Thread } from "../src/index.ts";

const DOC = [
  "<!-- p:1111 -->",
  "## 개요",
  "<!-- p:2222 -->",
  "리프레시 토큰을 회전시킨다.",
  "",
  "<!-- flightdeck:draft kind=question to=dh.lee,@park -->",
  "재사용 탐지 시 모든 세션을 끊는 근거는?",
  "<!-- /flightdeck:draft -->",
  "",
  "<!-- p:3333 -->",
  "## 리스크",
  "<!-- p:4444 -->",
  "재사용 탐지",
  "",
].join("\n");

describe("쓰레드 초안 블록", () => {
  it("새 쓰레드 초안: 종류·대상·본문, 앵커는 바로 위 블록의 문단 ID", () => {
    const [d] = parseDrafts(DOC);
    expect(d).toMatchObject({ kind: "question", to: ["dh.lee", "park"], body: "재사용 탐지 시 모든 세션을 끊는 근거는?", anchor: "p:2222", start: 5, end: 7 });
    expect(d!.error).toBeUndefined();
    expect(d!.key).toMatch(/^[0-9a-f]{12}$/);
  });

  it("초안은 문서 내용이 아니다: 문단 ID를 붙이지 않고, 섹션 내용으로 세지 않는다", () => {
    expect(parseBlocks(DOC.split("\n")).map((b) => b.pid)).toEqual(["p:1111", "p:2222", "p:3333", "p:4444"]);
    expect(ensureParagraphIds(DOC).added).toEqual([]);
    const onlyDraft = "## 개요\n<!-- flightdeck:draft kind=note -->\n메모\n<!-- /flightdeck:draft -->\n";
    expect(checkSections(onlyDraft, ["개요"]).empty).toEqual(["개요"]);
  });

  it("답글 초안과 형식 오류", () => {
    const md = [
      "<!-- p:1111 -->",
      "문단",
      "<!-- flightdeck:draft reply=t-01JB2X4K -->",
      "30분입니다.",
      "<!-- /flightdeck:draft -->",
      "<!-- flightdeck:draft kind=praise -->",
      "좋아요",
      "<!-- /flightdeck:draft -->",
      "<!-- flightdeck:draft kind=note -->",
      "<!-- /flightdeck:draft -->",
      "<!-- flightdeck:draft reply=t-01JB2X4K kind=note -->",
      "x",
      "<!-- /flightdeck:draft -->",
      "<!-- flightdeck:draft kind=note -->",
      "닫지 않음",
    ].join("\n");
    expect(parseDrafts(md).map((d) => d.error ?? `ok reply=${d.reply}`)).toEqual([
      "ok reply=t-01JB2X4K",
      "kind는 question|change_request|note 중 하나",
      "본문이 비어 있음",
      "reply와 kind를 함께 쓸 수 없음",
      "닫는 <!-- /flightdeck:draft --> 가 없음",
    ]);
    expect(parseDrafts("<!-- flightdeck:draft kind=note -->\n앵커 없음\n<!-- /flightdeck:draft -->\n")[0]!.error).toBe("초안 위에 문단 ID가 있는 블록이 없음");
  });

  it("올린 초안 지우기: 그 초안만, 뒤의 빈 줄까지", () => {
    const [d] = parseDrafts(DOC);
    const out = removeDrafts(DOC, [d!.key]);
    expect(out).toBe(DOC.replace("<!-- flightdeck:draft kind=question to=dh.lee,@park -->\n재사용 탐지 시 모든 세션을 끊는 근거는?\n<!-- /flightdeck:draft -->\n\n", ""));
    expect(removeDrafts(DOC, ["000000000000"])).toBe(DOC);
  });

  it("쓰레드 렌더링은 초안을 건드리지 않는다", () => {
    const t: Thread = { id: "t-01JB2X4K", phase: "DESIGN", file: "design.md", anchor: { type: "paragraph", pid: "p:2222" }, kind: "question", author: "dh.lee", to: ["park"], at: "2026-10-04T10:00:00+09:00", body: "TTL?", status: "open", replies: [], applied: [] };
    const out = renderThreads(DOC, "design.md", [t]);
    expect(parseDrafts(out).map((d) => d.body)).toEqual(["재사용 탐지 시 모든 세션을 끊는 근거는?"]);
    expect(parseDrafts(out)[0]!.anchor).toBe("p:2222"); // 쓰레드 블록이 사이에 들어와도 앵커는 그대로
  });

  it("읽기 전용 창: 공유 커밋 내용 위에 초안만 다시 끼운다 (다른 변경은 버림)", () => {
    const base = DOC.replace(/<!-- flightdeck:draft[\s\S]*?\/flightdeck:draft -->\n\n/, "");
    const tampered = DOC.replace("리프레시 토큰을 회전시킨다.", "에이전트가 고친 문장");
    const drafts = parseDrafts(tampered).map((d) => ({ draft: d, text: draftText(tampered, d) }));
    const out = insertDrafts(base, drafts);
    expect(out).not.toContain("에이전트가 고친 문장");
    expect(out).toContain("리프레시 토큰을 회전시킨다.\n\n<!-- flightdeck:draft kind=question");
    expect(parseDrafts(out)[0]).toMatchObject({ anchor: "p:2222", body: "재사용 탐지 시 모든 세션을 끊는 근거는?" });
    // 앵커를 못 찾으면 문서 끝
    const lost = insertDrafts(base, [{ draft: { ...drafts[0]!.draft, anchor: "p:dead" }, text: drafts[0]!.text }]);
    expect(lost.trimEnd().endsWith("<!-- /flightdeck:draft -->")).toBe(true);
  });
});

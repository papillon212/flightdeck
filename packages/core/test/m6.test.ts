// M6 core: 회의 이벤트·권한, 앵커링 출력 읽기, 검토 초안 (설계 §10, m6-plan G1·G3·G4)
import { describe, expect, it } from "vitest";
import { DEV_TRUST, Event as EventSchema, type Event } from "@flightdeck/schema";
import { anchoringPrompt, parseAnchoring, parseSessionDraft, reduce, renderSessionDraft, renderSessionSummary, ulid } from "../src/index.ts";

let t = 1_790_000_000_000;
const ev = (type: Event["type"], author: string, data: unknown): Event => {
  t += 1000;
  return EventSchema.parse({ v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data }) as Event;
};
const SID = "s-0000AAAA";
const started = () => ev("epic.started", "dh.lee", { tracker_ref: "1", owner: "dh.lee", base_sha: "a".repeat(40), config_version: "v1" });
const question = () => ev("thread.created", "dh.lee", { thread: "t-0000QQQQ", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:0001" }, kind: "question", to: ["park"], body: "TTL은?" });

describe("회의 이벤트 (§10.1)", () => {
  it("시작·포커스·끝·게시: 주최자만 끝내고 게시한다. 포커스는 멤버마다 한 번", () => {
    const s = reduce("CU-1", [
      started(),
      question(),
      ev("session.started", "choi", { sid: SID, title: "TTL 논의", space: { name: "spaces/x", uri: "https://meet.google.com/abc-defg-hij" } }),
      ev("session.focus", "park", { sid: SID, entries: [{ ts: "2026-10-05T10:00:00+09:00", file: "analysis.md", range: [3, 5] }] }),
      ev("session.focus", "park", { sid: SID, entries: [] }),
      ev("session.ended", "park", { sid: SID }),
      ev("session.published", "choi", { sid: SID, items: 1, summary: "x" }), // 끝나기 전
      ev("session.ended", "choi", { sid: SID }),
      ev("thread.replied", "park", { thread: "t-0000QQQQ", body: "요약", source: "session", sid: SID }), // 주최자 아님
      ev("thread.replied", "choi", { thread: "t-0000QQQQ", body: "30분으로 결정", source: "session", sid: SID }), // 참여자가 아니어도 주최자는
      ev("thread.created", "choi", { thread: "t-0000NNNN", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:0002" }, kind: "note", to: [], body: "회의 메모", source: "session", sid: SID }),
      ev("thread.created", "choi", { thread: "t-0000MMMM", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:0002" }, kind: "note", to: [], body: "회의 아님" }),
      ev("session.published", "choi", { sid: SID, items: 2, summary: "# 회의" }),
    ], DEV_TRUST);
    expect(s.ignored.map((i) => i.reason)).toEqual(["이미 올린 포커스", "주최자만 회의를 끝낼 수 있음", "끝나지 않은 회의", "회의 주최자만 회의 요약을 게시할 수 있음", "쓰레드 생성 권한 없음"]);
    const ss = s.sessions.get(SID)!;
    expect([ss.host, !!ss.ended_at, ss.focus.length, ss.published?.items]).toEqual(["choi", true, 1, 2]);
    expect(s.threads.get("t-0000QQQQ")!.replies.map((r) => `${r.author}:${r.source}`)).toEqual(["choi:session"]);
    expect(s.threads.has("t-0000NNNN")).toBe(true);
  });
});

describe("앵커링 (§10.1 ⑥, §10.2)", () => {
  it("지시문에 쓰레드·포커스·회의록·전사가 들어가고, 출력에서 JSON 배열을 읽는다. 없는 쓰레드는 에픽으로", () => {
    const p = anchoringPrompt({ epic: "CU-1", title: "TTL", notes: "TTL은 30분으로 정함", transcript: [{ participant: "park", startTime: "10:01", text: "30분이 좋겠습니다" }], focus: [{ member: "park", ts: "10:01", file: "analysis.md", range: [3, 3] }], threads: [{ id: "t-0000QQQQ", file: "analysis.md", where: "p:0001", status: "open", body: "TTL은?" }] });
    expect(p).toContain("t-0000QQQQ");
    expect(p).toContain("@park analysis.md:3-3");
    expect(p).toContain("30분이 좋겠습니다");
    const out = parseAnchoring(
      '요약입니다.\n[{"target":{"thread":"t-0000QQQQ"},"summary":"TTL 30분","decisions":["30분"],"actions":[]},{"target":{"thread":"t-NOPENOPE"},"summary":"없는 쓰레드"},{"target":{"file":"src/a.js","lines":[2,4]},"summary":"코드"},{"bad":1}]',
      new Set(["t-0000QQQQ"]),
    );
    expect(out.map((i) => JSON.stringify(i.target))).toEqual(['{"thread":"t-0000QQQQ"}', '{"epic":true}', '{"file":"src/a.js","lines":[2,4]}']);
    expect(parseAnchoring("JSON 없음", new Set())).toEqual([]);
  });

  it("검토 초안: 그린 대로 다시 읽고, 고친 문장·지운 블록·바꾼 target이 반영된다 (G3)", () => {
    const items = parseAnchoring('[{"target":{"thread":"t-0000QQQQ"},"summary":"TTL 30분","decisions":["30분"],"actions":["설계에 반영"]},{"target":{"epic":true},"summary":"다음 회의 금요일"}]', new Set(["t-0000QQQQ"]));
    const md = renderSessionDraft(SID, "TTL 논의", items, "https://docs.google.com/x");
    expect(parseSessionDraft(md).items).toEqual(items);
    const edited = md.replace("TTL 30분", "TTL은 30분, 슬라이딩").replace(/<!-- flightdeck:session-item target=epic -->[\s\S]*?<!-- \/flightdeck:session-item -->/, "").replace("target=thread:t-0000QQQQ", "target=file:src/a.js#L2-3");
    const r = parseSessionDraft(edited);
    expect(r.items).toEqual([{ target: { file: "src/a.js", lines: [2, 3] }, summary: "TTL은 30분, 슬라이딩", decisions: ["30분"], actions: ["설계에 반영"] }]);
    expect(parseSessionDraft(md.replace("target=epic", "target=어딘가")).problems).toEqual(["target을 읽을 수 없다: 어딘가"]);
    expect(renderSessionSummary({ sid: SID, title: "TTL 논의", host: "choi", started_at: "a", items })).toContain("## 에픽 전체\n다음 회의 금요일");
  });
});

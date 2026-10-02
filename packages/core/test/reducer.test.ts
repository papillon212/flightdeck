import { describe, expect, it } from "vitest";
import type { Event } from "@flightdeck/schema";
import { Event as EventSchema } from "@flightdeck/schema";
import { myOpenThreads, reduce, ulid } from "../src/index.ts";

let t = 1_790_000_000_000;
function ev(type: Event["type"], author: string, data: unknown): Event {
  t += 2000; // 이벤트마다 2초 간격 (ULID 순서 = 발생 순서)
  return EventSchema.parse({ v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data }) as Event;
}
const SHA = "a".repeat(40);
const started = () => ev("epic.started", "dh.lee", { tracker_ref: "CU-1", owner: "dh.lee", base_sha: SHA, config_version: "cfg1" });
const question = (id: string, author = "dh.lee") =>
  ev("thread.created", author, { thread: id, phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:a91c" }, kind: "question", to: ["park"], body: "TTL?" });

describe("reducer (설계 §4)", () => {
  it("epic.started → ANALYSIS", () => {
    const s = reduce("CU-1", [started()]);
    expect(s.phase).toBe("ANALYSIS");
    expect(s.owner).toBe("dh.lee");
  });

  it("열린 쓰레드가 있으면 분석 완료가 무시되고, 해결 후에는 DESIGN으로", () => {
    const events = [started(), question("t-AAAAAAAA"), ev("phase.completed", "dh.lee", { phase: "ANALYSIS" })];
    let s = reduce("CU-1", events);
    expect(s.phase).toBe("ANALYSIS");
    expect(s.ignored.at(-1)?.reason).toBe("열린 쓰레드 1개");

    events.push(
      ev("thread.replied", "park", { thread: "t-AAAAAAAA", body: "30분", source: "human" }),
      ev("thread.resolved", "dh.lee", { thread: "t-AAAAAAAA" }),
      ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }),
    );
    s = reduce("CU-1", events);
    expect(s.phase).toBe("DESIGN");
    expect(s.threads.get("t-AAAAAAAA")?.replies.map((r) => r.body)).toEqual(["30분"]);
    expect(s.history.map((h) => `${h.from}→${h.to}`)).toEqual(["INTAKE→ANALYSIS", "ANALYSIS→DESIGN"]);
  });

  it("권한 없는 이벤트는 무시한다 (§3.4)", () => {
    const s = reduce("CU-1", [
      started(),
      question("t-AAAAAAAA"),
      question("t-BBBBBBBB", "park"), // 멘션된 사람이라도 쓰레드 생성은 담당자만 (M3에서 티어 리뷰어 추가)
      ev("thread.replied", "choi", { thread: "t-AAAAAAAA", body: "끼어들기", source: "human" }), // 참여자 아님
      ev("thread.resolved", "park", { thread: "t-AAAAAAAA" }), // 생성자·담당자 아님
      ev("phase.completed", "park", { phase: "ANALYSIS" }), // 담당자 아님
    ]);
    expect(s.ignored.map((i) => i.reason)).toEqual(["쓰레드 생성 권한 없음", "답글 권한 없음", "resolve/reopen 권한 없음", "담당자만 단계를 완료할 수 있음"]);
    expect(s.threads.get("t-AAAAAAAA")?.status).toBe("open");
  });

  it("이벤트 도착 순서와 무관하게 ULID 순서로 계산한다", () => {
    const events = [started(), question("t-AAAAAAAA"), ev("thread.resolved", "dh.lee", { thread: "t-AAAAAAAA" }), ev("phase.completed", "dh.lee", { phase: "ANALYSIS" })];
    expect(reduce("CU-1", [...events].reverse()).phase).toBe("DESIGN");
  });

  it("DESIGN → ANALYSIS 되돌림 (§4.3)", () => {
    const s = reduce("CU-1", [
      started(),
      ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }),
      ev("phase.reverted", "dh.lee", { from: "DESIGN", to: "ANALYSIS", reason: "분석 누락" }),
    ]);
    expect(s.phase).toBe("ANALYSIS");
  });

  it("내 할 일: 나에게 온 질문 중 내가 아직 답하지 않은 것", () => {
    const s = reduce("CU-1", [started(), question("t-AAAAAAAA"), question("t-BBBBBBBB")]);
    expect(myOpenThreads(s, "park").map((x) => x.id)).toEqual(["t-AAAAAAAA", "t-BBBBBBBB"]);
    const s2 = reduce("CU-1", [started(), question("t-AAAAAAAA"), ev("thread.replied", "park", { thread: "t-AAAAAAAA", body: "답", source: "human" })]);
    expect(myOpenThreads(s2, "park")).toEqual([]);
    expect(myOpenThreads(s2, "dh.lee").map((x) => x.id)).toEqual(["t-AAAAAAAA"]);
  });
});

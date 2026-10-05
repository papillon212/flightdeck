import { describe, expect, it } from "vitest";
import type { Event, Trust } from "@flightdeck/schema";
import { DEV_TRUST, Event as EventSchema } from "@flightdeck/schema";
import { canonicalJson, generateServerKey, keyFingerprint, myOpenThreads, reduce as coreReduce, signEvent, ulid, verifyEvent } from "../src/index.ts";

// 권한·관문 규칙 테스트는 개발 모드(서명을 보지 않음)로 돌린다. 서명 규칙은 아래 "서버 서명"에서
const reduce = (epic: string, events: Event[]) => coreReduce(epic, events, DEV_TRUST);

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
    expect(s.ignored.map((i) => i.reason)).toEqual(["쓰레드 생성 권한 없음", "답글 권한 없음", "resolve/reopen 권한 없음", "조종수만 단계를 완료할 수 있음"]);
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

describe("정규화 JSON (RFC 8785)", () => {
  it("키 정렬, 공백 없음, undefined 필드 제외, 문자열·숫자는 JSON.stringify 그대로", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1.5, y: undefined, "é": " " } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"z":1.5,"é":" "}}');
    // 키 순서가 달라도 같은 결과
    expect(canonicalJson({ x: 1, y: { q: 2, p: 1 } })).toBe(canonicalJson({ y: { p: 1, q: 2 }, x: 1 }));
    // RFC 8785 부록의 숫자 예
    expect(canonicalJson([1e21, 1e-7, -0, 333333333.3333333])).toBe("[1e+21,1e-7,0,333333333.3333333]");
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe("서버 서명 (설계 §3.1, §12)", () => {
  const server = generateServerKey();
  const other = generateServerKey();
  const trust: Trust = { mode: "server", serverKey: server.publicKey, deactivated: {} };
  const signed = (e: Event, key = server.privateKeyPem) => signEvent(e, key);

  it("서명·검증, 지문 모양", () => {
    const e = signed(started());
    expect(e.sig).toMatch(/^ed25519:[A-Za-z0-9+/]{86}==$/);
    expect(verifyEvent(e, server.publicKey)).toBe(true);
    expect(verifyEvent(e, other.publicKey)).toBe(false);
    expect(keyFingerprint(server.publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // 파일에 쓰고 읽어 키 순서가 바뀌어도 검증된다
    const reordered = JSON.parse(JSON.stringify({ sig: e.sig, data: e.data, at: e.at, author: e.author, epic: e.epic, type: e.type, id: e.id, v: e.v }));
    expect(verifyEvent(EventSchema.parse(reordered) as Event, server.publicKey)).toBe(true);
  });

  it("서버 서명 이벤트: 서명이 없거나, 틀리거나, 다른 키거나, 서명 뒤 바뀌면 무시", () => {
    const start = signed(started());
    const tampered = { ...signed(ev("phase.completed", "dh.lee", { phase: "ANALYSIS" })) };
    tampered.data = { ...tampered.data, artifact_hash: "sha256:bad" } as never;
    const s = coreReduce("CU-1", [
      start,
      ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }), // 서명 없음: 확장이 직접 쓴 단계 완료
      signed(ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }), other.privateKeyPem), // 다른 키
      tampered, // 서명 뒤 필드 하나 변경
    ], trust);
    expect(s.phase).toBe("ANALYSIS");
    expect(s.ignored.map((i) => i.reason).sort()).toEqual(["서버 서명 없음", "서버 서명이 맞지 않음", "서버 서명이 맞지 않음"]);
    expect(s.ignored.find((i) => i.event === tampered.id)?.reason).toBe("서버 서명이 맞지 않음");
  });

  it("서명 없는 epic.started는 무시되어 그 뒤 일반 이벤트도 효력이 없다 (에픽 위조 불가)", () => {
    const s = coreReduce("CU-1", [started(), question("t-AAAAAAAA")], trust);
    expect(s.owner).toBeNull();
    expect(s.ignored.map((i) => i.reason)).toEqual(["서버 서명 없음", "epic.started 이전 이벤트"]);
  });

  it("일반 이벤트는 서명 없이 받아들이고, 서명된 단계 완료로 단계가 넘어간다", () => {
    const s = coreReduce("CU-1", [
      signed(started()),
      question("t-AAAAAAAA"),
      ev("thread.replied", "park", { thread: "t-AAAAAAAA", body: "30분", source: "human" }),
      ev("thread.resolved", "dh.lee", { thread: "t-AAAAAAAA" }),
      signed(ev("phase.completed", "dh.lee", { phase: "ANALYSIS", artifact_hash: "sha256:abc" })),
    ], trust);
    expect(s.ignored).toEqual([]);
    expect(s.phase).toBe("DESIGN");
  });

  it("서명이 맞아도 권한·관문은 그대로 본다 (서명은 조건을 대신하지 않는다)", () => {
    const s = coreReduce("CU-1", [signed(started()), question("t-AAAAAAAA"), signed(ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }))], trust);
    expect(s.ignored.map((i) => i.reason)).toEqual(["열린 쓰레드 1개"]);
  });

  it("비활성 멤버: 비활성 시각 이후의 일반 이벤트만 무시", () => {
    const start = signed(started()); // ev()는 만든 순서대로 ULID가 커진다
    const before = ev("thread.created", "dh.lee", { thread: "t-AAAAAAAA", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:a91c" }, kind: "question", to: ["park"], body: "TTL?" });
    const replyBefore = ev("thread.replied", "park", { thread: "t-AAAAAAAA", body: "전", source: "human" });
    const replyAfter = ev("thread.replied", "park", { thread: "t-AAAAAAAA", body: "후", source: "human" });
    const off: Trust = { mode: "server", serverKey: server.publicKey, deactivated: { park: replyAfter.at } };
    const s = coreReduce("CU-1", [start, before, replyBefore, replyAfter], off);
    expect(s.threads.get("t-AAAAAAAA")?.replies.map((r) => r.body)).toEqual(["전"]);
    expect(s.ignored.map((i) => i.reason)).toEqual(["비활성 멤버의 이벤트"]);
  });
});

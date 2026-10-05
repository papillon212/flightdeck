// M8 core: 조종수 (설계 §8.2·§8.5, m8-plan L2·L3)
import { describe, expect, it } from "vitest";
import { DEV_TRUST, Event as EventSchema, type Event } from "@flightdeck/schema";
import { reduce, ulid, writerOf } from "../src/index.ts";

let t = 1_790_000_000_000;
const ev = (type: Event["type"], author: string, data: unknown): Event => {
  t += 1000;
  return EventSchema.parse({ v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data }) as Event;
};
const started = () => ev("epic.started", "dh.lee", { tracker_ref: "1", owner: "dh.lee", base_sha: "a".repeat(40), config_version: "v1" });
const pilot = (author: string, from: string, to: string, reason: "handoff" | "request" | "takeover") => ev("pilot.changed", author, { from, to, reason, ckpt: "c".repeat(40) });
const run = (events: Event[]) => reduce("CU-1", events, DEV_TRUST);

describe("조종수 (L2)", () => {
  it("처음 조종수는 담당자, 넘기기·요청 수락은 현재 조종수가, 강제 인수는 담당자가", () => {
    const s = run([
      started(),
      pilot("park", "dh.lee", "park", "request"), // 조종수가 아닌 사람이 씀
      pilot("dh.lee", "park", "choi", "handoff"), // from이 현재 조종수가 아님
      pilot("dh.lee", "dh.lee", "park", "request"), // 수락
      pilot("dh.lee", "park", "choi", "handoff"), // 이제 dh.lee는 조종수가 아님
      pilot("park", "park", "choi", "handoff"),
      pilot("park", "choi", "park", "takeover"), // 강제 인수는 담당자만
      pilot("dh.lee", "choi", "dh.lee", "takeover"),
    ]);
    expect(s.ignored.map((i) => i.reason)).toEqual([
      "현재 조종수만 조종을 넘길 수 있음",
      "현재 조종수(@dh.lee)가 아님",
      "현재 조종수만 조종을 넘길 수 있음",
      "담당자만 강제 인수할 수 있음",
    ]);
    expect(s.pilotHistory.map((h) => `${h.from}→${h.to}:${h.reason}`)).toEqual(["dh.lee→park:request", "park→choi:handoff", "choi→dh.lee:takeover"]);
    expect([s.pilot, s.owner, writerOf(s)]).toEqual(["dh.lee", "dh.lee", "dh.lee"]);
  });

  it("작업 결과(단계 완료)는 조종수가 낸다. 넘긴 뒤 담당자는 못 낸다 (L3)", () => {
    const s = run([started(), pilot("dh.lee", "dh.lee", "park", "request"), ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }), ev("phase.completed", "park", { phase: "ANALYSIS" })]);
    expect(s.ignored.map((i) => i.reason)).toEqual(["조종수만 단계를 완료할 수 있음"]);
    expect([s.phase, writerOf(s), s.owner]).toEqual(["DESIGN", "park", "dh.lee"]);
  });
});

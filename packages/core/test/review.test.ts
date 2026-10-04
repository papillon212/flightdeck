// 티어 리뷰 (설계 §4.2 v0.13, docs/m3-plan.md W1~W6)
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_TRUST, Event as EventSchema, parsePipeline, type Event, type Pipeline } from "@flightdeck/schema";
import { reduce, reviewOf, ulid } from "../src/index.ts";

const SAMPLE = parsePipeline(readFileSync(path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample/pipeline.yaml"), "utf8"));
const SHA = "a".repeat(40);
const H1 = "sha256:1111";
const H2 = "sha256:2222";

/** 그룹·재승인을 바꾼 파이프라인 */
function pipeline(groups: Record<string, string[]>, opts: { reapproval?: "on_change" | "never"; min?: number } = {}): Pipeline {
  const p = structuredClone(SAMPLE);
  p.members.groups = groups;
  p.phases.design.review.reapproval = opts.reapproval ?? "on_change";
  if (opts.min) p.phases.design.review.tiers[1]!.min_approvals = opts.min;
  return p;
}

let t = 1_790_000_000_000;
function ev(type: Event["type"], author: string, data: unknown): Event {
  t += 2000;
  return EventSchema.parse({ v: 1, id: ulid(t), type, epic: "CU-1", author, at: new Date(t).toISOString(), data }) as Event;
}
/** ANALYSIS를 끝내 DESIGN에 들어간 에픽 */
const toDesign = () => [
  ev("epic.started", "dh.lee", { tracker_ref: "CU-1", owner: "dh.lee", base_sha: SHA, config_version: "v1" }),
  ev("phase.completed", "dh.lee", { phase: "ANALYSIS" }),
];
const request = (hash = H1) => ev("review.requested", "dh.lee", { phase: "DESIGN", artifact_hash: hash, commit: SHA });
const approve = (who: string, tier: string, hash = H1) => ev("review.approved", who, { phase: "DESIGN", tier, artifact_hash: hash });
const thread = (who: string, id: string, to: string[] = ["dh.lee"]) =>
  ev("thread.created", who, { thread: id, phase: "DESIGN", file: "design.md", anchor: { type: "paragraph", pid: "p:a91c" }, kind: "change_request", to, body: "고쳐 주세요" });
const resolve = (who: string, id: string) => ev("thread.resolved", who, { thread: id });

const run = (p: Pipeline, events: Event[]) => reduce("CU-1", events, DEV_TRUST, { pipelines: new Map([["v1", p]]) });
const reasons = (s: ReturnType<typeof run>) => s.ignored.map((i) => i.reason);
const GROUPS = { leads: ["park"], architects: ["choi"] };

describe("티어 리뷰 (§4.2)", () => {
  it("리뷰 요청 → lead 승인 → architect 승인 → IMPLEMENTATION (자동 전환)", () => {
    const s = run(pipeline(GROUPS), [...toDesign(), request(), approve("park", "lead"), approve("choi", "architect")]);
    expect(s.ignored).toEqual([]);
    expect(s.phase).toBe("IMPLEMENTATION");
    expect(s.history.map((h) => h.to)).toEqual(["ANALYSIS", "DESIGN", "IMPLEMENTATION"]);
  });

  it("진행 상황: 현재 티어와 티어별 승인자", () => {
    const s = run(pipeline(GROUPS), [...toDesign(), request(), approve("park", "lead")]);
    const p = reviewOf(s)!;
    expect(p.current?.name).toBe("architect");
    expect(p.tiers.map((x) => [x.name, x.approvedBy, x.done])).toEqual([["lead", ["park"], true], ["architect", [], false]]);
  });

  it("무시: 요청 전, 차례가 아닌 티어, 티어 리뷰어가 아님, 요청과 다른 해시, 중복 승인, DESIGN의 phase.completed", () => {
    const s = run(pipeline(GROUPS), [
      ...toDesign(),
      approve("park", "lead"), // 요청 전
      request(),
      approve("choi", "architect"), // lead 차례
      approve("choi", "lead"), // lead 리뷰어 아님
      approve("park", "lead", H2), // 해시 다름
      approve("park", "lead"),
      approve("park", "lead"), // 이미 끝난 티어
      ev("phase.completed", "dh.lee", { phase: "DESIGN" }),
    ]);
    expect(reasons(s)).toEqual([
      "리뷰 요청 전",
      "현재 차례의 티어가 아님 (현재: lead)",
      "lead 티어 리뷰어가 아님",
      "리뷰 요청된 문서와 해시가 다름",
      "현재 차례의 티어가 아님 (현재: architect)",
      "DESIGN는 단계 완료가 아니라 티어 리뷰로 넘어간다 (§4.2)",
    ]);
    expect(s.phase).toBe("DESIGN");
  });

  it("on_change: 다시 요청해 해시가 바뀌면 이전 승인은 무효, 첫 티어부터 다시", () => {
    const base = [...toDesign(), request(H1), approve("park", "lead", H1), request(H2)];
    expect(reviewOf(run(pipeline(GROUPS), base))!.current?.name).toBe("lead");
    const s = run(pipeline(GROUPS), [...base, approve("choi", "architect", H2), approve("park", "lead", H2), approve("choi", "architect", H2)]);
    expect(reasons(s)).toEqual(["현재 차례의 티어가 아님 (현재: lead)"]);
    expect(s.phase).toBe("IMPLEMENTATION");
  });

  it("never: 다시 요청해도 이전 승인을 유지한다", () => {
    const s = run(pipeline(GROUPS, { reapproval: "never" }), [...toDesign(), request(H1), approve("park", "lead", H1), request(H2), approve("choi", "architect", H2)]);
    expect(s.ignored).toEqual([]);
    expect(s.phase).toBe("IMPLEMENTATION");
  });

  it("리뷰어가 없는 티어는 건너뛴다 (설정)", () => {
    const p = pipeline({ architects: ["choi"] }); // leads 그룹 없음
    expect(reviewOf(run(p, [...toDesign(), request()]))!.current?.name).toBe("architect");
    const s = run(p, [...toDesign(), request(), approve("choi", "architect")]);
    expect(s.phase).toBe("IMPLEMENTATION");
    // 모든 티어에 리뷰어가 없으면 요청만으로 넘어간다
    expect(run(pipeline({}), [...toDesign(), request()]).phase).toBe("IMPLEMENTATION");
  });

  it("min_approvals 2", () => {
    const p = pipeline({ leads: ["park"], architects: ["choi", "lee"] }, { min: 2 });
    const one = run(p, [...toDesign(), request(), approve("park", "lead"), approve("choi", "architect")]);
    expect(one.phase).toBe("DESIGN");
    expect(run(p, [...toDesign(), request(), approve("park", "lead"), approve("choi", "architect"), approve("lee", "architect")]).phase).toBe("IMPLEMENTATION");
  });

  it("W3: 담당자가 유일한 리뷰어인 티어까지는 스스로 승인, 그 뒤 티어는 다른 사람", () => {
    const p = pipeline({ leads: ["dh.lee"], architects: ["choi"] });
    const s = run(p, [...toDesign(), request(), approve("dh.lee", "lead"), approve("dh.lee", "architect"), approve("choi", "architect")]);
    expect(reasons(s)).toEqual(["담당자 자신의 승인은 담당자가 유일한 리뷰어인 티어까지만"]);
    expect(s.phase).toBe("IMPLEMENTATION");
    // 담당자가 architect의 유일한 리뷰어면 앞 티어(lead)까지 스스로 승인할 수 있다
    expect(run(pipeline({ leads: ["park"], architects: ["dh.lee"] }), [...toDesign(), request(), approve("dh.lee", "lead"), approve("dh.lee", "architect")]).phase).toBe("IMPLEMENTATION");
    // 다른 리뷰어와 같이 있는 티어는 스스로 승인할 수 없다
    const shared = run(pipeline({ leads: ["dh.lee", "park"], architects: ["choi"] }), [...toDesign(), request(), approve("dh.lee", "lead")]);
    expect(reasons(shared)).toEqual(["담당자 자신의 승인은 담당자가 유일한 리뷰어인 티어까지만"]);
  });

  it("W3: 담당자가 아닌 한 사람의 승인은 한 티어에만 센다", () => {
    const p = pipeline({ leads: ["park"], architects: ["park", "choi"] });
    const s = run(p, [...toDesign(), request(), approve("park", "lead"), approve("park", "architect")]);
    expect(reasons(s)).toEqual(["이미 다른 티어를 승인함 (한 사람의 승인은 한 티어에만)"]);
    expect(s.phase).toBe("DESIGN");
  });

  it("W6: 승인자 본인이 연 쓰레드가 열려 있으면 거부, 마지막 승인 때는 모든 쓰레드가 닫혀 있어야 한다", () => {
    const p = pipeline(GROUPS);
    const events = [...toDesign(), request(), approve("park", "lead"), thread("choi", "t-AAAAAAAA"), approve("choi", "architect")];
    expect(reasons(run(p, events))).toEqual(["승인자가 연 열린 쓰레드 1개 (먼저 해결)"]);
    // 담당자가 연 쓰레드가 남아 있어도 마지막 승인은 거부
    const s = run(p, [...events, resolve("choi", "t-AAAAAAAA"), thread("dh.lee", "t-BBBBBBBB", ["choi"]), approve("choi", "architect")]);
    expect(reasons(s).at(-1)).toBe("열린 쓰레드 1개 (마지막 승인 전에 해결)");
    expect(run(p, [...events, resolve("choi", "t-AAAAAAAA"), approve("choi", "architect")]).phase).toBe("IMPLEMENTATION");
  });

  it("쓰레드 생성 권한: 담당자 + 리뷰 요청 이후의 현재 티어 리뷰어", () => {
    const p = pipeline(GROUPS);
    const s = run(p, [...toDesign(), thread("park", "t-AAAAAAAA"), request(), thread("choi", "t-BBBBBBBB"), thread("park", "t-CCCCCCCC")]);
    expect(reasons(s)).toEqual(["쓰레드 생성 권한 없음", "쓰레드 생성 권한 없음"]); // 요청 전 park, 차례가 아닌 choi
    expect([...s.threads.keys()]).toEqual(["t-CCCCCCCC"]);
  });

  it("파이프라인을 찾지 못하면 리뷰 이벤트를 처리하지 않는다", () => {
    const s = reduce("CU-1", [...toDesign(), request()], DEV_TRUST);
    expect(reasons(s)).toEqual(["파이프라인 없음 (설정 버전을 찾지 못함)"]);
  });

  it("DESIGN → ANALYSIS 되돌림은 리뷰를 처음부터", () => {
    const p = pipeline(GROUPS);
    const s = run(p, [...toDesign(), request(), approve("park", "lead"), ev("phase.reverted", "dh.lee", { from: "DESIGN", to: "ANALYSIS", reason: "분석 누락" }), ev("phase.completed", "dh.lee", { phase: "ANALYSIS" })]);
    expect(s.phase).toBe("DESIGN");
    expect(s.review).toMatchObject({ requested: null, approvals: [] });
  });
});

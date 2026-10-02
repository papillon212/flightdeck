import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditRecord, Event, EVENT_TYPES, eventFileName, parsePipeline } from "../src/index.ts";

const design = readFileSync(new URL("../../../docs/design.md", import.meta.url), "utf8");

/** design.md에서 `lang` 코드 블록 중 marker를 포함하는 첫 블록을 꺼낸다 */
function codeBlock(lang: string, marker: string): string {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  for (const m of design.matchAll(re)) if (m[1]!.includes(marker)) return m[1]!;
  throw new Error(`design.md에 ${marker}를 포함한 ${lang} 블록이 없음`);
}

describe("pipeline.yaml (설계 §5)", () => {
  it("design.md의 예시를 그대로 파싱한다", () => {
    const p = parsePipeline(codeBlock("yaml", "product: ad-platform"));
    expect(p.product).toBe("ad-platform");
    expect(p.phases.design.review.tiers.map((t) => t.name)).toEqual(["lead", "architect"]);
    expect(p.phases.implementation.gate.commands).toEqual(["pnpm lint", "pnpm test"]);
    expect(p.checkpoint.exclude_secrets).toContain(".env");
    expect(p.agent.defaults["claude-code"]).toBe("claude-opus-5-5");
  });

  it("필수 항목이 빠지면 거부한다", () => {
    expect(() => parsePipeline("version: 1\nproduct: x\n")).toThrow();
  });
});

describe("이벤트 (설계 §3.1)", () => {
  const sample = JSON.parse(
    codeBlock("json", '"type": "thread.replied"').replace('"sig": "ed25519:…"', '"sig": "ed25519:x"'),
  );

  it("design.md의 예시 이벤트를 파싱한다", () => {
    const e = Event.parse(sample);
    expect(e.type).toBe("thread.replied");
    expect(eventFileName(e)).toBe("01JB3K9PZQ8W5R2N7T4M6X1C0D-park.json");
  });

  it("design.md 이벤트 표의 모든 타입을 다룬다", () => {
    const table = design.slice(design.indexOf("| 이벤트 타입 | data |"), design.indexOf("- 파일 이름은 `<ULID>-<member>.json`"));
    const documented = [...table.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]!);
    for (const t of documented) expect(EVENT_TYPES).toContain(t);
  });

  it("타입과 data가 맞지 않으면 거부한다", () => {
    expect(() => Event.parse({ ...sample, type: "thread.created" })).toThrow();
  });

  it("thread.created는 문단 앵커를 받는다", () => {
    const e = Event.parse({
      ...sample,
      type: "thread.created",
      data: {
        thread: "t-01JB2X4K",
        phase: "ANALYSIS",
        file: "analysis.md",
        anchor: { type: "paragraph", pid: "p:a91c" },
        kind: "question",
        to: ["park"],
        body: "TTL은 몇 분인가요?",
      },
    });
    expect(e.type).toBe("thread.created");
  });

  it("잘못된 ID 형식을 거부한다", () => {
    expect(() => Event.parse({ ...sample, id: "not-a-ulid" })).toThrow();
    expect(() => Event.parse({ ...sample, data: { ...sample.data, thread: "t-xyz" } })).toThrow();
  });
});

describe("편집 기록 (설계 §8.6)", () => {
  it("에이전트 편집을 받는다", () => {
    const r = EditRecord.parse({
      epic: "CU-86abc123",
      file: "src/auth/token.ts",
      seq: 1842,
      base_hash: "a".repeat(64),
      range: [1203, 1240],
      insert: "…",
      source: { kind: "agent", member: "dh.lee", adapter: "claude-code", run: "01JB3K9PZQ8W5R2N7T4M6X1C0D", step: 3, prompt_id: "p1", tool_use_id: "toolu_1" },
      ts: "2026-10-02T10:01:22.481+09:00",
    });
    expect(r.source.kind).toBe("agent");
  });

  it("새 파일은 base_hash가 null이다", () => {
    expect(() =>
      EditRecord.parse({ epic: "E-1", file: "a.txt", seq: 1, base_hash: null, range: [0, 0], insert: "x", source: { kind: "human", member: "kim" }, ts: "2026-10-02T10:00:00Z" }),
    ).not.toThrow();
  });
});

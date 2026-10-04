// 읽기 전용 창(질문 대상·리뷰어)의 에이전트 정책과 맥락 (설계 §3.6, §6.2 v0.13, m3-plan W7)
import { describe, expect, it } from "vitest";
import { initialState } from "@flightdeck/core";
import { decide, viewerContext } from "../src/index.ts";

const WT = "/w";
const base = { phase: "DESIGN" as const, epic: "CU-1", runId: null, worktree: WT, protectedPaths: [".claude/settings.local.json", ".mcp.json"], role: "viewer" as const };
const write = (p: string) => decide({ ...base, tool: { name: "Edit", kind: "write", paths: [`${WT}/${p}`] } });
const shell = (command: string) => decide({ ...base, tool: { name: "Bash", kind: "shell", paths: [], command } });

describe("읽기 전용 창 정책", () => {
  it("쓰기는 산출물 문서(쓰레드 초안용)만", () => {
    expect(write(".flightdeck/epics/CU-1/design.md")).toEqual({ allow: true });
    expect(write(".flightdeck/epics/CU-1/analysis.md")).toEqual({ allow: true });
    expect(write("src/auth/token.ts")).toMatchObject({ allow: false, reason: expect.stringContaining("읽기 전용 창") });
    expect(write(".flightdeck/epics/CU-1/runs/x/handoff.md").allow).toBe(false);
    expect(write(".mcp.json")).toMatchObject({ allow: false, reason: expect.stringContaining("에이전트 설정 파일") });
    // 단계와 무관 (IMPLEMENTATION이어도 코드 쓰기 불가)
    expect(decide({ ...base, phase: "IMPLEMENTATION", tool: { name: "Write", kind: "write", paths: [`${WT}/src/a.ts`] } }).allow).toBe(false);
  });

  it("셸은 읽기 전용 명령만", () => {
    expect(shell("grep -rn TTL .flightdeck")).toEqual({ allow: true });
    expect(shell("sed -i s/a/b/ design.md").allow).toBe(false);
    expect(shell("cat a > b").allow).toBe(false);
    expect(shell("git log").allow).toBe(false);
  });

  it("맥락: 기록하지 않음, 초안 문법, 리뷰 차례 안내", async () => {
    const st = initialState("CU-1");
    st.phase = "DESIGN";
    const text = await viewerContext({ epic: "CU-1", phase: "DESIGN", member: "park", worktree: "/nowhere", state: st, review: "지금은 @park의 리뷰 차례입니다(lead 티어)." });
    expect(text).toContain("이 세션은 기록하지 않습니다");
    expect(text).toContain("<!-- flightdeck:draft kind=question to=멤버1,멤버2 -->");
    expect(text).toContain("reply=<쓰레드 ID>");
    expect(text).toContain("@park의 리뷰 차례");
  });
});

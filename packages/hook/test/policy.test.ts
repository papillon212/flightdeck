import { describe, expect, it } from "vitest";
import type { Phase } from "@flightdeck/schema";
import { decide, hasWriteRedirect, splitCommand } from "../src/policy.ts";

const WT = "/w";
const RUN = "01JB3K9PZQ8W5R2N7T4M6X1C0D";
const base = { epic: "CU-1", runId: RUN, worktree: WT, protectedPaths: [".claude/settings.local.json", ".mcp.json"] };
const write = (phase: Phase, rel: string) => decide({ ...base, phase, tool: { name: "Write", kind: "write", paths: [`${WT}/${rel}`] } });
const read = (phase: Phase, rel: string) => decide({ ...base, phase, tool: { name: "Read", kind: "read", paths: [`${WT}/${rel}`] } });
const bash = (phase: Phase, command: string, testCommands?: string[]) =>
  decide({ ...base, phase, testCommands, tool: { name: "Bash", kind: "shell", paths: [], command } });

describe("쓰기 권한 (설계 §6.2)", () => {
  it("ANALYSIS: analysis.md와 이 실행의 handoff만", () => {
    expect(write("ANALYSIS", ".flightdeck/epics/CU-1/analysis.md").allow).toBe(true);
    expect(write("ANALYSIS", `.flightdeck/epics/CU-1/runs/${RUN}/handoff.md`).allow).toBe(true);
    expect(write("ANALYSIS", ".flightdeck/epics/CU-1/design.md").allow).toBe(false);
    expect(write("ANALYSIS", "src/app.ts").allow).toBe(false);
    expect(write("ANALYSIS", ".flightdeck/epics/CU-1/runs/OTHER/handoff.md").allow).toBe(false);
  });

  it("DESIGN: design.md와 handoff만", () => {
    expect(write("DESIGN", ".flightdeck/epics/CU-1/design.md").allow).toBe(true);
    expect(write("DESIGN", ".flightdeck/epics/CU-1/analysis.md").allow).toBe(false);
  });

  it("IMPLEMENTATION: .flightdeck 밖 전체 + handoff. impl-log는 flightdeck_log_step으로만 (M4 X10)", () => {
    expect(write("IMPLEMENTATION", "src/app.ts").allow).toBe(true);
    expect(write("IMPLEMENTATION", ".flightdeck/epics/CU-1/impl-log.md").allow).toBe(false);
    expect(write("IMPLEMENTATION", ".flightdeck/epics/CU-1/trace.jsonl").allow).toBe(false);
    expect(write("IMPLEMENTATION", ".flightdeck/epics/CU-1/state.json").allow).toBe(false);
  });

  it("VERIFICATION: 쓰기 없음", () => {
    expect(write("VERIFICATION", "src/app.ts").allow).toBe(false);
  });

  it("내장 git 토큰 파일은 어느 단계·창에서도 읽을 수 없다 (M5.5 Z3)", () => {
    const f = "/repo/.git/flightdeck/git-credentials";
    for (const phase of ["IMPLEMENTATION", "VERIFICATION", "ANALYSIS"] as Phase[]) {
      expect(decide({ ...base, phase, tool: { name: "Read", kind: "read", paths: [f] } }).allow).toBe(false);
      expect(decide({ ...base, phase, role: "review", tool: { name: "Read", kind: "read", paths: [f] } }).allow).toBe(false);
    }
    expect(bash("IMPLEMENTATION", `cat ${f}`).allow).toBe(false);
    expect(read("IMPLEMENTATION", "src/app.ts").allow).toBe(true);
  });

  it("작업 폴더 밖에는 쓸 수 없다", () => {
    expect(decide({ ...base, phase: "IMPLEMENTATION", tool: { name: "Write", kind: "write", paths: ["/etc/hosts"] } }).allow).toBe(false);
    expect(write("IMPLEMENTATION", "../other/x").allow).toBe(false);
  });

  it("모든 단계: 보호 경로는 읽기도 차단", () => {
    for (const phase of ["ANALYSIS", "IMPLEMENTATION"] as Phase[]) {
      expect(read(phase, ".claude/settings.local.json").allow).toBe(false);
      expect(read(phase, ".mcp.json").allow).toBe(false);
      expect(read(phase, ".flightdeck/.runtime/config/v1/pipeline.yaml").allow).toBe(false);
      expect(write(phase, ".claude/settings.local.json").allow).toBe(false);
    }
    expect(read("ANALYSIS", "src/app.ts").allow).toBe(true);
  });

  it("거부 사유에 쓸 수 있는 파일을 알려준다", () => {
    const d = write("ANALYSIS", "src/app.ts");
    expect(!d.allow && d.reason).toContain(".flightdeck/epics/CU-1/analysis.md");
  });
});

describe("셸 권한 (설계 §6.2)", () => {
  it("모든 단계에서 git 차단 (D12)", () => {
    for (const phase of ["ANALYSIS", "DESIGN", "IMPLEMENTATION"] as Phase[]) {
      expect(bash(phase, "git status").allow).toBe(false);
      expect(bash(phase, "ls && git log -1").allow).toBe(false);
      expect(bash(phase, "GIT_DIR=x /usr/bin/git status").allow).toBe(false);
    }
  });

  it("ANALYSIS: 읽기 전용 명령만", () => {
    expect(bash("ANALYSIS", "ls -la src | head -20").allow).toBe(true);
    expect(bash("ANALYSIS", "grep -rn token src 2>/dev/null").allow).toBe(true);
    expect(bash("ANALYSIS", "rg foo 2>&1 | wc -l").allow).toBe(true);
    expect(bash("ANALYSIS", "npm test").allow).toBe(false);
    expect(bash("ANALYSIS", "echo x > a.txt").allow).toBe(false);
    expect(bash("ANALYSIS", "cat a | tee b").allow).toBe(false);
    expect(bash("ANALYSIS", "find . -name '*.tmp' -delete").allow).toBe(false);
    expect(bash("ANALYSIS", "echo $(rm -rf x)").allow).toBe(false);
    expect(bash("ANALYSIS", "sed -i s/a/b/ f").allow).toBe(false);
  });

  it("IMPLEMENTATION: 허용, rm -rf 차단", () => {
    expect(bash("IMPLEMENTATION", "pnpm test").allow).toBe(true);
    expect(bash("IMPLEMENTATION", "rm -rf node_modules").allow).toBe(false);
    expect(bash("IMPLEMENTATION", "rm -fr dist").allow).toBe(false);
    expect(bash("IMPLEMENTATION", "rm old.txt").allow).toBe(true);
  });

  it("VERIFICATION: 테스트 명령만", () => {
    expect(bash("VERIFICATION", "pnpm test", ["pnpm test"]).allow).toBe(true);
    expect(bash("VERIFICATION", "pnpm test auth", ["pnpm test"]).allow).toBe(true);
    expect(bash("VERIFICATION", "pnpm build", ["pnpm test"]).allow).toBe(false);
  });
});

describe("명령 해석", () => {
  it("splitCommand", () => {
    expect(splitCommand("FOO=1 sudo /bin/ls -la; cd x && git status | head").map((s) => s.prog)).toEqual(["ls", "cd", "git", "head"]);
  });
  it("hasWriteRedirect", () => {
    expect(hasWriteRedirect("ls 2>&1")).toBe(false);
    expect(hasWriteRedirect("ls >/dev/null 2>/dev/null")).toBe(false);
    expect(hasWriteRedirect("ls > out")).toBe(true);
    expect(hasWriteRedirect("ls >> out")).toBe(true);
  });
});

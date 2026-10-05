// 줄 단위 출처 문구 (§8.6 에디터 통합, M7 E6). VS Code API를 쓰지 않는다.
import type { BlameEntry } from "@flightdeck/core";

export function blameLabel(e: BlameEntry | null | undefined): string {
  if (!e) return "에픽 시작 때부터 있던 줄";
  const when = e.ts.slice(0, 16).replace("T", " ");
  switch (e.kind) {
    case "agent":
      return `@${e.member}의 에이전트 · Step ${e.step ?? "?"} · 실행 ${e.run?.slice(-6)} · ${when}${e.memo ? ` · 메모: ${e.memo}` : ""}`;
    case "agent_shell":
      return `@${e.member}의 에이전트 셸 (${e.cmd}) · Step ${e.step ?? "?"} · ${when}`;
    case "human":
      return `@${e.member} 직접 수정 · ${when}${e.memo ? ` · 메모: ${e.memo}` : " · 메모 없음"}`;
    case "patch":
      return `수정 제안 반영 (${e.thread}) · @${e.member} · ${when}`;
    case "flightdeck":
      return `Flightdeck 렌더링 · ${when}`;
    case "external":
      return e.commit ? `main 병합 반영 (${e.commit.slice(0, 7)}) · ${when}` : `Flightdeck 밖의 변경 · ${when}${e.memo ? ` · 메모: ${e.memo}` : " · 메모 없음"}`;
    case "restore":
      return `체크포인트 복원 · @${e.member} · ${when}`;
  }
}

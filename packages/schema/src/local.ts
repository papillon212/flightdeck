import { z } from "zod";
import { EpicId, MemberId, Phase, Ulid } from "./common.ts";

/**
 * 로컬 에픽 상태 (M1, docs/m1-plan.md "훅 ↔ 확장 통신").
 * 위치: <git common dir>/flightdeck/state/<epic>.json. 확장이 쓰고 flightdeck-hook·MCP 서버가 읽는다.
 * phase는 reducer 결과의 사본이다. 원천은 메타 이벤트다.
 */
export const LocalEpicState = z.object({
  epic: EpicId,
  /** 제품 레포 main worktree */
  repo: z.string().min(1),
  /** 에픽 작업 폴더 */
  worktree: z.string().min(1),
  /** 이 PC의 사용자 (조종수) */
  member: MemberId,
  phase: Phase,
  /** 단계 룰 폴더: <configDir>/rules/{common,analysis,…}.md (§2.5) */
  configDir: z.string().min(1),
  /** pipeline.yaml checkpoint.exclude_secrets */
  excludeSecrets: z.array(z.string()).default([".env", ".env.*", "*.pem", "*.key"]),
  /** 에이전트 세션 → 실행. 훅이 SessionStart에서 채운다 */
  runs: z
    .record(
      z.string(),
      z.object({
        run_id: Ulid,
        /** 이 세션에 마지막으로 룰을 넣은 단계. 다르면 UserPromptSubmit에서 새 룰을 붙인다 (§6.1) */
        context_phase: Phase,
        started_at: z.string(),
      }),
    )
    .default({}),
});
export type LocalEpicState = z.infer<typeof LocalEpicState>;

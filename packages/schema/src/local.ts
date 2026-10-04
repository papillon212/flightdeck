import { z } from "zod";
import { EpicId, MemberId, Phase, Ulid } from "./common.ts";

/**
 * reducer가 서버 서명을 어떻게 다룰지 (설계 §12, §2.5).
 * - server: 단계 통과 이벤트는 이 서버 공개키의 서명이 있어야 한다. deactivated(멤버 → 비활성 시각) 이후의 일반 이벤트는 무시한다.
 * - dev: 개발 모드(로컬 설정 폴더). 서명을 보지 않는다. 이 모드의 에픽은 서버 검증을 통과하지 못한다.
 */
export const Trust = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("server"), serverKey: z.string().min(1), deactivated: z.record(MemberId, z.string()).default({}) }),
  z.object({ mode: z.literal("dev") }),
]);
export type Trust = z.infer<typeof Trust>;
export const DEV_TRUST: Trust = { mode: "dev" };

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
  /**
   * owner: 에픽 작업 폴더 (담당자). viewer: 질문 대상의 읽기 전용 창 (§2.4). viewer에는 에이전트 설정을 넣지 않고,
   * 쓰레드 렌더링을 편집 기록에 남기지 않는다
   */
  role: z.enum(["owner", "viewer"]).default("owner"),
  /** 서버 모드의 제품 ID (설정·서명 요청) */
  product: z.string().optional(),
  phase: Phase,
  /** 단계 룰 폴더: <configDir>/rules/{common,analysis,…}.md (§2.5) */
  configDir: z.string().min(1),
  /** 서버 서명 검증 기준. 훅·MCP 서버도 같은 기준으로 상태를 계산한다 */
  trust: Trust.default(DEV_TRUST),
  /** pipeline.yaml checkpoint.exclude_secrets */
  excludeSecrets: z.array(z.string()).default([".env", ".env.*", "*.pem", "*.key"]),
  /** 제품 레포의 git 원격 이름 (서버 모드). 훅이 체크포인트·세션 원본 ref를 올릴 때 쓴다 */
  gitRemote: z.string().optional(),
  /**
   * 마지막으로 기록한 impl-log Step 번호 (에픽 단위, M4 제안 X2). 에이전트 편집은 이 번호 + 1의 Step에 속한다.
   * flightdeck_log_step이 올린다
   */
  impl_step: z.number().int().nonnegative().default(0),
  /** 마지막 자동 초안(headless)의 세션 ID. "이어서 작업"이 이 세션을 resume한다 (§6.1) */
  draft_session: z.string().optional(),
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
/** 기본값이 있는 필드는 생략할 수 있는 입력 형태 */
export type LocalEpicStateInput = z.input<typeof LocalEpicState>;

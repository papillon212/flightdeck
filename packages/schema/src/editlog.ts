import { z } from "zod";
import { EpicId, MemberId, Sha256, ThreadId, Timestamp, Ulid } from "./common.ts";

/** 편집 출처 (설계 §8.6 표) */
export const EditSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), member: MemberId }),
  z.object({
    kind: z.literal("agent"),
    member: MemberId,
    adapter: z.string().min(1),
    run: Ulid,
    step: z.number().int().nonnegative().optional(),
    prompt_id: z.string().optional(),
    tool_use_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_shell"),
    member: MemberId,
    run: Ulid,
    step: z.number().int().nonnegative().optional(),
    cmd: z.string(),
  }),
  z.object({ kind: z.literal("patch"), member: MemberId, thread: ThreadId }),
  // Flightdeck 자신의 렌더링: 문단 ID 부여, 쓰레드 블록 그리기 (설계 제안 T4)
  z.object({ kind: z.literal("flightdeck"), member: MemberId, reason: z.enum(["paragraph_ids", "thread_render"]) }),
  z.object({ kind: z.literal("external"), commit: z.string().optional() }), // commit 없으면 external:unknown
]);
export type EditSource = z.infer<typeof EditSource>;

/**
 * 편집 기록 1건 (설계 §8.6).
 * - range: base 상태 기준 [start, end) UTF-16 오프셋. insert로 교체한다.
 * - base_hash: 편집 직전 파일 디스크 바이트의 sha256. 파일이 없었으면 null.
 * - delete_file: 파일 삭제. 이때 range/insert는 무시한다.
 */
export const EditRecord = z.object({
  epic: EpicId,
  file: z.string().min(1),
  seq: z.number().int().positive(),
  base_hash: Sha256.nullable(),
  range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  insert: z.string(),
  delete_file: z.boolean().optional(),
  source: EditSource,
  ts: Timestamp,
});
export type EditRecord = z.infer<typeof EditRecord>;

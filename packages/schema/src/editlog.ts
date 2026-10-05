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
  // draft_posted: 올린 쓰레드 초안 블록을 문서에서 지움 (§3.2 v0.13)
  // impl_log: flightdeck_log_step이 쓴 구현 기록 Step·직접 수정 메모 (M4 제안 X1·X4)
  z.object({ kind: z.literal("flightdeck"), member: MemberId, reason: z.enum(["paragraph_ids", "thread_render", "draft_posted", "impl_log"]) }),
  z.object({ kind: z.literal("external"), commit: z.string().optional() }), // commit 없으면 external:unknown
  // 체크포인트 복원 (M4 제안 X8): 파일 전체 교체. 출처는 그 체크포인트의 편집 기록 위치(seq)에서 되살린다
  z.object({ kind: z.literal("restore"), member: MemberId, ckpt: z.string().min(1), seq: z.number().int().nonnegative() }),
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

/**
 * 직접 수정·외부 변경 메모 (설계 §7.4, M4 제안 X4). 수정 묶음(같은 파일의 연속 편집 seqs[0]..seqs[1])에 붙는다.
 * 로컬 memos/<epic>.jsonl에 쌓고, impl-log.md의 "직접 수정 메모"에도 그린다
 */
export const EditMemo = z.object({
  epic: EpicId,
  file: z.string().min(1),
  seqs: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  memo: z.string().trim().min(1),
  member: MemberId,
  at: Timestamp,
});
export type EditMemo = z.infer<typeof EditMemo>;

/**
 * 편집 기록 업로드 묶음 (M7 제안 E1·E8). records는 서버의 마지막 seq 바로 다음부터 이어져야 한다.
 * memos는 그 에픽의 메모 전체(서버가 통째로 바꾼다. 메모는 적고, 고쳐질 수 있다)
 */
export const EditUpload = z.object({
  epic: EpicId,
  records: z.array(EditRecord).max(5000),
  memos: z.array(EditMemo).max(2000).optional(),
});
export type EditUpload = z.infer<typeof EditUpload>;

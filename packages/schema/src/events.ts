import { z } from "zod";
import { Anchor } from "./anchor.ts";
import { EpicId, GitSha, MemberId, Phase, Sha256, ThreadId, Timestamp, Ulid } from "./common.ts";

/** 이벤트 종류별 data (설계 §3.1 표) */
const data = {
  "epic.started": z.object({
    tracker_ref: z.string().min(1),
    owner: MemberId,
    base_sha: GitSha,
    config_version: z.string().min(1),
  }),
  "epic.config_upgraded": z.object({ from_version: z.string().min(1), to_version: z.string().min(1) }),
  "thread.created": z.object({
    thread: ThreadId,
    phase: Phase,
    file: z.string().min(1),
    anchor: Anchor,
    kind: z.enum(["question", "change_request", "note"]),
    to: z.array(MemberId),
    body: z.string().min(1),
  }),
  "thread.replied": z.object({
    thread: ThreadId,
    body: z.string().min(1),
    source: z.enum(["human", "agent", "session"]),
    patch: z.string().optional(), // 수정 제안 (§9.3)
  }),
  "thread.resolved": z.object({ thread: ThreadId }),
  "thread.reopened": z.object({ thread: ThreadId }),
  "thread.moved": z.object({ thread: ThreadId, anchor: Anchor }),
  "patch.applied": z.object({ thread: ThreadId, commit: GitSha }),
  "phase.completed": z.object({ phase: Phase }),
  "review.approved": z.object({ phase: Phase, tier: z.string().min(1), artifact_hash: z.string().min(1) }),
  "review.edited": z.object({ phase: Phase, commit: GitSha }),
  "phase.reverted": z.object({ from: Phase, to: Phase, reason: z.string().min(1) }),
  "run.started": z.object({
    run_id: Ulid,
    phase: Phase,
    member: MemberId,
    agent: z.string().min(1), // 어댑터 ID (§6.5). 원본 파싱은 만든 쪽 어댑터가 맡는다
    ckpt_from: GitSha.optional(),
  }),
  "run.finished": z.object({
    run_id: Ulid,
    phase: Phase,
    member: MemberId,
    ckpt_from: GitSha.optional(),
    ckpt_to: GitSha.optional(),
  }),
  "gate.reported": z.object({
    commit: GitSha,
    commands: z.array(z.object({ cmd: z.string(), exit: z.number().int(), summary: z.string(), log_hash: Sha256 })),
  }),
  "pilot.changed": z.object({
    from: MemberId,
    to: MemberId,
    reason: z.enum(["handoff", "request", "takeover"]),
    ckpt: GitSha.optional(),
    handoff_run: Ulid.optional(),
  }),
  "land.requested": z.object({ head_sha: GitSha }),
  "epic.landed": z.object({ main_commit: GitSha, approvals: z.array(Ulid) }),
  "land.rejected": z.object({ reason: z.string().min(1), details: z.unknown().optional() }),
  "session.started": z.looseObject({ sid: z.string().min(1) }),
  "session.ended": z.looseObject({ sid: z.string().min(1) }),
  "session.published": z.looseObject({ sid: z.string().min(1) }),
} as const;

export type EventType = keyof typeof data;
export const EVENT_TYPES = Object.keys(data) as EventType[];

const base = {
  v: z.literal(1),
  id: Ulid,
  epic: EpicId,
  author: MemberId,
  at: Timestamp,
  /** ed25519 서명. M2에서 검증한다 (§12). M1에서는 없어도 된다 */
  sig: z.string().optional(),
};

const variants = EVENT_TYPES.map((type) => z.object({ ...base, type: z.literal(type), data: data[type] }));

/** 메타 브랜치의 이벤트 파일 1개 = 이벤트 1개 (설계 §2.3, §3.1) */
export const Event = z.discriminatedUnion("type", variants as unknown as [(typeof variants)[number], ...(typeof variants)[number][]]);

export type EventOf<T extends EventType> = {
  v: 1;
  id: string;
  type: T;
  epic: string;
  author: string;
  at: string;
  sig?: string;
  data: z.infer<(typeof data)[T]>;
};
export type Event = { [T in EventType]: EventOf<T> }[EventType];

/** 메타 브랜치의 이벤트 파일 이름: <ULID>-<member>.json */
export function eventFileName(e: Pick<Event, "id" | "author">): string {
  return `${e.id}-${e.author}.json`;
}

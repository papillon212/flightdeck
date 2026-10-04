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
    /** 문서 공유 커밋: 질문 대상이 이 커밋으로 문서를 본다 (§3.1, §2.4) */
    commit: GitSha.optional(),
    /** 에이전트가 쓴 쓰레드 초안을 사람이 올렸으면 agent (§3.2) */
    source: z.enum(["human", "agent"]).optional(),
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
  /** artifact_hash는 서버가 서명 전에 확인해 채운다 (§4.2). 개발 모드의 로컬 이벤트에는 없다 */
  "phase.completed": z.object({ phase: Phase, artifact_hash: z.string().min(1).optional() }),
  /** 담당자의 리뷰 요청 (§4.2). 이 해시가 재승인 기준인 "현재 산출물"이다 */
  "review.requested": z.object({ phase: Phase, artifact_hash: z.string().min(1), commit: GitSha }),
  "review.approved": z.object({ phase: Phase, tier: z.string().min(1), artifact_hash: z.string().min(1) }),
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

/** 서버 서명이 있어야 효력이 있는 단계 통과 이벤트 (§3.1 표의 ✅, §12). 나머지는 일반 이벤트로 서명하지 않는다 */
export const SERVER_SIGNED_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "epic.started",
  "epic.config_upgraded",
  "phase.completed",
  "review.requested",
  "review.approved",
  "gate.reported",
  "epic.landed",
  "land.rejected",
]);

const base = {
  v: z.literal(1),
  id: Ulid,
  epic: EpicId,
  author: MemberId,
  at: Timestamp,
  /** 서버 서명 `ed25519:<base64>`. 서버 서명 이벤트에만 있다 (§12) */
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

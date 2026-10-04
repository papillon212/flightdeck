// 에픽 상태 계산 (설계 §1.1, §3.4, §4, §12).
// 입력: 한 에픽의 메타 이벤트 전부. 순서: ULID(id) 오름차순.
// 권한이 없거나, 관문 조건을 못 채웠거나, 서버 서명이 필요한데 없거나 틀린 이벤트는 무시하고 ignored에 이유를 남긴다.
// 범위: INTAKE → ANALYSIS → DESIGN(티어 리뷰) → IMPLEMENTATION, 쓰레드, 실행 기록, 서버 서명 검증.
import type { Anchor, Event, EventOf, Phase, Pipeline, Trust } from "@flightdeck/schema";
import { approvalProblem, reviewConfig, reviewProgress, type ReviewProgress, type ReviewState } from "./review.ts";
import { needsServerSignature, verifyEvent } from "./sign.ts";

export interface Reply {
  id: string;
  author: string;
  at: string;
  body: string;
  source: "human" | "agent" | "session";
}

export interface Thread {
  id: string;
  phase: Phase;
  file: string;
  anchor: Anchor;
  kind: "question" | "change_request" | "note";
  author: string;
  to: string[];
  at: string;
  body: string;
  status: "open" | "resolved";
  replies: Reply[];
}

export interface Run {
  run_id: string;
  phase: Phase;
  member: string;
  agent: string;
  finished: boolean;
  ckpt_from?: string;
  ckpt_to?: string;
}

export interface EpicState {
  epic: string;
  phase: Phase;
  owner: string | null;
  base_sha: string | null;
  config_version: string | null;
  tracker_ref: string | null;
  threads: Map<string, Thread>;
  runs: Map<string, Run>;
  history: { at: string; from: Phase; to: Phase; by: string; event: string }[];
  ignored: { event: string; type: string; reason: string }[];
  /** 현재 단계의 티어 리뷰 (§4.2). 리뷰가 없는 단계·리뷰 요청 전에도 phase만 담긴 상태로 있다 */
  review: ReviewState;
  /** 에픽에 고정된 설정 버전의 파이프라인 (호출하는 쪽이 넘긴 것) */
  pipeline: Pipeline | undefined;
  /** 테스트 결과 보고 (§7.5): 커밋 → 마지막 보고. ok = 모든 명령 종료 코드 0 */
  gates: Map<string, { ok: boolean; event: string; author: string; at: string }>;
}

export interface ReduceOptions {
  /** 설정 버전 → 파이프라인. epic.started.config_version으로 찾는다. 없으면 티어 리뷰 이벤트를 처리하지 못한다 */
  pipelines?: ReadonlyMap<string, Pipeline> | ((version: string) => Pipeline | undefined);
}

export function initialState(epic: string): EpicState {
  return {
    epic,
    phase: "INTAKE",
    owner: null,
    base_sha: null,
    config_version: null,
    tracker_ref: null,
    threads: new Map(),
    runs: new Map(),
    history: [],
    ignored: [],
    review: { phase: "INTAKE", requested: null, approvals: [] },
    pipeline: undefined,
    gates: new Map(),
  };
}

/** 다음 단계 (설계 §4.1). ANALYSIS·IMPLEMENTATION은 phase.completed로, DESIGN은 마지막 티어 승인으로 넘어간다 */
const NEXT: Partial<Record<Phase, Phase>> = { ANALYSIS: "DESIGN", DESIGN: "IMPLEMENTATION", IMPLEMENTATION: "VERIFICATION" };
/** phase.completed로 넘어가는 단계 */
const COMPLETABLE: ReadonlySet<Phase> = new Set(["ANALYSIS", "IMPLEMENTATION"]);

export function reduce(epic: string, events: Event[], trust: Trust, opts: ReduceOptions = {}): EpicState {
  const s = initialState(epic);
  const lookup = opts.pipelines;
  const find = (v: string) => (typeof lookup === "function" ? lookup(v) : lookup?.get(v));
  const sorted = [...events].filter((e) => e.epic === epic).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of sorted) {
    const reason = trustProblem(e, trust);
    if (reason) s.ignored.push({ event: e.id, type: e.type, reason });
    else apply(s, e, find);
  }
  return s;
}

/** 이 에픽이 고정한 설정 버전 (epic.started). 파이프라인을 미리 불러올 때 쓴다 */
export function configVersionOf(events: Event[], epic: string): string | null {
  const e = events.find((x) => x.epic === epic && x.type === "epic.started") as EventOf<"epic.started"> | undefined;
  return e?.data.config_version ?? null;
}

/** 현재 단계의 리뷰 진행 (리뷰가 없는 단계·파이프라인이 없으면 null) */
export function reviewOf(s: EpicState): ReviewProgress | null {
  const cfg = reviewConfig(s.pipeline, s.phase);
  if (!cfg || !s.pipeline || !s.owner) return null;
  return reviewProgress(s.pipeline, cfg, s.review, s.owner);
}

const openThreads = (s: EpicState) => [...s.threads.values()].filter((t) => t.phase === s.phase && t.status === "open");

/** 서명·멤버 상태로 보아 받아들일 수 없으면 이유 (§12) */
export function trustProblem(e: Event, trust: Trust): string | null {
  if (trust.mode === "dev") return null;
  if (needsServerSignature(e)) {
    if (!e.sig) return "서버 서명 없음";
    if (!verifyEvent(e, trust.serverKey)) return "서버 서명이 맞지 않음";
    return null; // 서버가 서명할 때 요청자의 활성 여부를 이미 확인했다
  }
  const off = trust.deactivated[e.author];
  if (off !== undefined && Date.parse(e.at) >= Date.parse(off)) return "비활성 멤버의 이벤트";
  return null;
}

function apply(s: EpicState, e: Event, findPipeline: (v: string) => Pipeline | undefined): void {
  const ignore = (reason: string): void => {
    s.ignored.push({ event: e.id, type: e.type, reason });
  };
  const move = (to: Phase) => {
    s.history.push({ at: e.at, from: s.phase, to, by: e.author, event: e.id });
    s.phase = to;
    s.review = { phase: to, requested: null, approvals: [] }; // 단계가 바뀌면 리뷰는 새로
  };

  if (e.type !== "epic.started" && s.owner === null) return ignore("epic.started 이전 이벤트");

  switch (e.type) {
    case "epic.started": {
      if (s.owner !== null) return ignore("이미 시작된 에픽");
      s.owner = e.data.owner;
      s.base_sha = e.data.base_sha;
      s.config_version = e.data.config_version;
      s.pipeline = findPipeline(e.data.config_version);
      s.tracker_ref = e.data.tracker_ref;
      move("ANALYSIS"); // INTAKE는 자동으로 지나간다 (§4.1)
      return;
    }

    case "thread.created": {
      const d = e.data;
      if (s.threads.has(d.thread)) return ignore("이미 있는 쓰레드 ID");
      // 생성 권한 (§3.4): 해당 단계 담당자 / 현재 티어 리뷰어 (리뷰 요청 이후)
      if (e.author !== s.owner) {
        const cur = s.review.requested ? reviewOf(s)?.current : null;
        if (!cur?.reviewers.includes(e.author)) return ignore("쓰레드 생성 권한 없음");
      }
      s.threads.set(d.thread, {
        id: d.thread,
        phase: d.phase,
        file: d.file,
        anchor: d.anchor,
        kind: d.kind,
        author: e.author,
        to: d.to,
        at: e.at,
        body: d.body,
        status: "open",
        replies: [],
      });
      return;
    }

    case "thread.replied": {
      const t = s.threads.get(e.data.thread);
      if (!t) return ignore("없는 쓰레드");
      // 답글 권한 (§3.4): 쓰레드 참여자 + 멘션 대상. 담당자의 에이전트 답글은 담당자 이름으로 온다
      if (!threadMembers(t, s).has(e.author)) return ignore("답글 권한 없음");
      t.replies.push({ id: e.id, author: e.author, at: e.at, body: e.data.body, source: e.data.source });
      return;
    }

    case "thread.resolved":
    case "thread.reopened": {
      const t = s.threads.get(e.data.thread);
      if (!t) return ignore("없는 쓰레드");
      // resolve/reopen 권한 (§3.4): 쓰레드 생성자. 분석 단계에서는 담당자도
      const ok = e.author === t.author || (t.phase === "ANALYSIS" && e.author === s.owner);
      if (!ok) return ignore("resolve/reopen 권한 없음");
      const want = e.type === "thread.resolved" ? "resolved" : "open";
      if (t.status === want) return ignore(`이미 ${want}`);
      t.status = want;
      return;
    }

    case "thread.moved": {
      const t = s.threads.get(e.data.thread);
      if (!t) return ignore("없는 쓰레드");
      if (e.author !== s.owner && e.author !== t.author) return ignore("쓰레드 이동 권한 없음");
      t.anchor = e.data.anchor;
      return;
    }

    case "phase.completed": {
      if (e.data.phase !== s.phase) return ignore(`현재 단계(${s.phase})가 아님`);
      if (e.author !== s.owner) return ignore("담당자만 단계를 완료할 수 있음");
      if (!COMPLETABLE.has(s.phase)) return ignore(`${s.phase}는 단계 완료가 아니라 티어 리뷰로 넘어간다 (§4.2)`);
      // ANALYSIS 관문 (§4.1): 그 단계의 쓰레드 전부 resolved
      const open = openThreads(s);
      if (open.length) return ignore(`열린 쓰레드 ${open.length}개`);
      // IMPLEMENTATION 관문 (§4.1, §7.5, M4 제안 X5): 검사한 커밋의 테스트 보고가 모두 통과
      if (s.phase === "IMPLEMENTATION") {
        if (!e.data.commit) return ignore("검사한 커밋(commit)이 없음");
        const g = s.gates.get(e.data.commit);
        if (!g) return ignore("이 커밋의 테스트 결과 보고(gate.reported)가 없음");
        if (!g.ok) return ignore("이 커밋의 테스트 결과 보고에 실패한 명령이 있음");
      }
      move(NEXT[s.phase]!);
      return;
    }

    case "gate.reported": {
      // 구현 관문의 명령 결과 (§7.5): 담당자의 확장이 실행해 보고한다
      if (s.phase !== "IMPLEMENTATION") return ignore(`${s.phase} 단계에서는 테스트 결과를 보고하지 않음`);
      if (e.author !== s.owner) return ignore("담당자만 테스트 결과를 보고할 수 있음");
      s.gates.set(e.data.commit, { ok: e.data.commands.every((c) => c.exit === 0), event: e.id, author: e.author, at: e.at });
      return;
    }

    case "review.requested": {
      if (e.data.phase !== s.phase) return ignore(`현재 단계(${s.phase})가 아님`);
      if (e.author !== s.owner) return ignore("담당자만 리뷰를 요청할 수 있음");
      if (!reviewConfig(s.pipeline, s.phase)) return ignore(s.pipeline ? `${s.phase}는 티어 리뷰가 없는 단계` : "파이프라인 없음 (설정 버전을 찾지 못함)");
      s.review.requested = { hash: e.data.artifact_hash, commit: e.data.commit, at: e.at, event: e.id };
      finishReview(s, e, move);
      return;
    }

    case "review.approved": {
      if (e.data.phase !== s.phase) return ignore(`현재 단계(${s.phase})가 아님`);
      const cfg = reviewConfig(s.pipeline, s.phase);
      if (!cfg || !s.pipeline) return ignore(s.pipeline ? `${s.phase}는 티어 리뷰가 없는 단계` : "파이프라인 없음 (설정 버전을 찾지 못함)");
      const open = openThreads(s);
      const problem = approvalProblem(s.pipeline, cfg, s.review, s.owner!, { tier: e.data.tier, author: e.author, hash: e.data.artifact_hash }, { byAuthor: open.filter((t) => t.author === e.author).length, all: open.length });
      if (problem) return ignore(problem);
      s.review.approvals.push({ event: e.id, tier: e.data.tier, author: e.author, hash: e.data.artifact_hash, at: e.at });
      finishReview(s, e, move);
      return;
    }

    case "phase.reverted": {
      if (e.data.from !== s.phase) return ignore(`현재 단계(${s.phase})가 아님`);
      if (e.author !== s.owner) return ignore("담당자만 되돌릴 수 있음");
      // §4.3: DESIGN → ANALYSIS (M1 범위)
      if (!(e.data.from === "DESIGN" && e.data.to === "ANALYSIS")) return ignore("M1에서 허용하지 않는 되돌림");
      move("ANALYSIS");
      return;
    }

    case "run.started": {
      if (s.runs.has(e.data.run_id)) return ignore("이미 있는 실행");
      s.runs.set(e.data.run_id, { ...pick(e), finished: false });
      return;
    }

    case "run.finished": {
      const r = s.runs.get(e.data.run_id);
      if (!r) return ignore("없는 실행");
      r.finished = true;
      r.ckpt_to = e.data.ckpt_to;
      return;
    }

    default:
      return ignore("M1에서 처리하지 않는 이벤트");
  }
}

/** 리뷰어가 있는 모든 티어가 승인했고 열린 쓰레드가 없으면 다음 단계로 (§4.1: 마지막 티어 승인으로 자동 전환) */
function finishReview(s: EpicState, e: Event, move: (to: Phase) => void): void {
  const p = reviewOf(s);
  const next = NEXT[s.phase];
  if (p?.done && next && openThreads(s).length === 0) move(next);
}

function pick(e: EventOf<"run.started">): Omit<Run, "finished"> {
  const { run_id, phase, member, agent, ckpt_from } = e.data;
  return { run_id, phase, member, agent, ckpt_from };
}

function threadMembers(t: Thread, s: EpicState): Set<string> {
  const m = new Set([t.author, ...t.to, ...t.replies.map((r) => r.author)]);
  if (s.owner) m.add(s.owner);
  return m;
}

/** 내가 처리할 항목 (설계 §9.2 "내 할 일"): 내가 대상인 열린 쓰레드 중 내가 마지막으로 답하지 않은 것 */
export function myOpenThreads(s: EpicState, me: string): Thread[] {
  return [...s.threads.values()].filter((t) => {
    if (t.status !== "open") return false;
    const last = t.replies.at(-1)?.author ?? t.author;
    return (t.to.includes(me) || t.author === me) && last !== me;
  });
}

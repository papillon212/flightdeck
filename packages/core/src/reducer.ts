// 에픽 상태 계산 (설계 §1.1, §3.4, §4, §12).
// 입력: 한 에픽의 메타 이벤트 전부. 순서: ULID(id) 오름차순.
// 권한이 없거나, 관문 조건을 못 채웠거나, 서버 서명이 필요한데 없거나 틀린 이벤트는 무시하고 ignored에 이유를 남긴다.
// 범위: INTAKE → ANALYSIS → DESIGN, 쓰레드, 실행 기록, 서버 서명 검증. 티어 승인(§4.2)은 M3.
import type { Anchor, Event, EventOf, Phase, Trust } from "@flightdeck/schema";
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
  };
}

/** 다음 단계 (설계 §4.1). M1은 DESIGN까지 */
const NEXT: Partial<Record<Phase, Phase>> = { ANALYSIS: "DESIGN" };

export function reduce(epic: string, events: Event[], trust: Trust): EpicState {
  const s = initialState(epic);
  const sorted = [...events].filter((e) => e.epic === epic).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of sorted) {
    const reason = trustProblem(e, trust);
    if (reason) s.ignored.push({ event: e.id, type: e.type, reason });
    else apply(s, e);
  }
  return s;
}

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

function apply(s: EpicState, e: Event): void {
  const ignore = (reason: string): void => {
    s.ignored.push({ event: e.id, type: e.type, reason });
  };
  const move = (to: Phase) => {
    s.history.push({ at: e.at, from: s.phase, to, by: e.author, event: e.id });
    s.phase = to;
  };

  if (e.type !== "epic.started" && s.owner === null) return ignore("epic.started 이전 이벤트");

  switch (e.type) {
    case "epic.started": {
      if (s.owner !== null) return ignore("이미 시작된 에픽");
      s.owner = e.data.owner;
      s.base_sha = e.data.base_sha;
      s.config_version = e.data.config_version;
      s.tracker_ref = e.data.tracker_ref;
      move("ANALYSIS"); // INTAKE는 자동으로 지나간다 (§4.1)
      return;
    }

    case "thread.created": {
      const d = e.data;
      if (s.threads.has(d.thread)) return ignore("이미 있는 쓰레드 ID");
      // 생성 권한 (§3.4): 해당 단계 담당자 / 현재 티어 리뷰어. M1에는 티어가 없어 담당자만
      if (e.author !== s.owner) return ignore("쓰레드 생성 권한 없음");
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
      const next = NEXT[s.phase];
      if (!next) return ignore(`${s.phase} 완료는 M1 범위 밖`);
      // ANALYSIS 관문 (§4.1): 그 단계의 쓰레드 전부 resolved
      const open = [...s.threads.values()].filter((t) => t.phase === s.phase && t.status === "open");
      if (open.length) return ignore(`열린 쓰레드 ${open.length}개`);
      move(next);
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

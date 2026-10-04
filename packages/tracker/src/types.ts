// TrackerAdapter (설계 §1.4). 일감 도구별 차이는 어댑터 안에 가둔다. 모든 호출은 행위자 본인의 개인 토큰으로 한다(D10).
import type { Phase } from "@flightdeck/schema";

export interface TrackerUser {
  /** 일감 도구의 사용자 ID (서버 멤버 목록의 tracker_id) */
  id: string;
  name?: string;
}

export interface TrackerEpic {
  /** 일감 도구의 일감 참조 (epic.started.tracker_ref) */
  ref: string;
  /** Flightdeck 에픽 ID (예: CU-86abc123) */
  epicId: string;
  title: string;
  /** 본문 (마크다운) */
  body: string;
  url: string;
  status: string;
  tags: string[];
}

export interface TrackerAdapter {
  id: "clickup" | "jira" | (string & {});
  me(): Promise<TrackerUser>;
  /** 나에게 배정된, Flightdeck 대상(태그 등) 일감 */
  listAssignedEpics(me: TrackerUser): Promise<TrackerEpic[]>;
  getEpic(ref: string): Promise<TrackerEpic>;
  /** 단계에 대응하는 상태로 바꾼다. 대응이 없는 단계는 아무것도 하지 않는다 */
  setPhase(ref: string, phase: Phase): Promise<void>;
  setFields(ref: string, f: Record<string, string>): Promise<void>;
  /** 일감 댓글로 @멘션 (§3.7: 새 질문의 대상, 리뷰 차례에만) */
  notifyMention(ref: string, to: TrackerUser[], text: string, link: string): Promise<void>;
}

/** 조정 (§1.4 reconcile): reducer 단계와 일감 상태가 다르면 맞춘다. 여러 번 해도 결과가 같다. 바꿨으면 true */
export async function reconcile(t: TrackerAdapter, ref: string, phase: Phase, statusOf: (p: Phase) => string | undefined): Promise<boolean> {
  const want = statusOf(phase);
  if (!want) return false;
  const cur = (await t.getEpic(ref)).status;
  if (cur.toLowerCase() === want.toLowerCase()) return false;
  await t.setPhase(ref, phase);
  return true;
}

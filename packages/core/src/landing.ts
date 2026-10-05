// 반영·감사·코드 쓰레드 위치 (설계 §11, §3.3, M5 제안 Y2·Y7·Y8). 순수 함수.

/**
 * squash에 남길 에픽 기록인가 (Y7). rel = .flightdeck/epics/<epic>/ 아래 상대 경로.
 * keep 패턴: "runs/"처럼 /로 끝나면 그 폴더 아래 전부, 아니면 파일 이름 그대로
 */
export function keepRecord(rel: string, keep: string[]): boolean {
  return keep.some((k) => (k.endsWith("/") ? rel.startsWith(k) : rel === k));
}

export interface MainCommit {
  sha: string;
  subject: string;
  trailers: Record<string, string>;
}

export interface AuditFinding {
  sha: string;
  subject: string;
  reason: string;
}

/**
 * main 감사 (§11.4, Y8): 감사 시작점 이후 main first-parent 커밋 중
 * Flightdeck-Epic trailer가 없거나, 그 에픽의 서명된 epic.landed.main_commit과 다른 것.
 * landed: 에픽 → 서명된 반영 커밋. allow: 어드민이 확인한 예외 커밋
 */
export function auditMain(commits: MainCommit[], landed: ReadonlyMap<string, string>, allow: readonly string[] = [], mismatched: ReadonlyMap<string, string> = new Map()): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const c of commits) {
    if (allow.some((a) => a.length >= 7 && c.sha.startsWith(a))) continue;
    const epic = c.trailers["Flightdeck-Epic"];
    if (!epic) out.push({ sha: c.sha, subject: c.subject, reason: "Flightdeck-Epic trailer가 없는 main 커밋 (반영 서버를 거치지 않음)" });
    // 설정 불일치(M5.5 Z9): 반영이 정상이었는지 판정할 수 없다. 우회와 구별해 알린다
    else if (mismatched.has(epic)) out.push({ sha: c.sha, subject: c.subject, reason: `에픽 ${epic}의 설정 불일치로 판정할 수 없음 (서버의 ${mismatched.get(epic)} 내용이 에픽 시작 때와 다름)` });
    else if (landed.get(epic) !== c.sha) out.push({ sha: c.sha, subject: c.subject, reason: `에픽 ${epic}의 서명된 반영(epic.landed)과 맞지 않는 커밋` });
  }
  return out;
}

/**
 * 코드 쓰레드 줄 옮기기 (Y2, §3.5 대체 수단 3): `git diff -U0 <rev> -- <file>`의 hunk로 rev 기준 줄 범위를 현재 줄로 옮긴다.
 * 범위가 지워지거나 바뀐 hunk와 겹치면 lost(위치 잃음)이고, 가장 가까운 줄을 돌려준다
 */
export function mapLines(diff: string, range: [number, number]): { range: [number, number]; lost: boolean } {
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    oldStart: Number(m[1]),
    oldLen: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLen: m[4] === undefined ? 1 : Number(m[4]),
  }));
  let [a, b] = range;
  let shiftA = 0;
  let shiftB = 0;
  let lost = false;
  for (const h of hunks) {
    // -U0에서 oldLen 0인 hunk는 oldStart 줄 "뒤"에 넣은 것이다
    const oldFirst = h.oldLen === 0 ? h.oldStart + 1 : h.oldStart;
    const oldLast = h.oldStart + h.oldLen - 1;
    const delta = h.newLen - h.oldLen;
    if (h.oldLen > 0 && oldFirst <= b && oldLast >= a) lost = true;
    if (oldLast < a || (h.oldLen === 0 && h.oldStart < a)) shiftA += delta;
    if (oldLast < b || (h.oldLen === 0 && h.oldStart < b)) shiftB += delta;
  }
  a = Math.max(1, a + shiftA);
  b = Math.max(a, b + shiftB);
  return { range: [a, b], lost };
}

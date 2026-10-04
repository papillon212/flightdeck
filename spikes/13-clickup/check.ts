// M2-5 실제 ClickUp 확인: 어댑터로 me → 배정된 일감 → 단계 상태 변경·reconcile → 멘션 댓글.
// 사용: CLICKUP_TOKEN=… node check.mjs <list_id> <task_id>   (토큰은 레포에 두지 않는다)
import { ClickUpTracker, reconcile } from "../../packages/tracker/src/index.ts";

const [list, task] = process.argv.slice(2) as [string, string];
const statusMap = { ANALYSIS: "분석", DESIGN: "설계", IMPLEMENTATION: "구현", VERIFICATION: "검증", DONE: "complete" } as const;
const t = new ClickUpTracker({ token: process.env.CLICKUP_TOKEN!, list_ids: [list], tag: "flightdeck", status_map: statusMap });
const map = (p: string) => (statusMap as Record<string, string>)[p];

const me = await t.me();
console.log("me", me);
const mine = await t.listAssignedEpics(me);
console.log("배정된 일감", mine.map((e) => `${e.epicId} ${e.status} ${e.title}`));
console.log("reconcile ANALYSIS", await reconcile(t, task, "ANALYSIS", map), (await t.getEpic(task)).status);
console.log("reconcile DESIGN", await reconcile(t, task, "DESIGN", map), (await t.getEpic(task)).status);
console.log("reconcile DESIGN 다시", await reconcile(t, task, "DESIGN", map));
await t.notifyMention(task, [me], "질문 1건 · analysis.md", `vscode://flightdeck/${mine[0]?.epicId ?? task}`);
console.log("멘션 댓글 남김");

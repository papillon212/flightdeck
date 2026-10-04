// M2-2 GitHub 확인: RemoteEventStore 동시 append·sync, 에픽 브랜치 공유를 실제 GitHub 원격으로 1회 돌린다.
// 사용: node check.mjs <원격 URL> <작업 폴더(/tmp 아래)>
// 시험 레포가 비어 있으면 main에 README 하나를 올린다.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "../../packages/core/src/index.ts";
import { git, GitEngine, RemoteEventStore } from "../../packages/git/src/index.ts";
import type { Event } from "../../packages/schema/src/index.ts";

const [remote, work] = process.argv.slice(2) as [string, string];
const EPIC = `CU-GH${Date.now().toString(36).toUpperCase()}`;
const ms = (t0: number) => Date.now() - t0;
const reply = (author: string, body: string): Event => ({
  v: 1, id: ulid(), type: "thread.replied", epic: EPIC, author, at: new Date().toISOString(), data: { thread: "t-AAAAAAAA", body, source: "human" },
});

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
if (!(await git(["ls-remote", remote, "refs/heads/main"], { cwd: work })).trim()) {
  const seed = path.join(work, "seed");
  await git(["init", "-q", "-b", "main", seed], { cwd: work });
  await writeFile(path.join(seed, "README.md"), "# test-flightdeck\n\nFlightdeck M2 시험용 제품 레포.\n");
  await git(["add", "."], { cwd: seed });
  await git(["commit", "-q", "-m", "시험 레포 시작"], { cwd: seed });
  await git(["push", "-q", remote, "main"], { cwd: seed });
  console.log("seed: main 생성");
}
const clone = async (name: string) => {
  const dir = path.join(work, name);
  await git(["clone", "-q", remote, dir], { cwd: work });
  return dir;
};
const a = await clone("a"), b = await clone("b");
const sa = new RemoteEventStore(a), sb = new RemoteEventStore(b);
await Promise.all([sa.sync(), sb.sync()]);

let t0 = Date.now();
await sa.append(reply("dh.lee", "첫 이벤트"));
const tAppend = ms(t0);
t0 = Date.now();
const r = await sb.sync();
console.log(`append+push ${tAppend}ms, B sync ${ms(t0)}ms`, r);

t0 = Date.now();
await Promise.all([
  ...Array.from({ length: 5 }, (_, i) => sa.append(reply("dh.lee", `a${i}`))),
  ...Array.from({ length: 5 }, (_, i) => sb.append(reply("park", `b${i}`))),
]);
await sa.sync(); await sb.sync(); await sa.sync();
const la = (await sa.list(EPIC)).map((e) => e.id), lb = (await sb.list(EPIC)).map((e) => e.id);
const parents = (await git(["rev-list", "--parents", "refs/heads/flightdeck-meta"], { cwd: a })).trim().split("\n");
console.log(`동시 10건 ${ms(t0)}ms: A ${la.length}개, B ${lb.length}개, 같음 ${JSON.stringify(la) === JSON.stringify(lb)}, 병합 커밋 ${parents.filter((l) => l.split(" ").length > 2).length}`);

const ea = new GitEngine(a), eb = new GitEngine(b);
const { path: wt } = await ea.createEpicWorktree(EPIC);
await mkdir(path.join(wt, ".flightdeck/epics", EPIC), { recursive: true });
const doc = path.join(wt, ".flightdeck/epics", EPIC, "analysis.md");
await writeFile(doc, "## 불명확한 점\n- TTL?\n");
await ea.commit(wt, [path.relative(wt, doc)], "문서 공유");
t0 = Date.now();
const c = await ea.pushEpicBranch(EPIC);
const tPush = ms(t0);
t0 = Date.now();
const v = await eb.openViewWorktree(EPIC, c);
console.log(`에픽 브랜치 push ${tPush}ms, B 읽기 전용 창 ${ms(t0)}ms, 내용 일치 ${(await readFile(path.join(v.path, ".flightdeck/epics", EPIC, "analysis.md"), "utf8")).includes("TTL?")}`);
console.log(`정리용: 에픽 ${EPIC}, 브랜치 flightdeck/${EPIC}`);

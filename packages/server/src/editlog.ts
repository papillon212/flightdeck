// 편집 기록 서버 (서버 ③, 설계 §8.6, M7 제안 E1~E8).
// - 업로드: 그 에픽의 현재 조종수(지금은 담당자)만. seq가 서버의 마지막 바로 다음부터 이어져야 한다(E1·E4).
// - 받을 때는 재적용하지 않는다. 재적용 검증은 쓸 때(출처 조회·반영 coverage) 한다(E2).
// - 반영 coverage: 공유 커밋의 Flightdeck-Seq까지의 기록을 base 위에 재적용해 그 커밋과 같은지 보고, hunk마다 출처를 분류한다(E3).
import { blame, coverage, parseImplLog, type BlameResult } from "@flightdeck/core";
import { git, gitBuffer, isCoverageTarget, seqTrailer } from "@flightdeck/git";
import { EditUpload, type EditMemo, type EditRecord, type Pipeline } from "@flightdeck/schema";
import { RequestError } from "./signer.ts";

/** 커밋의 파일 내용 (저장된 바이트 그대로). 없으면 null */
export async function blobAt(dir: string, commit: string, file: string): Promise<string | null> {
  try {
    return (await gitBuffer(["cat-file", "blob", `${commit}:${file}`], { cwd: dir })).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 편집 기록 위치를 가진 커밋. 반영 서버의 main 병합 커밋(trailer 없음, 부모 둘)은 첫 부모(검증한 커밋)를 본다:
 * 병합으로 들어온 것은 이미 main에 있던 변경이라 이 에픽의 coverage 대상이 아니다
 */
export async function seqCommit(dir: string, commit: string): Promise<{ commit: string; upto: number } | null> {
  let c = commit;
  for (let i = 0; i < 4; i++) {
    const [parents, msg] = (await git(["log", "-1", "--format=%P%x00%B", c], { cwd: dir })).split("\0") as [string, string];
    const upto = seqTrailer(msg);
    if (upto !== null) return { commit: c, upto };
    const ps = parents.trim().split(" ").filter(Boolean);
    if (ps.length !== 2 || !/^.*\(flightdeck-server\)/m.test(msg)) return null;
    c = ps[0]!;
  }
  return null;
}

export interface ServerCoverage {
  checked: boolean;
  /** checked=false: 왜 계산하지 않았나 / true: 막는 문제 */
  problems: string[];
  note?: string;
  upto?: number;
  hunks?: number;
}

/** 반영 서버의 coverage 재계산 (§7.3 6, §11.3 5, E3) */
export async function serverCoverage(o: { dir: string; epic: string; base: string; commit: string; pipeline: Pipeline; records: EditRecord[]; memos: EditMemo[] }): Promise<ServerCoverage> {
  const at = await seqCommit(o.dir, o.commit);
  if (!at) return { checked: false, problems: [], note: "편집 기록 위치(Flightdeck-Seq)가 없는 커밋 (M7 이전 에픽): 확장의 계산을 믿는다" };
  const last = o.records.at(-1)?.seq ?? 0;
  if (last < at.upto) return { checked: true, problems: [`서버 편집 기록이 커밋의 위치까지 없다 (커밋 ${at.upto}, 서버 ${last}). 담당자 확장이 아직 올리지 않았다`], upto: at.upto };
  const records = o.records.filter((r) => r.seq <= at.upto);
  const changed = (await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", o.base, at.commit], { cwd: o.dir })).split("\0").filter(Boolean);
  const gate = o.pipeline.phases.implementation.gate;
  const files = [...new Set([...changed, ...records.map((r) => r.file)])].filter((f) => isCoverageTarget(f, o.pipeline.checkpoint.exclude_secrets, gate.coverage_ignore)).sort();
  const inputs = await Promise.all(files.map(async (file) => ({ file, base: await blobAt(o.dir, o.base, file), records: records.filter((r) => r.file === file), current: await blobAt(o.dir, at.commit, file) })));
  const implLog = await blobAt(o.dir, at.commit, `.flightdeck/epics/${o.epic}/impl-log.md`);
  const loggedSteps = new Set(implLog ? parseImplLog(implLog).steps.filter((s) => s.intent && s.decision).map((s) => s.n) : []);
  const rep = coverage(inputs, { loggedSteps, memos: o.memos });
  const problems: string[] = [];
  if (rep.drift.length) problems.push(`기록 불일치: 편집 기록을 재적용한 결과가 커밋과 다르다 (${rep.drift.join(", ")})`);
  for (const h of rep.unexplained) {
    const lines = h.newLines[1] < h.newLines[0] ? `${h.newLines[0]}(삭제)` : `${h.newLines[0]}-${h.newLines[1]}`;
    problems.push(`설명 없는 변경 ${h.file}:${lines} — ${h.sources.filter((s) => !s.explained).map((s) => s.why).join(", ") || "출처 없음(기록 누락)"}`);
  }
  return { checked: true, problems, upto: at.upto, hunks: rep.hunks.length };
}

/** 업로드 묶음 검사 (형식·에픽). 작성 권한은 호출하는 쪽이 본다 */
export function parseUpload(body: unknown): EditUpload {
  const r = EditUpload.safeParse(body);
  if (!r.success) throw new RequestError(400, `편집 기록 형식: ${r.error.message.slice(0, 300)}`);
  if (r.data.records.some((x) => x.epic !== r.data.epic) || r.data.memos?.some((m) => m.epic !== r.data.epic)) throw new RequestError(400, "다른 에픽의 기록이 섞여 있다");
  return r.data;
}

/** 줄 단위 출처 (E6): rev 커밋의 편집 기록 위치까지 재적용. rev 내용과 다르면 matches=false */
export async function serverBlame(o: { dir: string; base: string; rev: string; file: string; records: EditRecord[]; memos: EditMemo[] }): Promise<BlameResult & { upto: number | null; matches: boolean }> {
  const at = await seqCommit(o.dir, o.rev);
  const upto = at?.upto ?? null;
  const base = await blobAt(o.dir, o.base, o.file);
  const b = blame(o.file, base, o.records, { ...(upto !== null ? { upto } : {}), memos: o.memos });
  return { ...b, upto, matches: b.text === (await blobAt(o.dir, at?.commit ?? o.rev, o.file)) };
}

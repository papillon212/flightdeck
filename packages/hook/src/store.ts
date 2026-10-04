// 훅이 쓰는 로컬 저장소: 상태 파일, 편집 기록, 도구 전후 스냅샷, 훅 로그.
// 위치는 모두 <git common dir>/flightdeck/ 아래다(docs/m1-plan.md).
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EditMemo, EditRecord, LocalEpicState, type LocalEpicStateInput } from "@flightdeck/schema";

export const statePath = (dataDir: string, epic: string) => path.join(dataDir, "state", `${epic}.json`);
export const editlogPath = (dataDir: string, epic: string) => path.join(dataDir, "editlog", `${epic}.jsonl`);

export async function readState(dataDir: string, epic: string): Promise<LocalEpicState> {
  return LocalEpicState.parse(JSON.parse(await readFile(statePath(dataDir, epic), "utf8")));
}

export async function writeState(dataDir: string, s: LocalEpicStateInput): Promise<void> {
  const file = statePath(dataDir, s.epic);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(LocalEpicState.parse(s), null, 2) + "\n");
  await rename(tmp, file);
}

/** 상태 파일을 잠근 채로 고친다 (훅이 여러 세션에서 동시에 불릴 수 있다) */
export async function updateState(dataDir: string, epic: string, fn: (s: LocalEpicState) => void): Promise<LocalEpicState> {
  return withLock(statePath(dataDir, epic) + ".lock", async () => {
    const s = await readState(dataDir, epic);
    fn(s);
    await writeState(dataDir, s);
    return s;
  });
}

async function withLock<T>(lockFile: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const h = await open(lockFile, "wx");
      await h.close();
      break;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`잠금 시간 초과: ${lockFile}`);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

export async function readEditLog(dataDir: string, epic: string): Promise<EditRecord[]> {
  const file = editlogPath(dataDir, epic);
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => EditRecord.parse(JSON.parse(l)));
}

/** seq를 이어서 매겨 편집 기록을 추가한다. 추가한 레코드를 돌려준다 */
export async function appendEditRecords(dataDir: string, epic: string, records: Omit<EditRecord, "seq">[]): Promise<EditRecord[]> {
  if (!records.length) return [];
  const file = editlogPath(dataDir, epic);
  await mkdir(path.dirname(file), { recursive: true });
  return withLock(file + ".lock", async () => {
    const last = (await readEditLog(dataDir, epic)).at(-1)?.seq ?? 0;
    const withSeq = records.map((r, i) => EditRecord.parse({ ...r, seq: last + i + 1 }));
    await appendFile(file, withSeq.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return withSeq;
  });
}

export const memosPath = (dataDir: string, epic: string) => path.join(dataDir, "memos", `${epic}.jsonl`);

/** 직접 수정·외부 변경 메모 (§7.4, M4 제안 X4) */
export async function readMemos(dataDir: string, epic: string): Promise<EditMemo[]> {
  const file = memosPath(dataDir, epic);
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => EditMemo.parse(JSON.parse(l)));
}

export async function appendMemo(dataDir: string, m: EditMemo): Promise<void> {
  const file = memosPath(dataDir, m.epic);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(EditMemo.parse(m)) + "\n");
}

export async function lastSeq(dataDir: string, epic: string): Promise<number> {
  return (await readEditLog(dataDir, epic)).at(-1)?.seq ?? 0;
}

const snapDir = (dataDir: string, epic: string) => path.join(dataDir, "hook", epic, "snap");

/** 도구 실행 전 상태 저장 (PreToolUse → PostToolUse). files: 상대 경로 → 내용(null=없음), tree: 셸 전 작업 트리 */
export async function saveSnapshot(dataDir: string, epic: string, toolUseId: string, snap: { files?: Record<string, string | null>; tree?: string }): Promise<void> {
  await mkdir(snapDir(dataDir, epic), { recursive: true });
  await writeFile(path.join(snapDir(dataDir, epic), `${safe(toolUseId)}.json`), JSON.stringify(snap));
}

export async function takeSnapshot(dataDir: string, epic: string, toolUseId: string): Promise<{ files?: Record<string, string | null>; tree?: string } | null> {
  const f = path.join(snapDir(dataDir, epic), `${safe(toolUseId)}.json`);
  if (!existsSync(f)) return null;
  const s = JSON.parse(await readFile(f, "utf8"));
  await rm(f, { force: true });
  return s;
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** 훅 로그: 오류와 판단 근거를 남긴다 (§6.1 "훅 오류 n건" 표시의 원천) */
export async function hookLog(dataDir: string, epic: string, entry: Record<string, unknown>): Promise<void> {
  const file = path.join(dataDir, "hook", epic, "hook-log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// 관찰자 의견 → 에이전트 전달 대기열 (설계 §8.4, M8 제안 L7).
// 조종수가 "에이전트에 전달"을 고르면 확장이 넣고, 훅이 다음 기회에 꺼낸다.
// - 일반: 실행 중이면 다음 PostToolUse의 추가 컨텍스트, 멈춰 있으면 다음 UserPromptSubmit
// - 급한 의견: 다음 PreToolUse가 그 도구 호출을 거부하고 의견을 거부 사유로 돌려준다.
//   직전 거부 1초 안에 온 호출은 같은 메시지의 나머지 호출로 보고 함께 거부한다(§8.4 "같은 메시지" 판정)
// 파일은 추가만 한다: {op: queue | delivered}. 전달된 의견은 세션 원본에 남는다(추가 컨텍스트로 들어가므로)
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Opinion {
  id: string;
  /** 의견을 낸 관찰자 */
  from: string;
  body: string;
  urgent: boolean;
  at: string;
  /** 무엇에 대한 의견인가 (대화 메시지·파일 줄) */
  target?: string;
}

const file = (dataDir: string, epic: string) => path.join(dataDir, "opinions", `${epic}.jsonl`);
const denyFile = (dataDir: string, epic: string) => path.join(dataDir, "opinions", `${epic}.deny.json`);
export const SAME_MESSAGE_MS = 1000;

export async function queueOpinion(dataDir: string, epic: string, o: Opinion): Promise<void> {
  await mkdir(path.dirname(file(dataDir, epic)), { recursive: true });
  await appendFile(file(dataDir, epic), JSON.stringify({ op: "queue", ...o }) + "\n");
}

/** 아직 전달하지 않은 의견 (넣은 순서) */
export async function pendingOpinions(dataDir: string, epic: string): Promise<Opinion[]> {
  const f = file(dataDir, epic);
  if (!existsSync(f)) return [];
  const queued = new Map<string, Opinion>();
  for (const line of (await readFile(f, "utf8")).split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as { op: string; id?: string; ids?: string[] } & Opinion;
    if (r.op === "queue") {
      const { op: _op, ...o } = r;
      queued.set(r.id, o);
    } else if (r.op === "delivered") for (const id of r.ids ?? []) queued.delete(id);
  }
  return [...queued.values()];
}

export async function markDelivered(dataDir: string, epic: string, ids: string[], via: string, at: string): Promise<void> {
  if (!ids.length) return;
  await appendFile(file(dataDir, epic), JSON.stringify({ op: "delivered", ids, via, at }) + "\n");
}

/** 전달된 기록 (확장의 의견 패널에서 "전달됨" 표시) */
export async function deliveredOpinions(dataDir: string, epic: string): Promise<{ ids: string[]; via: string; at: string }[]> {
  const f = file(dataDir, epic);
  if (!existsSync(f)) return [];
  return (await readFile(f, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.op === "delivered");
}

export function renderOpinion(o: Opinion): string {
  return `[관찰자 @${o.from} 의견 · 조종수 전달${o.urgent ? " · 급함" : ""}]${o.target ? ` (${o.target})` : ""} ${o.body}`;
}

export async function lastDeny(dataDir: string, epic: string): Promise<number> {
  const f = denyFile(dataDir, epic);
  return existsSync(f) ? Number(JSON.parse(await readFile(f, "utf8")).at) || 0 : 0;
}

export async function setLastDeny(dataDir: string, epic: string, at: number): Promise<void> {
  await mkdir(path.dirname(denyFile(dataDir, epic)), { recursive: true });
  await writeFile(denyFile(dataDir, epic), JSON.stringify({ at }));
}

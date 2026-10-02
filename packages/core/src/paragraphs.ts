// 문단 고정 ID (설계 §3.2)
// - 문서의 모든 블록(제목, 문단, 최상위 목록 항목, 코드 블록) 바로 앞 줄에 `<!-- p:xxxx -->`를 둔다.
//   들여쓴 하위 항목과 이어지는 줄은 상위 항목 블록에 속한다.
// - 쓰레드 블록(<!-- flightdeck:thread … --> ~ <!-- /flightdeck:thread -->) 안은 블록으로 보지 않는다.
// - 에이전트·사람이 ID를 지우거나 바꾸면 저장 시 검사에서 잡아 원복한다(§6.2).
import { randomBytes } from "node:crypto";
import { diffArrays } from "diff";

export const PID_LINE = /^<!-- (p:[0-9a-f]{4}) -->$/;
export const THREAD_START = /^<!-- flightdeck:thread .*-->$/;
export const THREAD_END = /^<!-- \/flightdeck:thread -->$/;
const HEADING = /^#{1,6} /;
const FENCE = /^(```|~~~)/;
/** 최상위 목록 항목. 항목마다 따로 블록이 된다(불명확한 점 항목별로 쓰레드를 달 수 있게) */
const LIST_ITEM = /^([-*+]|\d+[.)]) /;

export interface Block {
  pid: string | null;
  /** 블록 첫 줄 (0부터) */
  start: number;
  /** 블록 마지막 줄 (포함) */
  end: number;
  text: string;
}

/** 줄 배열을 블록으로 나눈다. 블록 바로 앞 줄이 ID 줄이면 그 ID를 붙인다 */
export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (THREAD_START.test(line)) {
      while (i < lines.length && !THREAD_END.test(lines[i]!)) i++;
      i++;
      continue;
    }
    if (line.trim() === "" || PID_LINE.test(line)) {
      i++;
      continue;
    }
    const start = i;
    if (HEADING.test(line)) {
      i++;
    } else if (FENCE.test(line)) {
      const fence = line.slice(0, 3);
      i++;
      while (i < lines.length && !lines[i]!.startsWith(fence)) i++;
      i++; // 닫는 펜스 포함
    } else {
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !PID_LINE.test(lines[i]!) &&
        !HEADING.test(lines[i]!) &&
        !FENCE.test(lines[i]!) &&
        !THREAD_START.test(lines[i]!) &&
        !(i > start && LIST_ITEM.test(lines[i]!))
      )
        i++;
    }
    const end = Math.min(i, lines.length) - 1;
    const prev = start > 0 ? PID_LINE.exec(lines[start - 1]!) : null;
    blocks.push({ pid: prev ? prev[1]! : null, start, end, text: lines.slice(start, end + 1).join("\n") });
  }
  return blocks;
}

function splitLines(md: string): { lines: string[]; eol: string } {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  return { lines: md.split(eol), eol };
}

/** ID가 없는 블록에 새 ID를 붙인다. 새로 붙인 ID 목록도 돌려준다 */
export function ensureParagraphIds(md: string, reserved: Iterable<string> = []): { text: string; added: string[] } {
  const { lines, eol } = splitLines(md);
  const blocks = parseBlocks(lines);
  const used = new Set<string>([...reserved, ...blocks.map((b) => b.pid).filter((p): p is string => p !== null)]);
  const added: string[] = [];
  // 뒤에서부터 끼워 넣어야 앞 블록의 줄 번호가 안 바뀐다
  for (const b of [...blocks].reverse()) {
    if (b.pid) continue;
    const pid = newPid(used);
    used.add(pid);
    added.unshift(pid);
    lines.splice(b.start, 0, `<!-- ${pid} -->`);
  }
  return { text: lines.join(eol), added };
}

function newPid(used: Set<string>): string {
  for (;;) {
    const pid = `p:${randomBytes(2).toString("hex")}`;
    if (!used.has(pid)) return pid;
  }
}

/**
 * 문단 ID 훼손. line은 새 문서에서 ID 줄을 되살릴 위치(그 줄 앞), replaceBlank면 그 앞 빈 줄을 ID 줄로 바꾼다.
 */
export type PidViolation =
  | { kind: "duplicate"; pid: string }
  | { kind: "removed"; pid: string; line: number; replaceBlank: boolean } // 블록 일부라도 남았는데 ID가 사라짐
  | { kind: "changed"; from: string; to: string; line: number }; // ID 줄이 다른 새 ID로 바뀜 (line = 그 ID 줄)

/**
 * 줄 단위 diff로 이전 문서의 각 줄이 새 문서의 몇 번째 줄로 남았는지(없으면 null), 새 문서의 각 줄이 새로 생긴 줄인지,
 * 그리고 제자리 수정(지운 줄들 바로 그 자리에 새 줄들이 들어옴)이면 이전 줄 → 대신 들어온 새 줄 범위를 구한다.
 */
function lineMap(prev: string[], next: string[]): { toNext: (number | null)[]; added: boolean[]; replacedBy: ([number, number] | null)[] } {
  const toNext: (number | null)[] = new Array(prev.length).fill(null);
  const added: boolean[] = new Array(next.length).fill(false);
  const replacedBy: ([number, number] | null)[] = new Array(prev.length).fill(null);
  let i = 0;
  let j = 0;
  let removedRun: [number, number] | null = null; // 직전 removed 묶음의 이전 줄 범위
  let addedRun: [number, number] | null = null; // 직전 added 묶음의 새 줄 범위
  for (const part of diffArrays(prev, next)) {
    const n = part.count ?? part.value.length;
    if (part.added) {
      for (let k = 0; k < n; k++) added[j + k] = true;
      if (removedRun) for (let k = removedRun[0]; k < removedRun[1]; k++) replacedBy[k] = [j, j + n];
      addedRun = removedRun ? null : [j, j + n];
      removedRun = null;
      j += n;
    } else if (part.removed) {
      if (addedRun) for (let k = i; k < i + n; k++) replacedBy[k] = addedRun;
      removedRun = addedRun ? null : [i, i + n];
      addedRun = null;
      i += n;
    } else {
      for (let k = 0; k < n; k++) toNext[i + k] = j + k;
      removedRun = addedRun = null;
      i += n;
      j += n;
    }
  }
  return { toNext, added, replacedBy };
}

/**
 * 저장 전후 문서를 비교해 문단 ID 훼손을 찾는다 (설계 §3.2, §6.2).
 * 줄 단위 diff로 이전 블록의 줄이 새 문서에 남았는지 본다.
 * - ID가 사라졌는데 그 블록의 줄이 하나라도 남았으면 훼손(removed). 남은 첫 줄 앞에 되살린다.
 * - 블록의 줄이 하나도 남지 않았으면 블록을 통째로 지운 것이라 훼손이 아니다(그 ID의 쓰레드는 위치를 잃는다).
 * - ID 줄이 이전에 없던 ID로 바뀌었으면 changed.
 */
export function checkParagraphIds(prev: string, next: string): PidViolation[] {
  const pl = splitLines(prev).lines;
  const nl = splitLines(next).lines;
  const before = parseBlocks(pl).filter((b) => b.pid);
  const after = parseBlocks(nl);
  const beforePids = new Set(before.map((b) => b.pid!));
  const out: PidViolation[] = [];

  const seen = new Map<string, number>();
  for (const b of after) if (b.pid) seen.set(b.pid, (seen.get(b.pid) ?? 0) + 1);
  for (const [pid, n] of seen) if (n > 1) out.push({ kind: "duplicate", pid });

  const { toNext, added, replacedBy } = lineMap(pl, nl);
  const claimed = new Set<number>(); // 이미 다른 ID 복원 위치로 쓴 새 블록 시작 줄
  for (const b of before) {
    if (seen.has(b.pid!)) continue;
    const surviving: number[] = [];
    for (let k = b.start; k <= b.end; k++) {
      const j = toNext[k];
      if (j !== null && j !== undefined) surviving.push(j);
    }
    if (!surviving.length) {
      // 제자리 수정: 블록 줄들이 지워진 바로 그 자리에 새 줄이 들어왔으면, 그중 ID 없는 첫 블록이 이 블록의 새 모습이다
      const range = replacedBy[b.start];
      const host = range && after.find((a) => a.start >= range[0] && a.start < range[1] && a.pid === null && !claimed.has(a.start));
      if (!host) continue; // 블록을 통째로 지움 (그 자리에 들어온 내용이 없음)
      claimed.add(host.start);
      surviving.push(host.start);
    }
    const first = surviving[0]!;
    const host = after.find((a) => first >= a.start && first <= a.end);
    if (host && host.start === first && host.pid && !beforePids.has(host.pid)) {
      out.push({ kind: "changed", from: b.pid!, to: host.pid, line: first - 1 });
      continue;
    }
    // ID 줄 내용만 지워 빈 줄이 남았으면 그 빈 줄을 ID 줄로 바꾼다 (빈 줄이 하나 더 생기지 않게)
    const replaceBlank = first > 0 && nl[first - 1] === "" && added[first - 1] === true;
    out.push({ kind: "removed", pid: b.pid!, line: first, replaceBlank });
  }
  return out;
}

/**
 * 문단 ID 훼손을 고친다 (설계 §3.2 "저장할 때 확장이 검사해 복원한다").
 * 사라진 ID는 그 블록의 남은 첫 줄 앞에 되살리고, 바뀐 ID는 원래 ID로 되돌리고,
 * 중복 ID는 원래 블록 쪽만 남긴다(복사해 붙인 쪽은 렌더링 때 새 ID를 받는다). 같은 저장의 다른 편집은 그대로 둔다.
 */
export function restoreParagraphIds(prev: string, next: string): { text: string; restored: PidViolation[] } {
  const violations = checkParagraphIds(prev, next);
  if (!violations.length) return { text: next, restored: [] };
  const { lines, eol } = splitLines(next);
  const blocks = parseBlocks(lines);
  const ops: { line: number; kind: "insert" | "replace" | "delete"; text?: string }[] = [];
  for (const v of violations) {
    if (v.kind === "removed") {
      if (v.replaceBlank) ops.push({ line: v.line - 1, kind: "replace", text: `<!-- ${v.pid} -->` });
      else ops.push({ line: v.line, kind: "insert", text: `<!-- ${v.pid} -->` });
    } else if (v.kind === "changed") {
      ops.push({ line: v.line, kind: "replace", text: `<!-- ${v.from} -->` });
    } else {
      const dup = blocks.filter((x) => x.pid === v.pid);
      const orig = parseBlocks(splitLines(prev).lines).find((x) => x.pid === v.pid);
      const keep = dup.find((x) => orig && x.text.trim() === orig.text.trim()) ?? dup[0];
      for (const b of dup) if (b !== keep) ops.push({ line: b.start - 1, kind: "delete" });
    }
  }
  for (const op of ops.sort((a, b) => b.line - a.line)) {
    if (op.kind === "insert") lines.splice(op.line, 0, op.text!);
    else if (op.kind === "replace") lines[op.line] = op.text!;
    else lines.splice(op.line, 1);
  }
  return { text: lines.join(eol), restored: violations };
}


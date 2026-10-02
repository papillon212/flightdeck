// 문단 고정 ID (설계 §3.2)
// - 문서의 모든 블록(제목, 문단, 최상위 목록 항목, 코드 블록) 바로 앞 줄에 `<!-- p:xxxx -->`를 둔다.
//   들여쓴 하위 항목과 이어지는 줄은 상위 항목 블록에 속한다.
// - 쓰레드 블록(<!-- flightdeck:thread … --> ~ <!-- /flightdeck:thread -->) 안은 블록으로 보지 않는다.
// - 에이전트·사람이 ID를 지우거나 바꾸면 저장 시 검사에서 잡아 원복한다(§6.2).
import { randomBytes } from "node:crypto";

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

export type PidViolation =
  | { kind: "duplicate"; pid: string }
  | { kind: "removed"; pid: string; text: string } // 내용은 남았는데 ID만 사라짐
  | { kind: "changed"; from: string; to: string; text: string }; // 같은 내용인데 ID가 바뀜

/**
 * 문단 ID 훼손을 고친다 (설계 §3.2 "저장할 때 확장이 검사해 복원한다").
 * 사라진 ID는 그 블록 앞에 다시 넣고, 바뀐 ID는 원래 ID로 되돌리고, 중복 ID는 뒤쪽 것을 지운다(새 ID는 렌더링 때 붙는다).
 * 같은 저장에 들어 있던 다른 편집은 그대로 둔다.
 */
export function restoreParagraphIds(prev: string, next: string): { text: string; restored: PidViolation[] } {
  const violations = checkParagraphIds(prev, next);
  if (!violations.length) return { text: next, restored: [] };
  const { lines, eol } = splitLines(next);
  const blocks = parseBlocks(lines);
  const used = new Set<Block>();
  const ops: { line: number; kind: "insert" | "replace" | "delete"; text?: string }[] = [];
  for (const v of violations) {
    if (v.kind === "removed") {
      const b = blocks.find((x) => !used.has(x) && x.pid === null && x.text.trim() === v.text.trim());
      if (b) {
        used.add(b);
        ops.push({ line: b.start, kind: "insert", text: `<!-- ${v.pid} -->` });
      }
    } else if (v.kind === "changed") {
      const b = blocks.find((x) => !used.has(x) && x.pid === v.to && x.text.trim() === v.text.trim());
      if (b) {
        used.add(b);
        ops.push({ line: b.start - 1, kind: "replace", text: `<!-- ${v.from} -->` });
      }
    } else {
      const dup = blocks.filter((x) => x.pid === v.pid);
      // 원래 내용과 같은 블록의 ID는 남기고 나머지(복사해 붙인 쪽)의 ID 줄을 지운다
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

/**
 * 저장 전후 문서를 비교해 문단 ID 훼손을 찾는다 (설계 §6.2).
 * 블록을 통째로 지운 것은 위반이 아니다(그 ID를 가리키던 쓰레드는 고아가 된다).
 */
export function checkParagraphIds(prev: string, next: string): PidViolation[] {
  const before = parseBlocks(splitLines(prev).lines).filter((b) => b.pid);
  const after = parseBlocks(splitLines(next).lines);
  const out: PidViolation[] = [];

  const seen = new Map<string, number>();
  for (const b of after) if (b.pid) seen.set(b.pid, (seen.get(b.pid) ?? 0) + 1);
  for (const [pid, n] of seen) if (n > 1) out.push({ kind: "duplicate", pid });

  const afterByPid = new Map(after.filter((b) => b.pid).map((b) => [b.pid!, b]));
  for (const b of before) {
    if (afterByPid.has(b.pid!)) continue;
    const same = after.find((a) => a.text.trim() === b.text.trim());
    if (!same) continue; // 블록이 지워졌거나 내용이 바뀜: 위반 아님
    if (same.pid) out.push({ kind: "changed", from: b.pid!, to: same.pid, text: b.text });
    else out.push({ kind: "removed", pid: b.pid!, text: b.text });
  }
  return out;
}

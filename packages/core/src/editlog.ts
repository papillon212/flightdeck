// 편집 기록 (설계 §3.5, §8.6).
// - 오프셋은 UTF-16 code unit(JS 문자열 인덱스, VS Code와 같은 기준)이다.
// - base_hash는 편집 직전 파일 디스크 바이트(UTF-8)의 sha256이다. 파일이 없었으면 null.
// - 한 레코드의 range는 그 레코드 직전 상태 기준이다. 레코드는 순서대로 하나씩 적용한다.
import { diffLines } from "diff";
import type { EditRecord } from "@flightdeck/schema";
import { sha256 } from "./util.ts";

export interface TextEdit {
  range: [number, number];
  insert: string;
}

/** 텍스트에 편집 하나를 적용한다 */
export function applyTextEdit(text: string, e: TextEdit): string {
  const [s, t] = e.range;
  if (s < 0 || t < s || t > text.length) throw new RangeError(`범위 밖 편집 [${s}, ${t}) (길이 ${text.length})`);
  return text.slice(0, s) + e.insert + text.slice(t);
}

/** 순서대로 적용한다 (각 편집의 range는 직전 편집이 적용된 뒤의 좌표) */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  return edits.reduce(applyTextEdit, text);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 공통 앞·뒤를 뺀 최소 교체 1건. 서로게이트 쌍을 자르지 않는다 */
function trimEdit(before: string, after: string, offset: number): TextEdit | null {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  if (s > 0 && isLow(before.charCodeAt(before.length - s))) s--;
  if (p === before.length - s && p === after.length - s) return null;
  return { range: [offset + p, offset + before.length - s], insert: after.slice(p, after.length - s) };
}

/**
 * 변경 전후 내용을 편집 목록으로 바꾼다 (설계 §8.6 "범위는 잘게 나눈다").
 * 줄 단위 diff로 바뀐 덩어리를 찾고, 덩어리마다 글자 단위로 공통 앞뒤를 뺀다.
 * 반환하는 편집은 앞에서부터 순서대로 적용하는 좌표다.
 */
export function diffToEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const edits: TextEdit[] = [];
  let pos = 0; // 지금까지 편집을 적용한 문서에서의 위치
  let removed = "";
  let added = "";
  const flush = () => {
    if (!removed && !added) return;
    const e = trimEdit(removed, added, pos);
    if (e) edits.push(e);
    pos += added.length;
    removed = "";
    added = "";
  };
  for (const part of diffLines(before, after)) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else {
      flush();
      pos += part.value.length;
    }
  }
  flush();
  return edits;
}

export interface ReplayResult {
  files: Map<string, string | null>;
  /** base_hash가 재적용 상태와 맞지 않은 레코드 (순서 검증 실패, §8.6) */
  mismatches: { seq: number; file: string; expected: string | null; actual: string | null }[];
}

/** base 상태에서 편집 기록을 seq 순서로 재적용한다 */
export function replay(base: Map<string, string | null>, records: EditRecord[]): ReplayResult {
  const files = new Map(base);
  const mismatches: ReplayResult["mismatches"] = [];
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    const cur = files.get(r.file) ?? null;
    const actual = sha256(cur);
    // 기준이 다른 기록은 다른 내용 위에서 만든 편집이라 적용하면 엉뚱한 결과가 된다(범위 밖이면 예외). 건너뛰고 알린다
    // (M2 실측: 같은 렌더링이 동시에 두 번 기록된 경우)
    if (actual !== r.base_hash) {
      mismatches.push({ seq: r.seq, file: r.file, expected: r.base_hash, actual });
      continue;
    }
    if (r.delete_file) {
      files.set(r.file, null);
      continue;
    }
    files.set(r.file, applyTextEdit(cur ?? "", r));
  }
  return { files, mismatches };
}

/**
 * 연속된 편집을 하나로 묶는다 (설계 §8.6 "IME 이벤트 묶음").
 * 같은 파일·같은 출처의 다음 편집이 windowMs 안에 오고, 직전 편집이 넣은 구간(바로 뒤까지) 안에서 일어나면 합친다.
 * 묶은 결과를 순서대로 적용한 결과는 원래 편집들을 적용한 결과와 같다.
 */
export function coalesce<T extends EditRecord>(records: T[], windowMs = 300): T[] {
  const out: T[] = [];
  for (const r of records) {
    const prev = out.at(-1);
    if (prev && canMerge(prev, r, windowMs)) out[out.length - 1] = merge(prev, r);
    else out.push(r);
  }
  return out;
}

function sameSource(a: EditRecord, b: EditRecord): boolean {
  return JSON.stringify(a.source) === JSON.stringify(b.source);
}

function canMerge(a: EditRecord, b: EditRecord, windowMs: number): boolean {
  if (a.file !== b.file || a.delete_file || b.delete_file || !sameSource(a, b)) return false;
  if (Date.parse(b.ts) - Date.parse(a.ts) > windowMs) return false;
  const insStart = a.range[0];
  const insEnd = a.range[0] + a.insert.length;
  // b가 a가 넣은 구간 안(양 끝 포함)에서 시작해야 한다. 끝은 그 뒤로 넘어가도 된다(원문 일부를 더 지움)
  return b.range[0] >= insStart && b.range[0] <= insEnd && b.range[1] >= b.range[0];
}

function merge<T extends EditRecord>(a: T, b: T): T {
  const insStart = a.range[0];
  const insEnd = insStart + a.insert.length;
  const extra = Math.max(0, b.range[1] - insEnd); // a가 넣은 구간 뒤로 b가 더 지운 원문 길이
  const inserted = a.insert;
  const relStart = b.range[0] - insStart;
  const relEnd = Math.min(b.range[1], insEnd) - insStart;
  const insert = inserted.slice(0, relStart) + b.insert + inserted.slice(relEnd);
  return { ...a, range: [a.range[0], a.range[1] + extra], insert, ts: b.ts };
}

/**
 * 앵커 범위 [a, b)를 편집 하나에 맞춰 옮긴다 (설계 §3.5).
 * - 편집이 범위 앞이면 밀리고, 뒤면 그대로다.
 * - 범위 바로 앞(a 위치)에 끼워 넣은 글은 범위에 포함하지 않고, 바로 뒤(b 위치)에 넣은 글도 포함하지 않는다.
 * - 편집이 범위와 겹치면 touched, 범위가 모두 지워지면 collapsed.
 */
export function transformRange(range: [number, number], e: TextEdit): { range: [number, number]; touched: boolean; collapsed: boolean } {
  const [a, b] = range;
  const [s, t] = e.range;
  const L = e.insert.length;
  const d = L - (t - s);
  const mapStart = (x: number) => (x < s ? x : x >= t ? x + d : s);
  const mapEnd = (x: number) => (x <= s ? x : x >= t ? x + d : s + L);
  const na = mapStart(a);
  let nb = mapEnd(b);
  if (nb < na) nb = na;
  const touched = s < b && t > a;
  return { range: [na, nb], touched, collapsed: na === nb && a !== b };
}

/** 편집 기록을 따라 앵커를 seq 시점에서 현재로 옮긴다 */
export function transformAnchor(
  anchor: { file: string; seq: number; start: number; end: number },
  records: EditRecord[],
): { file: string; seq: number; start: number; end: number; touched: boolean; collapsed: boolean; deleted: boolean } {
  let range: [number, number] = [anchor.start, anchor.end];
  let touched = false;
  let collapsed = false;
  let deleted = false;
  let seq = anchor.seq;
  for (const r of [...records].sort((x, y) => x.seq - y.seq)) {
    if (r.seq <= anchor.seq || r.file !== anchor.file) continue;
    seq = r.seq;
    if (r.delete_file) {
      deleted = true;
      continue;
    }
    const m = transformRange(range, r);
    range = m.range;
    touched ||= m.touched;
    collapsed ||= m.collapsed;
  }
  return { file: anchor.file, seq, start: range[0], end: range[1], touched, collapsed, deleted };
}

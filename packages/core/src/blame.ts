// 줄 단위 출처와 편집 기록 기반 위치 이동 (설계 §8.6 "제공하는 조회", §3.5, M7 제안 E5·E6).
// - blame: base에서 편집 기록을 재적용해 줄마다 마지막으로 그 줄을 만든(고친) 편집을 찾는다.
// - moveLines: rev 시점(seq n)의 줄 범위를 그 뒤 편집 기록으로 옮긴다. diff 줄 매핑과 달리 그 줄 자체가 고쳐져도 따라간다.
import type { EditMemo, EditRecord } from "@flightdeck/schema";
import { provenance, type Origin, type ProvenanceResult } from "./coverage.ts";
import { replay, transformRange } from "./editlog.ts";

/** 한 편집의 출처 요약 (hover·서버 조회 응답) */
export interface BlameEntry {
  seq: number;
  ts: string;
  kind: Origin["source"]["kind"];
  member?: string;
  run?: string;
  step?: number;
  thread?: string;
  commit?: string;
  cmd?: string;
  /** 그 편집을 덮는 직접 수정 메모 (§7.4) */
  memo?: string;
}

export function blameEntry(file: string, o: Origin, memos: readonly EditMemo[] = []): BlameEntry {
  const s = o.source;
  const e: BlameEntry = { seq: o.seq, ts: o.ts, kind: s.kind };
  if ("member" in s) e.member = s.member;
  if ("run" in s) e.run = s.run;
  if ("step" in s && s.step !== undefined) e.step = s.step;
  if (s.kind === "patch") e.thread = s.thread;
  if (s.kind === "external" && s.commit) e.commit = s.commit;
  if (s.kind === "agent_shell") e.cmd = s.cmd;
  const memo = memos.find((m) => m.file === file && m.seqs[0] <= o.seq && o.seq <= m.seqs[1]);
  if (memo) e.memo = memo.memo;
  return e;
}

/** 줄(1부터)마다 그 줄의 문자를 만든 출처들 (seq 순). 지운 자리 표시는 그 자리의 줄에 붙는다 */
export function lineOrigins(p: ProvenanceResult): Origin[][] {
  const text = p.text ?? "";
  const lineCount = text.split("\n").length;
  const out: Map<number, Origin>[] = Array.from({ length: lineCount }, () => new Map());
  let line = 0;
  for (const seg of p.segs) {
    if (!seg.text.length) {
      if (seg.origin) out[Math.min(line, lineCount - 1)]!.set(seg.origin.seq, seg.origin);
      continue;
    }
    for (const part of seg.text.split(/(?<=\n)/)) {
      if (seg.origin && part.length) out[Math.min(line, lineCount - 1)]!.set(seg.origin.seq, seg.origin);
      if (part.endsWith("\n")) line++;
    }
  }
  return out.map((m) => [...m.values()].sort((a, b) => a.seq - b.seq));
}

export interface BlameResult {
  /** 재적용 결과 (null = 파일 없음) */
  text: string | null;
  /** 줄마다 마지막 출처 (null = base에 원래 있던 줄) */
  lines: (BlameEntry | null)[];
  /** base_hash가 맞지 않아 건너뛴 기록 (기록 불일치) */
  mismatches: number[];
}

/** 한 파일의 줄 단위 출처 (§8.6). records는 그 파일의 기록, upto는 그 seq까지만 */
export function blame(file: string, base: string | null, records: EditRecord[], opts: { upto?: number; memos?: readonly EditMemo[] } = {}): BlameResult {
  const p = provenance(base, records.filter((r) => r.file === file), opts.upto);
  const lines = lineOrigins(p).map((os) => (os.length ? blameEntry(file, os.at(-1)!, opts.memos) : null));
  return { text: p.text, lines: p.text === null ? [] : lines, mismatches: p.mismatches };
}

/**
 * 줄 범위 [a, b](1부터, 양 끝 포함) → 문자 오프셋 [시작, 끝). 끝은 끝 줄의 줄바꿈까지 포함한다(다음 줄 시작).
 * 그래야 줄 끝에 덧붙인 수정도 그 줄 안의 수정으로 옮겨진다
 */
export function linesToOffsets(text: string, [a, b]: [number, number]): [number, number] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const at = (l: number) => starts[Math.max(0, Math.min(l - 1, starts.length - 1))]!;
  const end = (l: number) => (l < starts.length ? starts[l]! : text.length);
  return [at(a), Math.max(at(a), end(Math.min(b, starts.length)))];
}

/** 문자 오프셋 [s, e) → 줄 범위 [a, b] (1부터). 끝이 줄바꿈 바로 뒤면 그 줄까지 */
export function offsetsToLines(text: string, [s, e]: [number, number]): [number, number] {
  const lineAt = (off: number) => text.slice(0, off).split("\n").length;
  const last = e > s && text[e - 1] === "\n" ? e - 1 : Math.max(s, e);
  return [lineAt(s), lineAt(last)];
}

export interface MovedLines {
  range: [number, number];
  /** 범위 전체가 지워졌다 (가장 가까운 줄) */
  lost: boolean;
  /** 범위 안이 고쳐졌다 */
  touched: boolean;
  /** 편집 기록을 끝까지 적용한 내용 (null = 파일 삭제). 작업 트리와 다르면 기록되지 않은 변경이 있다 */
  text: string | null;
}

/**
 * rev 시점 파일(revText, 편집 기록 seq n까지 재적용한 내용과 같아야 한다)의 줄 범위를 seq > n 편집 기록으로 옮긴다 (§3.5 1번, E5).
 * 기록이 rev 내용과 이어지지 않으면(base_hash 불일치) null: 호출하는 쪽이 diff 줄 매핑으로 대신한다
 */
export function moveLines(file: string, revText: string, seq: number, records: EditRecord[], range: [number, number]): MovedLines | null {
  const after = records.filter((r) => r.file === file && r.seq > seq).sort((a, b) => a.seq - b.seq);
  const r = replay(new Map([[file, revText]]), after);
  if (r.mismatches.length) return null;
  const final = r.files.get(file);
  if (final === null || final === undefined) return { range, lost: true, touched: true, text: null };
  let off = linesToOffsets(revText, range);
  let touched = false;
  let collapsed = false;
  for (const rec of after) {
    if (rec.delete_file) continue;
    const m = transformRange(off, rec);
    off = m.range;
    touched ||= m.touched;
    collapsed ||= m.collapsed;
  }
  const lines = offsetsToLines(final, off);
  return { range: lines, lost: collapsed && off[0] === off[1], touched, text: final };
}

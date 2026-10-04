// 출처 추적과 coverage (설계 §7.3, §7.4, M4 제안 X3·X4·X8).
// base 내용에서 편집 기록을 순서대로 재적용하며 문자마다 그 문자를 만든 편집(출처)을 붙인다.
// 지운 자리에는 길이 0인 삭제 표시를 남긴다(지운 것도 변경이다). 최종 diff(base → 현재)의 hunk마다
// 그 안의 출처를 모아, 모두 설명되면(Step·메모·Flightdeck 렌더링·수정 제안) 통과한다.
import { diffLines } from "diff";
import type { EditMemo, EditRecord, EditSource } from "@flightdeck/schema";
import { sha256 } from "./util.ts";

/** 문자 구간의 출처. origin null = base에 원래 있던 내용 */
export interface Seg {
  text: string;
  origin: Origin | null;
}

export interface Origin {
  seq: number;
  ts: string;
  source: EditSource;
}

export interface ProvenanceResult {
  /** 재적용 결과 (null = 파일 없음) */
  text: string | null;
  segs: Seg[];
  /** base_hash가 맞지 않아 건너뛴 기록 */
  mismatches: number[];
}

/** 같은 일을 한 출처끼리 같은 키 (자기 편집을 자기가 지운 것은 삭제 표시를 남기지 않는다) */
export function sourceKey(s: EditSource): string {
  switch (s.kind) {
    case "agent":
    case "agent_shell":
      return `agent:${s.run}:${s.step ?? "-"}`;
    case "human":
      return `human:${s.member}`;
    case "patch":
      return `patch:${s.thread}`;
    case "flightdeck":
      return "flightdeck";
    case "external":
      return `external:${s.commit ?? "unknown"}`;
    case "restore":
      return `restore:${s.ckpt}`;
  }
}

/** segs의 [s, t)를 insert(출처 o)로 바꾼다 */
function applySegs(segs: Seg[], s: number, t: number, insert: string, o: Origin): Seg[] {
  const before: Seg[] = [];
  const removed: Seg[] = [];
  const after: Seg[] = [];
  let pos = 0;
  for (const seg of segs) {
    const end = pos + seg.text.length;
    if (seg.text.length === 0) {
      // 삭제 표시: 지우는 범위의 안쪽에 있으면 지워지는 쪽, 아니면 위치대로
      if (pos <= s) before.push(seg);
      else if (pos >= t) after.push(seg);
      else removed.push(seg);
      continue;
    }
    if (end <= s) before.push(seg);
    else if (pos >= t) after.push(seg);
    else {
      if (pos < s) before.push({ text: seg.text.slice(0, s - pos), origin: seg.origin });
      removed.push({ text: seg.text.slice(Math.max(0, s - pos), Math.min(seg.text.length, t - pos)), origin: seg.origin });
      if (end > t) after.push({ text: seg.text.slice(t - pos), origin: seg.origin });
    }
    pos = end;
  }
  const key = sourceKey(o.source);
  const mid: Seg[] = [];
  // 지운 것 중 다른 출처가 만든 내용·표시가 있으면 이 편집의 삭제 표시를 남긴다. 다른 출처의 삭제 표시도 그대로 둔다
  const foreign = removed.filter((r) => r.origin === null || sourceKey(r.origin.source) !== key);
  if (foreign.some((r) => r.text.length > 0)) mid.push({ text: "", origin: o });
  for (const r of foreign) if (r.text.length === 0) mid.push(r);
  if (insert) mid.push({ text: insert, origin: o });
  return merge([...before, ...mid, ...after]);
}

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const prev = out.at(-1);
    if (prev && s.text && prev.text && prev.origin === s.origin) prev.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * 한 파일의 출처를 계산한다. records는 그 파일의 기록(순서 무관, seq로 정렬).
 * 복원 기록(source.kind=restore)은 그 체크포인트 시점(seq)의 출처를 되살린다. 내용이 맞지 않으면 복원 기록 자신이 출처다
 */
export function provenance(base: string | null, records: EditRecord[], uptoSeq = Infinity): ProvenanceResult {
  const sorted = [...records].filter((r) => r.seq <= uptoSeq).sort((a, b) => a.seq - b.seq);
  let text = base;
  let segs: Seg[] = base ? [{ text: base, origin: null }] : [];
  const mismatches: number[] = [];
  for (const r of sorted) {
    if (sha256(text) !== r.base_hash) {
      mismatches.push(r.seq);
      continue;
    }
    const o: Origin = { seq: r.seq, ts: r.ts, source: r.source };
    if (r.delete_file) {
      text = null;
      segs = [{ text: "", origin: o }];
      continue;
    }
    const cur = text ?? "";
    const next = cur.slice(0, r.range[0]) + r.insert + cur.slice(r.range[1]);
    if (r.source.kind === "restore") {
      const at = provenance(base, records, r.source.seq);
      if (at.text === next) {
        text = next;
        segs = at.segs;
        continue;
      }
    }
    segs = applySegs(segs, r.range[0], r.range[1], r.insert, o);
    text = next;
  }
  return { text, segs, mismatches };
}

export interface HunkSource {
  origin: Origin;
  explained: boolean;
  /** 설명: "Step 3", "메모", "Flightdeck", "수정 제안 t-…" 또는 설명이 안 되는 이유 */
  why: string;
}

export interface Hunk {
  file: string;
  /** base 쪽 줄 [시작, 끝] (1부터, 없으면 시작=끝+1 꼴의 빈 범위) */
  oldLines: [number, number];
  /** 현재 쪽 줄 [시작, 끝] (1부터). 지우기만 했으면 끝 < 시작 */
  newLines: [number, number];
  sources: HunkSource[];
  explained: boolean;
}

export interface CoverageContext {
  /** impl-log에 기록된(글이 채워진) Step 번호 */
  loggedSteps: ReadonlySet<number>;
  memos: EditMemo[];
}

/** 출처 하나가 설명되는가 (§7.3 4: 설명 없는 변경의 정의) */
export function classify(file: string, o: Origin, ctx: CoverageContext): HunkSource {
  const memo = ctx.memos.find((m) => m.file === file && m.seqs[0] <= o.seq && o.seq <= m.seqs[1]);
  const s = o.source;
  switch (s.kind) {
    case "agent":
    case "agent_shell":
      if (s.step !== undefined && ctx.loggedSteps.has(s.step)) return { origin: o, explained: true, why: `Step ${s.step}` };
      if (memo) return { origin: o, explained: true, why: "메모" };
      return { origin: o, explained: false, why: s.step === undefined ? "Step 밖의 에이전트 편집" : `기록되지 않은 Step ${s.step}의 에이전트 편집` };
    case "flightdeck":
      return { origin: o, explained: true, why: "Flightdeck" };
    case "patch":
      return { origin: o, explained: true, why: `수정 제안 ${s.thread}` };
    case "human":
      return memo ? { origin: o, explained: true, why: "메모" } : { origin: o, explained: false, why: `메모 없는 직접 수정 (@${s.member})` };
    case "external":
      return memo ? { origin: o, explained: true, why: "메모" } : { origin: o, explained: false, why: "메모 없는 외부 변경 (Flightdeck 밖)" };
    case "restore":
      return memo ? { origin: o, explained: true, why: "메모" } : { origin: o, explained: false, why: "출처를 되살리지 못한 복원" };
  }
}

/** base → 현재의 줄 단위 hunk와 각 hunk의 출처 */
export function fileHunks(file: string, base: string | null, p: ProvenanceResult, ctx: CoverageContext): Hunk[] {
  const cur = p.text ?? "";
  // 지점(오프셋) → 그 지점의 출처들
  const origins = (a: number, b: number): Origin[] => {
    const out = new Map<number, Origin>();
    let pos = 0;
    for (const seg of p.segs) {
      const end = pos + seg.text.length;
      const hit = seg.text.length ? pos < b && end > a : pos >= a && pos <= b;
      if (hit && seg.origin) out.set(seg.origin.seq, seg.origin);
      pos = end;
    }
    return [...out.values()].sort((x, y) => x.seq - y.seq);
  };
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let newOff = 0;
  let pending: { oldStart: number; newStart: number; offStart: number; oldN: number; newN: number; newLen: number } | null = null;
  const flush = () => {
    if (!pending) return;
    const { oldStart, newStart, offStart, oldN, newN, newLen } = pending;
    const sources = origins(offStart, offStart + newLen).map((o) => classify(file, o, ctx));
    // 출처가 하나도 없는 변경은 기록 누락이다 (설명 없음)
    hunks.push({ file, oldLines: [oldStart, oldStart + oldN - 1], newLines: [newStart, newStart + newN - 1], sources, explained: sources.length > 0 && sources.every((s) => s.explained) });
    pending = null;
  };
  for (const part of diffLines(base ?? "", cur)) {
    const n = part.count ?? part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
    if (!part.added && !part.removed) {
      flush();
      oldLine += n;
      newLine += n;
      newOff += part.value.length;
      continue;
    }
    pending ??= { oldStart: oldLine, newStart: newLine, offStart: newOff, oldN: 0, newN: 0, newLen: 0 };
    if (part.removed) {
      pending.oldN += n;
      oldLine += n;
    } else {
      pending.newN += n;
      pending.newLen += part.value.length;
      newLine += n;
      newOff += part.value.length;
    }
  }
  flush();
  return hunks;
}

export interface FileCoverageInput {
  file: string;
  base: string | null;
  records: EditRecord[];
}

export interface CoverageReport {
  hunks: Hunk[];
  unexplained: Hunk[];
  /** 설명된 hunk 비율 (hunk가 없으면 1) */
  ratio: number;
  /** 메모가 필요한 수정 묶음 (§7.4) */
  groups: MemoGroup[];
  /** 재적용 결과가 현재 내용과 다른 파일 (외부 변경을 먼저 기록해야 한다) */
  drift: string[];
}

export interface MemoGroup {
  file: string;
  kind: "human" | "external" | "restore" | "agent";
  /** 묶음의 첫·마지막 편집 기록 seq */
  seqs: [number, number];
  /** 이 묶음이 걸린 hunk의 현재 줄 범위 */
  lines: [number, number][];
  who: string;
}

const GROUP_GAP_MS = 2 * 60_000;

/**
 * coverage 계산 (§7.3). current: 파일의 현재(디스크) 내용. 재적용 결과와 다르면 drift로 알린다.
 * 같은 파일·같은 종류의 연속된 설명 없는 편집(2분 이내)을 수정 묶음으로 묶는다
 */
export function coverage(files: (FileCoverageInput & { current: string | null })[], ctx: CoverageContext): CoverageReport {
  const hunks: Hunk[] = [];
  const drift: string[] = [];
  for (const f of files) {
    const p = provenance(f.base, f.records);
    if (p.text !== f.current) drift.push(f.file);
    hunks.push(...fileHunks(f.file, f.base, p, ctx));
  }
  const unexplained = hunks.filter((h) => !h.explained);
  const groups: MemoGroup[] = [];
  const byFile = new Map<string, { o: Origin; lines: [number, number] }[]>();
  for (const h of unexplained) {
    for (const s of h.sources.filter((x) => !x.explained)) {
      const list = byFile.get(h.file) ?? [];
      list.push({ o: s.origin, lines: h.newLines });
      byFile.set(h.file, list);
    }
  }
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.o.seq - b.o.seq);
    let g: MemoGroup | null = null;
    let lastTs = 0;
    for (const { o, lines } of list) {
      const kind = o.source.kind === "agent_shell" ? "agent" : (o.source.kind as MemoGroup["kind"]);
      const who = "member" in o.source ? `@${o.source.member}` : "Flightdeck 밖";
      const ts = Date.parse(o.ts);
      if (g && g.kind === kind && g.who === who && ts - lastTs <= GROUP_GAP_MS) {
        g.seqs[1] = Math.max(g.seqs[1], o.seq);
        if (!g.lines.some((l) => l[0] === lines[0] && l[1] === lines[1])) g.lines.push(lines);
      } else {
        g = { file, kind, seqs: [o.seq, o.seq], lines: [lines], who };
        groups.push(g);
      }
      lastTs = ts;
    }
  }
  return { hunks, unexplained, ratio: hunks.length ? (hunks.length - unexplained.length) / hunks.length : 1, groups, drift };
}

/** Step n의 에이전트 편집이 만든 현재 줄 범위 (impl-log changes 자동 생성, §7.3 3). 예: "src/a.ts:3-9" */
export function stepChanges(files: FileCoverageInput[], step: number): string[] {
  const out: string[] = [];
  for (const f of files) {
    const p = provenance(f.base, f.records);
    const isStep = (o: Origin | null) => !!o && (o.source.kind === "agent" || o.source.kind === "agent_shell") && o.source.step === step;
    const lines = new Set<number>();
    let pos = 0;
    const text = p.text ?? "";
    const lineAt = (off: number) => text.slice(0, off).split("\n").length;
    for (const seg of p.segs) {
      if (isStep(seg.origin)) {
        if (!seg.text.length) {
          lines.add(lineAt(pos)); // 지운 자리의 줄
        } else {
          const a = lineAt(pos);
          const b = lineAt(pos + seg.text.length - (seg.text.endsWith("\n") ? 1 : 0));
          for (let l = a; l <= b; l++) lines.add(l);
        }
      }
      pos += seg.text.length;
    }
    if (p.text === null && p.segs.some((s) => isStep(s.origin))) {
      out.push(`${f.file}: 삭제`);
      continue;
    }
    if (!lines.size) continue;
    out.push(`${f.file}:${ranges([...lines].sort((a, b) => a - b))}`);
  }
  return out;
}

function ranges(nums: number[]): string {
  const parts: string[] = [];
  let start = nums[0]!;
  let prev = start;
  for (const n of [...nums.slice(1), Infinity]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return parts.join(",");
}

/** 묶음의 줄 범위를 "3-5,9"처럼 */
export function linesLabel(lines: [number, number][]): string {
  return lines.map(([a, b]) => (b < a ? `${a}(삭제)` : a === b ? `${a}` : `${a}-${b}`)).join(",");
}

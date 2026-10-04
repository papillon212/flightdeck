// 구현 기록 impl-log.md (설계 §7.1, M4 제안 X1·X4).
// Flightdeck만 쓴다(flightdeck_log_step). 에이전트는 Step의 글(의도·결정·검토한 대안·리뷰 포인트)과 design_ref·검증만 넘기고,
// ckpt(그 Step까지의 체크포인트)와 changes(편집 기록으로 계산한 줄 범위)는 Flightdeck이 채운다.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseBlocks } from "./paragraphs.ts";

export interface ImplStep {
  n: number;
  title: string;
  /** design.md#p:xxxx (여러 개면 쉼표) */
  design_ref: string;
  ckpt: string;
  changes: string[];
  verification: string;
  intent: string;
  decision: string;
  alternatives: string;
  review_points: string;
}

/** 직접 수정·외부 변경 메모 (§7.4) 한 줄 */
export interface ImplMemo {
  file: string;
  lines: string;
  who: string;
  memo: string;
}

/** Step 글 항목: 제목 → 필드 */
export const STEP_TEXT_FIELDS = [
  ["의도", "intent"],
  ["결정", "decision"],
  ["검토한 대안", "alternatives"],
  ["리뷰 포인트", "review_points"],
] as const;

const STEP_HEAD = /^## Step (\d+): (.*)$/;
const MEMO_HEAD = "## 직접 수정 메모";

export function renderImplLog(epic: string, steps: ImplStep[], memos: ImplMemo[] = []): string {
  const out = [`# 구현 기록 · ${epic}`, ""];
  for (const s of [...steps].sort((a, b) => a.n - b.n)) {
    const y = stringifyYaml({ design_ref: s.design_ref, ckpt: s.ckpt, changes: s.changes, verification: s.verification }).trimEnd();
    out.push(`## Step ${s.n}: ${oneLine(s.title)}`, "", "```yaml", y, "```", "");
    for (const [label, key] of STEP_TEXT_FIELDS) out.push(`**${label}** ${s[key].trim()}`, "");
  }
  if (memos.length) {
    out.push(MEMO_HEAD, "");
    for (const m of memos) out.push(`- \`${m.file}:${m.lines}\` (${m.who}): ${oneLine(m.memo)}`);
    out.push("");
  }
  return out.join("\n");
}

export interface ParsedImplLog {
  steps: ImplStep[];
  memos: ImplMemo[];
  /** 읽지 못한 부분 */
  errors: string[];
}

export function parseImplLog(md: string): ParsedImplLog {
  const lines = md.split(/\r?\n/);
  const steps: ImplStep[] = [];
  const memos: ImplMemo[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const h = STEP_HEAD.exec(lines[i]!);
    if (lines[i] === MEMO_HEAD) {
      for (i++; i < lines.length && !lines[i]!.startsWith("## "); i++) {
        const m = /^- `([^`]+):([^`:]+)` \(([^)]*)\): (.*)$/.exec(lines[i]!);
        if (m) memos.push({ file: m[1]!, lines: m[2]!, who: m[3]!, memo: m[4]! });
      }
      continue;
    }
    if (!h) {
      i++;
      continue;
    }
    const n = Number(h[1]);
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i]!.startsWith("## "); i++) body.push(lines[i]!);
    const step: ImplStep = { n, title: h[2]!.trim(), design_ref: "", ckpt: "", changes: [], verification: "", intent: "", decision: "", alternatives: "", review_points: "" };
    const text = body.join("\n");
    const y = /```yaml\n([\s\S]*?)\n```/.exec(text);
    if (!y) errors.push(`Step ${n}: yaml 블록이 없습니다`);
    else {
      try {
        const v = (parseYaml(y[1]!) ?? {}) as Record<string, unknown>;
        step.design_ref = String(v.design_ref ?? "");
        step.ckpt = String(v.ckpt ?? "");
        step.changes = Array.isArray(v.changes) ? v.changes.map(String) : [];
        step.verification = String(v.verification ?? "");
      } catch (e) {
        errors.push(`Step ${n}: yaml을 읽지 못했습니다 (${e instanceof Error ? e.message : e})`);
      }
    }
    const rest = y ? text.replace(y[0], "") : text;
    const labels = STEP_TEXT_FIELDS.map(([l]) => l);
    for (const [label, key] of STEP_TEXT_FIELDS) {
      const re = new RegExp(`\\*\\*${label}\\*\\*([\\s\\S]*?)(?=\\n\\*\\*(?:${labels.join("|")})\\*\\*|$)`);
      step[key] = (re.exec(rest)?.[1] ?? "").trim();
    }
    steps.push(step);
  }
  return { steps, memos, errors };
}

/** design.md에 있는 문단 ID */
export function designPids(designMd: string): Set<string> {
  return new Set(parseBlocks(designMd.split(/\r?\n/)).flatMap((b) => (b.pid ? [b.pid] : [])));
}

/**
 * impl-log 형식 검사 (§7.1, 구현 관문 impl_log_schema). 문제 목록을 돌려준다.
 * Step 번호는 1부터 빠짐없이, 필드는 모두 채워져 있고, design_ref는 design.md에 있는 문단을 가리킨다
 */
export function checkImplLog(md: string | null, designMd: string | null): string[] {
  if (md === null) return ["impl-log.md가 없습니다 (flightdeck_log_step으로 Step을 기록하세요)"];
  const { steps, errors } = parseImplLog(md);
  const problems = [...errors];
  if (!steps.length) problems.push("impl-log에 Step이 없습니다");
  steps.forEach((s, i) => {
    if (s.n !== i + 1) problems.push(`Step 번호가 ${i + 1}이어야 하는데 ${s.n}입니다`);
  });
  const pids = designMd === null ? null : designPids(designMd);
  for (const s of steps) {
    const p = `Step ${s.n}`;
    if (!s.title) problems.push(`${p}: 제목이 없습니다`);
    if (!/^[0-9a-f]{40}$/.test(s.ckpt)) problems.push(`${p}: ckpt가 체크포인트 커밋이 아닙니다`);
    if (!s.verification.trim()) problems.push(`${p}: verification이 비었습니다`);
    const refs = s.design_ref.split(",").map((r) => r.trim()).filter(Boolean);
    if (!refs.length) problems.push(`${p}: design_ref가 없습니다`);
    for (const r of refs) {
      const m = /^design\.md#(p:[0-9a-f]{4})$/.exec(r);
      if (!m) problems.push(`${p}: design_ref 형식은 design.md#p:xxxx입니다 (${r})`);
      else if (pids && !pids.has(m[1]!)) problems.push(`${p}: design_ref ${r}가 design.md에 없습니다`);
    }
    for (const [label, key] of STEP_TEXT_FIELDS) if (!s[key]) problems.push(`${p}: ${label}이(가) 비었습니다`);
  }
  return problems;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

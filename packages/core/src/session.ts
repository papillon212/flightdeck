// 회의 요약 앵커링·검토·게시 (설계 §10.1 ⑥~⑧, §10.2, M6 제안 G3·G4).
// - 앵커링 입력: 회의록 + 전사 항목 + 포커스 + 열린 쓰레드·문서 문단 → 주최자의 Claude Code에 JSON 배열로 답하게 한다.
// - 검토 초안: 항목마다 `<!-- flightdeck:session-item target=… -->` 블록. 주최자가 문장을 고치거나 블록을 지우고 target을 바꾼다.
// - 게시: 초안을 다시 읽어 쓰레드 답글·새 쓰레드·sessions/<sid>.md로 만든다.
import { SessionItemSchema } from "@flightdeck/schema";

export type AnchorTarget = { thread: string } | { file: string; lines: [number, number] } | { epic: true };

export interface SessionItem {
  target: AnchorTarget;
  summary: string;
  decisions: string[];
  actions: string[];
}

export interface TranscriptEntry {
  participant: string;
  startTime: string;
  endTime?: string;
  text: string;
}

export interface FocusEntry {
  member: string;
  ts: string;
  file: string;
  range: [number, number];
}

export interface AnchoringInput {
  epic: string;
  title: string;
  /** Gemini 회의록 본문 (없으면 null: 포커스만으로) */
  notes: string | null;
  transcript: TranscriptEntry[];
  focus: FocusEntry[];
  threads: { id: string; file: string; where: string; status: string; body: string; last?: string }[];
}

/** 앵커링 지시문 (§10.1 ⑥, §10.2 우선순위) */
export function anchoringPrompt(i: AnchoringInput): string {
  const lines: string[] = [];
  lines.push(`Flightdeck 회의 요약 앵커링입니다. 에픽 ${i.epic}의 회의 "${i.title}" 내용을 쓰레드·코드 위치·에픽에 나눠 붙이세요.`);
  lines.push("");
  lines.push("규칙:");
  lines.push("1. 전사 문장의 시각과 그 시각 참여자들의 포커스(파일·줄)가 겹치면 그 위치가 우선입니다.");
  lines.push("2. 그렇지 않으면 회의록 내용과 쓰레드·문서 내용의 의미가 맞는 곳에 붙입니다.");
  lines.push("3. 어디에도 맞지 않으면 에픽 전체(epic)에 붙입니다.");
  lines.push("4. 요약은 한국어로, 짧게. 결정과 할 일은 따로 적습니다. 없는 내용을 지어내지 마세요.");
  lines.push("");
  lines.push('출력: JSON 배열 하나만 출력하세요(설명·코드 블록 없이). 항목 형식: {"target": {"thread": "t-…"} | {"file": "경로", "lines": [시작, 끝]} | {"epic": true}, "summary": "…", "decisions": ["…"], "actions": ["…"]}');
  lines.push("");
  lines.push("## 열린 쓰레드");
  for (const t of i.threads) lines.push(`- ${t.id} (${t.status}, ${t.file} ${t.where}): ${t.body.replace(/\s+/g, " ").slice(0, 200)}${t.last ? ` / 마지막 답글: ${t.last.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
  if (!i.threads.length) lines.push("(없음)");
  lines.push("");
  lines.push("## 포커스 (회의 중 각자 보던 파일·줄)");
  for (const f of i.focus.slice(0, 300)) lines.push(`- ${f.ts} @${f.member} ${f.file}:${f.range[0]}-${f.range[1]}`);
  if (!i.focus.length) lines.push("(없음)");
  lines.push("");
  lines.push("## 회의록");
  lines.push(i.notes?.trim() || "(회의록 없음: 포커스와 전사로만)");
  if (i.transcript.length) {
    lines.push("");
    lines.push("## 전사");
    for (const t of i.transcript.slice(0, 600)) lines.push(`- ${t.startTime} ${t.participant}: ${t.text}`);
  }
  return lines.join("\n");
}

const Item = SessionItemSchema;

/** 에이전트 출력에서 항목 배열을 꺼낸다. 없는 쓰레드를 가리키면 에픽으로 옮긴다. 형식이 틀린 항목은 버린다 */
export function parseAnchoring(text: string, threadIds: ReadonlySet<string>): SessionItem[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SessionItem[] = [];
  for (const r of raw) {
    const p = Item.safeParse(r);
    if (!p.success) continue;
    let target = p.data.target as AnchorTarget;
    if ("thread" in target && !threadIds.has(target.thread)) target = { epic: true };
    out.push({ target, summary: p.data.summary.trim(), decisions: p.data.decisions.map((x: string) => x.trim()).filter(Boolean), actions: p.data.actions.map((x: string) => x.trim()).filter(Boolean) });
  }
  return out;
}

export function targetText(t: AnchorTarget): string {
  if ("thread" in t) return `thread:${t.thread}`;
  if ("file" in t) return `file:${t.file}#L${t.lines[0]}-${t.lines[1]}`;
  return "epic";
}

export function parseTarget(s: string): AnchorTarget | null {
  const th = /^thread:(t-[0-9A-HJKMNP-TV-Z]{8})$/.exec(s);
  if (th) return { thread: th[1]! };
  const f = /^file:(.+)#L(\d+)-(\d+)$/.exec(s);
  if (f) return { file: f[1]!, lines: [Number(f[2]), Number(f[3])] };
  return s === "epic" ? { epic: true } : null;
}

const ITEM_OPEN = /^<!-- flightdeck:session-item target=(\S+) -->$/;
const ITEM_CLOSE = "<!-- /flightdeck:session-item -->";

function itemBody(i: SessionItem): string {
  return [i.summary, ...i.decisions.map((d) => `- 결정: ${d}`), ...i.actions.map((a) => `- 할 일: ${a}`)].join("\n");
}

/** 검토 초안 (G3): 주최자가 고치고 지우고 target을 바꾼 뒤 게시한다 */
export function renderSessionDraft(sid: string, title: string, items: SessionItem[], notesUrl?: string): string {
  const out = [
    `# 회의 요약 초안 · ${sid} · ${title}`,
    "",
    "> 주최자 검토: 문장을 고치거나 블록을 통째로 지우세요. 붙일 곳은 `target=`을 바꿉니다(thread:t-…, file:경로#L시작-끝, epic).",
    "> 다 고쳤으면 `Flightdeck: 회의 요약 게시`를 실행하세요. 게시 전에는 아무에게도 보이지 않습니다.",
    ...(notesUrl ? ["", `회의록: ${notesUrl}`] : []),
    "",
  ];
  for (const i of items) out.push(`<!-- flightdeck:session-item target=${targetText(i.target)} -->`, itemBody(i), ITEM_CLOSE, "");
  return out.join("\n");
}

/** 초안을 다시 읽는다. target을 읽을 수 없는 블록은 problems로 */
export function parseSessionDraft(md: string): { items: SessionItem[]; problems: string[] } {
  const items: SessionItem[] = [];
  const problems: string[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_OPEN.exec(lines[i]!.trim());
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j]!.trim() !== ITEM_CLOSE; j++) body.push(lines[j]!);
    i = j;
    const target = parseTarget(m[1]!);
    if (!target) {
      problems.push(`target을 읽을 수 없다: ${m[1]}`);
      continue;
    }
    const decisions = body.filter((l) => /^- 결정: /.test(l)).map((l) => l.replace(/^- 결정: /, "").trim());
    const actions = body.filter((l) => /^- 할 일: /.test(l)).map((l) => l.replace(/^- 할 일: /, "").trim());
    const summary = body.filter((l) => !/^- (결정|할 일): /.test(l)).join("\n").trim();
    if (!summary && !decisions.length && !actions.length) continue;
    items.push({ target, summary, decisions, actions });
  }
  return { items, problems };
}

/** 쓰레드 답글·코드 쓰레드 본문 (§3.2 쓰레드 블록의 🎙 회의 요약) */
export function sessionReplyText(i: SessionItem): string {
  return itemBody(i);
}

/** sessions/<sid>.md (§2.2): 회의 전체 요약. 에픽 대상 항목과 다른 곳에 붙인 항목의 목록 */
export function renderSessionSummary(o: { sid: string; title: string; host: string; started_at: string; ended_at?: string; notesUrl?: string; items: SessionItem[] }): string {
  const out = [`# 회의 ${o.sid} · ${o.title}`, "", `- 주최: @${o.host}`, `- 시간: ${o.started_at}${o.ended_at ? ` ~ ${o.ended_at}` : ""}`, ...(o.notesUrl ? [`- 회의록: ${o.notesUrl}`] : []), ""];
  const epicItems = o.items.filter((i) => "epic" in i.target);
  if (epicItems.length) {
    out.push("## 에픽 전체");
    for (const i of epicItems) out.push(itemBody(i), "");
  }
  const placed = o.items.filter((i) => !("epic" in i.target));
  if (placed.length) {
    out.push("## 붙인 곳");
    for (const i of placed) out.push(`- ${targetText(i.target)}: ${i.summary.split("\n")[0]}`);
    out.push("");
  }
  return out.join("\n");
}

// 쓰레드 초안 블록 (설계 §3.2 v0.13). 사람이 자기 에이전트에게 "이 문단에 질문 달아 줘"라고 지시하면 에이전트가 문서에 쓴다.
//   <!-- flightdeck:draft kind=question to=dh.lee,park -->   새 쓰레드 (앵커 = 초안 바로 위 블록의 문단 ID)
//   <!-- flightdeck:draft reply=t-01JB2X4K -->              답글
//   본문 …
//   <!-- /flightdeck:draft -->
// 확장이 찾아 Comments에 초안으로 보여 주고, 사람이 "올리기"를 눌러야 이벤트가 된다.
import { createHash } from "node:crypto";
import { parseBlocks } from "./paragraphs.ts";

export const DRAFT_START = /^<!-- flightdeck:draft(?<attrs>(?: [^>]*?)?) ?-->$/;
export const DRAFT_END = /^<!-- \/flightdeck:draft -->$/;
const KINDS = ["question", "change_request", "note"] as const;
const THREAD_ID = /^t-[0-9A-HJKMNP-TV-Z]{8}$/;

export interface Draft {
  /** 같은 초안을 가리키는 키 (속성 + 본문의 해시 앞 12자) */
  key: string;
  kind?: (typeof KINDS)[number];
  to: string[];
  /** 답글이면 대상 쓰레드 */
  reply?: string;
  body: string;
  /** 새 쓰레드의 앵커: 초안 바로 위 블록의 문단 ID */
  anchor: string | null;
  /** 초안 블록의 첫 줄·끝 줄 (0부터, 포함) */
  start: number;
  end: number;
  /** 올릴 수 없는 이유 (형식) */
  error?: string;
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z_]+)=("([^"]*)"|\S+)/g)) out[m[1]!] = m[3] ?? m[2]!;
  return out;
}

export function parseDrafts(md: string): Draft[] {
  const lines = md.split(/\r?\n/);
  const blocks = parseBlocks(lines);
  const drafts: Draft[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DRAFT_START.exec(lines[i]!);
    if (!m) continue;
    const start = i;
    let end = i + 1;
    while (end < lines.length && !DRAFT_END.test(lines[end]!)) end++;
    const a = attrs(m.groups?.attrs ?? "");
    const body = lines.slice(start + 1, Math.min(end, lines.length)).join("\n").trim();
    const prev = [...blocks].reverse().find((b) => b.end < start);
    const d: Draft = {
      key: createHash("sha256").update(`${m.groups?.attrs ?? ""}\n${body}`).digest("hex").slice(0, 12),
      to: (a.to ?? "").split(/[,\s]+/).map((x) => x.replace(/^@/, "").toLowerCase()).filter(Boolean),
      body,
      anchor: prev?.pid ?? null,
      start,
      end: Math.min(end, lines.length - 1),
    };
    if (a.reply) d.reply = a.reply;
    if (a.kind) d.kind = a.kind as Draft["kind"];
    if (end >= lines.length) d.error = "닫는 <!-- /flightdeck:draft --> 가 없음";
    else if (!body) d.error = "본문이 비어 있음";
    else if (d.reply && d.kind) d.error = "reply와 kind를 함께 쓸 수 없음";
    else if (d.reply && !THREAD_ID.test(d.reply)) d.error = `쓰레드 ID 형식이 아님: ${d.reply}`;
    else if (!d.reply && !KINDS.includes(d.kind as never)) d.error = `kind는 ${KINDS.join("|")} 중 하나`;
    else if (!d.reply && !d.anchor) d.error = "초안 위에 문단 ID가 있는 블록이 없음";
    drafts.push(d);
    i = end;
  }
  return drafts;
}

/** 초안 블록을 지운다 (keys가 있으면 그 초안만). 초안 뒤의 빈 줄 하나도 같이 지운다 */
export function removeDrafts(md: string, keys?: Iterable<string>): string {
  const want = keys ? new Set(keys) : null;
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(eol);
  const drop = new Set<number>();
  for (const d of parseDrafts(md)) {
    if (want && !want.has(d.key)) continue;
    for (let i = d.start; i <= d.end; i++) drop.add(i);
    if (lines[d.end + 1] === "" && (d.start === 0 || lines[d.start - 1] === "")) drop.add(d.end + 1);
  }
  return lines.filter((_, i) => !drop.has(i)).join(eol);
}

/** 초안 블록 원문 (다른 문서로 옮겨 붙일 때) */
export function draftText(md: string, d: Draft): string {
  return md.split(/\r?\n/).slice(d.start, d.end + 1).join("\n");
}

/**
 * base 문서에 초안들을 다시 끼운다 (읽기 전용 창: 공유 커밋 내용 위에 초안만 남기고 나머지 변경은 버린다, §6.2).
 * 새 쓰레드 초안은 앵커 블록 바로 뒤, 답글은 그 쓰레드 블록 바로 뒤, 둘 다 못 찾으면 문서 끝.
 */
export function insertDrafts(base: string, drafts: { draft: Draft; text: string }[]): string {
  if (!drafts.length) return base;
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const lines = base.split(eol);
  const blocks = parseBlocks(lines);
  const after = new Map<number, string[]>(); // 이 줄 뒤에 넣을 초안들
  const tail: string[] = [];
  for (const { draft, text } of drafts) {
    let at = -1;
    if (draft.reply) {
      const s = lines.findIndex((l) => l.startsWith(`<!-- flightdeck:thread id=${draft.reply} `));
      if (s >= 0) at = lines.findIndex((l, i) => i > s && l === "<!-- /flightdeck:thread -->");
    } else if (draft.anchor) {
      const b = blocks.find((x) => x.pid === draft.anchor);
      if (b) at = b.end;
    }
    if (at < 0) tail.push(text);
    else after.set(at, [...(after.get(at) ?? []), text]);
  }
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(l);
    for (const t of after.get(i) ?? []) out.push("", ...t.split(/\r?\n/));
  });
  if (tail.length) {
    while (out.length && out.at(-1) === "") out.pop();
    for (const t of tail) out.push("", ...t.split(/\r?\n/));
    out.push("");
  }
  return out.join(eol);
}

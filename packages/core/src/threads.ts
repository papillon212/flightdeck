// 문서 인라인 쓰레드 블록 (설계 §3.2).
// 쓰레드 블록은 확장이 관리하는 렌더링 영역이다. 원천은 메타 이벤트이고, 문서에는 결과만 그린다.
// renderThreads(strip(doc)) 는 몇 번을 해도 같은 결과가 나와야 한다(멱등).
import type { Thread } from "./reducer.ts";
import { parseBlocks, THREAD_END, THREAD_START } from "./paragraphs.ts";

const KIND_ICON = { question: "❓", change_request: "✏️", note: "📝" } as const;
const SOURCE_ICON = { human: "💬", agent: "🤖", session: "🎙" } as const;

/** "2026-10-01T10:12:00+09:00" → "2026-10-01 10:12" (이벤트에 적힌 시간대 그대로) */
function shortTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function quote(text: string): string[] {
  return text.split("\n").map((l) => (l === "" ? ">" : `> ${l}`));
}

/** 쓰레드 하나를 블록 줄 배열로 */
export function renderThreadBlock(t: Thread): string[] {
  const anchor = t.anchor.type === "paragraph" ? t.anchor.pid : "none";
  const to = t.to.length ? ` → ${t.to.map((m) => `@${m}`).join(" ")}` : "";
  const lines = [
    `<!-- flightdeck:thread id=${t.id} status=${t.status} anchor=${anchor} -->`,
    `> **${KIND_ICON[t.kind]} @${t.author}${to}** · ${shortTime(t.at)}${t.status === "resolved" ? " · ✅ 해결됨" : ""}`,
    ...quote(t.body),
  ];
  for (const r of t.replies) {
    const who = r.source === "agent" ? `에이전트(@${r.author})` : r.source === "session" ? "회의 요약" : `@${r.author}`;
    lines.push(">", `> **${SOURCE_ICON[r.source]} ${who}** · ${shortTime(r.at)}`, ...quote(r.body));
  }
  lines.push("<!-- /flightdeck:thread -->");
  return lines;
}

export const ORPHAN_HEADING = "## 위치를 잃은 쓰레드";

/**
 * 문서에서 렌더링 영역(쓰레드 블록, "위치를 잃은 쓰레드" 제목)을 모두 지운다.
 * 블록 앞에 렌더링이 넣은 빈 줄 하나도 함께 지운다. 문서 끝 빈 줄은 렌더링 전 상태로 맞춘다.
 */
export function stripThreads(md: string): string {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(eol);
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === ORPHAN_HEADING) {
      if (out.length && out.at(-1) === "") out.pop();
      removed = true;
      continue;
    }
    if (!THREAD_START.test(line)) {
      out.push(line);
      continue;
    }
    if (out.length && out.at(-1) === "") out.pop();
    while (i < lines.length && !THREAD_END.test(lines[i]!)) i++;
    removed = true;
  }
  if (removed && out.at(-1) !== "" && md.endsWith(eol)) out.push("");
  return out.join(eol);
}

/**
 * 문서에 쓰레드 블록을 그린다. 이 파일의 문단 앵커 쓰레드만 대상이다.
 * 앵커 문단을 찾지 못한 쓰레드는 문서 끝 "위치를 잃은 쓰레드" 아래에 모은다(고아, §3.5).
 */
export function renderThreads(md: string, file: string, threads: Iterable<Thread>): string {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = stripThreads(md).split(eol);
  const mine = [...threads].filter((t) => t.file === file && t.anchor.type === "paragraph").sort((a, b) => (a.id < b.id ? -1 : 1));
  const blocks = parseBlocks(lines);
  const byPid = new Map(blocks.filter((b) => b.pid).map((b) => [b.pid!, b]));

  const inserts = new Map<number, string[]>(); // 블록 끝 줄 → 넣을 줄
  const orphans: Thread[] = [];
  for (const t of mine) {
    const b = t.anchor.type === "paragraph" ? byPid.get(t.anchor.pid) : undefined;
    if (!b) {
      orphans.push(t);
      continue;
    }
    const list = inserts.get(b.end) ?? [];
    list.push("", ...renderThreadBlock(t));
    inserts.set(b.end, list);
  }
  for (const end of [...inserts.keys()].sort((a, b) => b - a)) lines.splice(end + 1, 0, ...inserts.get(end)!);
  if (orphans.length) {
    const trailing = lines.at(-1) === "";
    if (trailing) lines.pop();
    lines.push("", ORPHAN_HEADING);
    for (const t of orphans) lines.push("", ...renderThreadBlock(t));
    if (trailing) lines.push("");
  }
  return lines.join(eol);
}

/** 문서에 그려진 쓰레드 블록의 머리 정보 (확장이 Comments API와 맞출 때 쓴다) */
export function listThreadBlocks(md: string): { id: string; status: string; anchor: string; line: number }[] {
  const re = /^<!-- flightdeck:thread id=(\S+) status=(\S+) anchor=(\S+) -->$/;
  return md.split(/\r?\n/).flatMap((l, line) => {
    const m = re.exec(l);
    return m ? [{ id: m[1]!, status: m[2]!, anchor: m[3]!, line }] : [];
  });
}

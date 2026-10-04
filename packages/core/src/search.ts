// 세션 원본 검색 (설계 §6.4 flightdeck_search_run). 원본 전체를 넘기지 않고 관련 구간만 돌려준다.
// 입력은 허용 목록 필터(§6.4)를 거친 transcript 항목이다. BM25로 항목을 고르고 앞뒤 항목을 붙여 발췌한다.
// 한국어는 띄어쓰기 단위가 조사와 붙어 있어 단어 그대로는 잘 맞지 않는다. 한글 토큰은 2글자 조각(2-gram)도 함께 쓴다.

export interface TranscriptDoc {
  run: string;
  session: string;
  /** 세션 안의 순서 */
  i: number;
  at?: string;
  role: string;
  text: string;
}

/** 필터를 거친 transcript 항목 하나를 사람이 읽을 글로 (없으면 null) */
export function transcriptText(item: unknown): { role: string; at?: string; text: string } | null {
  const o = item as Record<string, any>;
  if (!o) return null;
  if (o.type === "attachment") return o.attachment?.content ? { role: "flightdeck", at: o.timestamp, text: String(o.attachment.content) } : null;
  const content = o.message?.content;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === "text" && c.text) parts.push(c.text);
      else if (c?.type === "thinking" && c.thinking) parts.push(`(생각) ${c.thinking}`);
      else if (c?.type === "tool_use") parts.push(`[도구 ${c.name}] ${JSON.stringify(c.input ?? {})}`);
      else if (c?.type === "tool_result") {
        const r = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join("\n") : "";
        if (r) parts.push(`[도구 결과] ${r}`);
      }
    }
  }
  const text = parts.join("\n").trim();
  if (!text) return null;
  const isToolResult = Array.isArray(content) && content.every((c: any) => c?.type === "tool_result");
  return { role: o.type === "user" ? (isToolResult ? "tool" : "user") : "assistant", at: o.timestamp, text };
}

const HANGUL = /[가-힣]/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!w) continue;
    out.push(w);
    if (HANGUL.test(w) && w.length > 2) for (let i = 0; i + 2 <= w.length; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

export interface SearchHit {
  doc: TranscriptDoc;
  score: number;
  /** 앞뒤 맥락을 붙인 발췌 */
  excerpt: string;
}

const K1 = 1.2;
const B = 0.75;
const MAX_ITEM_CHARS = 1200;

/** BM25로 고른 항목에 앞뒤 1개씩 붙여 발췌한다. maxTokens는 대략 글자 수/2로 계산한다(한국어 섞인 글 기준) */
export function searchTranscripts(docs: TranscriptDoc[], query: string, maxTokens = 2000): SearchHit[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = docs.map((doc, k) => {
    const tf = new Map<string, number>();
    for (const w of toks[k]!) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const n = df.get(w)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks[k]!.length) / avg));
    }
    return { k, score };
  });
  const budget = maxTokens * 2;
  let used = 0;
  const hits: SearchHit[] = [];
  const shown = new Set<number>();
  for (const { k, score } of scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)) {
    if (shown.has(k)) continue;
    const doc = docs[k]!;
    const ctx = [k - 1, k, k + 1].filter((j) => j >= 0 && j < docs.length && docs[j]!.session === doc.session && !shown.has(j));
    const excerpt = ctx.map((j) => `${j === k ? "▶ " : ""}[${docs[j]!.role}${docs[j]!.at ? " · " + docs[j]!.at : ""}] ${clip(docs[j]!.text)}`).join("\n");
    if (used + excerpt.length > budget && hits.length) break;
    for (const j of ctx) shown.add(j);
    used += excerpt.length;
    hits.push({ doc, score, excerpt });
  }
  return hits;
}

const clip = (s: string) => (s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) + " …(생략)" : s);

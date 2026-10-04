// 산출물 형식 검사 (설계 §6.3 analysis·design, §6.4 handoff).
// 필수 `## <섹션>` 제목이 모두 있고, 이 순서대로 나오고, 내용이 비어 있지 않아야 한다.
// 쓰레드 블록과 문단 ID 줄은 내용으로 치지 않는다.
import { PID_LINE, THREAD_END, THREAD_START } from "./paragraphs.ts";
import { sha256 } from "./util.ts";

/** 승인·단계 완료의 artifact_hash (§4.2): 에픽 브랜치에 올라간 산출물 파일 바이트(UTF-8)의 sha256 */
export function artifactHash(text: string): string {
  return `sha256:${sha256(text)}`;
}

export interface SectionCheck {
  ok: boolean;
  missing: string[];
  outOfOrder: boolean;
  empty: string[];
}

export function checkSections(md: string, required: readonly string[]): SectionCheck {
  const sections: { title: string; content: string[] }[] = [];
  let inFence = false;
  let inThread = false;
  for (const line of md.split(/\r?\n/)) {
    if (THREAD_START.test(line)) inThread = true;
    if (inThread) {
      if (THREAD_END.test(line)) inThread = false;
      continue;
    }
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^## (.+?)\s*$/.exec(line);
    if (h) sections.push({ title: h[1]!, content: [] });
    else if (sections.length && line.trim() && !PID_LINE.test(line) && !/^<!--.*-->$/.test(line.trim())) sections.at(-1)!.content.push(line);
  }
  const titles = sections.map((s) => s.title);
  const missing = required.filter((r) => !titles.includes(r));
  const order = required.filter((r) => titles.includes(r)).map((r) => titles.indexOf(r));
  const outOfOrder = order.some((v, i) => i > 0 && v < order[i - 1]!);
  const empty = required.filter((r) => sections.find((s) => s.title === r)?.content.length === 0);
  return { ok: !missing.length && !outOfOrder && !empty.length, missing, outOfOrder, empty };
}

#!/usr/bin/env node
// 관찰자 대화 스트림(설계 §8.3) 시뮬레이션: 훅 로그에서 최신 transcript_path를 알아내 실시간으로 따라 읽는다.
// 새 줄을 읽을 때마다 {seen_at, 줄의 timestamp, type, 요약}을 기록한다. 파싱 실패 줄도 그대로 센다(너그러운 파서).
// 사용: node tail.mjs <STATE_DIR> <OUT.jsonl> <DURATION_SEC>
import fs from "node:fs";
import path from "node:path";

const [STATE, OUT, DURATION = "120"] = process.argv.slice(2);
const deadline = Date.now() + Number(DURATION) * 1000;
const offsets = new Map(); // transcript path → 읽은 바이트 수
const partial = new Map(); // 줄 끝이 아직 안 온 조각

function transcriptPaths() {
  const log = path.join(STATE, "hook-log.jsonl");
  if (!fs.existsSync(log)) return [];
  const paths = new Set();
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    if (!line) continue;
    const tp = JSON.parse(line).input?.transcript_path;
    if (tp) paths.add(tp);
  }
  return [...paths];
}

function summarize(o) {
  if (o.type === "assistant") {
    const c = o.message?.content ?? [];
    return c.map((b) => (b.type === "text" ? `text:${b.text.slice(0, 40)}` : b.type === "tool_use" ? `tool_use:${b.name}` : b.type)).join(",");
  }
  if (o.type === "user") {
    const c = o.message?.content;
    return typeof c === "string" ? `prompt:${c.slice(0, 40)}` : (c ?? []).map((b) => b.type).join(",");
  }
  if (o.type === "attachment") return `attachment:${o.attachment?.type}`;
  return o.subtype ?? "";
}

function poll() {
  for (const tp of transcriptPaths()) {
    if (!offsets.has(tp)) {
      // 이미 있던 내용은 "따라잡기"로 한 번에 읽고, 이후 줄부터 지연을 잰다
      offsets.set(tp, 0);
      partial.set(tp, "");
    }
    if (!fs.existsSync(tp)) continue;
    const size = fs.statSync(tp).size;
    const from = offsets.get(tp);
    if (size <= from) continue;
    const fd = fs.openSync(tp, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    offsets.set(tp, size);
    const text = partial.get(tp) + buf.toString("utf8");
    const lines = text.split("\n");
    partial.set(tp, lines.pop());
    const seenAt = new Date();
    for (const line of lines) {
      if (!line) continue;
      let rec;
      try {
        const o = JSON.parse(line);
        const ts = o.timestamp ? new Date(o.timestamp) : null;
        rec = { seen_at: seenAt.toISOString(), file: path.basename(tp), ts: o.timestamp ?? null, lag_ms: ts ? seenAt - ts : null, type: o.type, sid: o.sessionId, what: summarize(o) };
      } catch {
        rec = { seen_at: seenAt.toISOString(), file: path.basename(tp), parse_error: true, bytes: line.length };
      }
      fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
    }
  }
  if (Date.now() < deadline) setTimeout(poll, 100);
}
poll();

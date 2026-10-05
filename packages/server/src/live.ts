// 실시간 중계 (서버 ④, 설계 §8.3·§8.4·§8.5, M8 제안 L1·L5).
// - 서버 → 확장: SSE(`GET /live/<epic>`). 끊기면 Last-Event-ID 뒤부터 다시 받는다(에픽별 최근 1,000건을 메모리에).
// - 확장 → 서버: POST(`/live/<epic>`). 조종수만 보내는 것(편집·대화·활동)과 누구나 보내는 것(의견·조종 요청·답장)이 있다.
// - 접속 상태: 멤버별 연결 수와 마지막으로 끊긴 시각. 조종수 이탈 판단(강제 인수, L5)에 쓴다.
// 실시간 데이터는 저장하지 않는다(§11.5). 원본은 편집 기록(서버 ③)과 세션 원본(§6.4)이다.
import type { ServerResponse } from "node:http";
import { nowIso } from "@flightdeck/core";

/** 조종수만 보낼 수 있는 종류 */
export const PILOT_TYPES = new Set(["edit", "chat", "activity"]);
/** 누구나 보낼 수 있는 종류 */
export const MEMBER_TYPES = new Set(["opinion", "opinion.reply", "opinion.status", "pilot.request", "pilot.answer"]);

export interface LiveMessage {
  id: number;
  type: string;
  from: string;
  at: string;
  /** 받는 사람을 정하면 그 사람과 보낸 사람에게만 (의견·답장) */
  to?: string[];
  data: unknown;
}

interface Sub {
  member: string;
  res: ServerResponse;
}

interface Channel {
  seq: number;
  buf: LiveMessage[];
  subs: Set<Sub>;
  presence: Map<string, { conns: number; offlineAt: string | null }>;
}

const BUF = 1000;

export class LiveHub {
  private channels = new Map<string, Channel>();

  private ch(product: string, epic: string): Channel {
    const key = `${product}\0${epic}`;
    let c = this.channels.get(key);
    if (!c) this.channels.set(key, (c = { seq: 0, buf: [], subs: new Set(), presence: new Map() }));
    return c;
  }

  private visible(m: LiveMessage, member: string): boolean {
    return !m.to || m.from === member || m.to.includes(member);
  }

  private write(res: ServerResponse, m: LiveMessage): void {
    res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`);
  }

  /** SSE 구독. lastId 뒤의 메시지부터 다시 보낸 뒤 실시간으로 */
  subscribe(product: string, epic: string, member: string, res: ServerResponse, lastId = 0): void {
    const c = this.ch(product, epic);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": flightdeck live\n\n");
    for (const m of c.buf) if (m.id > lastId && this.visible(m, member)) this.write(res, m);
    const sub: Sub = { member, res };
    c.subs.add(sub);
    const p = c.presence.get(member) ?? { conns: 0, offlineAt: null };
    p.conns++;
    c.presence.set(member, p);
    this.publish(product, epic, member, "presence", this.presence(product, epic));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(ping);
      c.subs.delete(sub);
      const q = c.presence.get(member)!;
      q.conns = Math.max(0, q.conns - 1);
      if (!q.conns) q.offlineAt = nowIso();
      this.publish(product, epic, member, "presence", this.presence(product, epic));
    });
  }

  publish(product: string, epic: string, from: string, type: string, data: unknown, to?: string[]): LiveMessage {
    const c = this.ch(product, epic);
    const m: LiveMessage = { id: ++c.seq, type, from, at: nowIso(), ...(to?.length ? { to } : {}), data };
    // 접속 상태는 매번 바뀌므로 버퍼에 쌓지 않는다
    if (type !== "presence") {
      c.buf.push(m);
      if (c.buf.length > BUF) c.buf.splice(0, c.buf.length - BUF);
    }
    for (const s of c.subs) if (this.visible(m, s.member)) this.write(s.res, m);
    return m;
  }

  /** 멤버별 접속 상태 */
  presence(product: string, epic: string): Record<string, { online: boolean; offlineAt: string | null }> {
    const out: Record<string, { online: boolean; offlineAt: string | null }> = {};
    for (const [m, p] of this.ch(product, epic).presence) out[m] = { online: p.conns > 0, offlineAt: p.conns > 0 ? null : p.offlineAt };
    return out;
  }
}

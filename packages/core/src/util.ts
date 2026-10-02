import { createHash, randomBytes } from "node:crypto";

/** 문자열(UTF-8 바이트)의 sha256. null은 "파일 없음"으로 null을 돌려준다 (설계 §8.6 base_hash) */
export function sha256(text: string | null): string | null {
  if (text === null) return null;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 이 PC의 시간대를 붙인 ISO 8601 시각 (예: 2026-10-02T16:14:00.123+09:00). 이벤트 at에 쓴다 (설계 §3.1 예시) */
export function nowIso(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, -1);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

/**
 * ULID 생성 (48비트 시각 + 80비트 난수). 같은 밀리초 안에서는 난수를 1 올려 단조 증가를 보장한다.
 * 이벤트 파일 이름과 정렬 기준으로 쓴다 (설계 §3.1).
 */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = [...lastRandom];
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i]! < 31) {
        random[i]!++;
        break;
      }
      random[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    random = Array.from({ length: 16 }, (_, i) => bytes[i]! % 32);
  }
  lastTime = now;
  lastRandom = random;
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((n) => CROCKFORD[n]).join("");
}

/** 쓰레드 ID: t-<ULID 앞 8자> (설계 §3.1) */
export function threadIdFrom(eventUlid: string): string {
  return `t-${eventUlid.slice(0, 8)}`;
}

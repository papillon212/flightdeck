// 실시간 관찰 (설계 §8.3·§8.4, M8 제안 L1·L6·L8). VS Code API를 쓰지 않는다.
// - LiveConnection: 서버 ④의 SSE를 받아 메시지로 나눈다. 끊기면 마지막 번호부터 다시 받는다.
// - PilotStreamer: 조종수 확장이 로컬 편집 기록과 세션 기록 파일을 따라 읽어 보낸다(대화는 허용 목록 필터 + 비밀값 가림).
// - LiveFollower: 관찰자의 읽기 전용 창에 편집을 순서대로 적용한다. 빠진 seq는 서버 편집 기록(M7)에서 채운다.
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, sha256, transcriptText } from "@flightdeck/core";
import { readEditLog, readState } from "@flightdeck/hook";
import type { EditRecord } from "@flightdeck/schema";
import type { ServerClient } from "./server-client.ts";

export interface LiveMessage {
  id: number;
  type: string;
  from: string;
  at: string;
  to?: string[];
  data: any;
}

/** 대화 블록 (관찰자 화면의 한 줄) */
export interface ChatBlock {
  role: string;
  text: string;
  at?: string;
}

export class LiveConnection {
  private abort = new AbortController();
  private lastId = 0;
  private stopped = false;
  connected = false;

  constructor(
    private server: ServerClient,
    private product: string,
    private epic: string,
    private onMessage: (m: LiveMessage) => void,
    private onState: (connected: boolean, error?: unknown) => void = () => undefined,
  ) {}

  start(): this {
    void this.loop();
    return this;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await this.server.liveStream(this.product, this.epic, this.lastId, this.abort.signal);
        this.connected = true;
        this.onState(true);
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const m = JSON.parse(data) as LiveMessage;
            if (m.type !== "presence") this.lastId = Math.max(this.lastId, m.id);
            this.onMessage(m);
          }
        }
      } catch (e) {
        if (this.stopped) return;
        this.onState(false, e);
      }
      this.connected = false;
      if (!this.stopped) await new Promise((res) => setTimeout(res, 1000));
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }
}

/** 파일의 offset 뒤에 붙은 내용 */
async function tail(file: string, offset: number): Promise<{ text: string; size: number }> {
  const size = (await stat(file)).size;
  if (size <= offset) return { text: "", size };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    return { text: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

/** 조종수 확장: 편집 기록·대화를 실시간으로 보낸다 (L6). 시작한 뒤의 것만 보낸다(늦게 온 관찰자는 체크포인트·서버 편집 기록으로 따라잡는다) */
export class PilotStreamer {
  private timer: NodeJS.Timeout | null = null;
  private sentSeq = -1;
  private offsets = new Map<string, number>();
  private busy = false;

  constructor(
    private o: {
      server: ServerClient;
      product: string;
      epic: string;
      dataDir: string;
      filter: (item: unknown) => unknown | null;
      secrets: () => Promise<string[]>;
      intervalMs?: number;
      onError?: (e: unknown) => void;
    },
  ) {}

  async start(): Promise<this> {
    this.sentSeq = (await readEditLog(this.o.dataDir, this.o.epic)).at(-1)?.seq ?? 0;
    const st = await readState(this.o.dataDir, this.o.epic);
    for (const r of Object.values(st.runs)) if (r.transcript && existsSync(r.transcript)) this.offsets.set(r.transcript, (await stat(r.transcript)).size);
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 200);
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 한 번 돈다 (테스트에서 직접 부른다) */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const log = await readEditLog(this.o.dataDir, this.o.epic);
      const fresh = log.filter((r) => r.seq > this.sentSeq);
      if (fresh.length) {
        await this.o.server.liveSend(this.o.product, this.o.epic, "edit", { records: fresh });
        this.sentSeq = fresh.at(-1)!.seq;
      }
      const st = await readState(this.o.dataDir, this.o.epic);
      for (const [sid, r] of Object.entries(st.runs)) {
        if (!r.transcript || !existsSync(r.transcript)) continue;
        const { text, size } = await tail(r.transcript, this.offsets.get(r.transcript) ?? 0);
        if (!text) continue;
        const done = text.lastIndexOf("\n") + 1; // 줄이 끝난 데까지만
        if (!done) continue;
        this.offsets.set(r.transcript, size - (text.length - done));
        const secrets = await this.o.secrets();
        const blocks: ChatBlock[] = [];
        for (const line of text.slice(0, done).split("\n").filter(Boolean)) {
          let item: unknown;
          try {
            item = JSON.parse(line);
          } catch {
            continue;
          }
          const kept = this.o.filter(item);
          const t = kept ? transcriptText(kept) : null;
          if (t) blocks.push({ role: t.role, text: redactSecrets(t.text, secrets).slice(0, 4000), ...(t.at ? { at: t.at } : {}) });
        }
        if (blocks.length) await this.o.server.liveSend(this.o.product, this.o.epic, "chat", { session: sid, run: r.run_id, blocks });
      }
    } catch (e) {
      this.o.onError?.(e);
    } finally {
      this.busy = false;
    }
  }
}

/** 편집 기록을 폴더의 파일에 순서대로 적용한다. base_hash가 맞지 않으면 그 seq에서 멈추고 알린다 */
export async function applyRecords(dir: string, records: EditRecord[]): Promise<{ applied: number; mismatch: number | null }> {
  let applied = 0;
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    const f = path.join(dir, r.file);
    const cur = existsSync(f) ? await readFile(f, "utf8") : null;
    if (sha256(cur) !== r.base_hash) return { applied, mismatch: r.seq };
    if (r.delete_file) await rm(f, { force: true });
    else {
      await mkdir(path.dirname(f), { recursive: true });
      const text = cur ?? "";
      await writeFile(f, text.slice(0, r.range[0]) + r.insert + text.slice(r.range[1]));
    }
    applied = r.seq;
  }
  return { applied, mismatch: null };
}

/**
 * 관찰자 창: 편집을 seq 순서로 적용한다 (L8). 빠진 seq는 서버 편집 기록에서 채우고(아직 안 올라왔으면 다음에),
 * 적용할 수 없으면(base_hash 불일치) onReset으로 다시 맞추게 한다
 */
export class LiveFollower {
  private pending = new Map<number, EditRecord>();
  private busy: Promise<void> = Promise.resolve();
  /** 적용 지연(ms): 조종수 기록 시각 → 이 창의 디스크 반영 */
  readonly latencies: number[] = [];

  constructor(
    private o: { dir: string; product: string; epic: string; server: ServerClient; seq: number; onApplied?: (records: EditRecord[]) => void; onReset?: (reason: string) => void },
  ) {}

  get seq(): number {
    return this.o.seq;
  }

  push(records: EditRecord[]): Promise<void> {
    for (const r of records) if (r.seq > this.o.seq) this.pending.set(r.seq, r);
    this.busy = this.busy.then(() => this.drain()).catch(() => undefined);
    return this.busy;
  }

  private async drain(): Promise<void> {
    if (this.pending.size && !this.pending.has(this.o.seq + 1)) {
      // 빠진 seq: 서버 편집 기록(조종수가 5초마다 올린다)에서 채운다
      const { records } = await this.o.server.editlog(this.o.product, this.o.epic, this.o.seq + 1);
      for (const r of records) if (r.seq > this.o.seq && !this.pending.has(r.seq)) this.pending.set(r.seq, r);
    }
    const run: EditRecord[] = [];
    for (let s = this.o.seq + 1; this.pending.has(s); s++) run.push(this.pending.get(s)!);
    if (!run.length) return;
    const r = await applyRecords(this.o.dir, run);
    const done = run.filter((x) => x.seq <= r.applied);
    const now = Date.now();
    for (const x of done) {
      this.latencies.push(now - Date.parse(x.ts));
      this.pending.delete(x.seq);
    }
    if (r.applied) this.o.seq = r.applied;
    if (done.length) this.o.onApplied?.(done);
    if (r.mismatch !== null) {
      this.pending.clear();
      this.o.onReset?.(`편집 기록 ${r.mismatch}가 이 창의 내용과 맞지 않는다`);
    }
  }
}

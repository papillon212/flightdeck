// flightdeck-server 클라이언트 (설계 §11.2, §2.5, §12). VS Code API를 쓰지 않는다.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyConfig, type BlameResult, type ConfigPayload, type SignedConfig } from "@flightdeck/core";
import type { EditMemo, EditRecord, Event } from "@flightdeck/schema";

export class ServerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 응답 본문 (JSON이면) */
    readonly data: any = null,
  ) {
    super(message);
  }
}

export class ServerClient {
  constructor(
    readonly url: string,
    private token: string | null,
    /** 확장 설정 flightdeck.serverKeyFingerprint (§12 서버 키 최초 신뢰) */
    readonly fingerprint: string,
    private f: typeof fetch = fetch,
  ) {}

  get loggedIn(): boolean {
    return !!this.token;
  }

  setToken(t: string | null) {
    this.token = t;
  }

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await this.f(this.url.replace(/\/$/, "") + p, {
        method,
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ServerRequestError(0, `서버에 연결하지 못했다 (${this.url}): ${e instanceof Error ? e.message : e}`);
    }
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* JSON 아님 */
    }
    if (!r.ok) throw new ServerRequestError(r.status, data?.error ?? `${r.status} ${text.slice(0, 200)}`, data);
    return data as T;
  }

  /** 개발용 로그인 (서버가 루프백에서 FD_DEV_LOGIN=1일 때만) */
  async devLogin(member: string): Promise<string> {
    const r = await this.call<{ token: string }>("POST", "/auth/dev", { member });
    this.token = r.token;
    return r.token;
  }

  me(): Promise<{ id: string; admin: boolean; tracker_id?: string }> {
    return this.call("GET", "/me");
  }

  /** 설정을 받아 서버 키 지문과 서명을 검증한다 */
  async config(product: string, version?: string): Promise<ConfigPayload> {
    const q = new URLSearchParams({ product, ...(version ? { version } : {}) });
    return verifyConfig(await this.call<SignedConfig>("GET", `/config?${q}`), this.fingerprint);
  }

  // ---- 실시간 중계 (서버 ④, M8 L1) ----

  liveSend(product: string, epic: string, type: string, data: unknown, to?: string[]): Promise<{ id: number }> {
    return this.call("POST", `/live/${encodeURIComponent(epic)}?product=${encodeURIComponent(product)}`, { type, data, ...(to ? { to } : {}) });
  }

  livePresence(product: string, epic: string): Promise<Record<string, { online: boolean; offlineAt: string | null }>> {
    return this.call("GET", `/live/${encodeURIComponent(epic)}/presence?product=${encodeURIComponent(product)}`);
  }

  /** SSE 응답 (본문을 읽는 쪽이 메시지로 나눈다). after: 마지막으로 받은 메시지 번호 */
  async liveStream(product: string, epic: string, after: number, signal: AbortSignal): Promise<Response> {
    const r = await this.f(`${this.url.replace(/\/$/, "")}/live/${encodeURIComponent(epic)}?product=${encodeURIComponent(product)}&after=${after}`, {
      headers: { accept: "text/event-stream", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      signal,
    });
    if (!r.ok || !r.body) throw new ServerRequestError(r.status, `실시간 연결 실패 (${r.status})`);
    return r;
  }

  // ---- 편집 기록 (서버 ③, M7) ----

  /** 편집 기록 올리기. seq가 이어지지 않으면 409 (data.last = 서버의 마지막 seq) */
  uploadEditlog(product: string, body: { epic: string; records: EditRecord[]; memos?: EditMemo[] }): Promise<{ last: number }> {
    return this.call("POST", `/editlog?product=${encodeURIComponent(product)}`, body);
  }

  editlog(product: string, epic: string, from = 1): Promise<{ records: EditRecord[]; memos: EditMemo[]; last: number }> {
    return this.call("GET", `/editlog/${encodeURIComponent(epic)}?product=${encodeURIComponent(product)}&from=${from}`);
  }

  /** 줄 단위 출처 (E6): rev 커밋의 편집 기록 위치까지 */
  blame(product: string, epic: string, file: string, rev: string): Promise<BlameResult & { upto: number | null; matches: boolean }> {
    const q = new URLSearchParams({ product, file, rev });
    return this.call("GET", `/editlog/${encodeURIComponent(epic)}/blame?${q}`);
  }

  /** 내장 git 전용 토큰 (M5.5 Z3). git 경로에만 쓸 수 있다 */
  gitToken(): Promise<{ member: string; token: string; expires_at: string }> {
    return this.call("POST", "/git/token");
  }

  /** 서버 서명 이벤트 요청 (§12 서명 요청). 서버가 검증·서명·push한 이벤트를 돌려준다 */
  async requestEvent(product: string, epic: string, type: string, data: Record<string, unknown>): Promise<Event> {
    return (await this.call<{ event: Event }>("POST", "/events", { product, epic, type, data })).event;
  }
}

/**
 * 설정 캐시 (§2.5 "받은 설정을 캐시한다. 서버가 죽어 있으면 캐시를 쓴다").
 * 위치: <git common dir>/flightdeck/config/<product>/<version>/{config.json, rules/*.md}.
 * 설계는 .flightdeck/.runtime/config/<version>/이지만, 에픽 작업 폴더를 만들기 전에도 필요해서 모든 작업 폴더가 공유하는 곳에 둔다.
 * rules/는 훅이 읽는 단계 룰 폴더(LocalEpicState.configDir)로 그대로 쓴다.
 */
export function configCacheDir(dataDir: string, product: string, version: string): string {
  return path.join(dataDir, "config", product, version);
}

export async function cacheConfig(dataDir: string, c: ConfigPayload): Promise<string> {
  const dir = configCacheDir(dataDir, c.product, c.version);
  await mkdir(path.join(dir, "rules"), { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify(c, null, 2));
  for (const [name, text] of Object.entries(c.rules)) await writeFile(path.join(dir, "rules", `${name}.md`), text);
  await writeFile(path.join(dir, "pipeline.yaml"), c.pipeline_yaml);
  return dir;
}

/** 캐시된 설정. version이 없으면 가장 최근에 받은 것 */
export async function loadCachedConfig(dataDir: string, product: string, version?: string): Promise<ConfigPayload | null> {
  const base = path.join(dataDir, "config", product);
  if (!existsSync(base)) return null;
  let dir: string | null = null;
  if (version) dir = existsSync(path.join(base, version, "config.json")) ? path.join(base, version) : null;
  else {
    let best = -1;
    for (const v of await readdir(base)) {
      const f = path.join(base, v, "config.json");
      if (!existsSync(f)) continue;
      const t = (await stat(f)).mtimeMs;
      if (t > best) [best, dir] = [t, path.join(base, v)];
    }
  }
  return dir ? (JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")) as ConfigPayload) : null;
}

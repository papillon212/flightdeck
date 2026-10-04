// 서버 서명 (설계 §3.1, §12). 단계 통과 이벤트와 설정 응답은 서버 키(ed25519)로 서명한다.
// 서명 대상은 정규화 JSON(RFC 8785 JCS)이다. JCS의 문자열·숫자 직렬화는 ECMAScript JSON.stringify와 같으므로
// 객체 키를 UTF-16 코드 단위 순으로 정렬하고 공백 없이 쓰면 된다.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { SERVER_SIGNED_TYPES, type Event } from "@flightdeck/schema";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("정규화 JSON: 유한하지 않은 숫자");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 서버 키 쌍 생성. 공개키는 32바이트 원본의 base64, 개인키는 PKCS#8 PEM (서버 비밀 저장소에 둔다) */
export function generateServerKey(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519_PREFIX.length);
  return { publicKey: raw.toString("base64"), privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

export function publicKeyOf(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  return der.subarray(SPKI_ED25519_PREFIX.length).toString("base64");
}

/** 지문: SHA256:<base64> (ssh-keygen -l과 같은 모양). 확장 설정 flightdeck.serverKeyFingerprint와 비교한다 */
export function keyFingerprint(publicKey: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function publicKeyObject(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) throw new Error("ed25519 공개키는 32바이트여야 한다");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function signPayload(payload: unknown, privateKeyPem: string): string {
  return `ed25519:${sign(null, Buffer.from(canonicalJson(payload), "utf8"), createPrivateKey(privateKeyPem)).toString("base64")}`;
}

export function verifyPayload(payload: unknown, sig: string | undefined, publicKey: string): boolean {
  if (!sig?.startsWith("ed25519:")) return false;
  try {
    return verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKeyObject(publicKey), Buffer.from(sig.slice(8), "base64"));
  } catch {
    return false;
  }
}

function unsigned<E extends { sig?: string }>(e: E): Omit<E, "sig"> {
  const { sig: _, ...rest } = e;
  return rest;
}

/** 이벤트 서명: sig를 뺀 이벤트의 정규화 JSON에 서명해 sig를 채운다 */
export function signEvent<E extends Event>(e: E, privateKeyPem: string): E {
  return { ...e, sig: signPayload(unsigned(e), privateKeyPem) };
}

export function verifyEvent(e: Event, publicKey: string): boolean {
  return verifyPayload(unsigned(e), e.sig, publicKey);
}

export function needsServerSignature(e: Pick<Event, "type">): boolean {
  return SERVER_SIGNED_TYPES.has(e.type);
}

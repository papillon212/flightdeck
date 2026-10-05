// 서버가 서명해 배포하는 설정 (설계 §2.5 배포, §12 서버 키 최초 신뢰). 서버와 확장이 같이 쓴다.
import { parsePipeline, type Trust } from "@flightdeck/schema";
import { canonicalJson, keyFingerprint, verifyPayload } from "./sign.ts";
import { sha256 } from "./util.ts";

export interface ConfigPayload {
  product: string;
  version: string;
  pipeline_yaml: string;
  /** rules/<이름>.md → 내용 */
  rules: Record<string, string>;
  /** 멤버 목록 (이메일은 넣지 않는다) */
  members: { id: string; tracker_id?: string; active: boolean }[];
  /** 멤버 → 비활성 시각. reducer 신뢰 기준(Trust.deactivated)에 그대로 쓴다 */
  deactivated: Record<string, string>;
  server_key: string;
  issued_at: string;
}

export interface SignedConfig {
  payload: ConfigPayload;
  sig: string;
}

/**
 * 설정 내용 해시 (M5.5 Z9): pipeline.yaml과 룰 전체의 정규화 JSON sha256.
 * 설정 버전 ID는 서버 DB 안에서만 유일하므로, epic.started에 이 해시를 함께 서명해 다른 내용의 같은 ID를 잡는다
 */
export function configHash(c: { pipeline_yaml: string; rules: Record<string, string> }): string {
  return `sha256:${sha256(canonicalJson({ pipeline_yaml: c.pipeline_yaml, rules: c.rules }))}`;
}

/** 확장 쪽 검증: 지문이 맞는 키로 서명됐고 파이프라인이 유효한가. 문제가 있으면 이유를 던진다 */
export function verifyConfig(c: SignedConfig, expectedFingerprint: string): ConfigPayload {
  if (keyFingerprint(c.payload.server_key) !== expectedFingerprint) throw new Error(`서버 키 지문이 다르다: ${keyFingerprint(c.payload.server_key)} ≠ 설정값 ${expectedFingerprint}`);
  if (!verifyPayload(c.payload, c.sig, c.payload.server_key)) throw new Error("설정 응답의 서버 서명이 맞지 않는다");
  parsePipeline(c.payload.pipeline_yaml);
  return c.payload;
}

/** 검증한 설정으로 reducer 신뢰 기준을 만든다 */
export function trustFromConfig(c: ConfigPayload): Trust {
  return { mode: "server", serverKey: c.server_key, deactivated: c.deactivated };
}

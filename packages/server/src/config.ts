// 서명한 설정 응답 (설계 §2.5 배포). 형식과 확장 쪽 검증은 core/serverconfig.ts
import { nowIso, signPayload, type ConfigPayload, type SignedConfig } from "@flightdeck/core";
import type { ServerStore } from "./store.ts";

export async function buildConfig(store: ServerStore, product: string, keys: { publicKey: string; privateKeyPem: string }, version?: string): Promise<SignedConfig | null> {
  const cv = version ? await store.getConfigVersion(product, version) : await store.currentConfig(product);
  if (!cv) return null;
  const members = await store.listMembers();
  const payload: ConfigPayload = {
    product,
    version: cv.version,
    pipeline_yaml: cv.pipeline_yaml,
    rules: cv.rules,
    members: members.map((m) => ({ id: m.id, ...(m.tracker_id ? { tracker_id: m.tracker_id } : {}), active: m.active })),
    deactivated: Object.fromEntries(members.filter((m) => m.deactivated_at).map((m) => [m.id, m.deactivated_at!])),
    server_key: keys.publicKey,
    issued_at: nowIso(),
  };
  return { payload, sig: signPayload(payload, keys.privateKeyPem) };
}

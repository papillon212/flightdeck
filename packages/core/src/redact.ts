// 세션 원본의 비밀값 가리기 (설계 §6.4, M4 제안 X6). 허용 목록 필터를 거친 뒤, 저장 전에 적용한다.
// GitHub에서는 ref를 지워도 커밋이 남으므로(§2.1) 저장 전에 걸러야 한다.

export const REDACTED = "[REDACTED]";

/** 토큰 모양 (공급자별 접두사) */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // Anthropic·OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bpk_[0-9]+_[A-Z0-9]{20,}/g, // ClickUp
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API 키
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** 이름이 비밀처럼 보이는 환경변수 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|PRIVATE|API_?KEY|_KEY$|^KEY$)/i;

/** 가릴 환경변수 값 (이름이 비밀처럼 보이고 6자 이상) */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).flatMap(([k, v]) => (v && v.length >= 6 && SECRET_NAME.test(k) ? [v] : []));
}

/** .env 형식 파일의 값 (6자 이상) */
export function dotenvValues(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (v.length >= 6) out.push(v);
  }
  return out;
}

/** 토큰 모양과 주어진 값들을 가린다. 긴 값부터 바꾼다(한 값이 다른 값을 품는 경우) */
export function redactSecrets(text: string, values: string[] = []): string {
  let out = text;
  for (const v of [...new Set(values)].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

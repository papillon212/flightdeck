import { z } from "zod";

/** 단계 (설계 §4.1) */
export const Phase = z.enum(["INTAKE", "ANALYSIS", "DESIGN", "IMPLEMENTATION", "VERIFICATION", "LANDING", "DONE"]);
export type Phase = z.infer<typeof Phase>;

/** ULID: Crockford base32 26자 */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID가 아닙니다");

/** 멤버 ID (예: dh.lee). 설정 레포 members/<member>.pub의 이름과 같다 */
export const MemberId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "멤버 ID 형식이 아닙니다");

/** 에픽 ID (예: CU-86abc123). 일감 도구의 참조를 그대로 쓴다 */
export const EpicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "에픽 ID 형식이 아닙니다");

/** 쓰레드 ID: t-<ULID 앞 8자> (설계 §3.1) */
export const ThreadId = z.string().regex(/^t-[0-9A-HJKMNP-TV-Z]{8}$/, "쓰레드 ID 형식이 아닙니다");

/** 문단 고정 ID: p:<16진 4자> (설계 §3.2) */
export const ParagraphId = z.string().regex(/^p:[0-9a-f]{4}$/, "문단 ID 형식이 아닙니다");

/** 시간대가 붙은 ISO 8601 시각 */
export const Timestamp = z.iso.datetime({ offset: true });

/** git 객체 ID (SHA-1 40자 또는 SHA-256 64자) */
export const GitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "git 객체 ID가 아닙니다");

/** sha256 16진 */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256이 아닙니다");

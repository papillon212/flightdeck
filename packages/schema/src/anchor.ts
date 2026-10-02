import { z } from "zod";
import { GitSha, ParagraphId } from "./common.ts";

/** 문서 쓰레드 앵커: 문단 고정 ID (설계 §3.2) */
export const ParagraphAnchor = z.object({
  type: z.literal("paragraph"),
  pid: ParagraphId,
});

/** 편집 기록 위치 앵커 (설계 §3.5). seq 시점의 파일에서 [start, end) UTF-16 오프셋 */
export const EditAnchor = z.object({
  type: z.literal("edit"),
  file: z.string().min(1),
  seq: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

/** 코드 쓰레드 앵커 (설계 §3.3). 편집 기록으로 따라갈 수 없을 때의 대체 정보 */
export const CodeAnchor = z.object({
  type: z.literal("code"),
  file: z.string().min(1),
  rev: GitSha, // 체크포인트 또는 커밋
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]), // 1부터 세는 줄 번호, 양 끝 포함
  context: z.array(z.string()).max(6), // 앞뒤 3줄
  symbol: z.string().optional(),
});

export const Anchor = z.discriminatedUnion("type", [ParagraphAnchor, EditAnchor, CodeAnchor]);
export type Anchor = z.infer<typeof Anchor>;

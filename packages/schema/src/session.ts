import { z } from "zod";

/** 회의 요약 항목 (§10.1 ⑥ 앵커링 출력, M6). target: 쓰레드 / 파일 줄 / 에픽 전체 */
export const SessionAnchorTarget = z.union([
  z.object({ thread: z.string() }),
  z.object({ file: z.string().min(1), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]) }),
  z.object({ epic: z.literal(true) }),
]);

export const SessionItemSchema = z.object({
  target: SessionAnchorTarget,
  summary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
});

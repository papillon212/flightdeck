// 티어 리뷰 계산 (설계 §4.2 v0.13). reducer가 쓰는 순수 함수.
// - 티어는 일감의 검증 단계. 리뷰어가 없는 티어는 건너뛴다(설정).
// - 현재 산출물 = 마지막 review.requested의 해시. on_change면 해시가 다른 승인은 무효.
// - 현재 티어 = 유효 승인이 min_approvals에 못 미치는 첫 티어.
// - 담당자 자신의 승인은 담당자가 유일한 리뷰어인 티어까지만(그 티어와 앞 티어). 담당자가 아닌 한 사람의 승인은 한 티어에만 센다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parsePipeline, type Phase, type Pipeline } from "@flightdeck/schema";

/**
 * 설정 폴더(<dir>/pipeline.yaml)의 파이프라인. 훅·MCP는 로컬 상태 파일의 configDir(에픽에 고정된 설정 버전의 캐시)에서 읽는다.
 * 없거나 틀리면 undefined (티어 리뷰 이벤트를 처리하지 못할 뿐 다른 계산은 된다)
 */
export function pipelineFromDir(dir: string): Pipeline | undefined {
  const f = path.join(dir, "pipeline.yaml");
  if (!existsSync(f)) return undefined;
  try {
    return parsePipeline(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}

export interface Approval {
  event: string;
  tier: string;
  author: string;
  hash: string;
  at: string;
}

export interface ReviewState {
  phase: Phase;
  /** 마지막 리뷰 요청 */
  requested: { hash: string; commit: string; at: string; event: string } | null;
  /** 받아들인 승인 (받을 당시 유효했던 것). 지금 유효한지는 reviewProgress가 해시로 다시 거른다 */
  approvals: Approval[];
}

export interface TierProgress {
  name: string;
  reviewers: string[];
  min: number;
  skipped: boolean;
  /** 지금 유효한 승인자 */
  approvedBy: string[];
  done: boolean;
}

export interface ReviewProgress {
  tiers: TierProgress[];
  /** 현재 차례 티어 (모두 끝났으면 null) */
  current: TierProgress | null;
  done: boolean;
}

type ReviewConfig = Pipeline["phases"]["design"]["review"];

/** 단계별 리뷰 설정 (DESIGN, VERIFICATION) */
export function reviewConfig(pipeline: Pipeline | undefined, phase: Phase): ReviewConfig | null {
  if (!pipeline) return null;
  if (phase === "DESIGN") return pipeline.phases.design.review;
  if (phase === "VERIFICATION") return pipeline.phases.verification.review;
  return null;
}

export function tierReviewers(pipeline: Pipeline, tier: ReviewConfig["tiers"][number]): string[] {
  const r = tier.reviewers;
  return "group" in r ? [...(pipeline.members.groups[r.group] ?? [])] : [...r.members];
}

/** 담당자가 스스로 승인할 수 있는 마지막 티어 인덱스 (담당자가 유일한 리뷰어인 티어 중 가장 뒤). 없으면 -1 */
export function ownerSelfApprovalLimit(pipeline: Pipeline, cfg: ReviewConfig, owner: string): number {
  let limit = -1;
  cfg.tiers.forEach((t, i) => {
    const r = tierReviewers(pipeline, t);
    if (r.length === 1 && r[0] === owner) limit = i;
  });
  return limit;
}

/** 지금 유효한 승인으로 티어별 진행을 계산한다 */
export function reviewProgress(pipeline: Pipeline, cfg: ReviewConfig, rs: ReviewState, owner: string): ReviewProgress {
  const hash = rs.requested?.hash ?? null;
  const valid = rs.approvals.filter((a) => cfg.reapproval === "never" || a.hash === hash);
  const counted = new Set<string>(); // 담당자가 아닌 사람: 한 티어에만 센다
  const tiers: TierProgress[] = cfg.tiers.map((t) => {
    const reviewers = tierReviewers(pipeline, t);
    const approvedBy: string[] = [];
    for (const a of valid.filter((x) => x.tier === t.name)) {
      if (approvedBy.includes(a.author)) continue;
      if (a.author !== owner && counted.has(a.author)) continue;
      approvedBy.push(a.author);
      if (a.author !== owner) counted.add(a.author);
    }
    const skipped = reviewers.length === 0;
    const min = Math.min(t.min_approvals, Math.max(1, reviewers.length));
    return { name: t.name, reviewers, min, skipped, approvedBy, done: skipped || approvedBy.length >= min };
  });
  return { tiers, current: tiers.find((t) => !t.done) ?? null, done: !!rs.requested && tiers.every((t) => t.done) };
}

/**
 * 이 승인을 받아들일 수 없으면 이유. openByAuthor: 승인자 본인이 연 열린 쓰레드 수, openAll: 이 단계의 열린 쓰레드 수
 */
export function approvalProblem(
  pipeline: Pipeline,
  cfg: ReviewConfig,
  rs: ReviewState,
  owner: string,
  a: { tier: string; author: string; hash: string },
  open: { byAuthor: number; all: number },
): string | null {
  if (!rs.requested) return "리뷰 요청 전";
  if (a.hash !== rs.requested.hash) return "리뷰 요청된 문서와 해시가 다름";
  const p = reviewProgress(pipeline, cfg, rs, owner);
  if (!p.current) return "모든 티어가 이미 승인됨";
  if (a.tier !== p.current.name) return `현재 차례의 티어가 아님 (현재: ${p.current.name})`;
  const idx = cfg.tiers.findIndex((t) => t.name === a.tier);
  if (a.author === owner) {
    if (idx > ownerSelfApprovalLimit(pipeline, cfg, owner)) return "담당자 자신의 승인은 담당자가 유일한 리뷰어인 티어까지만";
  } else {
    if (!p.current.reviewers.includes(a.author)) return `${a.tier} 티어 리뷰어가 아님`;
    if (p.tiers.some((t) => t.name !== a.tier && t.approvedBy.includes(a.author))) return "이미 다른 티어를 승인함 (한 사람의 승인은 한 티어에만)";
  }
  if (p.current.approvedBy.includes(a.author)) return "이미 승인함";
  if (open.byAuthor > 0) return `승인자가 연 열린 쓰레드 ${open.byAuthor}개 (먼저 해결)`;
  // 이 승인으로 모든 티어가 끝나면 단계가 넘어가므로, 그때는 열린 쓰레드가 0이어야 한다
  const willFinish = p.tiers.every((t) => t.done || (t.name === a.tier && t.approvedBy.length + 1 >= t.min));
  if (willFinish && open.all > 0) return `열린 쓰레드 ${open.all}개 (마지막 승인 전에 해결)`;
  return null;
}

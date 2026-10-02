import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { MemberId } from "./common.ts";

/** 지원 등급 (설계 §6.5) */
export const SupportLevel = z.enum(["full", "partial", "minimal"]);

const Reviewers = z.union([
  z.object({ group: z.string().min(1) }),
  z.object({ members: z.array(MemberId).min(1) }),
]);

const Tier = z.object({
  name: z.string().min(1),
  reviewers: Reviewers,
  min_approvals: z.number().int().positive().default(1),
});

const Review = z.object({
  reapproval: z.enum(["on_change", "never"]).default("on_change"),
  tiers: z.array(Tier).min(1),
});

const Skip = z.object({
  when: z.object({
    tracker_tags: z.array(z.string()).optional(),
    size: z.array(z.string()).optional(),
  }),
  tiers: z.array(z.string()).min(1),
});

/** pipeline.yaml (설계 §5). 설정 레포 flightdeck-config/products/<product>/에 있다 */
export const Pipeline = z.object({
  version: z.literal(1),
  product: z.string().min(1),
  repo: z.string().min(1),

  agent: z.object({
    allowed: z.array(z.string().min(1)).min(1),
    min_support: SupportLevel.default("partial"),
    defaults: z.record(z.string(), z.string()).default({}),
    max_turns: z.number().int().positive().default(200),
  }),

  members: z.object({
    groups: z.record(z.string(), z.array(MemberId)).default({}),
    tracker_ids: z.record(MemberId, z.union([z.number(), z.string()])).default({}),
  }),

  tracker: z.looseObject({ provider: z.string().min(1) }),

  phases: z.object({
    analysis: z.object({
      rules: z.string().min(1),
      gate: z.object({
        threads_resolved: z.boolean().default(true),
        owner_approval: z.boolean().default(true),
      }),
    }),
    design: z.object({
      rules: z.string().min(1),
      review: Review,
      skip: z.array(Skip).default([]),
    }),
    implementation: z.object({
      rules: z.string().min(1),
      gate: z.object({
        impl_log_schema: z.boolean().default(true),
        coverage: z.number().min(0).max(1).default(1),
        coverage_ignore: z.array(z.string()).default([]),
        commands: z.array(z.string()).default([]),
      }),
    }),
    verification: z.object({
      rules: z.string().min(1),
      review: Review,
    }),
  }),

  checkpoint: z.object({
    agent: z.enum(["per_step_or_idle", "per_step"]).default("per_step_or_idle"),
    human_on_save: z.boolean().default(true),
    idle_seconds: z.number().int().positive().default(30),
    exclude_secrets: z.array(z.string()).default([".env", ".env.*", "*.pem", "*.key"]),
  }),

  session: z.looseObject({ provider: z.string().min(1) }),

  landing: z.object({
    target: z.string().default("main"),
    strategy: z.enum(["squash", "merge"]).default("squash"),
    on_main_moved: z.enum(["recheck"]).default("recheck"),
    test_verification: z.enum(["reported", "server_run"]).default("reported"),
    records: z.object({
      keep: z.array(z.string()).default([]),
      drop: z.array(z.string()).default([]),
    }),
  }),

  pilot: z.object({
    takeover_after_minutes: z.number().int().positive().default(10),
    takeover_by: z.array(z.string()).default(["owner"]),
  }),

  retention: z.object({
    ckpt_days: z.number().int().positive().default(14),
    runs_days: z.number().int().positive().default(30),
    editlog_days: z.number().int().positive().default(90),
  }),
});
export type Pipeline = z.infer<typeof Pipeline>;

/** YAML 문자열을 파싱·검증한다. 실패하면 zod 오류를 던진다 */
export function parsePipeline(yamlText: string): Pipeline {
  return Pipeline.parse(parseYaml(yamlText));
}

import { z } from "zod"
import { botSkillReference, botSkillSelection } from "./bot-skill-references"
import { botLocalComputerTarget } from "./bot-local-tool-permission"
import { skillDependencyDeclaration, type SkillDependencyDeclaration } from "./skill-dependencies"

export const BOT_SKILL_DEPENDENCY_SOURCE = "skill-dependency-check"
export const BOT_SKILL_DEPENDENCY_FRESH_MS = 10 * 60_000
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botCheckSkillDependencies = z
  .object({
    nonce: id,
    expectedDataEpoch: id,
    skill: botSkillSelection
  })
  .strict()
export type BotCheckSkillDependencies = z.infer<typeof botCheckSkillDependencies>
export const botSkillDependencyOrigin = botSkillReference
  .extend({
    scope: z.enum(["bot", "user", "desktop"]),
    sha256
  })
  .strict()
export type BotSkillDependencyOrigin = z.infer<typeof botSkillDependencyOrigin>
export const botSkillDependencyEnvironment = z
  .object({
    target: botLocalComputerTarget,
    dataEpoch: id,
    authoritySha256: sha256,
    workspaceSha256: sha256,
    policyRevision: z.number().int().nonnegative().safe(),
    commandRulesRevision: z.number().int().nonnegative().safe(),
    reviewRevision: z.number().int().nonnegative().safe(),
    botRevision: z.number().int().positive().safe(),
    buildId: z.string().min(1).max(160)
  })
  .strict()
export type BotSkillDependencyEnvironment = z.infer<typeof botSkillDependencyEnvironment>
export const botSkillDependencyReason = z.enum([
  "observed",
  "not_found",
  "version_too_old",
  "platform_mismatch",
  "unsupported",
  "permission_denied",
  "environment_unavailable",
  "probe_failed",
  "probe_output_invalid",
  "command_exit_unconfirmed",
  "not_checked",
  "stale_skill",
  "stale_environment",
  "expired",
  "interrupted",
  "superseded"
])
export const botSkillDependencyCheckResult = z
  .object({
    id: z.string().min(1).max(80),
    status: z.enum(["satisfied", "missing", "unverified"]),
    reason: botSkillDependencyReason,
    observedVersion: z
      .string()
      .max(64)
      .regex(/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/)
      .optional(),
    effectId: id.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.status === "satisfied"
        ? value.reason === "observed"
        : value.status === "missing"
          ? ["not_found", "version_too_old", "platform_mismatch"].includes(value.reason)
          : !["observed", "not_found", "version_too_old", "platform_mismatch"].includes(
              value.reason
            ),
    { message: "Result reason does not match observation" }
  )
export type BotSkillDependencyCheckResult = z.infer<typeof botSkillDependencyCheckResult>
export const botSkillDependencyReport = z
  .object({
    format: z.literal(1),
    skill: botSkillDependencyOrigin,
    environment: botSkillDependencyEnvironment,
    runId: id,
    checkedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
    status: z.enum(["satisfied", "missing", "unverified"]),
    checks: z.array(botSkillDependencyCheckResult).max(32)
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt > value.checkedAt &&
      value.expiresAt <= value.checkedAt + BOT_SKILL_DEPENDENCY_FRESH_MS,
    { message: "Invalid verification lifetime" }
  )
  .refine(
    (value) =>
      new Set(value.checks.map((item) => item.id)).size === value.checks.length &&
      value.status ===
        (value.checks.some((item) => item.status === "missing")
          ? "missing"
          : !value.checks.length || value.checks.some((item) => item.status === "unverified")
            ? "unverified"
            : "satisfied"),
    { message: "Report does not match individual checks" }
  )
export type BotSkillDependencyReport = z.infer<typeof botSkillDependencyReport>
export const botSkillDependencyReceipt = z
  .object({
    runId: id,
    messageId: id,
    skill: botSkillDependencyOrigin
  })
  .strict()
export type BotSkillDependencyReceipt = z.infer<typeof botSkillDependencyReceipt>
export interface BotSkillDependencyView {
  skill: BotSkillDependencyOrigin
  declaration: SkillDependencyDeclaration
  /** Historical reports do not grant permission or claim a skill trial passed. */
  history: Array<{
    receipt: BotSkillDependencyReceipt
    status: import("./bot-types").BotRunStatus
    createdAt: number
    report: BotSkillDependencyReport | null
    current: boolean
    reason?: z.infer<typeof botSkillDependencyReason>
  }>
}
export const botSkillDependencyPinned = z
  .object({
    skill: botSkillDependencyOrigin,
    declaration: skillDependencyDeclaration
  })
  .strict()

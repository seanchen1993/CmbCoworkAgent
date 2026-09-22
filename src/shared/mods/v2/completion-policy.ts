import { resolve, isAbsolute, relative, sep } from "node:path"

export const COMPLETION_MODES = ["off", "report", "check", "repair"] as const
export const COMPLETION_SCOPES = ["file", "diff", "feature", "project"] as const
export const COMPLETION_CHECKS = ["code-review", "unit-test", "e2e", "autobiz-validator"] as const

export type CompletionMode = (typeof COMPLETION_MODES)[number]
export type CompletionScope = (typeof COMPLETION_SCOPES)[number]
export type CompletionCheck = (typeof COMPLETION_CHECKS)[number]

export interface CompletionPolicy {
  mode: CompletionMode
  scope: CompletionScope
  target?: string
  feature?: string
  checks: CompletionCheck[]
  maxRepairs: number
  timeoutMs: number
  modelTokenBudget: number
}

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  mode: "off",
  scope: "project",
  checks: [...COMPLETION_CHECKS],
  maxRepairs: 2,
  timeoutMs: 120_000,
  modelTokenBudget: 8_192
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function boundedRelative(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new Error(`MODS_COMPLETION_${name.toUpperCase()}_INVALID`)
  if (isAbsolute(value) || value.split(/[\\/]+/).includes(".."))
    throw new Error(`MODS_COMPLETION_${name.toUpperCase()}_OUTSIDE_SCOPE`)
  const normalized = value.replaceAll("\\", "/")
  if (!normalized || normalized === "." || normalized.startsWith("/"))
    throw new Error(`MODS_COMPLETION_${name.toUpperCase()}_INVALID`)
  return normalized
}

export function resolveCompletionTarget(workspace: string, value: string): string {
  const root = resolve(workspace)
  const target = resolve(root, value)
  const rest = relative(root, target)
  if (rest === "" || rest.startsWith(`..${sep}`) || isAbsolute(rest))
    throw new Error("MODS_COMPLETION_TARGET_OUTSIDE_SCOPE")
  return target
}

export function parseCompletionPolicy(input: unknown): CompletionPolicy {
  if (!isRecord(input)) throw new Error("MODS_COMPLETION_CONFIG_INVALID")
  const mode = input.mode ?? DEFAULT_COMPLETION_POLICY.mode
  const scope = input.scope ?? DEFAULT_COMPLETION_POLICY.scope
  if (!COMPLETION_MODES.includes(mode as CompletionMode))
    throw new Error("MODS_COMPLETION_MODE_INVALID")
  if (!COMPLETION_SCOPES.includes(scope as CompletionScope))
    throw new Error("MODS_COMPLETION_SCOPE_INVALID")
  const checksValue = input.checks ?? DEFAULT_COMPLETION_POLICY.checks
  if (!Array.isArray(checksValue) || checksValue.length > COMPLETION_CHECKS.length)
    throw new Error("MODS_COMPLETION_CHECKS_INVALID")
  const checks = [...new Set(checksValue)]
  if (checks.some((check) => !COMPLETION_CHECKS.includes(check as CompletionCheck)))
    throw new Error("MODS_COMPLETION_CHECK_INVALID")
  if (mode !== "off" && checks.length === 0) throw new Error("MODS_COMPLETION_CHECKS_EMPTY")
  const maxRepairs: unknown = input.maxRepairs === undefined ? DEFAULT_COMPLETION_POLICY.maxRepairs : input.maxRepairs
  const timeoutMs: unknown = input.timeoutMs === undefined ? DEFAULT_COMPLETION_POLICY.timeoutMs : input.timeoutMs
  const modelTokenBudget: unknown = input.modelTokenBudget === undefined ? DEFAULT_COMPLETION_POLICY.modelTokenBudget : input.modelTokenBudget
  if (typeof maxRepairs !== "number" || !Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10)
    throw new Error("MODS_COMPLETION_MAX_REPAIRS_INVALID")
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000)
    throw new Error("MODS_COMPLETION_TIMEOUT_INVALID")
  if (typeof modelTokenBudget !== "number" || !Number.isInteger(modelTokenBudget) || modelTokenBudget < 256 || modelTokenBudget > 1_000_000)
    throw new Error("MODS_COMPLETION_MODEL_BUDGET_INVALID")
  const target = boundedRelative(input.target, "target")
  const feature = boundedRelative(input.feature, "feature")
  return { mode: mode as CompletionMode, scope: scope as CompletionScope, target, feature, checks, maxRepairs, timeoutMs, modelTokenBudget }
}

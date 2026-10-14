import type { ClawCapability } from "./claw"
import {
  COMPLETION_CHECKS,
  COMPLETION_SCOPES,
  DEFAULT_COMPLETION_POLICY,
  type CompletionPolicy
} from "./v2/completion-policy-values"

export interface ClawCompletionRule {
  pluginId: string
  name: string
  digest: string
  policy: Omit<CompletionPolicy, "mode" | "maxRepairs" | "autobizStartCheckpoint"> & {
    mode: "report" | "check"
    maxRepairs: 0
  }
}

/** Browser-safe parsing. A Claw can add checks, never grant repair or checkpoint writes. */
export function parseClawCompletionRules(
  input: unknown,
  capabilities: ClawCapability[]
): ClawCompletionRule[] {
  if (!Array.isArray(input) || input.length > 8) throw Error("Claw 附加规则无效。")
  const seen = new Set<string>()
  return input.map((raw) => {
    const rule = raw as ClawCompletionRule
    const capability = capabilities.find(
      (item) =>
        item.pluginId === rule?.pluginId && item.name === rule?.name && item.digest === rule?.digest
    )
    if (!capability || capability.components?.mode === "selected" || seen.has(rule.pluginId))
      throw Error("附加规则必须引用组合中唯一且完整启用的能力。")
    seen.add(rule.pluginId)
    const policy = rule.policy
    if (
      !policy ||
      typeof policy !== "object" ||
      Array.isArray(policy) ||
      !["report", "check"].includes(policy.mode) ||
      (policy.maxRepairs !== undefined && policy.maxRepairs !== 0) ||
      "autobizStartCheckpoint" in policy
    )
      throw Error("Claw 附加规则只能报告或检查，不能自动修复或推进阶段。")
    const scope = policy.scope ?? DEFAULT_COMPLETION_POLICY.scope
    const checks = policy.checks ?? DEFAULT_COMPLETION_POLICY.checks
    if (
      !COMPLETION_SCOPES.includes(scope) ||
      !Array.isArray(checks) ||
      !checks.length ||
      checks.length > COMPLETION_CHECKS.length ||
      checks.some((check) => !COMPLETION_CHECKS.includes(check))
    )
      throw Error("Claw 附加规则的范围或检查项无效。")
    const path = (value: unknown): string | undefined => {
      if (value === undefined) return undefined
      if (
        typeof value !== "string" ||
        !value ||
        value.length > 512 ||
        /^(?:[A-Za-z]:|[/\\])/.test(value) ||
        value.split(/[/\\]+/).includes("..") ||
        value === "." ||
        // eslint-disable-next-line no-control-regex -- Reject controls in untrusted paths.
        /[\x00-\x1f]/.test(value)
      )
        throw Error("Claw 附加规则路径必须位于项目内。")
      return value.replaceAll("\\", "/")
    }
    const target = path(policy.target)
    const feature = path(policy.feature)
    if ((scope === "file" && !target) || (scope === "feature" && !feature))
      throw Error("Claw 附加规则缺少文件或 Feature。")
    const bound = (value: number | undefined, fallback: number, min: number, max: number) => {
      const result = value ?? fallback
      if (!Number.isSafeInteger(result) || result < min || result > max)
        throw Error("Claw 附加规则预算无效。")
      return result
    }
    return {
      pluginId: capability.pluginId,
      name: capability.name,
      digest: capability.digest,
      policy: {
        mode: policy.mode,
        scope,
        target,
        feature,
        checks: [...new Set(checks)],
        maxRepairs: 0,
        timeoutMs: bound(policy.timeoutMs, DEFAULT_COMPLETION_POLICY.timeoutMs, 1000, 3_600_000),
        modelTokenBudget: bound(
          policy.modelTokenBudget,
          DEFAULT_COMPLETION_POLICY.modelTokenBudget,
          256,
          1_000_000
        )
      }
    }
  })
}

/** Same-source rules share one completion gate and cannot weaken the project floor. */
export function mergeClawCompletionPolicy(
  project: CompletionPolicy | undefined,
  additional: ClawCompletionRule["policy"] | undefined
): CompletionPolicy | undefined {
  if (!additional) return project
  const active = project && project.mode !== "off" ? project : undefined
  if (
    active &&
    (["scope", "target", "feature"] as const).some((key) => active[key] !== additional[key])
  )
    throw Error("附加规则与项目规则的范围、文件及 Feature 必须一致。")
  const ceiling = project ?? DEFAULT_COMPLETION_POLICY
  return {
    ...additional,
    mode:
      active?.mode === "check" || active?.mode === "repair" || additional.mode === "check"
        ? "check"
        : "report",
    checks: [...new Set([...(active?.checks ?? []), ...additional.checks])],
    maxRepairs: 0,
    timeoutMs: Math.min(ceiling.timeoutMs, additional.timeoutMs),
    modelTokenBudget: Math.min(ceiling.modelTokenBudget, additional.modelTokenBudget)
  }
}

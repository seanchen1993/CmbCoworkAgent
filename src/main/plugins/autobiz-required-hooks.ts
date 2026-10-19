import reviewedKernel from "./autobiz-business-kernel-reviewed.json"
import mergeReviewedKernel from "./autobiz-business-kernel-merge-reviewed.json"
import wakeupReviewedKernel from "./autobiz-business-kernel-wakeup-reviewed.json"
import specRoleReviewedKernel from "./autobiz-business-kernel-spec-role-reviewed.json"
import utestLiteralReviewedKernel from "./autobiz-business-kernel-utest-literal-reviewed.json"

/** Identity classification only. Existing reviewed-package admission still verifies every source byte. */
export function isReviewedAutobizKernelIdentity(kernel: { id: string; version: string }): boolean {
  return [reviewedKernel, mergeReviewedKernel, wakeupReviewedKernel, specRoleReviewedKernel, utestLiteralReviewedKernel].some(
    (profile) => kernel.id === profile.id && kernel.version === profile.version
  )
}

/** Reviewed AutoBiz v1 constraints. Prompt augmentation and critic logging remain composable. */
const REQUIRED = [
  ["PreToolUse", "python -X utf8 hooks/state_checkpoint.py state-done", 1],
  ["PreToolUse", "python -X utf8 hooks/state_checkpoint.py autodev-lifecycle", 1],
  ["PreToolUse", "python -X utf8 hooks/frontend_route_write_guard.py", 1],
  ["PreToolUse", "python -X utf8 hooks/check-secrets-new.py", 1],
  ["PreToolUse", "python -X utf8 hooks/check_state_read.py", 2],
  ["PreToolUse", "python -X utf8 hooks/code_execution_guard.py", 1],
  ["PreToolUse", "python -X utf8 hooks/runtime_artifact_guard.py", 1],
  ["PreToolUse", "python -X utf8 hooks/human_gate_design_done.py", 1],
  ["PreToolUse", "python -X utf8 hooks/performance_checker.py", 1],
  ["PostToolUse", "python -X utf8 hooks/verified_digest_guard.py", 2]
] as const
const PINNED_ORIGINAL_REQUIRED = [
  ["PreToolUse", "python hooks/state_checkpoint.py state-done", 1],
  ["PreToolUse", "python hooks/state_checkpoint.py autodev-lifecycle", 1],
  ["PreToolUse", "python hooks/check-secrets-new.py", 1],
  ["PreToolUse", "python hooks/performance_checker.py", 1]
] as const

/** Pure portable IDs using the original CC parser's Event:group:handler identity.
 * Call only after admission to the supported AutoBiz adapter. This list grants no source authority.
 */
export function reviewedAutobizRequiredHookIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("AUTOBIZ_REQUIRED_HOOKS_INVALID")
  const raw = value as Record<string, unknown>
  const input =
    raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
      ? (raw.hooks as Record<string, unknown>)
      : raw
  // The original admitted 49-file adapter predates the larger reviewed business kernel.
  const currentKernel =
    Object.hasOwn(input, "PostToolUse") || JSON.stringify(input).includes("-X utf8")
  const required: readonly (readonly ["PreToolUse" | "PostToolUse", string, number])[] =
    currentKernel ? REQUIRED : PINNED_ORIGINAL_REQUIRED
  const counts = new Map<string, number>()
  const result: string[] = []
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const groups = input[event]
    if (!Array.isArray(groups)) {
      if (!currentKernel && event === "PostToolUse") continue
      throw Error("AUTOBIZ_REQUIRED_HOOKS_INCOMPLETE")
    }
    groups.forEach((group: unknown, groupIndex) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return
      const hooks = (group as Record<string, unknown>).hooks
      if (!Array.isArray(hooks)) return
      hooks.forEach((value: unknown, hookIndex) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return
        const hook = value as Record<string, unknown>
        if (hook.type !== "command" || typeof hook.command !== "string") return
        const command = hook.command.trim().replace(/\s+/g, " ")
        if (
          !required.some(
            ([requiredEvent, requiredCommand]) =>
              event === requiredEvent && command === requiredCommand
          )
        )
          return
        const key = `${event}\0${command}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        const id = typeof hook.id === "string" && hook.id.trim() ? hook.id.trim() : undefined
        result.push(id ? `${event}:${id}` : `${event}:${groupIndex}:${hookIndex}`)
      })
    })
  }
  if (
    new Set(result).size !== result.length ||
    required.some(([event, command, count]) => counts.get(`${event}\0${command}`) !== count)
  )
    throw Error("AUTOBIZ_REQUIRED_HOOKS_INCOMPLETE")
  return result
}

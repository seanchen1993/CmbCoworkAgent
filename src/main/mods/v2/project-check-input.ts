import { AsyncLocalStorage } from "node:async_hooks"
import type { ModIdentity } from "../../../shared/mods/types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { ModError } from "../errors"

type CheckIdentity = Pick<
  ModIdentity,
  "workspace" | "threadId" | "turnId" | "agentId" | "modId" | "grantEpoch" | "toolCallId"
>
interface CheckScope {
  identity: CheckIdentity
  input: { command: string; cwd: string }
  active: boolean
  validated: boolean
}
const checks = new AsyncLocalStorage<CheckScope>()

/** Additional host assertion inside the original tool approval boundary, never an executor. */
export function assertProjectCheckInput(
  identity: ModIdentity,
  toolId: string,
  input: Record<string, unknown>
): void {
  const check = checks.getStore()
  if (!check || identity.toolCallId !== check.identity.toolCallId) return
  if (!check.active) throw new ModError("MODS_PROJECT_CHECK_SCOPE_EXPIRED")
  for (const key of ["workspace", "threadId", "turnId", "agentId", "modId", "grantEpoch"] as const)
    if (identity[key] !== check.identity[key])
      throw new ModError("MODS_PROJECT_CHECK_SCOPE_CHANGED")
  if (
    toolId !== "host:execute" ||
    input.command !== check.input.command ||
    typeof input.cwd !== "string" ||
    !isSameWorkspacePath(input.cwd, check.input.cwd) ||
    Object.keys(input).some((key) => key !== "command" && key !== "cwd")
  )
    throw new ModError("MODS_PROJECT_CHECK_INPUT_CHANGED")
  check.validated = true
}

export async function withProjectCheckInput<T>(
  identity: CheckIdentity,
  input: CheckScope["input"],
  run: () => Promise<T>
): Promise<T> {
  const check: CheckScope = {
    identity: { ...identity },
    input: { ...input },
    active: true,
    validated: false
  }
  try {
    return await checks.run(check, async () => {
      const value = await run()
      if (!check.validated) throw new ModError("MODS_PROJECT_CHECK_RECEIPT_REQUIRED")
      return value
    })
  } finally {
    check.active = false
  }
}

/** Only the host's validated, still-active test invocation may request process containment. */
export function isProjectCheckExecution(identity: ModIdentity): boolean {
  const check = checks.getStore()
  if (!check || identity.toolCallId !== check.identity.toolCallId) return false
  if (!check.active || !check.validated) throw new ModError("MODS_PROJECT_CHECK_SCOPE_EXPIRED")
  for (const key of ["workspace", "threadId", "turnId", "agentId", "modId", "grantEpoch"] as const)
    if (identity[key] !== check.identity[key])
      throw new ModError("MODS_PROJECT_CHECK_SCOPE_CHANGED")
  return true
}

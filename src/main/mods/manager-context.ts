import type { ModsManager } from "./manager-core"
import { ModError } from "./errors"
import { getModCallContext } from "./context"
import { beforeModToolExecution } from "./execution-error"
import { filterModData } from "./publication"
import { encodeModJson } from "../../shared/mods/validation"
import { AsyncLocalStorage } from "node:async_hooks"

const scopedManager = new AsyncLocalStorage<ModsManager>()
/** Concurrent headless runs retain their own grants, policy and physical runtime. */
export function withModsManager<T>(value: ModsManager, run: () => T): T {
  return scopedManager.run(value, run)
}

let manager: ModsManager | undefined
let unavailable: string | undefined
export function setModsManager(value: ModsManager | undefined): void {
  manager = value
  unavailable = undefined
}
export function setModsUnavailable(code: string): void {
  manager = undefined
  unavailable = code
}
export function getModsManager(): ModsManager | undefined {
  const scoped = scopedManager.getStore()
  if (scoped) return scoped
  if (unavailable) throw new ModError(unavailable)
  return manager
}

export async function authorizeCurrentModInput(
  toolId: string,
  args: Record<string, unknown>
): Promise<void> {
  const context = getModCallContext()
  if (!context) return
  await beforeModToolExecution(async () => {
    args = filterModData(args, false) as Record<string, unknown>
    const signature = `${toolId}:${encodeModJson(args)}`
    context.assertLive?.()
    if (context.approvedOperation && context.authorizedInput === signature) return
    context.approvedOperation = undefined
    await context.authorize?.(toolId, args)
    context.assertLive?.()
    context.effectiveArgs = args
    if (context.routeClaimed)
      getModsManager()?.store.bindFinalInput(context.identity.callId, toolId, args)
    if (context.originMod && context.authorize) {
      context.authorizedInput = signature
      context.approvedOperation = { toolId, args }
    }
  })
}

export function hasModOperationApproval(toolId: string, args: Record<string, unknown>): boolean {
  const context = getModCallContext()
  context?.assertLive?.()
  const approved = context?.approvedOperation
  return Boolean(
    context?.originMod &&
    approved?.toolId === toolId &&
    Object.entries(args).every(([key, value]) => approved.args[key] === value)
  )
}

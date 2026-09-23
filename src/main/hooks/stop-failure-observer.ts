import { getModsManager } from "../mods/manager"
import { runHooks, type HookContext, type HookResultCallback } from "./runner"
import type { HookConfig } from "./types"

/** Observe a failed run without replacing its error, restarting it, or outliving its Mods scope. */
export async function observeStopFailure(
  hooks: HookConfig[],
  context: HookContext,
  onHookResult?: HookResultCallback
): Promise<void> {
  const waitForMods =
    !!context.workspacePath && !!getModsManager()?.isEnabled(context.workspacePath)
  const observed = runHooks(hooks, "StopFailure", context, onHookResult).catch((error: unknown) => {
    console.warn("[Hooks] StopFailure hook error:", error)
  })
  // The original legacy-only notification path remains asynchronous.
  if (waitForMods) await observed
}

import { ModError } from "../../mods/errors"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { findHookProcessCleanupError } from "../../hooks/owned-process-error"
import { assertCurrentRuntimePluginSourceContent } from "../../plugins/runtime-source-scope"

/** Optional guest failures recover in the dispatcher, never at the Skill publication boundary. */
export function throwIfSkillHookHostFailure(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  // Source guards may throw ordinary native Errors; never classify them by guessed error text.
  assertCurrentRuntimePluginSourceContent()
  const cleanupFailure = findHookProcessCleanupError(error)
  if (cleanupFailure) throw cleanupFailure
  if (
    error instanceof ModError ||
    error instanceof ModFunctionError ||
    (error instanceof Error && error.message === "HOOK_SESSION_CHANGED")
  )
    throw error
}

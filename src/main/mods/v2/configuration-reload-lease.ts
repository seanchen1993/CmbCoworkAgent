import { randomUUID } from "node:crypto"
import {
  assertLocalThreadRunLease,
  captureLocalThreadRunLease,
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Uses the same physical gate as desktop, IM and scheduler; never hand off ownership. */
export function claimConfigurationReload(threadId: string) {
  const runId = `mods-reload:${randomUUID()}`
  const claim = claimLocalThreadRunLease({ threadId, owner: "mods", runId })
  if (!claim.acquired) return undefined
  const current = captureLocalThreadRunLease(threadId)!
  return {
    assertLive() {
      if (!current()) throw new ModFunctionError("MODS_CONFIG_RELOAD_LEASE_CHANGED")
      assertLocalThreadRunLease(threadId, "mods", runId)
    },
    release() {
      releaseLocalThreadRunLease(threadId, "mods", runId)
    }
  }
}

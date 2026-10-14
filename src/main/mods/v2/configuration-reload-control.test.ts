import { expect, it } from "vitest"
import { FunctionConfigurationReloadControl } from "./configuration-reload-control"
import { claimConfigurationReload } from "./configuration-reload-lease"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { randomUUID } from "node:crypto"

it("physical reload uses the actual shared gate and releases only its exact lease", () => {
  const threadId = randomUUID()
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "running" })
  expect(claimConfigurationReload(threadId)).toBeUndefined()
  releaseLocalThreadRunLease(threadId, "desktop", "running")
  const lease = claimConfigurationReload(threadId)!
  expect(getLocalThreadRunLease(threadId)?.owner).toBe("mods")
  expect(claimLocalThreadRunLease({ threadId, owner: "im", runId: "other" }).acquired).toBe(false)
  expect(() => lease.assertLive()).not.toThrow()
  const actual = getLocalThreadRunLease(threadId)!
  releaseLocalThreadRunLease(threadId, actual.owner, actual.runId)
  claimLocalThreadRunLease({ threadId, owner: "scheduler", runId: "new" })
  expect(() => lease.assertLive()).toThrow("MODS_CONFIG_RELOAD_LEASE_CHANGED")
  lease.release()
  expect(getLocalThreadRunLease(threadId)?.runId).toBe("new")
  releaseLocalThreadRunLease(threadId, "scheduler", "new")
})

it("cache lifecycle cancellation never clears the stopped effects receipt", () => {
  const controls = new FunctionConfigurationReloadControl()
  const first = controls.begin("workspace", "thread")
  first.failed(Error("startup failed"))
  controls.cancel("workspace")
  expect(first.signal.aborted).toBe(true)
  expect(controls.error("workspace", "thread")).toBe("startup failed")
  first.finish()
  const explicitRetry = controls.begin("workspace", "thread")
  explicitRetry.applied()
  explicitRetry.finish()
  expect(controls.error("workspace", "thread")).toBeUndefined()
})

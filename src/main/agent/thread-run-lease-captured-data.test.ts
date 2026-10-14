import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { captureLocalThreadRunLease, claimLocalThreadRunLease,
  releaseLocalThreadRunLease } from "./thread-run-lease"

describe("actual captured local lease data", () => {
  it.each(["getter", "replacement"] as const)(
    "uses fresh original Map.get with late %s callback zero and refuses reacquired ownership", attack => {
      const threadId = randomUUID(), runId = randomUUID()
      expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
      const original = Object.getOwnPropertyDescriptor(Map.prototype, "get")
      let callbacks = 0, first = false, second = false, failed = false, failure: unknown
      let captured: (() => boolean) | undefined
      const forbidden = () => { callbacks++; throw Error("LATE_LEASE_MAP_GET") }
      try {
        Object.defineProperty(Map.prototype, "get", attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, writable: true, value: forbidden })
        try {
          captured = captureLocalThreadRunLease(threadId)
          first = captured?.() ?? false
          second = captured?.() ?? false
        } catch (error) { failed = true; failure = error }
      } finally {
        if (original) Object.defineProperty(Map.prototype, "get", original)
        else Reflect.deleteProperty(Map.prototype, "get")
      }
      try {
        expect(failed).toBe(false)
        expect(failure).toBeUndefined()
        expect(callbacks).toBe(0)
        expect(first).toBe(true)
        expect(second).toBe(true)
        expect(releaseLocalThreadRunLease(threadId, "desktop", runId)).toBe(true)
        expect(captured?.()).toBe(false)
        expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
        expect(captured?.()).toBe(false)
        expect(captureLocalThreadRunLease(threadId)?.()).toBe(true)
      } finally { releaseLocalThreadRunLease(threadId, "desktop", runId) }
    })
})

import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FUNCTION_DISPLAY_PROTOCOL,
  FUNCTION_DISPLAY_MAX_PENDING,
  HostDisplayRollout,
  type HostDisplayLease
} from "./display-rollout"

afterEach(() => vi.unstubAllEnvs())

describe("host-only display rollout fence", () => {
  it("bounds all physical reads including same-key followers and unknown peers", () => {
    const host = new HostDisplayRollout({ invalidateProjection: () => {} })
    const leases = Array.from({ length: FUNCTION_DISPLAY_MAX_PENDING }, (_, index) =>
      host.admit(index % 2 ? "legacy-peer" : FUNCTION_DISPLAY_PROTOCOL)
    )
    expect(host.snapshot().physicalPending).toBe(256)
    expect(() => host.admit()).toThrow("MODS_DISPLAY_PENDING_LIMIT")
    leases[0].completePhysical()
    const replacement = host.admit()
    expect(host.snapshot().physicalPending).toBe(256)
    host.markPhysicalUnknown(replacement)
    expect(host.snapshot()).toMatchObject({ physicalPending: 256, physicalUnknown: 1 })
    for (const lease of leases) lease.completePhysical()
    expect(host.snapshot()).toMatchObject({ physicalPending: 1, physicalUnknown: 1 })
    expect(() => host.admit()).toThrow("MODS_DISPLAY_DRAINING")
    replacement.completePhysical()
    expect(host.snapshot()).toMatchObject({
      physicalPending: 0,
      physicalUnknown: 0,
      phase: "active"
    })
  })

  it("defaults to v1 and permits only a native startup switch to legacy", () => {
    vi.stubEnv("DEVCLAW_MODS_DISPLAY_PROJECTION", "0")
    expect(new HostDisplayRollout({ invalidateProjection: () => {} }).snapshot().path).toBe(
      "legacy"
    )
    vi.stubEnv("DEVCLAW_MODS_DISPLAY_PROJECTION", "1")
    const host = new HostDisplayRollout({ invalidateProjection: () => {} })
    expect(host.admit().protocol).toBe(FUNCTION_DISPLAY_PROTOCOL)
    expect(
      new HostDisplayRollout({ enabled: false, invalidateProjection: () => {} }).snapshot().path
    ).toBe("legacy")
  })

  it("negotiates an unknown peer to legacy without publishing a mixed DTO", () => {
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: () => {} })
    for (const peer of [undefined, null, 1, "mods.display/v2", {}, ""]) {
      // Omitting the parameter is Main's explicit v1 default; an actual unknown peer is passed through.
      const lease = host.admit(peer)
      expect(lease.path).toBe("legacy")
      expect(lease.protocol).toBe("legacy")
      expect(host.canPublish(lease, "projection-v1")).toBe(false)
      expect(host.canPublish(lease, "legacy")).toBe(true)
      lease.completePhysical()
    }
    expect(host.admit(FUNCTION_DISPLAY_PROTOCOL).path).toBe("projection-v1")
  })

  it("retires an in-flight drawing before invalidation and waits for its actual finally", async () => {
    const invalidate = vi.fn(() => {
      expect(current.canPublish(old)).toBe(false)
      expect(() => current.admit()).toThrow("DRAINING")
    })
    const current: HostDisplayRollout = new HostDisplayRollout({
      enabled: true,
      invalidateProjection: invalidate
    })
    const old = current.admit()
    let complete!: () => void
    const physical = new Promise<void>((resolve) => {
      complete = resolve
    })
    const execute = vi.fn(async () => {
      try {
        await physical
        return current.canPublish(old)
      } finally {
        old.completePhysical()
      }
    })
    const pending = execute()
    current.switchPath("legacy")
    expect(current.snapshot()).toMatchObject({
      path: "legacy",
      phase: "draining",
      physicalPending: 1
    })
    expect(() => current.admit()).toThrow("DRAINING")
    complete()
    expect(await pending).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(current.snapshot()).toMatchObject({ phase: "active", physicalPending: 0 })
    expect(current.admit().path).toBe("legacy")
  })

  it("keeps a pure cache version valid after physical release but never after a source change", () => {
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: vi.fn() })
    const lease = host.admit()
    lease.completePhysical()
    expect(host.canPublish(lease)).toBe(false)
    expect(() => host.assertVersion(lease.epoch, lease.path)).not.toThrow()
    host.invalidate("source-changed")
    expect(() => host.assertVersion(lease.epoch, lease.path)).toThrow("VERSION_CHANGED")
    const current = host.admit()
    expect(host.canPublish(current)).toBe(true)
    expect(host.canPublish({ ...current } as HostDisplayLease)).toBe(false)
    expect(
      host.canPublish({ path: "projection-v1", epoch: current.epoch } as HostDisplayLease)
    ).toBe(false)
    current.completePhysical()
    current.completePhysical()
    expect(host.snapshot().physicalPending).toBe(0)
  })

  it("does not recreate a pending-confirmation owner or change an unknown action receipt", () => {
    const confirmOwner = Object.freeze({
      id: "opaque-native-owner",
      state: "awaiting-confirmation"
    })
    const actionReceipt = Object.freeze({ requestKey: "native-request", outcome: "unknown" })
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: vi.fn() })
    const display = host.admit()
    host.switchPath("legacy")
    display.completePhysical()
    host.switchPath("projection-v1")
    expect(host.canPublish(display)).toBe(false)
    expect(host.canPublish(confirmOwner as unknown as HostDisplayLease)).toBe(false)
    expect(() => host.markPhysicalUnknown(confirmOwner as unknown as HostDisplayLease)).toThrow(
      "LEASE_INVALID"
    )
    expect(confirmOwner.state).toBe("awaiting-confirmation")
    expect(actionReceipt.outcome).toBe("unknown")
  })

  it("keeps physical timeout unknown and refuses admission until actual completion", () => {
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: vi.fn() })
    const first = host.admit(),
      second = host.admit()
    host.markPhysicalUnknown(first)
    host.switchPath("legacy")
    expect(host.snapshot()).toMatchObject({
      phase: "unknown",
      physicalPending: 2,
      physicalUnknown: 1
    })
    second.completePhysical()
    host.retryInvalidation()
    expect(host.snapshot()).toMatchObject({ phase: "unknown", physicalPending: 1 })
    expect(() => host.admit()).toThrow("DRAINING")
    first.completePhysical()
    expect(host.snapshot()).toMatchObject({
      phase: "active",
      physicalPending: 0,
      physicalUnknown: 0
    })
    expect(host.canPublish(first)).toBe(false)
  })

  it("keeps failed projection invalidation closed and retries only that callback explicitly", () => {
    const invalidate = vi.fn().mockImplementationOnce(() => {
      throw Error("cache retirement failed")
    })
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: invalidate })
    const lease = host.admit()
    expect(() => host.switchPath("legacy")).toThrow("cache retirement failed")
    lease.completePhysical()
    expect(host.snapshot()).toMatchObject({ phase: "unknown", physicalPending: 0 })
    expect(() => host.admit()).toThrow("DRAINING")
    host.retryInvalidation()
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(host.snapshot().phase).toBe("active")
    expect(host.admit().path).toBe("legacy")
  })

  it("does not activate a new path while any retired drawing remains in flight", () => {
    const host = new HostDisplayRollout({ enabled: true, invalidateProjection: vi.fn() })
    const old = host.admit()
    host.switchPath("legacy")
    host.switchPath("projection-v1")
    expect(host.snapshot().phase).toBe("draining")
    old.completePhysical()
    expect(host.canPublish(old)).toBe(false)
    const next = host.admit()
    expect(next.epoch).toBeGreaterThan(old.epoch)
    expect(() => host.assertVersion(old.epoch, old.path)).toThrow("VERSION_CHANGED")
  })

  it("does not treat an accidentally asynchronous invalidator as completed retirement", () => {
    const host = new HostDisplayRollout({
      enabled: true,
      invalidateProjection: () => Promise.resolve()
    })
    expect(() => host.switchPath("legacy")).toThrow("MUST_BE_SYNCHRONOUS")
    expect(host.snapshot()).toMatchObject({ phase: "unknown", physicalPending: 0 })
    expect(() => host.admit()).toThrow("DRAINING")
  })

  it("has no Creator or business dependencies and does not import the manager facade", () => {
    const source = readFileSync(new URL("./display-rollout.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\b(?:Creator|AutoBiz|autobiz|FunctionModsManager)\b/)
  })
})

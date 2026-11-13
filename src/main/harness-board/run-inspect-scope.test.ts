import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  source: undefined as unknown,
  internal: false,
  current: true,
  assertSource: vi.fn(),
  capture: vi.fn(),
  readInternal: vi.fn()
}))
vi.mock("../plugins/runtime-source-scope", () => ({
  currentRuntimePluginSource: () => state.source,
  captureRuntimePluginSourceContentGuard: state.capture
}))
vi.mock("./internal-project-context", () => ({
  isInternalHarnessProjectId: () => state.internal,
  readInternalHarnessProject: state.readInternal
}))

import { runScopedHarnessInspection } from "./run-inspect-scope"

beforeEach(() => {
  vi.resetAllMocks()
  state.source = undefined
  state.internal = false
  state.current = true
  state.assertSource.mockImplementation(() => {
    if (!state.current) throw Error("SOURCE_REVOKED")
  })
  state.capture.mockReturnValue(state.assertSource)
  state.readInternal.mockReturnValue({})
})

describe("harness inspection reuse scope", () => {
  it("shares only an ordinary UI read without creating source authority", async () => {
    const value = Buffer.from("ordinary")
    const shared = vi.fn(async () => value)
    const actual = vi.fn()
    expect(await runScopedHarnessInspection({ projectId: "p" }, shared, actual)).toBe(value)
    expect(shared).toHaveBeenCalledOnce()
    expect(actual).not.toHaveBeenCalled()
    expect(state.capture).not.toHaveBeenCalled()
    expect(state.readInternal).not.toHaveBeenCalled()
  })

  it.each(["source", "readonly", "internal"] as const)(
    "executes a fresh protected read for %s instead of reusing a UI result", async kind => {
      state.source = kind === "source" ? {} : undefined
      state.internal = kind === "internal"
      const shared = vi.fn()
      const actual = vi.fn(async (beforeSpawn: () => void) => {
        beforeSpawn()
        return "actual"
      })
      expect(await runScopedHarnessInspection(
        { projectId: "p", readonlyPackage: kind === "readonly" }, shared, actual
      )).toBe("actual")
      expect(shared).not.toHaveBeenCalled()
      expect(actual).toHaveBeenCalledOnce()
      expect(state.capture).toHaveBeenCalledTimes(kind === "source" ? 1 : 0)
      expect(state.assertSource).toHaveBeenCalledTimes(kind === "source" ? 3 : 0)
      expect(state.readInternal).toHaveBeenCalledTimes(kind === "internal" ? 3 : 0)
    }
  )

  it("rejects an already revoked source without starting or sharing work", async () => {
    state.source = {}
    state.current = false
    const shared = vi.fn()
    const actual = vi.fn()
    await expect(runScopedHarnessInspection({ projectId: "p" }, shared, actual))
      .rejects.toThrow("SOURCE_REVOKED")
    expect(shared).not.toHaveBeenCalled()
    expect(actual).not.toHaveBeenCalled()
  })

  it("rechecks the original source after actual queue admission before spawning", async () => {
    state.source = {}
    const effect = vi.fn()
    const shared = vi.fn()
    const actual = async (beforeSpawn: () => void) => {
      await Promise.resolve()
      state.current = false
      beforeSpawn()
      effect()
      return "forbidden"
    }
    await expect(runScopedHarnessInspection({ projectId: "p" }, shared, actual))
      .rejects.toThrow("SOURCE_REVOKED")
    expect(effect).not.toHaveBeenCalled()
    expect(shared).not.toHaveBeenCalled()
    expect(state.capture).toHaveBeenCalledOnce()
  })

  it("does not publish a protected result after its source was revoked", async () => {
    state.source = {}
    const shared = vi.fn()
    await expect(runScopedHarnessInspection({ projectId: "p" }, shared, async beforeSpawn => {
      beforeSpawn()
      state.current = false
      return "must-not-publish"
    })).rejects.toThrow("SOURCE_REVOKED")
    expect(shared).not.toHaveBeenCalled()
  })

  it("rechecks internal project lifetime at the actual spawn boundary", async () => {
    state.internal = true
    const effect = vi.fn()
    const shared = vi.fn()
    await expect(runScopedHarnessInspection({ projectId: "internal" }, shared, async beforeSpawn => {
      state.readInternal.mockReturnValue(undefined)
      beforeSpawn()
      effect()
      return "forbidden"
    })).rejects.toThrow("COMPOSITION_INTERNAL_SCOPE_CHANGED")
    expect(effect).not.toHaveBeenCalled()
    expect(shared).not.toHaveBeenCalled()
  })

  it("propagates original execution errors without falling back to a cached result", async () => {
    const failure = Error("ORIGINAL_FAILURE")
    const shared = vi.fn()
    await expect(runScopedHarnessInspection({ projectId: "p", readonlyPackage: true }, shared,
      async () => { throw failure })).rejects.toBe(failure)
    expect(shared).not.toHaveBeenCalled()
  })

  it("cancels a protected read before entering its executor", async () => {
    const controller = new AbortController()
    const failure = Error("CANCELLED")
    controller.abort(failure)
    const shared = vi.fn()
    const actual = vi.fn()
    await expect(runScopedHarnessInspection(
      { projectId: "p", readonlyPackage: true, signal: controller.signal }, shared, actual
    )).rejects.toBe(failure)
    expect(shared).not.toHaveBeenCalled()
    expect(actual).not.toHaveBeenCalled()
  })
})

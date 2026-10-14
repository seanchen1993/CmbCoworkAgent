import { describe, expect, it, vi } from "vitest"
import {
  classifyPhysicalStreamRunFailure,
  createPhysicalStreamRunSetupGuard,
  failPhysicalStreamRunBeforeSetupPublication,
  physicalStreamRunHasSuccessor,
  restorePhysicalStreamRunPredecessorToken
} from "./physical-stream-run-setup"

describe("physical stream run failure disposition", () => {
  it("finalizes an aborted run that still owns its lease as cancelled", () => {
    expect(
      classifyPhysicalStreamRunFailure({
        ownsLease: true,
        signalAborted: true,
        error: new Error("provider stopped")
      })
    ).toBe("cancelled")
  })

  it("treats provider abort errors as cancelled even before the signal flips", () => {
    expect(
      classifyPhysicalStreamRunFailure({
        ownsLease: true,
        signalAborted: false,
        error: new DOMException("request aborted", "AbortError")
      })
    ).toBe("cancelled")
  })

  it("reports an owned non-abort failure as an error", () => {
    expect(
      classifyPhysicalStreamRunFailure({
        ownsLease: true,
        signalAborted: false,
        error: new Error("all models failed")
      })
    ).toBe("error")
  })

  it("ignores a superseded run regardless of how it failed", () => {
    expect(
      classifyPhysicalStreamRunFailure({
        ownsLease: false,
        signalAborted: true,
        error: new DOMException("replaced", "AbortError")
      })
    ).toBe("stale")
  })
})

describe("physical stream run handoff", () => {
  it("reports a complete pre-publication terminal outcome", () => {
    const events: string[] = []

    failPhysicalStreamRunBeforeSetupPublication({
      error: new Error("strict flush failed"),
      sendError: (message) => events.push(`error:${message}`),
      sendDone: () => events.push("done")
    })

    expect(events).toEqual(["error:strict flush failed", "done"])
  })

  it("treats a reserved continuation token as a successor before its controller is installed", () => {
    const oldRunToken = "old-run"
    let currentTurnRunToken: string | undefined = oldRunToken
    let controllerReplaced = false

    expect(
      physicalStreamRunHasSuccessor({
        runToken: oldRunToken,
        currentTurnRunToken,
        controllerReplaced
      })
    ).toBe(false)

    // resume/interrupt reserve the logical-turn token before aborting and
    // waiting for the old controller to settle.
    currentTurnRunToken = "continuation-run"
    expect(
      physicalStreamRunHasSuccessor({
        runToken: oldRunToken,
        currentTurnRunToken,
        controllerReplaced
      })
    ).toBe(true)

    controllerReplaced = true
    expect(
      physicalStreamRunHasSuccessor({
        runToken: oldRunToken,
        currentTurnRunToken,
        controllerReplaced
      })
    ).toBe(true)
  })

  it("does not mistake a new-invoke wait for a continuation reservation", () => {
    expect(
      physicalStreamRunHasSuccessor({
        runToken: "old-run",
        currentTurnRunToken: "old-run",
        controllerReplaced: false
      })
    ).toBe(false)
  })

  it("does not treat released logical-turn state as a successor", () => {
    expect(
      physicalStreamRunHasSuccessor({
        runToken: "old-run",
        currentTurnRunToken: undefined,
        controllerReplaced: false
      })
    ).toBe(false)
  })

  it("rolls back only the abandoned continuation reservation", () => {
    expect(
      restorePhysicalStreamRunPredecessorToken({
        abandonedRunToken: "continuation-run",
        currentTurnRunToken: "continuation-run",
        predecessorRunToken: "old-run"
      })
    ).toBe("old-run")
    expect(
      restorePhysicalStreamRunPredecessorToken({
        abandonedRunToken: "continuation-run",
        currentTurnRunToken: "newer-run",
        predecessorRunToken: "old-run"
      })
    ).toBe("newer-run")
  })
})

describe("physical stream run setup guard", () => {
  it("releases and reports an active setup failure exactly once", () => {
    const release = vi.fn()
    const onActiveError = vi.fn()
    const cleanup = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => true,
      release,
      onActiveError
    })
    guard.addCleanup(cleanup)

    const error = new Error("setup failed")
    guard.fail(error)
    guard.abandon()
    guard.fail(new Error("late"))

    expect(release).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith(true, true)
    expect(onActiveError).toHaveBeenCalledOnce()
    expect(onActiveError).toHaveBeenCalledWith(error)
  })

  it("releases stale setup without reporting into the replacement run", () => {
    const release = vi.fn()
    const onActiveError = vi.fn()
    const cleanup = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => false,
      ownsLease: () => false,
      release,
      onActiveError
    })
    guard.addCleanup(cleanup)

    guard.fail(new Error("stale"))

    expect(release).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith(false, false)
    expect(onActiveError).not.toHaveBeenCalled()
  })

  it("runs owner cleanup only for an active setup failure", () => {
    const activeOwnerCleanup = vi.fn()
    const staleOwnerCleanup = vi.fn()
    const activeGuard = createPhysicalStreamRunSetupGuard({
      isActive: () => true,
      release: vi.fn(),
      onActiveError: vi.fn()
    })
    const staleGuard = createPhysicalStreamRunSetupGuard({
      isActive: () => false,
      release: vi.fn(),
      onActiveError: vi.fn()
    })
    activeGuard.addCleanup((_wasActive, wasOwner) => {
      if (wasOwner) activeOwnerCleanup()
    })
    staleGuard.addCleanup((_wasActive, wasOwner) => {
      if (wasOwner) staleOwnerCleanup()
    })

    activeGuard.fail(new Error("active setup failed"))
    staleGuard.fail(new Error("stale setup failed"))

    expect(activeOwnerCleanup).toHaveBeenCalledOnce()
    expect(staleOwnerCleanup).not.toHaveBeenCalled()
  })

  it("cleans an aborted setup that still owns the physical lease", () => {
    const ownerCleanup = vi.fn()
    const onActiveError = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => false,
      ownsLease: () => true,
      release: vi.fn(),
      onActiveError
    })
    guard.addCleanup((_wasActive, wasOwner) => {
      if (wasOwner) ownerCleanup()
    })

    guard.abandon()

    expect(ownerCleanup).toHaveBeenCalledOnce()
    expect(onActiveError).not.toHaveBeenCalled()
  })

  it("abandons an early return without fabricating an error", () => {
    const release = vi.fn()
    const onActiveError = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => true,
      release,
      onActiveError
    })

    guard.abandon()

    expect(release).toHaveBeenCalledOnce()
    expect(onActiveError).not.toHaveBeenCalled()
  })

  it("hands cleanup ownership to the main lifecycle", () => {
    const release = vi.fn()
    const onActiveError = vi.fn()
    const cleanup = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => true,
      release,
      onActiveError
    })
    guard.addCleanup(cleanup)

    guard.handoff()
    guard.abandon()
    guard.fail(new Error("owned by lifecycle"))

    expect(release).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(onActiveError).not.toHaveBeenCalled()
  })

  it("ignores cleanup registration after closure", () => {
    const cleanup = vi.fn()
    const guard = createPhysicalStreamRunSetupGuard({
      isActive: () => true,
      release: vi.fn(),
      onActiveError: vi.fn()
    })

    guard.abandon()
    guard.addCleanup(cleanup)

    expect(cleanup).not.toHaveBeenCalled()
  })
})

describe("file preparation cancellation terminal", () => {
  it("reports cancellation only after the actual held operation and cleanup finish", async () => {
    const controller = new AbortController()
    const gate = Promise.withResolvers<void>()
    const events: string[] = []
    const onActiveError = vi.fn()
    let ownsOriginal = true
    const options = {
      isActive: () => !controller.signal.aborted && ownsOriginal,
      ownsLease: () => ownsOriginal,
      release: () => { events.push("release"); ownsOriginal = false },
      onActiveError,
      onOwnedCancellation: () => events.push("done")
    }
    const guard = createPhysicalStreamRunSetupGuard(options)
    guard.addCleanup(() => events.push("signal-cleanup"))
    guard.addCleanup((wasActive, wasOwner) => {
      expect(wasActive).toBe(false)
      expect(wasOwner).toBe(true)
      events.push("owner-cleanup")
    })
    const actual = (async () => {
      try {
        await gate.promise
        controller.signal.throwIfAborted()
      } finally {
        events.push("physical-finally")
      }
    })()
    const observed = actual.then(() => guard.abandon(), error => guard.fail(error))
    try {
      controller.abort()
      expect(events).toEqual([])
      expect(ownsOriginal).toBe(true)
    } finally {
      gate.resolve()
      await observed
    }
    expect(events).toEqual([
      "physical-finally", "release", "signal-cleanup", "owner-cleanup", "done"
    ])
    expect(onActiveError).not.toHaveBeenCalled()
    guard.abandon()
    guard.fail(new Error("late completion"))
    expect(events.filter(event => event === "done")).toHaveLength(1)
  })

  it.each([undefined, null])("uses original ownership rather than the rejection value %s", reason => {
    const controller = new AbortController()
    controller.abort()
    const release = vi.fn()
    const cleanup = vi.fn()
    const onActiveError = vi.fn()
    const onOwnedCancellation = vi.fn()
    const options = {
      isActive: () => !controller.signal.aborted,
      ownsLease: () => true,
      release,
      onActiveError,
      onOwnedCancellation
    }
    const guard = createPhysicalStreamRunSetupGuard(options)
    guard.addCleanup(cleanup)
    guard.fail(reason)
    guard.abandon()
    expect(release).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith(false, true)
    expect(onActiveError).not.toHaveBeenCalled()
    expect(onOwnedCancellation).toHaveBeenCalledOnce()
  })

  it("does not notify after a replacement takes the original controller and owner", async () => {
    const originalController = new AbortController()
    let controller = originalController
    const originalOwner = Object.freeze({})
    let owner = originalOwner
    const gate = Promise.withResolvers<void>()
    const events: string[] = []
    const options = {
      isActive: () => !originalController.signal.aborted && owner === originalOwner,
      ownsLease: () => controller === originalController && owner === originalOwner,
      release: () => events.push("original-release"),
      onActiveError: vi.fn(),
      onOwnedCancellation: () => events.push("done")
    }
    const guard = createPhysicalStreamRunSetupGuard(options)
    const actual = (async () => {
      try {
        await gate.promise
        originalController.signal.throwIfAborted()
      } finally {
        events.push("physical-finally")
      }
    })()
    const observed = actual.then(() => guard.abandon(), error => guard.fail(error))
    try {
      originalController.abort()
      controller = new AbortController()
      owner = Object.freeze({})
      expect(events).toEqual([])
    } finally {
      gate.resolve()
      await observed
    }
    expect(events).toEqual(["physical-finally", "original-release"])
    expect(controller.signal.aborted).toBe(false)
    expect(options.onActiveError).not.toHaveBeenCalled()
  })

  it("leaves the cancellation terminal with the lifecycle after handoff", () => {
    const controller = new AbortController()
    const release = vi.fn()
    const cleanup = vi.fn()
    const options = {
      isActive: () => !controller.signal.aborted,
      ownsLease: () => true,
      release,
      onActiveError: vi.fn(),
      onOwnedCancellation: vi.fn()
    }
    const guard = createPhysicalStreamRunSetupGuard(options)
    guard.addCleanup(cleanup)
    guard.handoff()
    controller.abort()
    guard.fail(undefined)
    guard.abandon()
    expect(release).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(options.onActiveError).not.toHaveBeenCalled()
    expect(options.onOwnedCancellation).not.toHaveBeenCalled()
  })

  it("does not add a cancellation terminal to an active drop or active failure", () => {
    for (const failed of [false, true]) {
      const events: string[] = []
      const error = new Error("actual active failure")
      const options = {
        isActive: () => true,
        ownsLease: () => true,
        release: () => events.push("release"),
        onActiveError: (reason: unknown) => {
          expect(reason).toBe(error)
          events.push("error", "original-done")
        },
        onOwnedCancellation: () => events.push("cancel-done")
      }
      const guard = createPhysicalStreamRunSetupGuard(options)
      guard.addCleanup(() => events.push("cleanup"))
      if (failed) guard.fail(error)
      else guard.abandon()
      expect(events).toEqual(failed
        ? ["release", "cleanup", "error", "original-done"]
        : ["release", "cleanup"])
    }
  })
})

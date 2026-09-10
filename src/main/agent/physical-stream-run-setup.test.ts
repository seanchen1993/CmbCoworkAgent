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

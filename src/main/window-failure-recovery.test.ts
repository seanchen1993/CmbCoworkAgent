import { describe, expect, it, vi } from "vitest"
import { createNativeClosePrompt } from "./native-close-prompt"
import {
  createWindowFailureRecovery,
  createWindowPageLoader,
  showStartupFailure
} from "./window-failure-recovery"

function fixture() {
  let available = true
  let resolve: (value: { response: number }) => void = () => {}
  const context = {
    isAvailable: () => available,
    show: vi.fn(() => new Promise<{ response: number }>((done) => (resolve = done))),
    reload: vi.fn(),
    restart: vi.fn(),
    quit: vi.fn(),
    reportError: vi.fn()
  }
  return {
    context,
    recovery: createWindowFailureRecovery(context),
    unavailable: () => (available = false),
    async respond(response: number) {
      resolve({ response })
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

describe("native window failure recovery", () => {
  it("reloads once automatically and offers explicit recovery on repeated crashes", async () => {
    const f = fixture()
    f.recovery.crashed("crashed")
    f.recovery.loaded()
    f.recovery.crashed("oom")
    f.recovery.crashed("crashed")
    expect(f.context.reload).toHaveBeenCalledTimes(1)
    expect(f.context.show).toHaveBeenCalledTimes(1)
    await f.respond(0)
    expect(f.context.reload).toHaveBeenCalledTimes(2)
    f.recovery.loaded()
    f.recovery.crashed("crashed")
    expect(f.context.show).toHaveBeenCalledTimes(2)
    expect(f.context.reload).toHaveBeenCalledTimes(2)
  })

  it("ignores subframes, navigation aborts, clean exits and shutdown", () => {
    const f = fixture()
    f.recovery.failed(-105, false)
    f.recovery.failed(-3, true)
    f.recovery.crashed("clean-exit")
    f.unavailable()
    f.recovery.failed(-2, true)
    f.recovery.crashed("crashed")
    expect(f.context.show).not.toHaveBeenCalled()
    expect(f.context.reload).not.toHaveBeenCalled()
  })

  it("coalesces event and rejected load promise without retry loops", async () => {
    const f = fixture()
    f.recovery.failed(-105, true)
    f.recovery.failed(-2, true)
    expect(f.context.show).toHaveBeenCalledTimes(1)
    await f.respond(3)
    f.recovery.failed(-2, true)
    expect(f.context.show).toHaveBeenCalledTimes(1)
    expect(f.context.reload).not.toHaveBeenCalled()
    f.recovery.loading()
    f.recovery.failed(-2, true)
    expect(f.context.show).toHaveBeenCalledTimes(2)
  })

  it.each(["loaded", "loading", "shutdown"] as const)(
    "ignores stale prompt responses after %s",
    async (state) => {
      const f = fixture()
      f.recovery.failed(-2, true)
      if (state === "shutdown") f.unavailable()
      else f.recovery[state]()
      await f.respond(1)
      expect(f.context.restart).not.toHaveBeenCalled()
    }
  )

  it.each([1, 2])("performs the explicit recovery choice %s", async (choice) => {
    const f = fixture()
    f.recovery.failed(-2, true)
    await f.respond(choice)
    expect(choice === 1 ? f.context.restart : f.context.quit).toHaveBeenCalledOnce()
    expect(f.context.reload).not.toHaveBeenCalled()
  })

  it("offers the newer load failure after ignoring a superseded prompt", async () => {
    const f = fixture()
    f.recovery.failed(-2, true)
    f.recovery.loading()
    f.recovery.failed(-105, true)
    await f.respond(1)
    expect(f.context.restart).not.toHaveBeenCalled()
    expect(f.context.show).toHaveBeenCalledTimes(2)
  })

  it("reports a failed automatic reload and offers native recovery", () => {
    const f = fixture()
    f.context.reload.mockImplementationOnce(() => {
      throw new Error("load failed")
    })
    f.recovery.crashed("crashed")
    expect(f.context.reportError).toHaveBeenCalledOnce()
    expect(f.context.show).toHaveBeenCalledOnce()
  })

  it("reports a failed native dialog without an unhandled rejection", async () => {
    const f = fixture()
    f.context.show.mockRejectedValueOnce(new Error("dialog failed"))
    f.recovery.failed(-2, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.context.reportError).toHaveBeenCalledOnce()
  })
})

describe("startup failure recovery", () => {
  it.each([0, 1])("offers restart or exit after partial startup: %s", async (choice) => {
    const f = fixture()
    const pending = showStartupFailure(f.context)
    expect(f.context.show).toHaveBeenCalledOnce()
    await f.respond(choice)
    await pending
    expect(choice === 0 ? f.context.restart : f.context.quit).toHaveBeenCalledOnce()
  })

  it("does not restart if shutdown begins while the prompt is open", async () => {
    const f = fixture()
    const pending = showStartupFailure(f.context)
    f.unavailable()
    await f.respond(0)
    await pending
    expect(f.context.restart).not.toHaveBeenCalled()
  })

  it("exits after reporting a native dialog failure", async () => {
    const f = fixture()
    f.context.show.mockRejectedValueOnce(new Error("dialog failed"))
    await showStartupFailure(f.context)
    expect(f.context.reportError).toHaveBeenCalledOnce()
    expect(f.context.quit).toHaveBeenCalledOnce()
  })
})

describe("application page loading", () => {
  it("ignores the rejected promise of a superseded navigation", async () => {
    let rejectOld!: (error: Error) => void
    const first = new Promise<void>((_resolve, reject) => (rejectOld = reject))
    const load = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(undefined)
    const failed = vi.fn()
    const reload = createWindowPageLoader(load, failed)
    reload()
    reload()
    await Promise.resolve()
    rejectOld(new Error("old document failed"))
    await Promise.resolve()
    expect(failed).not.toHaveBeenCalled()
  })

  it("reports both synchronous and asynchronous current load failures", async () => {
    const error = new Error("load failed")
    const load = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockRejectedValueOnce(error)
    const failed = vi.fn()
    const reload = createWindowPageLoader(load, failed)
    reload()
    reload()
    await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenLastCalledWith(error)
  })
})

describe("renderer crashes during an actual native close choice", () => {
  it.each(
    ["crash", "load", "mixed", "load-first"].flatMap((kind) =>
      [0, 1, 2].map((response) => ({ kind, response }))
    )
  )(
    "preserves choice $response during $kind and coalesces repeated failures",
    async ({ kind, response }) => {
      const native = createNativeClosePrompt()
      let resolveClose!: (value: { response: number }) => void
      let quitting = false,
        visible = true
      const quit = vi.fn(() => {
        quitting = true
      })
      const minimize = vi.fn(() => {
        visible = false
      })
      const closeContext = {
        isAvailable: () => !quitting,
        hasActiveRuns: () => false,
        hasTray: () => true,
        show: vi.fn(
          () =>
            new Promise<{ response: number }>((resolve) => {
              resolveClose = resolve
            })
        ),
        quit,
        minimize
      }
      // The native fallback is already open: the renderer prompt flag is false.
      const close = native.request(closeContext)
      const reload = vi.fn(() => native.cancel()) // actual did-start-loading behavior
      const show = vi.fn(async () => ({ response: 3 }))
      const recovery = createWindowFailureRecovery({
        isAvailable: () => !quitting,
        pendingClose: () => native.pending,
        canRecoverAfterClose: () => visible,
        reload,
        show,
        quit,
        restart: vi.fn(),
        reportError: vi.fn()
      })
      if (kind === "load-first") recovery.failed(-105, true)
      if (kind !== "load") {
        recovery.crashed("crashed")
        recovery.crashed("oom")
        recovery.crashed("crashed")
      }
      if (kind !== "crash") {
        recovery.failed(-105, true)
        recovery.failed(-2, true)
      }
      expect(reload).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      expect(native.request(closeContext)).toBe(close)
      resolveClose({ response })
      await close
      await Promise.resolve()
      expect(quit).toHaveBeenCalledTimes(response === 1 ? 1 : 0)
      expect(minimize).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
      expect(reload).toHaveBeenCalledTimes(response === 0 && kind === "crash" ? 1 : 0)
      expect(show).toHaveBeenCalledTimes(response === 0 && kind !== "crash" ? 1 : 0)
      expect(closeContext.show).toHaveBeenCalledTimes(1)
      if (response === 2) {
        visible = true
        recovery.shown()
        recovery.shown()
        expect(reload).toHaveBeenCalledTimes(kind === "crash" ? 1 : 0)
        expect(show).toHaveBeenCalledTimes(kind === "crash" ? 0 : 1)
        await Promise.resolve()
        recovery.shown()
        expect(reload).toHaveBeenCalledTimes(kind === "crash" ? 1 : 0)
        expect(show).toHaveBeenCalledTimes(kind === "crash" ? 0 : 1)
      } else if (response === 1) {
        recovery.shown()
        expect(reload).not.toHaveBeenCalled()
        expect(show).not.toHaveBeenCalled()
      }
    }
  )

  it.each(["loading", "loaded"] as const)(
    "discards deferred failures after %s while the native close choice is pending",
    async (state) => {
      const native = createNativeClosePrompt()
      let resolveClose!: (value: { response: number }) => void
      const close = native.request({
        isAvailable: () => true,
        hasActiveRuns: () => false,
        hasTray: () => true,
        show: () =>
          new Promise((resolve) => {
            resolveClose = resolve
          }),
        quit: vi.fn(),
        minimize: vi.fn()
      })
      const reload = vi.fn(() => native.cancel()),
        show = vi.fn(async () => ({ response: 0 }))
      const recovery = createWindowFailureRecovery({
        isAvailable: () => true,
        pendingClose: () => native.pending,
        canRecoverAfterClose: () => true,
        reload,
        show,
        quit: vi.fn(),
        restart: vi.fn(),
        reportError: vi.fn()
      })
      recovery.crashed("crashed")
      recovery.failed(-105, true)
      recovery[state]()
      resolveClose({ response: 0 })
      await close
      await Promise.resolve()
      recovery.shown()
      expect(show).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
    }
  )
})

describe("background window failure lifecycle", () => {
  it("keeps repeated hidden faults quiet and shows one recovery on explicit restore", async () => {
    const f = fixture()
    f.recovery.hidden()
    f.recovery.crashed("crashed")
    f.recovery.failed(-105, true)
    f.recovery.crashed("oom")
    expect(f.context.reload).not.toHaveBeenCalled()
    expect(f.context.show).not.toHaveBeenCalled()
    f.recovery.shown()
    f.recovery.shown()
    expect(f.context.reload).not.toHaveBeenCalled()
    expect(f.context.show).toHaveBeenCalledTimes(1)
    await f.respond(3)
    f.recovery.shown()
    expect(f.context.show).toHaveBeenCalledTimes(1)
    f.recovery.hidden()
    f.recovery.loading()
    f.recovery.failed(-2, true)
    expect(f.context.show).toHaveBeenCalledTimes(1)
    f.recovery.shown()
    expect(f.context.show).toHaveBeenCalledTimes(2)
  })

  it.each(["loading", "loaded"] as const)(
    "does not revive an old hidden fault after %s",
    (state) => {
      const f = fixture()
      f.recovery.hidden()
      f.recovery.failed(-105, true)
      f.recovery.crashed("crashed")
      f.recovery[state]()
      f.recovery.shown()
      f.recovery.shown()
      expect(f.context.show).not.toHaveBeenCalled()
      expect(f.context.reload).not.toHaveBeenCalled()
    }
  )

  it("does not reload under an existing recovery dialog when more crashes arrive", async () => {
    const f = fixture()
    f.recovery.failed(-105, true)
    f.recovery.crashed("crashed")
    f.recovery.crashed("oom")
    expect(f.context.reload).not.toHaveBeenCalled()
    expect(f.context.show).toHaveBeenCalledTimes(1)
    await f.respond(3)
    f.recovery.shown()
    expect(f.context.reload).not.toHaveBeenCalled()
    expect(f.context.show).toHaveBeenCalledTimes(1)
  })
})

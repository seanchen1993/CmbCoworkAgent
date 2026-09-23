import { beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ enabled: true, run: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ isEnabled: () => state.enabled })
}))
vi.mock("./runner", () => ({ runHooks: state.run }))
import { observeStopFailure } from "./stop-failure-observer"

beforeEach(() => {
  state.enabled = true
  state.run.mockReset()
})
const context = {
  workspacePath: "/workspace",
  sessionId: "thread",
  stopFailureError: "invalid_request"
}

it("keeps enabled failure observation inside the original run lifetime", async () => {
  let finish!: () => void
  state.run.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  let settled = false
  const observed = observeStopFailure([], context).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  await observed
  expect(settled).toBe(true)
  expect(state.run).toHaveBeenCalledTimes(1)
  expect(state.run).toHaveBeenCalledWith([], "StopFailure", context, undefined)
})

it("preserves legacy fire-and-forget timing when Mods are off", async () => {
  state.enabled = false
  let finish!: () => void
  state.run.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  await observeStopFailure([], context)
  expect(state.run).toHaveBeenCalledTimes(1)
  finish()
})

it("observation failures cannot replace the original model failure or restart a turn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    for (const enabled of [true, false]) {
      state.enabled = enabled
      state.run.mockRejectedValue(new DOMException("cancelled", "AbortError"))
      await expect(observeStopFailure([], context)).resolves.toBeUndefined()
    }
    expect(state.run).toHaveBeenCalledTimes(2)
  } finally {
    warn.mockRestore()
  }
})

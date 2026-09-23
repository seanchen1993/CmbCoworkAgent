import { expect, it, vi } from "vitest"
import { createInstructionsLoadedMiddleware } from "./mods-instructions-loaded"

function fixture() {
  const controller = new AbortController()
  const notify = vi.fn(async () => {})
  const assertLive = vi.fn()
  const failed = vi.fn()
  let enabled = true
  const middleware = createInstructionsLoadedMiddleware({
    sources: [{ file_path: "/project/AGENTS.md", memory_type: "Project" }],
    signal: controller.signal,
    enabled: () => enabled,
    assertLive,
    notify,
    failed
  })
  const before = middleware.beforeModel as unknown as (
    state: unknown,
    runtime: { signal: AbortSignal }
  ) => Promise<unknown>
  return {
    controller,
    notify,
    failed,
    assertLive,
    run: () => before({ messages: [] }, { signal: controller.signal }),
    off: () => {
      enabled = false
    }
  }
}

it("notifies each real loaded source once without gating a model and retains session-start provenance", async () => {
  const f = fixture()
  await f.run()
  await f.run()
  expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.notify).toHaveBeenCalledWith(
    { file_path: "/project/AGENTS.md", memory_type: "Project", load_reason: "session_start" },
    expect.any(AbortSignal)
  )
})

it("off adds no instruction check or authority work", async () => {
  const f = fixture()
  f.off()
  await f.run()
  expect(f.notify).not.toHaveBeenCalled()
  expect(f.assertLive).not.toHaveBeenCalled()
})

it("never delays the model for a pending observational hook", async () => {
  const f = fixture()
  let release!: () => void
  f.notify.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  let returned = false
  const pending = Promise.resolve(f.run()).then(() => {
    returned = true
  })
  await Promise.resolve()
  await Promise.resolve()
  const observed = returned
  release()
  await pending
  expect(observed).toBe(true)
})
it("reports an observer failure without blocking or replaying the model", async () => {
  const f = fixture()
  f.notify.mockRejectedValue(Error("observer failed"))
  await f.run()
  await vi.waitFor(() => expect(f.failed).toHaveBeenCalledTimes(1))
  await f.run()
  expect(f.notify).toHaveBeenCalledTimes(1)
})

it("cancels the observation when the original model fails", async () => {
  let active: AbortSignal | undefined
  const middleware = createInstructionsLoadedMiddleware({
    sources: [{ file_path: "/project/AGENTS.md", memory_type: "Project" }],
    enabled: () => true,
    assertLive: () => {},
    failed: () => {},
    notify: async (_source, signal) => {
      void _source
      active = signal
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
    }
  })
  const before = middleware.beforeModel as unknown as (state: unknown, runtime: unknown) => unknown
  before({}, {})
  const wrap = middleware.wrapModelCall as unknown as (
    request: unknown,
    handler: () => Promise<never>
  ) => Promise<unknown>
  expect(active?.aborted).toBe(false)
  await expect(
    wrap({}, async () => {
      throw Error("original provider error")
    })
  ).rejects.toThrow("original provider error")
  expect(active?.aborted).toBe(true)
})

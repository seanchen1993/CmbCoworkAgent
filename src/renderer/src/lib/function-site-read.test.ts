import { expect, it, vi } from "vitest"
import { readFunctionSite, renderFunctionSite } from "./function-site-read"
import { createFunctionSiteQueue } from "./function-site-queue"
import type { FunctionSiteReadOutcome } from "../../../shared/mods/v2/sites"

const request = {
  threadId: "A",
  component: "AssistantMessage" as const,
  props: { text: "protected", isFirstOfReply: true }
}
const inactive: FunctionSiteReadOutcome = { state: "inactive", reason: "mods-disabled" }

it("cancels one read by data ID but waits for the actual invoke to complete", async () => {
  const gate = Promise.withResolvers<FunctionSiteReadOutcome>(),
    controller = new AbortController()
  const api = {
    nextSiteReadId: () => "read-1",
    cancelSiteRead: vi.fn(async () => undefined),
    siteRead: vi.fn(() => gate.promise),
    siteRender: vi.fn(async () => null)
  }
  let settled = false
  const pending = readFunctionSite(api, request, controller.signal).finally(() => {
    settled = true
  })
  controller.abort()
  await Promise.resolve()
  expect(api.cancelSiteRead).toHaveBeenCalledExactlyOnceWith("read-1")
  expect(settled).toBe(false)
  expect(api.siteRead).toHaveBeenCalledWith(
    "A",
    "AssistantMessage",
    request.props,
    undefined,
    undefined,
    undefined,
    undefined,
    "read-1"
  )
  gate.resolve(inactive)
  expect(await pending).toEqual(inactive)
})

it("does not create an invoke for an already-cancelled virtual row", () => {
  const controller = new AbortController()
  controller.abort(Error("old row"))
  const api = { nextSiteReadId: vi.fn(() => "id"), siteRead: vi.fn(), siteRender: vi.fn() }
  expect(() => readFunctionSite(api, request, controller.signal)).toThrow("old row")
  expect(api.nextSiteReadId).not.toHaveBeenCalled()
  expect(api.siteRead).not.toHaveBeenCalled()
})

it.each([undefined, true])(
  "preserves the exact legacy API arity with ownerRequired=%s",
  async (ownerRequired) => {
    const api = {
      siteRead: vi.fn(async () => inactive),
      siteRender: vi.fn(async () => null)
    }
    await readFunctionSite(api, { ...request, ownerRequired }, new AbortController().signal)
    expect(api.siteRead).toHaveBeenCalledExactlyOnceWith(
      "A",
      "AssistantMessage",
      request.props,
      undefined,
      undefined,
      undefined,
      ownerRequired
    )
    await renderFunctionSite(
      api,
      { threadId: "A", owner: "owner", props: request.props },
      new AbortController().signal
    )
    expect(api.siteRender).toHaveBeenCalledExactlyOnceWith("A", "owner", request.props)
  }
)

it("keeps a legacy peer's physical read pending after abort without inventing a cancellation ID", async () => {
  const gate = Promise.withResolvers<FunctionSiteReadOutcome>(),
    controller = new AbortController()
  const api = {
    siteRead: vi.fn(() => gate.promise),
    siteRender: vi.fn(async () => null),
    cancelSiteRead: vi.fn(async () => undefined)
  }
  let settled = false
  const pending = readFunctionSite(api, request, controller.signal).finally(() => {
    settled = true
  })
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(api.siteRead.mock.calls[0]).toHaveLength(7)
  expect(api.cancelSiteRead).not.toHaveBeenCalled()
  gate.resolve(inactive)
  expect(await pending).toEqual(inactive)
})

it("removes cancellation after a completed render and preserves legacy peer completion", async () => {
  const controller = new AbortController()
  const api = {
    nextSiteReadId: () => "render-1",
    cancelSiteRead: vi.fn(async () => undefined),
    siteRead: vi.fn(async () => inactive),
    siteRender: vi.fn(async () => null)
  }
  expect(
    await renderFunctionSite(
      api,
      { threadId: "A", owner: "owner", props: request.props },
      controller.signal
    )
  ).toBeNull()
  controller.abort()
  expect(api.cancelSiteRead).not.toHaveBeenCalled()
  expect(api.siteRender).toHaveBeenCalledWith("A", "owner", request.props, "render-1")
  expect(
    await readFunctionSite(
      { siteRead: api.siteRead, siteRender: api.siteRender },
      request,
      new AbortController().signal
    )
  ).toEqual(inactive)
})

it("admits rapid A-B-C-A switches after cooperative old physical reads actually end", async () => {
  const queue = createFunctionSiteQueue()
  const reads = new Map<string, () => void>()
  let sequence = 0,
    physical = 0,
    peak = 0
  const api = {
    nextSiteReadId: () => String(++sequence),
    cancelSiteRead: vi.fn(async (readId: string) => {
      reads.get(readId)?.()
    }),
    siteRead: vi.fn(
      async (
        _thread: string,
        _component: unknown,
        _props: unknown,
        _presentation?: string,
        _message?: string,
        _question?: string,
        _owner?: boolean,
        readId?: string
      ) => {
        peak = Math.max(peak, ++physical)
        try {
          await new Promise<void>((resolve) => reads.set(readId!, resolve))
          return inactive
        } finally {
          physical--
          reads.delete(readId!)
        }
      }
    ),
    siteRender: vi.fn(async () => null)
  }
  const all: Promise<unknown>[] = []
  let previous: AbortController | undefined
  for (const threadId of ["A", "B", "C", "A"]) {
    previous?.abort()
    await new Promise((resolve) => setImmediate(resolve))
    const controller = new AbortController()
    for (let index = 0; index < 4; index++)
      all.push(
        queue.run(
          () => !controller.signal.aborted,
          () => readFunctionSite(api, { ...request, threadId }, controller.signal),
          "visible",
          controller.signal
        )
      )
    expect(physical).toBe(4)
    expect(api.siteRead.mock.calls.slice(-4).every((call) => call[0] === threadId)).toBe(true)
    previous = controller
  }
  previous!.abort()
  await Promise.all(all)
  expect(physical).toBe(0)
  expect(peak).toBe(4)
  expect(api.siteRead).toHaveBeenCalledTimes(16)
})

it("does not admit unlimited calls if a peer ignores the cancellation request", async () => {
  const queue = createFunctionSiteQueue(),
    gate = Promise.withResolvers<FunctionSiteReadOutcome>()
  const controller = new AbortController()
  const api = {
    nextSiteReadId: () => "ignored",
    cancelSiteRead: vi.fn(async () => undefined),
    siteRead: vi.fn(() => gate.promise),
    siteRender: vi.fn(async () => null)
  }
  const active = Array.from({ length: 4 }, () =>
    queue.run(
      () => true,
      () => readFunctionSite(api, request, controller.signal)
    )
  )
  controller.abort()
  const next = vi.fn(async () => inactive)
  const queued = queue.run(() => true, next)
  await Promise.resolve()
  expect(next).not.toHaveBeenCalled()
  expect(api.siteRead).toHaveBeenCalledTimes(4)
  gate.resolve(inactive)
  await Promise.all([...active, queued])
  expect(next).toHaveBeenCalledOnce()
})

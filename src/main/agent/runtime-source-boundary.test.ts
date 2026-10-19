import { expect, it, vi } from "vitest"
vi.mock("langchain", () => ({ createMiddleware: (value: unknown) => value }))
import { bindRuntimeSourceProfile, createRuntimeSourceBoundary } from "./runtime-source-boundary"

it("fences models and each actual tool call without running tools from a changed source", async () => {
  let changed = false
  const content = vi.fn(() => {
    if (changed) throw Error("SOURCE_CHANGED")
  })
  const identity = vi.fn()
  const middleware = createRuntimeSourceBoundary(content, identity) as unknown as {
    beforeModel(): void
    afterModel(): void
    wrapToolCall(request: object, handler: (request: object) => Promise<object>): Promise<object>
  }
  middleware.beforeModel()
  middleware.afterModel()
  expect(content).toHaveBeenCalledTimes(2)
  expect(identity).toHaveBeenCalledTimes(2)
  const request = {}
  const handler = vi.fn(async (input) => input)
  expect(await middleware.wrapToolCall(request, handler)).toBe(request)
  expect(content).toHaveBeenCalledTimes(4)
  changed = true
  await expect(middleware.wrapToolCall(request, handler)).rejects.toThrow("SOURCE_CHANGED")
  expect(handler).toHaveBeenCalledTimes(1)
  changed = false
  await expect(
    middleware.wrapToolCall(request, async () => {
      changed = true
      return {}
    })
  ).rejects.toThrow("SOURCE_CHANGED")
})

it("preserves profile identity checks for restricted runtimes and also fences their source", () => {
  const profile = { binding: { id: "child" }, assertCurrent: vi.fn() }
  expect(bindRuntimeSourceProfile(profile, undefined)).toBe(profile)
  const source = vi.fn()
  const fixed = bindRuntimeSourceProfile(profile, source)
  expect(fixed.binding).toBe(profile.binding)
  fixed.assertCurrent()
  expect(source).toHaveBeenCalledOnce()
  expect(profile.assertCurrent).toHaveBeenCalledOnce()
  source.mockImplementation(() => {
    throw Error("SOURCE_CHANGED")
  })
  expect(() => fixed.assertCurrent()).toThrow("SOURCE_CHANGED")
  expect(profile.assertCurrent).toHaveBeenCalledOnce()
})

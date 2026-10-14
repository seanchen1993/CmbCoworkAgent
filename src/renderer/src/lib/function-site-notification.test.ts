import { afterEach, expect, it, vi } from "vitest"
const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }))
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T>(value: T) => [value, vi.fn()],
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect)
  }
}))
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionSite } from "../components/chat/FunctionSite"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ModsChatScope } from "./mods-chat-scope"
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  hooks.effects.length = 0
  vi.unstubAllGlobals()
})
it("the production site subscription ignores Client frames but retains legacy invalidation and configuration reset", async () => {
  let notify!: (event: { threadId: string; scope?: string }) => void
  let reset!: () => void
  const stop = vi.fn()
  const mods = {
    siteMountOutcome: vi.fn(async () => ({ state: "mounted", owner: "owner" })),
    siteRender: vi.fn(async () => ({
      key: "engine:owner",
      id: "owner",
      plugin: "engine",
      generation: "drawing",
      title: "CommandOutput",
      rows: 12,
      closeOnEscape: false,
      tree: { type: "engine", ref: 0 },
      nativeContent: {
        component: "CommandOutput",
        entries: [{
          ref: 0,
          props: { command: "run", args: "***", text: "host result", isErrored: false }
        }],
        nativeUnchanged: true
      }
    })),
    siteUnmount: vi.fn(async () => {}),
    onCardsChanged: (callback: typeof notify) => {
      notify = callback
      return stop
    },
    onConfigurationChanged: (callback: () => void) => {
      reset = callback
      return stop
    }
  }
  vi.stubGlobal("window", Object.assign(new EventTarget(), { api: { mods } }))
  renderToStaticMarkup(
    createElement(
      ModsChatScope.Provider,
      { value: { threadId: "thread", enabled: true, ready: true } },
      createElement(FunctionSite, {
        threadId: "thread",
        component: "CommandOutput",
        facts: { command: "run", args: "***", text: "host result", isErrored: false }
      })
    )
  )
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  // Let both initial mount/props effects settle before measuring update queries.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const initial = mods.siteRender.mock.calls.length
  expect(initial).toBeGreaterThan(0)
  for (let i = 0; i < 20; i++) notify({ threadId: "thread", scope: "panes" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mods.siteRender).toHaveBeenCalledTimes(initial)
  notify({ threadId: "thread", scope: "records" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mods.siteRender).toHaveBeenCalledTimes(initial)
  notify({ threadId: "other" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mods.siteRender).toHaveBeenCalledTimes(initial)
  notify({ threadId: "thread", scope: "site:other-owner" })
  notify({ threadId: "thread", scope: "site-invalidated:other-owner" })
  notify({ threadId: "thread", scope: "site-redraw:other-owner" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mods.siteRender).toHaveBeenCalledTimes(initial)
  notify({ threadId: "thread", scope: "site:owner" })
  await expect.poll(() => mods.siteRender.mock.calls.length).toBe(initial + 1)
  notify({ threadId: "thread" })
  await expect.poll(() => mods.siteRender.mock.calls.length).toBe(initial + 2)
  notify({ threadId: "thread", scope: "future-scope" })
  await expect.poll(() => mods.siteRender.mock.calls.length).toBe(initial + 3)
  const mounted = mods.siteMountOutcome.mock.calls.length
  reset()
  await expect.poll(() => mods.siteMountOutcome.mock.calls.length).toBe(mounted + 1)
  expect(mods.siteUnmount).toHaveBeenCalledWith("thread", "owner")
})

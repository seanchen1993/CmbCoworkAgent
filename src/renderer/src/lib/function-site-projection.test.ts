import { afterEach, expect, it, vi } from "vitest"
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  updates: [] as unknown[]
}))
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(value: T) => [value, (next: unknown) => hooks.updates.push(next)],
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect)
}))
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { FunctionSite } from "../components/chat/FunctionSite"
import { ModsChatScope } from "./mods-chat-scope"
import {
  FunctionSitePresentationCache,
  functionSitePresentationKey
} from "./function-site-presentation"
import type { FunctionDisplaySnapshot } from "../../../shared/mods/v2/display-snapshot"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

const cleanups: Array<() => void> = []
const projection = (): FunctionDisplaySnapshot => ({
  scopeId: "host-scope",
  key: "message",
  version: "protected-v1",
  expiresAt: Date.now() + 120000,
  data: {
    component: "AssistantMessage",
    tree: { type: "engine", ref: 0 },
    nativeContent: {
      component: "AssistantMessage",
      entries: [{ ref: 0, props: { text: "protected", isFirstOfReply: true } }]
    }
  }
})
const pane = (): FunctionPaneSnapshot => ({
  key: "engine:owner",
  id: "owner",
  plugin: "mod",
  generation: "real-drawing",
  title: "message",
  rows: 8,
  closeOnEscape: false,
  nativeContent: projection().data.nativeContent,
  tree: { type: "Text", props: {}, children: ["protected"] }
})
function mount(
  siteRead: (...args: unknown[]) => Promise<unknown>,
  options: {
    cache?: FunctionSitePresentationCache
    rows?: string[]
    cacheFirst?: boolean
  } = {}
) {
  type Event = { threadId: string; scope?: string }
  const notifications = new Set<(event: Event) => void>()
  const mods = {
    siteRead: vi.fn(siteRead),
    siteMountOutcome: vi.fn(),
    siteRender: vi.fn(async () => pane()),
    siteUnmount: vi.fn(async () => {}),
    onCardsChanged: (callback: (event: Event) => void) => {
      notifications.add(callback)
      return () => {
        notifications.delete(callback)
      }
    },
    onConfigurationChanged: () => () => {}
  }
  vi.stubGlobal("window", Object.assign(new EventTarget(), { api: { mods }, innerWidth: 800 }))
  renderToStaticMarkup(
    createElement(
      ModsChatScope.Provider,
      {
        value: { threadId: "thread", enabled: true, ready: true, presentationCache: options.cache }
      },
      ...(options.rows ?? ["row"]).map((row) =>
        createElement(FunctionSite, {
          key: row,
          threadId: "thread",
          component: "AssistantMessage",
          presentationId: row,
          facts: { text: "input", isFirstOfReply: true }
        })
      )
    )
  )
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  return {
    mods,
    notify: (scope: string) => {
      const invalidate = () => {
        if (scope.startsWith("site-projection:"))
          options.cache?.invalidateProjection(scope.slice("site-projection:".length))
      }
      if (options.cacheFirst !== false) invalidate()
      for (const notify of notifications) notify({ threadId: "thread", scope })
      if (options.cacheFirst === false) invalidate()
    }
  }
}
function retire() {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
}
afterEach(() => {
  retire()
  hooks.effects.length = 0
  hooks.updates.length = 0
  vi.unstubAllGlobals()
})

it("reads protected passive data without creating or rendering a drawing owner", async () => {
  const f = mount(async () => ({ state: "projected", snapshot: projection() }))
  await expect
    .poll(() =>
      hooks.updates.some(
        (value) =>
          (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.scopeId === "host-scope"
      )
    )
    .toBe(true)
  expect(f.mods.siteRead).toHaveBeenCalledWith(
    "thread",
    "AssistantMessage",
    { text: "input", isFirstOfReply: true },
    "row",
    undefined,
    undefined,
    undefined
  )
  expect(f.mods.siteMountOutcome).not.toHaveBeenCalled()
  expect(f.mods.siteRender).not.toHaveBeenCalled()
  f.notify("site-presentations:UserMessage")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.mods.siteRead).toHaveBeenCalledTimes(1)
  f.notify("site-presentations:AssistantMessage")
  await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(2)
  retire()
  expect(f.mods.siteUnmount).not.toHaveBeenCalled()
})

it("adopts a real mounted snapshot once and keeps its owner-specific redraw lifecycle", async () => {
  const f = mount(async () => ({ state: "mounted", owner: "real-owner", snapshot: pane() }))
  await expect
    .poll(() =>
      hooks.updates.some((value) => (value as { owner?: string })?.owner === "real-owner")
    )
    .toBe(true)
  expect(f.mods.siteRender).not.toHaveBeenCalled()
  expect(f.mods.siteMountOutcome).not.toHaveBeenCalled()
  f.notify("site:real-owner")
  await expect.poll(() => f.mods.siteRender.mock.calls.length).toBe(1)
  expect(f.mods.siteRender).toHaveBeenCalledWith("thread", "real-owner", {
    text: "input",
    isFirstOfReply: true
  })
  retire()
  expect(f.mods.siteUnmount).toHaveBeenCalledWith("thread", "real-owner")
})

it.each(["projected", "mounted"])(
  "retires a late %s result after the row unmounts",
  async (state) => {
    let complete!: (value: unknown) => void
    const f = mount(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(1)
    retire()
    hooks.updates.length = 0
    complete(
      state === "projected"
        ? { state, snapshot: projection() }
        : { state, owner: "late-owner", snapshot: pane() }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      hooks.updates.some((value) => Boolean((value as { snapshot?: unknown })?.snapshot))
    ).toBe(false)
    expect(f.mods.siteRender).not.toHaveBeenCalled()
    if (state === "mounted") expect(f.mods.siteUnmount).toHaveBeenCalledWith("thread", "late-owner")
    else expect(f.mods.siteUnmount).not.toHaveBeenCalled()
  }
)

it("rejects active IPC data instead of fabricating an interaction generation", async () => {
  const unsafe = projection()
  unsafe.data.tree = {
    type: "Button",
    props: { key: "execute", label: "execute" },
    press: { plugin: "x", handle: 1 }
  }
  const f = mount(async () => ({ state: "projected", snapshot: unsafe }))
  await expect.poll(() => hooks.updates.includes("MODS_DISPLAY_DATA_ACTIVE")).toBe(true)
  expect(hooks.updates.some((value) => Boolean((value as { snapshot?: unknown })?.snapshot))).toBe(
    false
  )
  expect(f.mods.siteRender).not.toHaveBeenCalled()
  expect(f.mods.siteUnmount).not.toHaveBeenCalled()
})

it.each([true, false])(
  "re-reads only the exact projected row regardless of scope event ordering (%s)",
  async (cacheFirst) => {
    const cache = new FunctionSitePresentationCache(() => true)
    const f = mount(
      async (_thread, _component, _facts, row) => ({
        state: "projected",
        snapshot: { ...projection(), key: String(row) }
      }),
      { cache, rows: ["first", "second"], cacheFirst }
    )
    await expect
      .poll(
        () =>
          hooks.updates.filter(
            (value) =>
              (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.scopeId === "host-scope"
          ).length
      )
      .toBe(2)
    f.notify("site-projection:first")
    await expect
      .poll(() => f.mods.siteRead.mock.calls.filter((call) => call[3] === "first").length)
      .toBe(2)
    expect(f.mods.siteRead.mock.calls.filter((call) => call[3] === "second")).toHaveLength(1)
    f.notify("site-projection:unrelated")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.mods.siteRead).toHaveBeenCalledTimes(3)
    expect(f.mods.siteMountOutcome).not.toHaveBeenCalled()
    expect(f.mods.siteRender).not.toHaveBeenCalled()
  }
)

it("does not publish a first-read response invalidated before its host key is known", async () => {
  const cache = new FunctionSitePresentationCache(() => true)
  let finish!: (value: unknown) => void
  let reads = 0
  const f = mount(
    async () =>
      ++reads === 1
        ? new Promise((resolve) => {
            finish = resolve
          })
        : { state: "projected", snapshot: { ...projection(), version: "fresh" } },
    { cache }
  )
  await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(1)
  f.notify("site-projection:message")
  finish({ state: "projected", snapshot: { ...projection(), version: "stale" } })
  await expect
    .poll(() =>
      hooks.updates.some(
        (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.version === "fresh"
      )
    )
    .toBe(true)
  expect(f.mods.siteRead).toHaveBeenCalledTimes(2)
  expect(f.mods.siteRead.mock.calls[1][6]).toBe(true)
  expect(
    hooks.updates.some(
      (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.version === "stale"
    )
  ).toBe(false)
})

it("preserves an unrelated first read through a different row's invalidation", async () => {
  const cache = new FunctionSitePresentationCache(() => true)
  let finish!: (value: unknown) => void
  const f = mount(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    { cache }
  )
  await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(1)
  f.notify("site-projection:other")
  finish({ state: "projected", snapshot: projection() })
  await expect
    .poll(() =>
      hooks.updates.some(
        (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.key === "message"
      )
    )
    .toBe(true)
  expect(f.mods.siteRead).toHaveBeenCalledTimes(1)
})

it.each([true, false])(
  "recognizes cached host keys even when the scope provider removes the entry first (%s)",
  async (cacheFirst) => {
    const cache = new FunctionSitePresentationCache(() => true)
    const key = functionSitePresentationKey(
      "thread",
      "AssistantMessage",
      "row",
      JSON.stringify({ text: "input", isFirstOfReply: true }),
      800
    )!
    cache.saveData(key, projection().data, 200, cache.capture("AssistantMessage"), 800, "message")
    let finish!: (value: unknown) => void
    let reads = 0
    const f = mount(
      async () =>
        ++reads === 1
          ? new Promise((resolve) => {
              finish = resolve
            })
          : { state: "projected", snapshot: { ...projection(), version: "fresh" } },
      { cache, cacheFirst }
    )
    await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(1)
    f.notify("site-projection:message")
    expect(cache.read(key)).toBeNull()
    finish({ state: "projected", snapshot: { ...projection(), version: "stale" } })
    await expect.poll(() => f.mods.siteRead.mock.calls.length).toBe(2)
    expect(
      hooks.updates.some(
        (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.version === "stale"
      )
    ).toBe(false)
  }
)

it("does not retire a published row when unrelated-key pending history reaches its bound", async () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const f = mount(async () => ({ state: "projected", snapshot: projection() }), { cache })
  await expect
    .poll(() =>
      hooks.updates.some(
        (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.key === "message"
      )
    )
    .toBe(true)
  const frame = hooks.updates.find(
    (value) => (value as { snapshot?: FunctionDisplaySnapshot })?.snapshot?.key === "message"
  ) as {
    ticket: { current(): boolean }
    presentationCurrent(): boolean
  }
  for (let i = 0; i < 128; i++) f.notify("site-projection:other-" + i)
  expect(frame.ticket.current()).toBe(true)
  expect(frame.presentationCurrent()).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.mods.siteRead).toHaveBeenCalledTimes(1)
})

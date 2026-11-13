import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { functionSiteBrowser } from "../../../../tests/support/function-site-real-react-browser"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

const browser = functionSiteBrowser()
beforeAll(() => browser.open())
afterEach(async () => {
  try {
    expect((await browser.snapshot()).errors).toEqual([])
  } finally {
    await browser.closeCase()
  }
})
afterAll(() => browser.close())

it("the production site subscription ignores Client frames but retains legacy invalidation and configuration reset", async () => {
  const pane: FunctionPaneSnapshot = {
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
      entries: [
        {
          ref: 0,
          props: {
            command: "run",
            args: "***",
            text: "host result",
            isErrored: false
          }
        }
      ],
      nativeUnchanged: true
    }
  }
  await browser.mount({
    legacyMount: true,
    component: "CommandOutput",
    pane,
    facts: { command: "run", args: "***", text: "host result", isErrored: false }
  })
  // Real layout is 640px wide and 600px high, matching the original default 80/8 geometry.
  await expect.poll(async () => (await browser.snapshot()).renders.length).toBeGreaterThan(0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const initial = (await browser.snapshot()).renders.length
  expect(initial).toBeGreaterThan(0)
  await browser.notifyMany(Array.from({ length: 20 }, () => "panes"))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await browser.snapshot()).renders).toHaveLength(initial)
  await browser.notifyMany(["placed", "site-presentations:AssistantMessage"])
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await browser.snapshot()).renders).toHaveLength(initial)
  await browser.notify("records")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await browser.snapshot()).renders).toHaveLength(initial)
  await browser.notify(undefined, true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await browser.snapshot()).renders).toHaveLength(initial)
  await browser.notifyMany([
    "site:other-owner",
    "site-invalidated:other-owner",
    "site-redraw:other-owner"
  ])
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await browser.snapshot()).renders).toHaveLength(initial)
  await browser.notify("site:owner")
  await expect.poll(async () => (await browser.snapshot()).renders.length).toBe(initial + 1)
  await browser.notify()
  await expect.poll(async () => (await browser.snapshot()).renders.length).toBe(initial + 2)
  await browser.notify("future-scope")
  await expect.poll(async () => (await browser.snapshot()).renders.length).toBe(initial + 3)
  const mounted = (await browser.snapshot()).mounts.length
  await browser.reset()
  await expect.poll(async () => (await browser.snapshot()).mounts.length).toBe(mounted + 1)
  expect((await browser.snapshot()).unmounts).toContainEqual(["thread", "owner"])
})

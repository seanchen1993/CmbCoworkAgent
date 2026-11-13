import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { functionSiteBrowser } from "../../../../tests/support/function-site-real-react-browser"
import type { FunctionDisplaySnapshot } from "../../../shared/mods/v2/display-snapshot"
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

const projection = (text = "protected", key = "message"): FunctionDisplaySnapshot => ({
  scopeId: "host-scope",
  key,
  version: text === "protected" ? "protected-v1" : text,
  expiresAt: Date.now() + 120000,
  data: {
    component: "AssistantMessage",
    tree: { type: "engine", ref: 0 },
    nativeContent: {
      component: "AssistantMessage",
      entries: [{ ref: 0, props: { text, isFirstOfReply: true } }]
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
const readCount = async (count: number): Promise<void> => {
  await expect.poll(async () => (await browser.snapshot()).reads.length).toBe(count)
}
const projectedText = async (row = "row"): Promise<string[]> =>
  (await browser.snapshot()).rows.find((value) => value.id === row)?.projected ?? []
const protectedBody = async (text = "protected", row = "row"): Promise<void> => {
  await expect.poll(() => projectedText(row)).toEqual([text])
}
const expectNeverCommitted = async (text: string): Promise<void> => {
  const state = await browser.snapshot()
  for (const mutation of state.mutations) {
    for (const value of [...mutation.added, ...mutation.removed, mutation.oldValue, mutation.value])
      expect(value ?? "").not.toContain(text)
  }
}

it("reads protected passive data without creating or rendering a drawing owner", async () => {
  await browser.mount({ pane: pane() })
  await readCount(1)
  await browser.complete(0, { state: "projected", snapshot: projection() })
  await protectedBody()
  const initial = await browser.snapshot()
  expect(initial.reads[0]).toEqual([
    "thread",
    "AssistantMessage",
    { text: "input", isFirstOfReply: true },
    "row",
    undefined,
    undefined,
    undefined
  ])
  expect(initial.mounts).toEqual([])
  expect(initial.renders).toEqual([])
  await browser.notify("site-presentations:UserMessage")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect((await browser.snapshot()).reads).toHaveLength(1)
  await browser.notify("site-presentations:AssistantMessage")
  await readCount(2)
  await browser.retire()
  expect((await browser.snapshot()).unmounts).toEqual([])
})

it("adopts a real mounted snapshot once and keeps its owner-specific redraw lifecycle", async () => {
  await browser.mount({ pane: pane() })
  await readCount(1)
  await browser.complete(0, { state: "mounted", owner: "real-owner", snapshot: pane() })
  await expect.poll(async () => (await browser.snapshot()).rows[0]?.owned.length).toBe(1)
  expect((await browser.snapshot()).mounts).toEqual([])
  expect((await browser.snapshot()).renders).toEqual([])
  await browser.notify("site:real-owner")
  await expect.poll(async () => (await browser.snapshot()).renders.length).toBe(1)
  expect((await browser.snapshot()).renders[0]).toEqual([
    "thread",
    "real-owner",
    { text: "input", isFirstOfReply: true }
  ])
  await browser.retire()
  expect((await browser.snapshot()).unmounts).toEqual([["thread", "real-owner"]])
})

it.each(["projected", "mounted"] as const)(
  "retires a late %s result after the row unmounts",
  async (state) => {
    await browser.mount({ pane: pane() })
    await readCount(1)
    await browser.retire()
    await browser.complete(
      0,
      state === "projected"
        ? { state, snapshot: projection() }
        : { state, owner: "late-owner", snapshot: pane() }
    )
    await expect.poll(async () => (await browser.snapshot()).physicalPending).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await browser.snapshot()).rows).toEqual([])
    expect(await browser.text()).toBe("")
    expect((await browser.snapshot()).renders).toEqual([])
    if (state === "mounted")
      await expect
        .poll(async () => (await browser.snapshot()).unmounts)
        .toEqual([["thread", "late-owner"]])
    else expect((await browser.snapshot()).unmounts).toEqual([])
    await expectNeverCommitted("protected")
  }
)

it("rejects active IPC data instead of fabricating an interaction generation", async () => {
  const unsafe = projection()
  unsafe.data.tree = {
    type: "Button",
    props: { key: "execute", label: "execute" },
    press: { plugin: "x", handle: 1 }
  }
  await browser.mount({ pane: pane() })
  await readCount(1)
  await browser.complete(0, { state: "projected", snapshot: unsafe })
  await expect.poll(() => browser.text()).toContain("MODS_DISPLAY_DATA_ACTIVE")
  expect(await projectedText()).toEqual([])
  expect(await browser.text()).not.toContain("execute")
  expect((await browser.snapshot()).renders).toEqual([])
  expect((await browser.snapshot()).unmounts).toEqual([])
  await expectNeverCommitted("protected")
})

it.each([true, false])(
  "re-reads only the exact projected row regardless of scope event ordering (%s)",
  async (cacheFirst) => {
    await browser.mount({ pane: pane(), cache: true, rows: ["first", "second"], cacheFirst })
    const assigned = new Set<unknown>()
    for (let index = 0; index < 2; index++) {
      await expect.poll(async () => (await browser.snapshot()).reads.length).toBeGreaterThan(index)
      const row = (await browser.snapshot()).reads[index][3]
      expect(["first", "second"]).toContain(row)
      expect(assigned.has(row)).toBe(false)
      assigned.add(row)
      await browser.complete(index, { state: "projected", snapshot: projection("protected", String(row)) })
    }
    await protectedBody("protected", "first")
    await protectedBody("protected", "second")
    const initial = (await browser.snapshot()).reads
    expect(initial).toHaveLength(2)
    expect(initial.filter(call => call[3] === "first")).toHaveLength(1)
    expect(initial.filter(call => call[3] === "second")).toHaveLength(1)
    await browser.notify("site-projection:first")
    await readCount(3)
    const reads = (await browser.snapshot()).reads
    expect(reads.filter((call) => call[3] === "first")).toHaveLength(2)
    expect(reads.filter((call) => call[3] === "second")).toHaveLength(1)
    await browser.notify("site-projection:unrelated")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await browser.snapshot()).reads).toHaveLength(3)
    expect((await browser.snapshot()).mounts).toEqual([])
    expect((await browser.snapshot()).renders).toEqual([])
  }
)

it("does not publish a first-read response invalidated before its host key is known", async () => {
  await browser.mount({ pane: pane(), cache: true })
  await readCount(1)
  await browser.notify("site-projection:message")
  await browser.complete(0, { state: "projected", snapshot: projection("stale") })
  await readCount(2)
  await browser.complete(1, { state: "projected", snapshot: projection("fresh") })
  await protectedBody("fresh")
  expect((await browser.snapshot()).reads[1][6]).toBe(true)
  await expectNeverCommitted("stale")
})

it("preserves an unrelated first read through a different row's invalidation", async () => {
  await browser.mount({ pane: pane(), cache: true })
  await readCount(1)
  await browser.notify("site-projection:other")
  await browser.complete(0, { state: "projected", snapshot: projection() })
  await protectedBody()
  expect((await browser.snapshot()).reads).toHaveLength(1)
})

it.each([true, false])(
  "recognizes cached host keys even when the scope provider removes the entry first (%s)",
  async (cacheFirst) => {
    await browser.mount({ pane: pane(), cache: true, cachedSnapshot: projection(), cacheFirst })
    await readCount(1)
    await browser.notify("site-projection:message")
    expect((await browser.snapshot()).cachedCurrent).toBe(false)
    await browser.complete(0, { state: "projected", snapshot: projection("stale") })
    await readCount(2)
    await browser.complete(1, { state: "projected", snapshot: projection("fresh") })
    await protectedBody("fresh")
    await expectNeverCommitted("stale")
  }
)

it("does not retire a published row when unrelated-key pending history reaches its bound", async () => {
  await browser.mount({ pane: pane(), cache: true })
  await readCount(1)
  await browser.complete(0, { state: "projected", snapshot: projection() })
  await protectedBody()
  expect((await browser.snapshot()).admissionCurrent).toBe(true)
  await browser.notifyMany(
    Array.from({ length: 128 }, (_, index) => "site-projection:other-" + index)
  )
  // A real same-facts commit re-evaluates the actual frame ticket, not merely retained DOM.
  await browser.rerender()
  await protectedBody()
  expect((await browser.snapshot()).admissionCurrent).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect((await browser.snapshot()).reads).toHaveLength(1)
})

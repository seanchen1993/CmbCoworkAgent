import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionNativeDisplayProjection } from "./display-native-projection"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-display-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  let incarnation = "first",
    database: object = {},
    enabled = false,
    protection = true
  let publisher = async (value: ModJson): Promise<ModJson> =>
    JSON.parse(JSON.stringify(value).replaceAll("PRIVATE", "SAFE")) as ModJson
  const publish = vi.fn((_workspace: string, value: ModJson) => publisher(value))
  const capture = () => {
    const token = incarnation,
      db = database
    return {
      database: db,
      workspace: root,
      threadId: "thread",
      incarnation: { token, legacyCreatedAt: 1 },
      assertCurrent: () => {
        if (incarnation !== token || database !== db) throw Error("THREAD_REPLACED")
      }
    }
  }
  const load = vi.fn(async () => {
    throw Error("GUEST_MUST_NOT_START")
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [],
      enabled: () => enabled,
      protects: () => protection,
      captureDisplayScope: capture,
      captureSiteGuard: () => capture().assertCurrent,
      changed: vi.fn(),
      publish
    },
    () => ({ load, stop: () => {} })
  )
  cleanup.push(() => {
    manager.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const read = (text = "PRIVATE") =>
    manager.siteRead(
      root,
      "thread",
      "AssistantMessage",
      { text, isFirstOfReply: true },
      "message:block"
    )
  return {
    root,
    manager,
    read,
    load,
    publish,
    setPublisher(value: typeof publisher) {
      publisher = value
    },
    replaceThread() {
      incarnation = "next"
    },
    replaceDatabase() {
      database = {}
    },
    enable(value: boolean) {
      enabled = value
    },
    protect(value: boolean) {
      protection = value
    }
  }
}

it("publishes protected passive native text with no owner or guest and reuses valid data", async () => {
  const f = fixture()
  const first = await f.read()
  expect(first.state).toBe("projected")
  if (first.state !== "projected") throw Error("NO_PROJECTION")
  expect(JSON.stringify(first)).toContain("SAFE")
  expect(JSON.stringify(first)).not.toContain("PRIVATE")
  expect(JSON.stringify(first)).not.toMatch(/"(?:owner|generation|handle|press)":/)
  expect(f.load).not.toHaveBeenCalled()
  const count = f.publish.mock.calls.length
  expect(count).toBeGreaterThan(1)
  expect(await f.read()).toEqual(first)
  expect(f.publish).toHaveBeenCalledTimes(count)
  const changed = await f.read("NEW_PRIVATE")
  expect(JSON.stringify(changed)).toContain("NEW_SAFE")
  expect(f.publish.mock.calls.length).toBeGreaterThan(count)
})

it("projects native duration decorations without owned mount/unmount churn, preserving protection", async () => {
  const f = fixture()
  const read = (durationMs = 1200) => f.manager.siteRead(f.root, "thread", "TurnDuration",
    { word: "PRIVATE duration", durationMs }, "message:duration")
  const first = await read()
  expect(first.state).toBe("projected")
  expect(JSON.stringify(first)).toContain("SAFE duration")
  expect(JSON.stringify(first)).not.toContain("PRIVATE")
  expect(JSON.stringify(first)).not.toMatch(/"(?:owner|generation|handle|press)":/)
  const published = f.publish.mock.calls.length
  expect(await read()).toEqual(first)
  expect(f.publish).toHaveBeenCalledTimes(published)
  expect(await read(2400)).not.toEqual(first)
  expect(f.load).not.toHaveBeenCalled()
  f.protect(false)
  expect(await read()).toEqual({ state: "inactive", reason: "mods-disabled" })
})

it("bounds same-key waiting reads and releases their slots only when publication settles", async () => {
  const f = fixture()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setPublisher(async (value) => {
    await barrier
    return value
  })
  const reads = Array.from({ length: 256 }, () => f.read())
  await expect(f.read()).rejects.toThrow("MODS_DISPLAY_PENDING_LIMIT")
  expect(f.publish).toHaveBeenCalledTimes(1)
  release()
  const frames = await Promise.all(reads)
  expect(frames.every((frame) => frame.state === "projected")).toBe(true)
  expect(f.publish).toHaveBeenCalledTimes(2)
  expect((await f.read()).state).toBe("projected")
})

it.each(["thread", "database"])("does not resurrect a cached same-ID %s", async (kind) => {
  const f = fixture()
  const first = await f.read()
  if (kind === "thread") f.replaceThread()
  else f.replaceDatabase()
  const next = await f.read()
  expect(first.state).toBe("projected")
  expect(next.state).toBe("projected")
  if (first.state === "projected" && next.state === "projected")
    expect(next.snapshot.scopeId).not.toBe(first.snapshot.scopeId)
})

it("retains disabled/unprotected fallback and rejects invalid native message identities", async () => {
  const f = fixture()
  f.protect(false)
  expect(await f.read()).toEqual({ state: "inactive", reason: "mods-disabled" })
  expect(f.publish).not.toHaveBeenCalled()
  await expect(
    f.manager.siteRead(
      f.root,
      "thread",
      "AssistantMessage",
      { text: "text", isFirstOfReply: true },
      "row",
      "forged-user-id"
    )
  ).rejects.toMatchObject({ code: "MODS_UI_SITE_PROPS" })
})

it.each(["revoke", "thread", "close"])("rejects a held publication after %s", async (reason) => {
  const f = fixture()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setPublisher(async (value) => {
    enter()
    await barrier
    return value
  })
  const read = f.read()
  const rejected = expect(read).rejects.toThrow()
  await entered
  if (reason === "revoke") {
    f.protect(false)
    f.manager.invalidate(f.root)
  } else if (reason === "thread") f.replaceThread()
  else f.manager.closeThread("thread")
  release()
  await rejected
})

it("protects output tree separately and rejects a forged native reference", async () => {
  const f = fixture()
  f.setPublisher(async (value) => {
    if (value && !Array.isArray(value) && typeof value === "object" && "tree" in value)
      return {
        tree: { type: "Button", props: { label: "forged" }, press: { plugin: "old", handle: 1 } }
      }
    return value
  })
  await expect(f.read()).rejects.toThrow("MODS_UI_TREE_INVALID")
})

it("keeps the physical publication pending after invalidation until the real finally", async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const database = {},
    incarnation = { token: "one", legacyCreatedAt: 1 }
  const projection = new FunctionNativeDisplayProjection({
    capture: () => ({
      database,
      workspace: "C:/workspace",
      threadId: "thread",
      incarnation,
      assertCurrent: () => {}
    }),
    publish: async (_workspace, value) => {
      await barrier
      return value
    }
  })
  cleanup.push(() => projection.close())
  const read = projection.read(
    "C:/workspace",
    "thread",
    "AssistantMessage",
    { text: "body", isFirstOfReply: true },
    "row",
    { version: "one", assertCurrent: () => {} }
  )
  const rejected = expect(read).rejects.toThrow()
  expect(projection.stats().pending).toBe(1)
  projection.invalidate()
  expect(projection.stats().pending).toBe(1)
  release()
  await rejected
  expect(projection.stats().pending).toBe(0)
})

it("uses fresh full source proofs at every public read, without rescanning private Map checks", async () => {
  const database = {},
    full = vi.fn(),
    identity = vi.fn()
  const projection = new FunctionNativeDisplayProjection({
    capture: () => ({
      database,
      workspace: "C:/workspace",
      threadId: "thread",
      incarnation: { token: "one", legacyCreatedAt: 1 },
      assertCurrent: () => {}
    }),
    publish: async (_workspace, value) => value
  })
  cleanup.push(() => projection.close())
  const read = () =>
    projection.read(
      "C:/workspace",
      "thread",
      "AssistantMessage",
      { text: "safe", isFirstOfReply: true },
      "row",
      {
        version: "one",
        assertCurrent: full,
        assertIdentity: identity
      }
    )
  await read()
  full.mockClear()
  identity.mockClear()
  await read()
  expect(full).toHaveBeenCalledTimes(2)
  expect(identity.mock.calls.length).toBeGreaterThanOrEqual(2)
  await read()
  expect(full).toHaveBeenCalledTimes(4)
})

it("retires both a stale in-flight A and B instead of coalescing a later A with the old read", async () => {
  const database = {}
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const publish = vi.fn(async (_workspace: string, value: ModJson) => {
    await gate
    return value
  })
  const projection = new FunctionNativeDisplayProjection({
    capture: () => ({
      database,
      workspace: "C:/workspace",
      threadId: "thread",
      incarnation: { token: "one", legacyCreatedAt: 1 },
      assertCurrent: () => {}
    }),
    publish
  })
  cleanup.push(() => projection.close())
  const read = (text: string) =>
    projection.read(
      "C:/workspace",
      "thread",
      "AssistantMessage",
      { text, isFirstOfReply: true },
      "row",
      { version: "one", assertCurrent: () => {} }
    )
  const a = read("A"),
    b = read("B"),
    nextA = read("A")
  const oldA = expect(a).rejects.toThrow("MODS_DISPLAY_ROW_CHANGED")
  const oldB = expect(b).rejects.toThrow("MODS_DISPLAY_ROW_CHANGED")
  release()
  await Promise.all([oldA, oldB])
  expect(JSON.stringify(await nextA)).toContain("A")
  expect(publish.mock.calls.length).toBeGreaterThan(2)
})

it("keeps each single-flight waiter responsible for its own final full source check", async () => {
  const database = {}
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const publish = vi.fn(async (_workspace: string, value: ModJson) => {
    await gate
    return value
  })
  const projection = new FunctionNativeDisplayProjection({
    capture: () => ({
      database,
      workspace: "C:/workspace",
      threadId: "thread",
      incarnation: { token: "one", legacyCreatedAt: 1 },
      assertCurrent: () => {}
    }),
    publish
  })
  cleanup.push(() => projection.close())
  const input = { text: "A", isFirstOfReply: true }
  const first = projection.read("C:/workspace", "thread", "AssistantMessage", input, "row", {
    version: "one",
    assertCurrent: () => {},
    assertIdentity: () => {}
  })
  let checks = 0
  const second = projection.read("C:/workspace", "thread", "AssistantMessage", input, "row", {
    version: "one",
    assertIdentity: () => {},
    assertCurrent: () => {
      if (++checks > 1) throw Error("SOURCE_CHANGED_BEFORE_WAITER_RETURN")
    }
  })
  const rejected = expect(second).rejects.toThrow("SOURCE_CHANGED_BEFORE_WAITER_RETURN")
  release()
  expect((await first).data.component).toBe("AssistantMessage")
  await rejected
  expect(checks).toBe(2)
  expect(publish).toHaveBeenCalledTimes(2)
})

it("evicts old passive scopes within the existing 256 limit, including same-ID replacement", async () => {
  const database = {},
    incarnations = new Map<string, string>()
  const projection = new FunctionNativeDisplayProjection({
    capture: (workspace, threadId) => {
      const token = incarnations.get(threadId) ?? "one"
      return {
        database,
        workspace,
        threadId,
        incarnation: { token, legacyCreatedAt: 1 },
        assertCurrent: () => {
          if ((incarnations.get(threadId) ?? "one") !== token) throw Error("THREAD_REPLACED")
        }
      }
    },
    publish: async (_workspace, value) => value
  })
  cleanup.push(() => projection.close())
  const read = (threadId: string) =>
    projection.read(
      "C:/workspace",
      threadId,
      "AssistantMessage",
      { text: "safe", isFirstOfReply: true },
      "row",
      { version: "one", assertCurrent: () => {} }
    )
  for (let index = 0; index < 256; index++) await read(String(index))
  incarnations.set("255", "replacement")
  await expect(read("255")).resolves.toHaveProperty("data.component", "AssistantMessage")
  await expect(read("256")).resolves.toHaveProperty("data.component", "AssistantMessage")
  expect(projection.stats().entries).toBeLessThanOrEqual(256)
})

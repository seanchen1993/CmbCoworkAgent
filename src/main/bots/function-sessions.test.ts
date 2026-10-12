import { AsyncResource } from "node:async_hooks"
import { cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import type { FunctionUiElement, FunctionUiAction } from "../../shared/mods/v2/ui"
import { BotFunctionSessions, type BotFunctionHost } from "./function-sessions"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(capacity = 4) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-function-sessions-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const plugin = join(root, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  const sessions = new BotFunctionSessions(capacity)
  cleanup.push(() => sessions.close())
  let loads = 0,
    stops = 0
  const borrow = (
    key = "bot/conversation/main",
    config = "v1",
    overrides: Partial<BotFunctionHost> = {},
    persistent = true
  ) => {
    const host: BotFunctionHost = {
      plugins: () => [{ id: "source", name: "function-commands", path: plugin, enabled: true }],
      enabled: () => true,
      assertThread: (workspace, thread) => {
        expect(workspace).toBe(root)
        expect(thread).toBe("conversation")
      },
      publish: async (_, value) => value,
      changed: () => {},
      ...overrides
    }
    const lease = sessions.acquire({
      botId: key.startsWith("other/") ? "other" : "owner",
      key,
      configuration: config,
      storePath: join(root, "control.sqlite"),
      host,
      persistent,
      messageId: "opening-message",
      createClient: () => {
        const guests = new Set<FunctionGuestRuntime>()
        return {
          async load(code, options) {
            loads++
            const guest = await FunctionGuestRuntime.create(code, options)
            guests.add(guest)
            return guest
          },
          stop() {
            stops++
            for (const guest of guests) guest.dispose()
          }
        }
      }
    })
    cleanup.push(lease.release)
    return lease
  }
  const open = async (lease: ReturnType<typeof borrow>) => {
    const status = (await lease.functions.status(root))[0]
    if (status.state !== "ready") await lease.functions.approve(root, "source", status.digest!)
    const command = (await lease.functions.commands(root, "conversation")).find(
      (c) => c.command === "claw-board"
    )!
    await lease.functions.runCommand(
      root,
      "conversation",
      command,
      "",
      new AbortController().signal
    )
    const [pane] = await lease.functions.panes(root, "conversation")
    const row = pane.tree.children!.find(
      (node) => typeof node !== "string" && node.type === "Box"
    ) as FunctionUiElement
    const button = row.children![0] as FunctionUiElement
    const action: FunctionUiAction = {
      pane: pane.key,
      generation: pane.generation,
      plugin: button.press!.plugin,
      handle: button.press!.handle,
      intentId: randomUUID(),
      kind: "press"
    }
    return { pane, action }
  }
  return { root, sessions, borrow, open, loads: () => loads, stops: () => stops }
}

it("keeps the shipped pane closure after a turn and binds its callback to the next host", async () => {
  const f = await fixture()
  let oldPublications = 0,
    newPublications = 0
  const first = f.borrow(undefined, undefined, {
    publish: async (_, value) => {
      oldPublications++
      return value
    }
  })
  const { action } = await f.open(first)
  const loads = f.loads(),
    stops = f.stops()
  first.release()
  const count = oldPublications
  expect(() => first.functions.act(f.root, "conversation", action)).toThrow(
    "MODS_CALL_SCOPE_EXPIRED"
  )
  const next = f.borrow(undefined, undefined, {
    publish: async (_, value) => {
      newPublications++
      return value
    }
  })
  await next.functions.act(f.root, "conversation", action)
  // Transport retries keep the original intent and never call the closure twice.
  await next.functions.act(f.root, "conversation", action)
  const [updated] = await next.functions.panes(f.root, "conversation")
  expect((updated.tree.children![1] as FunctionUiElement).children).toEqual(["点击次数：", "1"])
  expect(f.loads()).toBe(loads)
  expect(oldPublications).toBe(count)
  expect(newPublications).toBeGreaterThan(0)
  next.release()
  first.release()
  expect(f.stops()).toBe(stops)
  f.sessions.close()
  expect(f.stops()).toBe(stops + 1)
})

it("does not let an inherited async callback borrow the next run's capability scope", async () => {
  const f = await fixture()
  let late: (() => void) | undefined
  const first = f.borrow(undefined, undefined, {
    publish: async (_, value) => {
      late ??= AsyncResource.bind(() => {
        // Calls from an old async resource must not become a new host entry.
        first.functions.hasToolCheck(f.root, "conversation")
      })
      return value
    }
  })
  await f.open(first)
  expect(late).toThrow("MODS_CALL_SCOPE_EXPIRED")
  first.release()
  const next = f.borrow()
  expect(late).toBeTypeOf("function")
  expect(late).toThrow("MODS_CALL_SCOPE_EXPIRED")
  expect(await next.functions.panes(f.root, "conversation")).toHaveLength(1)
})

it("rejects simultaneous owners, isolates branches and invalidates old callbacks after configuration changes", async () => {
  const f = await fixture()
  const first = f.borrow()
  const { action } = await f.open(first)
  expect(() => f.borrow()).toThrow("MODS_SESSION_BUSY")
  const branch = f.borrow("bot/conversation/branch")
  expect(await branch.functions.panes(f.root, "conversation")).toEqual([])
  branch.release()
  first.release()
  const stops = f.stops()
  const changed = f.borrow(undefined, "v2")
  await expect(changed.functions.act(f.root, "conversation", action)).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  expect(f.stops()).toBe(stops + 1)
  expect(await changed.functions.panes(f.root, "conversation")).toEqual([])
})

it("stops disposable child guests and releases their capacity, while host shutdown invalidates every handle", async () => {
  const f = await fixture(1)
  const child = f.borrow("child", "v1", {}, false)
  await f.open(child)
  expect(() => f.borrow("another")).toThrow("MODS_SESSION_CAPACITY")
  const stops = f.stops()
  child.release()
  expect(f.stops()).toBe(stops + 1)
  const next = f.borrow("another")
  await f.open(next)
  f.sessions.close()
  expect(f.stops()).toBe(stops + 2)
  expect(() => next.functions.panes(f.root, "conversation")).toThrow("MODS_CALL_SCOPE_EXPIRED")
  expect(() => f.borrow()).toThrow("MODS_DISABLED")
})

it("releases every deleted Bot surface immediately without closing another Bot's guest", async () => {
  const f = await fixture(3)
  const main = f.borrow(),
    branch = f.borrow("branch"),
    other = f.borrow("other/conversation")
  await f.open(main)
  await f.open(branch)
  await f.open(other)
  main.release()
  branch.release()
  const stops = f.stops()
  f.sessions.closeBot("owner")
  expect(f.stops()).toBe(stops + 2)
  expect(f.sessions.view("bot/conversation/main").sessionId).toBeNull()
  expect(await other.functions.panes(f.root, "conversation")).toHaveLength(1)
  const replacement = f.borrow("replacement")
  await f.open(replacement)
  // Deletion also expires an in-flight borrowed handle.
  f.sessions.closeBot("owner")
  expect(() => replacement.functions.panes(f.root, "conversation")).toThrow(
    "MODS_CALL_SCOPE_EXPIRED"
  )
})

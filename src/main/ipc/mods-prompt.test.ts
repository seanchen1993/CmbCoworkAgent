import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerPromptComposerHandlers } from "./mods-prompt"
import { FunctionPromptBroker, type FunctionPromptScope } from "../mods/v2/prompt-broker"
import { ModFunctionError, MODS_COMPOSITION_REVIEW_REQUIRED } from "../../shared/mods/v2/contracts"
import { submitAfterPromptEdit } from "../../renderer/src/lib/prompt-edit-submission"

function fixture(editing?: Parameters<typeof registerPromptComposerHandlers>[3]) {
  const broker = new FunctionPromptBroker()
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  let writable = true
  const scope = vi.fn(() => {
    if (!writable) throw Error("thread deleted or read-only")
    return "workspace"
  })
  registerPromptComposerHandlers(
    { handle: (name, fn) => handlers.set(name, fn) } as unknown as IpcMain,
    broker,
    scope,
    editing
  )
  const sender = (id: number) => {
    const events = new EventEmitter()
    let destroyed = false
    return Object.assign(events, {
      id,
      send: vi.fn(),
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true
        events.emit("destroyed")
      }
    })
  }
  const owner = sender(1),
    other = sender(2)
  const call = (channel: string, input: unknown, from = owner) =>
    handlers.get(`mods:prompt-${channel}`)!(
      { sender: from } as unknown as IpcMainInvokeEvent,
      input
    )
  const readScope = (threadId = "t", sessionId = "session"): FunctionPromptScope => ({
    threadId,
    pluginId: "p",
    sessionId,
    signal: new AbortController().signal,
    assertLive: () => undefined
  })
  return {
    broker,
    owner,
    other,
    scope,
    call,
    readScope,
    deleted: () => {
      writable = false
    }
  }
}

it("preserves the unsent draft and blocks model/storage entry with an actionable composition failure", async () => {
  const support = vi.fn(async () => {
    throw new ModFunctionError("CLAW_CAPABILITY_CHANGED", "PRIVATE_SOURCE")
  })
  const run = vi.fn()
  const f = fixture({ support, run })
  f.call("attach", { threadId: "t", owner: "one" })
  const draft = { text: "请继续我的普通聊天", revision: 3 }
  const submit = vi.fn()
  await expect(
    submitAfterPromptEdit("revoked-composition", {
      read: () => draft,
      flush: async () => {
        await f.call("edit-support", { threadId: "t", owner: "one" })
        return draft
      },
      submit
    })
  ).rejects.toThrow(MODS_COMPOSITION_REVIEW_REQUIRED)
  expect(draft).toEqual({ text: "请继续我的普通聊天", revision: 3 })
  expect(submit).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  const error = await Promise.resolve(
    f.call("edit-support", { threadId: "t", owner: "one" })
  ).catch((error) => error)
  if (!(error instanceof Error)) throw Error("Expected a native composition review error")
  expect(error.message).toContain("输入已保留")
  expect(error.message).not.toContain("PRIVATE_SOURCE")
  f.broker.close()
})

it.each([
  new Error("CLAW_CAPABILITY_CHANGED"),
  new ModFunctionError("MODS_SCOPE_CHANGED", "original failure"),
  { code: "CLAW_CAPABILITY_CHANGED", message: "spoofed failure" }
])("does not reinterpret an unrelated or spoofed support failure", async (original) => {
  const f = fixture({
    support: vi.fn(async () => {
      throw original
    }),
    run: vi.fn()
  })
  f.call("attach", { threadId: "t", owner: "one" })
  await expect(f.call("edit-support", { threadId: "t", owner: "one" })).rejects.toBe(original)
  f.broker.close()
})

it("releases a registered composer after the thread loses writable scope", async () => {
  const f = fixture()
  f.call("attach", { threadId: "t", owner: "one" })
  f.deleted()
  expect(() => f.call("detach", { threadId: "t", owner: "one" })).not.toThrow()
  expect(f.scope).toHaveBeenCalledTimes(1)
  expect(await f.broker.read(f.readScope())).toEqual({ text: "", cursor: 0 })
  expect(f.owner.send).not.toHaveBeenCalled()
  expect(() => f.call("attach", { threadId: "t", owner: "next" })).toThrow("read-only")
  expect(() => f.call("response", { threadId: "t" })).toThrow("read-only")
  expect(() => f.call("authorize", { threadId: "t" })).toThrow("read-only")
})

it("does not let another sender detach an owner even with its exact thread and token", async () => {
  const f = fixture()
  f.call("attach", { threadId: "t", owner: "one" })
  f.call("detach", { threadId: "t", owner: "one" }, f.other)
  const reading = f.broker.read(f.readScope())
  const request = f.owner.send.mock.calls[0][1]
  f.call("response", { ...request, status: "ok", text: "kept", cursor: 4, revision: 1 })
  expect(await reading).toEqual({ text: "kept", cursor: 4 })
  f.broker.close()
})

it("observes sender destruction once and closes only that sender's owners and pending requests", async () => {
  const f = fixture()
  f.call("attach", { threadId: "t", owner: "one" })
  f.call("attach", { threadId: "u", owner: "two" })
  f.call("attach", { threadId: "v", owner: "other" }, f.other)
  expect(f.owner.listenerCount("destroyed")).toBe(1)
  const first = f.broker.read(f.readScope("t", "first"))
  const second = f.broker.read(f.readScope("v", "second"))
  f.owner.destroy()
  expect(await first).toEqual({ text: "", cursor: 0 })
  const request = f.other.send.mock.calls[0][1]
  f.call("response", { ...request, status: "ok", text: "other", cursor: 5, revision: 2 }, f.other)
  expect(await second).toEqual({ text: "other", cursor: 5 })
  expect(await f.broker.read(f.readScope("u", "third"))).toEqual({ text: "", cursor: 0 })
  expect(() => f.call("attach", { threadId: "t", owner: "next" })).toThrow("NO_COMPOSER")
  f.broker.close()
})

it("validates detach identity shape without granting any new scoped operation", () => {
  const f = fixture()
  for (const input of [
    null,
    [],
    {},
    { threadId: "t", owner: 1 },
    { threadId: "t", owner: "x".repeat(101) },
    { threadId: "x".repeat(201), owner: "one" }
  ])
    expect(() => f.call("detach", input)).toThrow("OWNER_INVALID")
  expect(f.scope).not.toHaveBeenCalled()
})

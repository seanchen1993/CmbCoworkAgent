import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionSession } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { FunctionSessionInitializer } from "./session-initializer"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { currentFunctionExecution } from "./execution-context"
import { withFunctionTransportExecution } from "./host-call"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.restoreAllMocks()
})
const tick = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}
const facts = {
  workspace: "/actual-project",
  threadId: "thread",
  agentId: "actual-child",
  turnId: "actual-turn",
  userInitiated: false,
  leased: false,
  immediate: true
}

/** Real Session/Panes/RuntimeClient; native utility messages are controlled, not actual Guest VM. */
async function fixture(options: { readOnly?: boolean; candidate?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(message: FunctionRequest): void
    kill(): void
  }
  const ids: string[] = []
  const messages: FunctionRequest[] = []
  let prepare: Extract<FunctionRequest, { type: "prepare-ui-resolve" }> | undefined
  child.kill = vi.fn()
  child.postMessage = (message) => {
    messages.push(message)
    if (message.type === "load") {
      ids.push(message.runtimeId)
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: [
            {
              id: "0",
              pattern: ids.length === 1 ? "ui.render" : "ui.resolve",
              hasCatch: false,
              hasMatcher: false
            }
          ]
        })
      )
    } else if (message.type === "prepare-ui-resolve") {
      prepare = message
      queueMicrotask(() => {
        child.emit("message", {
          type: "ui-resolve-credit-ack",
          assembly: message.assembly,
          revision: message.credit.revision
        })
        child.emit("message", {
          type: "ui-resolve-credit-request",
          assembly: message.assembly,
          id: "growth",
          limits: { handles: 64, roots: 16, branches: 512, reactions: 512 }
        })
      })
    } else if (message.type === "ui-resolve-credit-reply") {
      queueMicrotask(() => {
        child.emit("message", {
          type: "ui-resolve-credit-ack",
          assembly: message.assembly,
          revision: message.credit!.revision
        })
        child.emit("message", {
          type: "result",
          id: prepare!.id,
          runtimeId: prepare!.runtimeId,
          value: {
            assembly: message.assembly,
            preparedToken: "actual-token",
            sources: { [ids[0]]: { Pane: [{ runtimeId: ids[1], registration: "0" }] } }
          }
        })
      })
    } else if (message.type === "invoke" && message.metadata.event === "ui.render") {
      queueMicrotask(() => {
        child.emit("message", {
          type: "ui-constructor-open",
          assembly: message.uiDrawing!.assembly,
          scopeId: "root",
          drawToken: message.uiDrawing!.token,
          consumerRuntimeId: ids[0],
          runtimeId: ids[1],
          registration: "0"
        })
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: { value: { type: "Text", props: {}, children: ["safe drawing"] } }
        })
      })
    } else if (
      message.type === "adopt-ui-resolve" ||
      message.type === "release-ui" ||
      message.type === "dispose"
    )
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: null
        })
      )
  }
  fork.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  const client = new FunctionRuntimeClient("controlled-session-transport")
  clients.push(client)
  const plugins: FunctionPlugin[] = [
    {
      name: "Q",
      root: "/Q",
      tier: "user",
      capabilities: ["ui.resolve", "store.set"],
      guest: await client.load("Q")
    },
    {
      name: "P",
      root: "/P",
      tier: "user",
      capabilities: options.readOnly ? ["store.get"] : ["store.get", "store.set"],
      guest: await client.load("P")
    }
  ]
  const activity = new FunctionSessionActivity()
  const initializer = new FunctionSessionInitializer(Boolean(options.candidate))
  const writes: Array<{ plugin: string; key: string; facts: unknown }> = []
  const reads: string[] = []
  const session = new FunctionSession(plugins, {
    workspace: facts.workspace,
    threadId: facts.threadId,
    activity,
    initializer,
    uiResolveQuota: () => new FunctionUiResolveMainQuota(),
    assertLive() {
      /* Runtime identity is provided by the actual private transport binding. */
    },
    publish: async (value) => value,
    state: (plugin) => ({
      get: async () => {
        reads.push(plugin.name)
        return "actual value"
      },
      set: async (key) => {
        writes.push({ plugin: plugin.name, key, facts: currentFunctionExecution() })
      },
      delete() {
        /* These focused tests do not remove persisted fixture state. */
      },
      keys: async () => []
    })
  })
  await withFunctionTransportExecution(facts, async () => {
    await session.start()
    session.panes.open("Q", { id: "view" })
    await session.panes.snapshot()
  })
  const call = async (id: string, method = "store.set") => {
    child.emit("message", {
      type: "ui-constructor-call",
      assembly: prepare!.assembly,
      scopeId: "root",
      id,
      runtimeId: ids[1],
      registration: "0",
      method,
      args: method === "store.get" ? ["key"] : ["key", 1]
    })
    await tick()
    const reply = messages.find((row) => row.type === "reply" && row.id === id)
    return reply
  }
  return { session, client, child, messages, activity, initializer, writes, reads, call }
}

it("keeps actual P namespace and original child/turn in a fresh read-only entry after drawing returns", async () => {
  const f = await fixture()
  expect(f.activity.size).toBe(1)
  expect(await f.call("late-sdk")).toMatchObject({ type: "reply", value: {} })
  expect(f.writes).toEqual([
    {
      plugin: "P",
      key: "key",
      facts: expect.objectContaining({
        agentId: facts.agentId,
        turnId: facts.turnId,
        userInitiated: false,
        leased: false,
        immediate: true
      })
    }
  ])
  const drawing = f.messages.find(
    (row) => row.type === "invoke" && row.metadata.event === "ui.render"
  )
  expect(drawing).toMatchObject({
    uiDrawing: { assembly: expect.any(String), token: expect.any(String) }
  })
  expect(drawing && "metadata" in drawing && "uiDrawing" in drawing.metadata).toBe(false)
  await f.session.close()
})

it("cannot borrow the consumer's store write capability for P", async () => {
  const f = await fixture({ readOnly: true })
  expect(await f.call("denied-write")).toMatchObject({ error: { code: "MODS_CAPABILITY_DENIED" } })
  expect(f.writes).toEqual([])
  expect(await f.call("allowed-read", "store.get")).toMatchObject({
    value: { value: "actual value" }
  })
  expect(f.reads).toEqual(["P"])
  await f.session.close()
})

it("keeps actual candidate admission read-only through activation", async () => {
  const f = await fixture({ candidate: true })
  f.initializer.activate()
  expect(await f.call("old-candidate-write")).toMatchObject({
    error: { code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" }
  })
  expect(f.writes).toEqual([])
  expect(() => f.initializer.assertReady()).toThrow("参数已保存")
  await f.session.close()
})

it("rejects an old drawing SDK after an actual pane unmount", async () => {
  const f = await fixture()
  await f.session.panes.closePane("Q", "view")
  expect(await f.call("unmounted-write")).toMatchObject({
    error: { code: "MODS_UI_DRAWING_STALE" }
  })
  expect(f.writes).toEqual([])
  await f.session.close()
})

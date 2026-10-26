import { AsyncResource } from "node:async_hooks"
import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import type { ModJson } from "../../../shared/mods/types"
import { withTrustedFunctionWait } from "./trusted-function-wait"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"
const clients: FunctionRuntimeClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.clearAllMocks() })

// This tests the real main transport's admission logic against adversarial worker ACKs.
// Actual utility-process/Guest/process execution is covered by the separate Electron fixture.
it.each<ModJson>([null, {}, { acknowledged: false }, { acknowledged: true, extra: true }])(
  "rejects malformed ACK %j before opening the native approval",
  async ack => {
    const external = new AsyncResource("outside-logical-call")
    const child = new EventEmitter() as EventEmitter & {
      postMessage(message: FunctionRequest): void; kill(): void
    }
    const dispatched = Promise.withResolvers<Extract<FunctionRequest, { type: "invoke" }>>()
    const observed = Promise.withResolvers<unknown>()
    const messages: FunctionRequest[] = []
    child.kill = () => {}
    child.postMessage = message => {
      messages.push(message)
      if (message.type === "invoke") { dispatched.resolve(message); return }
      if (message.type === "load" || message.type === "trusted-wait") {
        queueMicrotask(() => child.emit("message", { type: "result", id: message.id,
          runtimeId: message.runtimeId, value: message.type === "load"
            ? [{ id: "0", pattern: "tool.describe", hasCatch: false, hasMatcher: false }] : ack }))
      }
      if (message.type === "cancel") queueMicrotask(() => child.emit("message", {
        type: "error", id: message.id, runtimeId: message.runtimeId,
        error: { code: "MODS_CANCELLED", message: "MODS_CANCELLED" }
      }))
    }
    fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }))
      return child
    })
    const client = new FunctionRuntimeClient("fixture")
    clients.push(client)
    const guest = await client.load("fixture")
    const dialog = vi.fn(async () => ({ value: "allowed" }))
    const run = guest.invoke("0", {}, async (_method, _args, signal) => {
      try { return await withTrustedFunctionWait("user-approval", signal, dialog) }
      catch (error) { observed.resolve(error); throw error }
    }, { event: "tool.describe", origin: { plugin: "engine", tier: "core" },
      plugin: { name: "probe", root: "/probe" }, capabilities: ["session.id"] })
    const rejected = expect(run).rejects.toThrow()
    try {
      const request = await dispatched.promise
      external.runInAsyncScope(() => child.emit("message", { type: "call", id: "actual-call",
        requestId: request.id, runtimeId: request.runtimeId, method: "session.id", args: [] }))
      expect(await observed.promise).toMatchObject({ code: "MODS_TRUSTED_WAIT_ACK_INVALID" })
      await rejected
      expect(dialog).not.toHaveBeenCalled()
      expect(messages.find(message => message.type === "trusted-wait")).toMatchObject({
        type: "trusted-wait", phase: "begin", callId: "actual-call", requestId: request.id,
        runtimeId: request.runtimeId
      })
    } finally { external.emitDestroy() }
  }
)

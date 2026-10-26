import { AsyncResource } from "node:async_hooks"
import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import {
  createRunCancellationSettlement,
  recordRunCancellation,
  confirmRunCancellationSettlement
} from "../../agent/run-cancellation-settlement"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.clearAllMocks()
})

it.each([false, true])(
  "preheated pure Guest invocation vetoes cancellation without an SDK call (already cancelled=%s)",
  async (alreadyCancelled) => {
    const child = new EventEmitter() as EventEmitter & {
      postMessage(message: FunctionRequest): void
      kill(): void
    }
    const invocations: FunctionRequest[] = []
    child.kill = () => {}
    child.postMessage = (message) => {
      if (message.type === "invoke") invocations.push(message)
      if (message.type === "load" || message.type === "invoke" || message.type === "dispose") {
        queueMicrotask(() =>
          child.emit("message", {
            type: "result",
            id: message.id,
            runtimeId: message.runtimeId,
            value:
              message.type === "load"
                ? [{ id: "0", pattern: "tool.describe", hasCatch: false, hasMatcher: false }]
                : message.type === "invoke"
                  ? { value: { text: "pure description" } }
                  : null
          })
        )
      }
    }
    fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }))
      return child
    })
    const client = new FunctionRuntimeClient("fixture")
    clients.push(client)
    // The real main-process session is warmed before the run frame exists.
    const guest = await client.load(
      'var __cmbFunctionMod={register(on){on("tool.describe",()=>({text:"pure description"}))}}'
    )
    const scope = createRunCancellationSettlement()
    const host = vi.fn(async () => ({ value: "unexpected SDK call" }))
    await scope.run(async () => {
      if (alreadyCancelled) recordRunCancellation()
      const result = guest.invoke("0", {}, host, {
        event: "tool.describe",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "probe", root: "/probe" }
      })
      if (alreadyCancelled) {
        await expect(result).rejects.toThrow("AGENT_RUN_EFFECT_ADMISSION_CLOSED")
      } else {
        await expect(result).resolves.toEqual({ value: { text: "pure description" } })
        recordRunCancellation()
      }
      confirmRunCancellationSettlement(true)
    })
    expect(host).not.toHaveBeenCalled()
    expect(invocations).toHaveLength(alreadyCancelled ? 0 : 1)
    expect(scope.read()).toEqual({ requested: true, confirmed: false })
  }
)

it.each([false, true])(
  "original utility transport retains cancellation scope (cancel before SDK=%s)",
  async (early) => {
    const external = new AsyncResource("utility-message-outside-agent")
    const child = new EventEmitter() as EventEmitter & {
      postMessage(message: FunctionRequest): void
      kill(): void
    }
    const dispatched = Promise.withResolvers<Extract<FunctionRequest, { type: "invoke" }>>()
    let invoke: Extract<FunctionRequest, { type: "invoke" }> | undefined
    const replies: FunctionRequest[] = []
    child.kill = () => {}
    child.postMessage = (message) => {
      if (message.type === "invoke") {
        invoke = message
        dispatched.resolve(message)
      } else if (message.type === "reply") {
        replies.push(message)
        const original = invoke!
        queueMicrotask(() =>
          child.emit("message", {
            type: "result",
            id: original.id,
            runtimeId: original.runtimeId,
            value: { done: true }
          })
        )
      } else if (message.type === "load" || message.type === "dispose") {
        queueMicrotask(() =>
          child.emit("message", {
            type: "result",
            id: message.id,
            runtimeId: message.runtimeId,
            value:
              message.type === "load"
                ? [{ id: "0", pattern: "tool.describe", hasCatch: false, hasMatcher: false }]
                : null
          })
        )
      }
    }
    fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }))
      return child
    })
    const client = new FunctionRuntimeClient("fixture")
    clients.push(client)
    const guest = await client.load("fixture")
    const scope = createRunCancellationSettlement()
    const host = vi.fn(async () => ({ value: "real-sdk-result" }))
    try {
      await scope.run(async () => {
        const pending = guest.invoke("0", {}, host, {
          event: "tool.describe",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["session.id"],
          plugin: { name: "probe", root: "/probe" }
        })
        const request = await dispatched.promise
        if (early) recordRunCancellation()
        external.runInAsyncScope(() =>
          child.emit("message", {
            type: "call",
            id: "sdk",
            requestId: request.id,
            runtimeId: request.runtimeId,
            method: "session.id",
            args: []
          })
        )
        await expect(pending).resolves.toEqual({ done: true })
        if (!early) recordRunCancellation()
        confirmRunCancellationSettlement(true)
      })
      expect(host).toHaveBeenCalledTimes(early ? 0 : 1)
      expect(replies).toHaveLength(1)
      if (early)
        expect(replies[0]).toMatchObject({
          error: { message: "AGENT_RUN_EFFECT_ADMISSION_CLOSED" }
        })
      expect(scope.read().confirmed).toBe(false)
    } finally {
      external.emitDestroy()
    }
  }
)

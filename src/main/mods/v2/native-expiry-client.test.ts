import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { ModError } from "../errors"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const expiry = "MODS_RUNTIME_INSTANCE_EXPIRED"
const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
})

for (const kind of ["call", "module-call"] as const) {
  it.each([
    { error: new ModError(expiry), code: expiry, downstream: true },
    { error: new Error(expiry), code: "MODS_HOST_ERROR", downstream: false },
    {
      error: Object.assign(new Error(expiry), { code: expiry }),
      code: "MODS_HOST_ERROR",
      downstream: false
    },
    { error: new ModError("MODS_PLUGIN_CHANGED"), code: "MODS_HOST_ERROR", downstream: false },
    {
      error: new ModFunctionError("MODS_CONTROLLED", "controlled", false),
      code: "MODS_CONTROLLED",
      downstream: false
    },
    {
      error: new ModFunctionError("MODS_CONTROLLED", "controlled", true),
      code: "MODS_CONTROLLED",
      downstream: true
    }
  ])(
    `preserves trusted provenance at the actual main ${kind} packet boundary (%#)`,
    async (row) => {
      const child = new EventEmitter() as EventEmitter & {
        postMessage(message: FunctionRequest): void
        kill(): void
      }
      const messages: FunctionRequest[] = []
      child.kill = vi.fn()
      child.postMessage = (message) => {
        messages.push(message)
        if (message.type === "load")
          queueMicrotask(() =>
            child.emit("message", {
              type: "result",
              id: message.id,
              runtimeId: message.runtimeId,
              value: [{ id: "0", pattern: "command.run", hasCatch: false, hasMatcher: false }]
            })
          )
      }
      fork.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("message", { type: "ready" }))
        return child
      })
      const client = new FunctionRuntimeClient("controlled-child")
      clients.push(client)
      const guest = await client.load("controlled-source")
      const host = vi.fn(async () => {
        throw row.error
      })
      let pending: Promise<unknown> | undefined
      if (kind === "module-call") guest.bindModuleHost!(host)
      else {
        pending = guest.invoke("0", {}, host, {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["session.id"],
          plugin: { name: "controlled", root: "/controlled" }
        })
        void pending.catch(() => undefined)
        await vi.waitFor(() =>
          expect(messages.some((message) => message.type === "invoke")).toBe(true)
        )
      }
      const invocation = messages.find((message) => message.type === "invoke")
      const runtimeId = messages[0].runtimeId
      child.emit("message", {
        type: kind,
        id: "host-call",
        runtimeId,
        ...(invocation ? { requestId: invocation.id } : {}),
        method: "session.id",
        args: []
      })
      await vi.waitFor(() =>
        expect(
          messages.some((message) => message.type === "reply" && message.id === "host-call")
        ).toBe(true)
      )
      expect(host).toHaveBeenCalledOnce()
      const reply = messages.find(
        (message) => message.type === "reply" && message.id === "host-call"
      )
      expect(reply).toMatchObject({ error: { code: row.code, downstream: row.downstream } })
      if (invocation)
        child.emit("message", {
          type: "result",
          id: invocation.id,
          runtimeId,
          value: { value: "settled" }
        })
      if (pending) await pending
      await vi.waitFor(() => expect(client.stats.calls).toBe(0))
    }
  )
}

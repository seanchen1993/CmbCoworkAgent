import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import { isFunctionGuestInvokeFailure } from "./guest-invoke-failure"
import { isFunctionGuestLoadFailure } from "./client-load-failure"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
})

async function fixture() {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(request: FunctionRequest): void
    kill(): void
  }
  const calls: FunctionRequest[] = []
  child.kill = () => {}
  child.postMessage = (request) => {
    calls.push(request)
    if (request.type === "load")
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: request.id,
          runtimeId: request.runtimeId,
          value: [{ id: "0", pattern: "surface.update", hasCatch: false, hasMatcher: false }]
        })
      )
  }
  fork.mockImplementation(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  const client = new FunctionRuntimeClient("fixture")
  clients.push(client)
  const guest = await client.load("fixture")
  const invoke = () =>
    guest.invoke("0", {}, async () => ({}), {
      event: "surface.update",
      capabilities: [],
      origin: { plugin: "engine", tier: "core" },
      plugin: { name: "fixture", root: "" }
    })
  return { client, child, calls, invoke }
}

it("does not mark actual native proxy pending-capacity refusal as VM failure", async () => {
  const f = await fixture()
  const pending = Array.from({ length: 128 }, () => f.invoke().catch((error: unknown) => error))
  await vi.waitFor(() => expect(f.client.stats.pending).toBe(128))
  const refused = await f.invoke().catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: "MODS_HOST_CAPACITY" })
  expect(isFunctionGuestInvokeFailure(refused)).toBe(false)
  expect(f.calls.filter((call) => call.type === "invoke")).toHaveLength(128)
  f.client.stop()
  await Promise.all(pending)
})

it.each([false, true])(
  "only propagates a native VM receipt, regardless of error text: %s",
  async (receipt) => {
    const f = await fixture()
    const pending = f.invoke().catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.calls.some((call) => call.type === "invoke")).toBe(true))
    const request = f.calls.find((call) => call.type === "invoke")!
    f.child.emit("message", {
      type: "error",
      id: request.id,
      runtimeId: request.runtimeId,
      error: { code: "MODS_HOST_CAPACITY", message: "same text", downstream: false },
      guestInvokeFailure: receipt,
      guestLoadFailure: true
    })
    const error = await pending
    expect(isFunctionGuestInvokeFailure(error)).toBe(receipt)
    expect(isFunctionGuestLoadFailure(error)).toBe(false)
  }
)

import { beforeEach, expect, it, vi } from "vitest"
const owned = vi.hoisted(() => ({
  drain: undefined as Promise<void> | undefined,
  worker: undefined as Promise<void> | undefined,
  stopped: 0,
  drains: 0
}))
vi.mock("../v2/runtime-client", () => ({
  FunctionRuntimeClient: class {
    load = vi.fn()
    stop() { owned.stopped++ }
    async stopAndDrain() { owned.drains++; await owned.drain }
  }
}))
vi.mock("./authoring-preflight-client", () => ({
  AuthoringPreflightClient: class {
    run = vi.fn()
    async stop() { await owned.worker }
  }
}))
import { createAuthoringPreviewBackend } from "./authoring-preview-backend"

beforeEach(() => {
  owned.drain = undefined
  owned.worker = undefined
  owned.drains = 0
  owned.stopped = 0
})

it("does not release preview sources before physical guest exit and worker shutdown", async () => {
  const guest = Promise.withResolvers<void>(), worker = Promise.withResolvers<void>()
  owned.drain = guest.promise
  owned.worker = worker.promise
  const backend = createAuthoringPreviewBackend()
  let finished = false
  const closing = backend.stop().then(() => { finished = true })
  worker.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(owned.stopped).toBe(0)
  expect(owned.drains).toBe(1)
  guest.resolve()
  await closing
  expect(finished).toBe(true)
})

it("keeps physical cleanup failure visible to the owner instead of confirming a stop", async () => {
  owned.drain = Promise.reject(Error("EXIT_UNCONFIRMED"))
  await expect(createAuthoringPreviewBackend().stop()).rejects.toThrow("EXIT_UNCONFIRMED")
})

it("drains the other owner before returning a cleanup failure", async () => {
  const worker = Promise.withResolvers<void>()
  owned.drain = Promise.reject(Error("EXIT_UNCONFIRMED"))
  owned.worker = worker.promise
  let finished = false
  const closing = createAuthoringPreviewBackend().stop().finally(() => { finished = true })
  const rejected = expect(closing).rejects.toThrow("EXIT_UNCONFIRMED")
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  worker.resolve()
  await rejected
  expect(finished).toBe(true)
})

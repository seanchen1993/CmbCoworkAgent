import { randomUUID } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { ModFunctionError, type FunctionHostReply } from "../../../shared/mods/v2/contracts"
import type { FunctionRequest, FunctionResponse } from "../../../shared/mods/v2/protocol"
import { FunctionGuestRuntime } from "./guest-runtime"
import { fromWireError, wireError } from "./wire"

const port = (
  process as NodeJS.Process & {
    parentPort: {
      on(event: "message", listener: (event: { data: FunctionRequest }) => void): void
      postMessage(value: FunctionResponse): void
    }
  }
).parentPort

const runtimes = new Map<string, FunctionGuestRuntime>()
const loading = new Set<string>()
const frames = new Map<string, { runtimeId: string; controller: AbortController }>()
const replies = new Map<
  string,
  {
    runtimeId: string
    resolve(value: FunctionHostReply): void
    reject(error: Error): void
    detach(): void
  }
>()

port.on("message", ({ data: request }) => {
  if (request.type === "reply") {
    const pending = replies.get(request.id)
    if (!pending || pending.runtimeId !== request.runtimeId) return
    replies.delete(request.id)
    pending.detach()
    if (request.error) pending.reject(fromWireError(request.error))
    else {
      try {
        pending.resolve(parseModJson(encodeModJson(request.value ?? {})) as FunctionHostReply)
      } catch {
        pending.reject(new ModFunctionError("MODS_INVALID_HOST_RESULT"))
      }
    }
    return
  }
  if (request.type === "cancel") {
    const frame = frames.get(request.id)
    if (frame && frame.runtimeId === request.runtimeId) frame.controller.abort()
    return
  }
  void handle(request)
    .then(
      (value) =>
        port.postMessage({
          type: "result",
          id: request.id,
          runtimeId: request.runtimeId,
          value: parseModJson(encodeModJson(value)) as ModJson
        }),
      (error) =>
        port.postMessage({
          type: "error",
          id: request.id,
          runtimeId: request.runtimeId,
          error: wireError(error)
        })
    )
    .catch(() => {
      port.postMessage({
        type: "error",
        id: request.id,
        runtimeId: request.runtimeId,
        error: wireError(new ModFunctionError("MODS_INVALID_GUEST_RESULT"))
      })
    })
})

async function handle(request: FunctionRequest): Promise<ModJson> {
  if (request.type === "load") {
    if (
      runtimes.has(request.runtimeId) ||
      loading.has(request.runtimeId) ||
      runtimes.size + loading.size >= 16
    )
      throw new ModFunctionError("MODS_RUNTIME_LIMIT")
    if (Buffer.byteLength(request.code) > 2 * 1024 * 1024)
      throw new ModFunctionError("MODS_SOURCE_LIMIT")
    loading.add(request.runtimeId)
    try {
      const guest = await FunctionGuestRuntime.create(request.code, request.options)
      runtimes.set(request.runtimeId, guest)
      return guest.registrations as unknown as ModJson
    } finally {
      loading.delete(request.runtimeId)
    }
  }
  const guest = runtimes.get(request.runtimeId)
  if (!guest) throw new ModFunctionError("MODS_RUNTIME_MISSING")
  if (request.type === "dispose") {
    guest.dispose()
    runtimes.delete(request.runtimeId)
    return null
  }
  if (request.type === "match") return guest.matches(request.registration, request.event)
  if (request.type === "release-ui") {
    guest.releaseUi(request.generation)
    return null
  }
  if (request.type !== "invoke") throw new ModFunctionError("MODS_REQUEST_INVALID")
  if (frames.size >= 128) throw new ModFunctionError("MODS_HOST_CAPACITY")
  const controller = new AbortController()
  frames.set(request.id, { runtimeId: request.runtimeId, controller })
  try {
    return await guest.invoke(
      request.registration,
      request.event,
      (method, args, signal) => {
        if (signal.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
        if (replies.size >= 512) return Promise.reject(new ModFunctionError("MODS_RPC_LIMIT"))
        const id = randomUUID()
        return new Promise<FunctionHostReply>((resolve, reject) => {
          const cancel = (): void => {
            if (!replies.delete(id)) return
            signal.removeEventListener("abort", cancel)
            port.postMessage({
              type: "revoke",
              id,
              runtimeId: request.runtimeId,
              requestId: request.id
            })
            reject(new ModFunctionError("MODS_INVOCATION_ENDED"))
          }
          replies.set(id, {
            runtimeId: request.runtimeId,
            resolve,
            reject,
            detach: () => signal.removeEventListener("abort", cancel)
          })
          signal.addEventListener("abort", cancel, { once: true })
          port.postMessage({
            type: "call",
            id,
            requestId: request.id,
            runtimeId: request.runtimeId,
            method,
            args
          })
        })
      },
      { ...request.metadata, signal: controller.signal }
    )
  } finally {
    frames.delete(request.id)
    if (guest.stats.disposed && runtimes.get(request.runtimeId) === guest) {
      runtimes.delete(request.runtimeId)
      port.postMessage({ type: "disposed", runtimeId: request.runtimeId })
    }
  }
}

setInterval(() => {
  port.postMessage({
    type: "heartbeat",
    rss: process.memoryUsage().rss,
    runtimes: runtimes.size,
    frames: frames.size,
    replies: replies.size
  })
}, 250).unref()
port.postMessage({ type: "ready" })

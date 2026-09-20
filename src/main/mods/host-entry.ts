import { randomUUID } from "node:crypto"
import type { ModJson, ModRuntimeRequest, ModRuntimeResponse } from "../../shared/mods/types"
import { ModGuestRuntime } from "./guest-runtime"
import { modErrorCode } from "./errors"

const port = (
  process as NodeJS.Process & {
    parentPort: {
      on(event: "message", listener: (event: { data: ModRuntimeRequest }) => void): void
      postMessage(value: ModRuntimeResponse): void
    }
  }
).parentPort

const runtimes = new Map<string, ModGuestRuntime>()
const loading = new Set<string>()
const replies = new Map<
  string,
  {
    runtimeId: string
    resolve: (value: ModJson) => void
    reject: (error: Error) => void
  }
>()

port.on("message", ({ data: request }) => {
  if (request.type === "reply") {
    const pending = replies.get(request.id)
    if (!pending || pending.runtimeId !== request.runtimeId) return
    replies.delete(request.id)
    if (request.error) pending.reject(new Error("MODS_HOST_REJECTED"))
    else pending.resolve(request.value ?? null)
    return
  }
  if (request.type === "cancel") {
    runtimes.get(request.runtimeId)?.cancel()
    return
  }
  void handle(request).then(
    (value) =>
      port.postMessage({ type: "result", id: request.id, runtimeId: request.runtimeId, value }),
    (error) =>
      port.postMessage({
        type: "error",
        id: request.id,
        runtimeId: request.runtimeId,
        error: modErrorCode(error)
      })
  )
})

async function handle(request: ModRuntimeRequest): Promise<ModJson> {
  if (request.type === "load") {
    if (
      runtimes.has(request.runtimeId) ||
      loading.has(request.runtimeId) ||
      runtimes.size + loading.size >= 16
    )
      throw new Error("MODS_RUNTIME_LIMIT")
    loading.add(request.runtimeId)
    try {
      const runtime = await ModGuestRuntime.create(request.code ?? "")
      runtimes.set(request.runtimeId, runtime)
      return runtime.registrations as unknown as ModJson
    } finally {
      loading.delete(request.runtimeId)
    }
  }
  const runtime = runtimes.get(request.runtimeId)
  if (!runtime) throw new Error("MODS_RUNTIME_MISSING")
  if (request.type === "dispose") {
    runtime.dispose()
    runtimes.delete(request.runtimeId)
    for (const [id, pending] of replies) {
      if (pending.runtimeId !== request.runtimeId) continue
      pending.reject(new Error("MODS_UNLOADED"))
      replies.delete(id)
    }
    return null
  }
  if (request.type !== "invoke") throw new Error("MODS_REQUEST_INVALID")
  return runtime.invoke(request.registration ?? "", request.event ?? {}, async (method, input) => {
    if (replies.size >= 32) throw new Error("MODS_RPC_LIMIT")
    const id = randomUUID()
    const result = new Promise<ModJson>((resolve, reject) => {
      replies.set(id, { runtimeId: request.runtimeId, resolve, reject })
    })
    port.postMessage({
      type: "call",
      id,
      requestId: request.id,
      runtimeId: request.runtimeId,
      method,
      value: input
    })
    return result
  })
}

setInterval(() => {
  port.postMessage({ type: "heartbeat", value: { rss: process.memoryUsage().rss } })
}, 250).unref()
port.postMessage({ type: "ready" })

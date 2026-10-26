import { FunctionTrustedWaitClock } from "./trusted-function-wait"
import { prepareFunctionDisplayEnvelope } from "./display-preparation"
import { randomUUID } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { ModFunctionError, functionInvocationTimeoutMs, type FunctionHostReply } from "../../../shared/mods/v2/contracts"
import type { FunctionRequest, FunctionResponse } from "../../../shared/mods/v2/protocol"
import { FunctionGuestRuntime } from "./guest-runtime"
import { fromWireError, wireError } from "./wire"
import { functionGuestLoad, isFunctionGuestLoadFailure } from "./client-load-failure"
import { isFunctionGuestInvokeFailure } from "./guest-invoke-failure"
import type { FunctionUiResolveWireResponse } from "../../../shared/mods/v2/ui-resolve-wire"
import type { FunctionUiResolveWireCredit } from "../../../shared/mods/v2/ui-resolve-wire"
import { FunctionUiResolveUtilityAssembly } from "./ui-resolve-utility-assembly"

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
const uiAssemblies = new Map<string, {
  value: FunctionUiResolveUtilityAssembly
  runtimes: ReadonlySet<string>
}>()
const physicalUiIdentity = Object.freeze({})
const uiCredits = new Map<string, { assembly: string; runtimeId: string;
  resolve(credit: FunctionUiResolveWireCredit): void; reject(error: Error): void; detach(): void }>()
const frames = new Map<string, { runtimeId: string; controller: AbortController; waitClock?: FunctionTrustedWaitClock }>()
const replies = new Map<
  string,
  {
    runtimeId: string
    requestId?: string
    resolve(value: FunctionHostReply): void
    reject(error: Error): void
    detach(): void
  }
>()

port.on("message", ({ data: request }) => {
  if (request.type === "ui-resolve-credit-reply") {
    const pending = uiCredits.get(request.id)
    if (!pending || pending.assembly !== request.assembly ||
      pending.runtimeId !== request.runtimeId) return
    uiCredits.delete(request.id)
    pending.detach()
    if (request.error) pending.reject(fromWireError(request.error))
    else if (request.credit) pending.resolve(request.credit)
    else pending.reject(new ModFunctionError("MODS_UI_RESOLVE_QUOTA_INVALID"))
    return
  }
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
          error: wireError(error),
          ...(request.type === "load" && isFunctionGuestLoadFailure(error)
            ? { guestLoadFailure: true as const } : {}),
          ...(request.type === "invoke" && isFunctionGuestInvokeFailure(error)
            ? { guestInvokeFailure: true as const } : {})
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
  if (request.type === "trusted-wait") {
    const frame = frames.get(request.requestId)
    const call = replies.get(request.callId)
    if (!frame?.waitClock || frame.runtimeId !== request.runtimeId || frame.controller.signal.aborted ||
      call?.requestId !== request.requestId || call.runtimeId !== request.runtimeId)
      throw new ModFunctionError("MODS_TRUSTED_WAIT_SCOPE")
    if (request.phase === "begin" && typeof request.allowanceMs === "number")
      frame.waitClock.begin(request.ticket, request.allowanceMs)
    else if (request.phase === "end" && typeof request.creditMs === "number")
      frame.waitClock.end(request.ticket, request.creditMs)
    else throw new ModFunctionError("MODS_TRUSTED_WAIT_INVALID")
    return { acknowledged: true }
  }
  if (request.type === "prepare-ui-resolve") {
    if (uiAssemblies.size || frames.size >= 128 || !request.assembly ||
      !runtimes.has(request.runtimeId) || request.participants.length > 16)
      throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    const participants = request.participants.map(declaration => {
      const guest = runtimes.get(declaration.runtimeId)
      if (!guest) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
      return { runtimeId: declaration.runtimeId, guest, declaration,
        assertCurrent() {
          if (runtimes.get(declaration.runtimeId) !== guest || guest.stats.disposed)
            throw new ModFunctionError("MODS_UNLOADED")
        } }
    })
    const controller = new AbortController()
    frames.set(request.id, { runtimeId: request.runtimeId, controller })
    let value: FunctionUiResolveUtilityAssembly | undefined
    try {
      value = new FunctionUiResolveUtilityAssembly({ identity: physicalUiIdentity,
        assembly: request.assembly, requestId: request.id, participants,
        credit: request.credit, startupCutNs: request.startupCutNs,
        signal: controller.signal,
        host: {
          assertCurrent() {
            if (value ? uiAssemblies.get(request.assembly)?.value !== value
              : uiAssemblies.size > 0 || frames.get(request.id)?.controller !== controller)
              throw new ModFunctionError("MODS_UI_RESOLVE_RETIRED")
          },
          publish: message => port.postMessage(message),
          call: (runtime, registration, owner, method, args, signal) => forwardUiCall(
            owner.kind === "resolver" ? { type: "ui-resolver-call", assembly: request.assembly,
              runtimeId: runtime.runtimeId, registration: registration.id, requestId: owner.requestId }
              : { type: "ui-constructor-call", assembly: request.assembly,
                runtimeId: runtime.runtimeId, registration: registration.id, scopeId: owner.scopeId },
            method, args, signal),
          requestCredit: (limits, signal) => requestUiCredit(request.assembly,
            request.runtimeId, limits, signal)
        }
      })
      uiAssemblies.set(request.assembly, { value,
        runtimes: new Set(participants.map(peer => peer.runtimeId)) })
      return await value.prepare()
    } catch (error) {
      value?.retire()
      throw error
    } finally { frames.delete(request.id) }
  }
  if (["adopt-ui-resolve", "retire-ui-resolve", "ui-resolve-drawing-close",
    "ui-resolve-scope-close"].includes(request.type)) {
    if (!("assembly" in request)) throw new ModFunctionError("MODS_REQUEST_INVALID")
    const entry = uiAssemblies.get(request.assembly)
    if (!entry || !entry.runtimes.has(request.runtimeId))
      throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    if (request.type === "adopt-ui-resolve") entry.value.adopt(request.preparedToken)
    if (request.type === "retire-ui-resolve") entry.value.retire()
    if (request.type === "ui-resolve-drawing-close") entry.value.closeDrawing(request.token)
    if (request.type === "ui-resolve-scope-close") entry.value.closeScope(request.scopeId)
    return null
  }
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
      const guest = await functionGuestLoad(() =>
        FunctionGuestRuntime.create(request.code, request.options))
      guest.bindModuleHost(
        (method, args, signal, context) => forwardCall(request.runtimeId, undefined, method, args, signal, context),
        () => {
          for (const assembly of uiAssemblies.values())
            if (assembly.runtimes.has(request.runtimeId)) assembly.value.retire()
          if (runtimes.get(request.runtimeId) === guest) runtimes.delete(request.runtimeId)
          port.postMessage({ type: "disposed", runtimeId: request.runtimeId })
        }
      )
      runtimes.set(request.runtimeId, guest)
      return { registrations: guest.registrations,
        registrationQuiescent: guest.registrationQuiescent,
        displayPreparation: prepareFunctionDisplayEnvelope(guest, request.code, request.runtimeId) } as unknown as ModJson
    } finally {
      loading.delete(request.runtimeId)
    }
  }
  const guest = runtimes.get(request.runtimeId)
  if (!guest) throw new ModFunctionError("MODS_RUNTIME_MISSING")
  if (request.type === "dispose") {
    for (const assembly of uiAssemblies.values())
      if (assembly.runtimes.has(request.runtimeId)) assembly.value.retire()
    guest.dispose()
    runtimes.delete(request.runtimeId)
    return null
  }
  if (request.type === "match") return guest.matches(request.registration, request.event)
  if (request.type === "release-ui") {
    guest.releaseUi(request.generation)
    return null
  }
  if (request.type === "release-resource") {
    guest.releaseResource(request.handle)
    return null
  }
  if (request.type === "release-stream-cursor") {
    guest.releaseStreamCursor(request.handle)
    return null
  }
  if (request.type !== "invoke") throw new ModFunctionError("MODS_REQUEST_INVALID")
  if (frames.size >= 128) throw new ModFunctionError("MODS_HOST_CAPACITY")
  const controller = new AbortController()
  const waitClock = new FunctionTrustedWaitClock(functionInvocationTimeoutMs(request.metadata))
  frames.set(request.id, { runtimeId: request.runtimeId, controller, waitClock })
  try {
    return await guest.invoke(
      request.registration,
      request.event,
      (method, args, signal) => forwardCall(request.runtimeId, request.id, method, args, signal),
      { ...request.metadata, signal: controller.signal }, request.uiDrawing, waitClock
    )
  } finally {
    frames.delete(request.id)
    if (guest.stats.disposed && runtimes.get(request.runtimeId) === guest) {
      runtimes.delete(request.runtimeId)
      port.postMessage({ type: "disposed", runtimeId: request.runtimeId })
    }
  }
}

function requestUiCredit(assembly: string, runtimeId: string,
  limits: FunctionUiResolveWireCredit["limits"], signal: AbortSignal):
  Promise<FunctionUiResolveWireCredit> {
  if (signal.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
  if (uiCredits.size >= 32) return Promise.reject(new ModFunctionError("MODS_RPC_LIMIT"))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cancel = () => {
      if (!uiCredits.delete(id)) return
      signal.removeEventListener("abort", cancel)
      reject(new ModFunctionError("MODS_CANCELLED"))
    }
    uiCredits.set(id, { assembly, runtimeId, resolve, reject,
      detach: () => signal.removeEventListener("abort", cancel) })
    signal.addEventListener("abort", cancel, { once: true })
    port.postMessage({ type: "ui-resolve-credit-request", assembly, id, limits })
    if (signal.aborted) cancel()
  })
}

function forwardCall(
  runtimeId: string,
  requestId: string | undefined,
  method: string,
  args: ModJson,
  signal: AbortSignal,
  context?: { dispatchCutNs: string }
): Promise<FunctionHostReply> {
  if (signal.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
  if (replies.size >= 512) return Promise.reject(new ModFunctionError("MODS_RPC_LIMIT"))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      if (!replies.delete(id)) return
      signal.removeEventListener("abort", cancel)
      port.postMessage(
        requestId === undefined
          ? { type: "module-revoke", id, runtimeId }
          : { type: "revoke", id, runtimeId, requestId }
      )
      reject(
        new ModFunctionError(requestId === undefined ? "MODS_UNLOADED" : "MODS_INVOCATION_ENDED")
      )
    }
    replies.set(id, {
      runtimeId,
      requestId,
      resolve,
      reject,
      detach: () => signal.removeEventListener("abort", cancel)
    })
    signal.addEventListener("abort", cancel, { once: true })
    port.postMessage(
      requestId === undefined
        ? { type: "module-call", id, runtimeId, method, args, ...context }
        : { type: "call", id, requestId, runtimeId, method, args }
    )
  })
}

/** Private constructor/initialization channel, with the same bounded native reply map. */
function forwardUiCall(
  owner: Omit<Extract<FunctionUiResolveWireResponse, { type: "ui-constructor-call" }>,
    "id" | "method" | "args"> |
    Omit<Extract<FunctionUiResolveWireResponse, { type: "ui-resolver-call" }>,
      "id" | "method" | "args">,
  method: string,
  args: ModJson,
  signal: AbortSignal
): Promise<FunctionHostReply> {
  if (signal.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
  if (replies.size >= 512) return Promise.reject(new ModFunctionError("MODS_RPC_LIMIT"))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      if (!replies.delete(id)) return
      signal.removeEventListener("abort", cancel)
      port.postMessage({ type: "ui-resolve-call-revoke", assembly: owner.assembly, id,
        runtimeId: owner.runtimeId, registration: owner.registration })
      reject(new ModFunctionError("MODS_CANCELLED"))
    }
    replies.set(id, { runtimeId: owner.runtimeId, resolve, reject,
      detach: () => signal.removeEventListener("abort", cancel) })
    signal.addEventListener("abort", cancel, { once: true })
    // The owner fields are native assembly facts; ordinary guest metadata never selects P/Q.
    port.postMessage({ ...owner, id, method, args })
    if (signal.aborted) cancel()
  })
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

import { createHash } from "node:crypto"
import { nativeConversationFairness } from "./function-conversation-native-fairness"
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages"
import type { ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  validateFunctionSessionAppendInput,
  validateFunctionSessionAppendOrigin,
  type FunctionSessionAppendDoor,
  type FunctionSessionAppendInput,
  type FunctionSessionAppendOrigin,
  type FunctionSessionAppendResult
} from "../../shared/mods/v2/session-append"
import type { FunctionConversationRow } from "../db/function-conversation-store"
import type { FunctionConversationTarget } from "../mods/v2/conversation-registry"
import {
  FunctionSessionAppendTicket,
  type FunctionSessionAppendCommitPlan
} from "../mods/v2/session-append-ticket"
import {
  deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage
} from "./function-conversation-native-message"
import { fixedFunctionConversationNativeFacts } from "./function-conversation-native-rendering"

export interface FunctionNativeRetentionCandidate {
  readonly target: FunctionConversationTarget
  /** The real capture/adopter's private object, not a serialized row or SDK token. */
  readonly projectionOwner: object
  readonly producer: object
  readonly native: BaseMessage
  readonly nativePayload: string
  readonly rendering: ModObject
  readonly uuid: string
  readonly inputDigest: string
  readonly door: FunctionSessionAppendDoor
  readonly origin: FunctionSessionAppendOrigin
}

/** These methods are installed by the actual native producer/keeper factory. */
export interface FunctionNativeRetentionHost {
  /** Seal synchronously before the first await, then strictly flush and capture actual DB facts. */
  captureProjection(): object | Promise<object>
  protectNative(message: BaseMessage, signal: AbortSignal, guard: () => void): Promise<BaseMessage>
  /** Complete native rendering; public availability is checked separately below. */
  project(message: BaseMessage): ModObject
  apply(message: BaseMessage, rendering: ModObject): BaseMessage
  /** Bound to FunctionModsManager.appendConversation; never a cold session loader. */
  dispatch(ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult>
  prepare(
    candidate: FunctionNativeRetentionCandidate,
    signal: AbortSignal,
    guard: () => void
  ): Promise<FunctionSessionAppendCommitPlan>
}

export interface FunctionNativeRetainerOptions {
  readonly message: BaseMessage
  readonly target: FunctionConversationTarget
  readonly producer: object
  readonly signal: AbortSignal
  readonly door: Exclude<FunctionSessionAppendDoor, "note">
  readonly origin: FunctionSessionAppendOrigin
  readonly agentId?: string
  readonly host: FunctionNativeRetentionHost
  /** Check the original source and this target in full, including after every host await. */
  assertCurrent(): void
}

export interface FunctionRetainedNativeMessage {
  readonly message: BaseMessage
  readonly row: FunctionConversationRow
  readonly publicAvailability: "bounded" | "limit" | "unrepresentable"
}

function fail(code = "MODS_CONVERSATION_NATIVE_RETENTION_INVALID"): never {
  throw new ModFunctionError(code)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const a = record(left), b = record(right), keys = Object.keys(a)
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

function executionIdentity(message: BaseMessage): unknown {
  return { type: message.getType(), id: message.id, name: message.name,
    ...(ToolMessage.isInstance(message) ? {
      call: message.tool_call_id, status: message.status
    } : {}),
    ...(AIMessage.isInstance(message) ? {
      calls: (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.name }))
    } : {}) }
}

function fixedNativeData(payload: string): unknown {
  return fixedFunctionConversationNativeFacts(payload)
}

function sameRow(left: FunctionConversationRow, right: FunctionConversationRow): boolean {
  return left.uuid === right.uuid && left.sequence === right.sequence &&
    left.receiptId === right.receiptId && left.branchId === right.branchId &&
    left.inputDigest === right.inputDigest && left.door === right.door &&
    left.nativePayload === right.nativePayload && left.createdAt === right.createdAt &&
    left.inbox === right.inbox && left.bytes === right.bytes && equal(left.origin, right.origin) &&
    equal(left.message, right.message) && equal(left.orderAnchor, right.orderAnchor)
}

function deferred<T>() {
  let resolve: (value: T) => void = () => fail("MODS_CONVERSATION_NATIVE_RETENTION_INIT")
  let reject: (error: unknown) => void = () => fail("MODS_CONVERSATION_NATIVE_RETENTION_INIT")
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** One native occurrence. Persistence, adoption and full protection remain real host capabilities. */
export class FunctionConversationNativeRetainer {
  private readonly uuid: string
  private readonly originalPayload: string
  private readonly originalIdentity: unknown
  private readonly origin: FunctionSessionAppendOrigin
  private readonly signal: AbortSignal
  private readonly guard: () => void
  private once?: Promise<FunctionRetainedNativeMessage>
  private readonly yieldPhase: () => Promise<void>

  constructor(private readonly options: FunctionNativeRetainerOptions) {
    this.originalPayload = serializeFunctionConversationNativeMessage(options.message)
    if (typeof options.message.id !== "string" || !options.message.id) fail()
    this.uuid = options.message.id
    this.originalIdentity = executionIdentity(options.message)
    validateFunctionSessionAppendOrigin(options.origin)
    this.origin = copy(options.origin)
    const host = options.host
    this.options = Object.freeze({ ...options, origin: this.origin, host: Object.freeze({
      captureProjection: host.captureProjection.bind(host),
      protectNative: host.protectNative.bind(host), project: host.project.bind(host),
      apply: host.apply.bind(host), dispatch: host.dispatch.bind(host), prepare: host.prepare.bind(host)
    }) })
    this.signal = AbortSignal.any([options.signal, options.target.signal])
    this.guard = options.assertCurrent.bind(options)
    this.yieldPhase = nativeConversationFairness(this.signal, () => this.assertOriginal())
    this.assertCurrent()
    // Validate fixed public facts independently of the possibly oversized native content.
    validateFunctionSessionAppendInput({ uuid: this.uuid, door: options.door,
      origin: this.origin, ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      message: { type: "user", role: "user", content: [] } })
  }

  private assertCurrent(): void {
    this.signal.throwIfAborted()
    this.guard()
  }

  private assertOriginal(): void {
    this.assertCurrent()
    if (serializeFunctionConversationNativeMessage(this.options.message) !== this.originalPayload)
      fail("MODS_CONVERSATION_NATIVE_MESSAGE_CHANGED")
  }

  retain(): Promise<FunctionRetainedNativeMessage> {
    if (this.once) return this.once
    const result = deferred<FunctionRetainedNativeMessage>()
    this.once = result.promise
    try {
      this.assertOriginal()
      // The factory's synchronous seal runs now, after once installation and before any await.
      const projection = this.options.host.captureProjection()
      void this.run(projection).then(result.resolve, result.reject)
    } catch (error) { result.reject(error) }
    return result.promise
  }

  private input(rendering: ModObject): ModObject {
    return { uuid: this.uuid, door: this.options.door, origin: copy(this.origin),
      ...(this.options.agentId === undefined ? {} : { agentId: this.options.agentId }),
      message: copy(rendering) }
  }

  private async protectedNative(message: BaseMessage): Promise<BaseMessage> {
    this.assertOriginal()
    const safe = await this.options.host.protectNative(message, this.signal, () => this.assertCurrent())
    await this.yieldPhase()
    this.assertOriginal()
    serializeFunctionConversationNativeMessage(safe)
    if (!equal(executionIdentity(safe), this.originalIdentity))
      fail("MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED")
    return safe
  }

  private candidate(
    native: BaseMessage, rendering: ModObject, inputDigest: string, projectionOwner: object
  ): FunctionNativeRetentionCandidate {
    const payload = serializeFunctionConversationNativeMessage(native)
    return Object.freeze({ target: this.options.target, producer: this.options.producer,
      projectionOwner, native, nativePayload: payload, rendering: copy(rendering),
      uuid: this.uuid, inputDigest, door: this.options.door, origin: copy(this.origin) })
  }

  private async prepare(candidate: FunctionNativeRetentionCandidate):
    Promise<FunctionSessionAppendCommitPlan> {
    this.assertOriginal()
    const raw = await this.options.host.prepare(candidate, this.signal, () => this.assertCurrent())
    await this.yieldPhase()
    this.assertOriginal()
    if (serializeFunctionConversationNativeMessage(candidate.native) !== candidate.nativePayload)
      fail("MODS_CONVERSATION_NATIVE_MESSAGE_CHANGED")
    return Object.freeze({ commit: raw.commit.bind(raw), read: raw.read.bind(raw) })
  }

  private verified(plan: FunctionSessionAppendCommitPlan, candidate: FunctionNativeRetentionCandidate,
    returned: FunctionConversationRow): FunctionConversationRow {
    const saved = plan.read()
    if (!saved || !sameRow(saved, returned) || saved.uuid !== candidate.uuid ||
      saved.branchId !== candidate.target.ref.branchId || saved.door !== candidate.door ||
      saved.inputDigest !== candidate.inputDigest || saved.nativePayload !== candidate.nativePayload ||
      !equal(saved.origin, candidate.origin) || !equal(saved.message, candidate.rendering) ||
      !saved.receiptId || !Number.isSafeInteger(saved.sequence) || saved.sequence < 1 ||
      !Number.isSafeInteger(saved.bytes) || saved.bytes < 1 ||
      !Number.isSafeInteger(saved.createdAt) || saved.createdAt < 0 || saved.inbox)
      fail("MODS_SESSION_APPEND_NOT_COMMITTED")
    this.assertOriginal()
    return saved
  }

  private async run(projection: object | Promise<object>): Promise<FunctionRetainedNativeMessage> {
    const owner = await projection
    await this.yieldPhase()
    this.assertOriginal()
    if (!owner || typeof owner !== "object") fail()
    const safe = await this.protectedNative(this.options.message)
    const safePayload = serializeFunctionConversationNativeMessage(safe)
    const safeFacts = fixedNativeData(safePayload)
    const rendering = copy(this.options.host.project(safe))
    this.assertOriginal()
    const expectedType = safe.getType() === "ai" ? "assistant"
      : safe.getType() === "system" ? "system" : "user"
    if (rendering.type !== expectedType &&
      !(rendering.type === "attachment" && ["human", "system"].includes(safe.getType())))
      fail("MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED")
    if (ToolMessage.isInstance(safe) && (rendering.isMeta === true ||
      !Array.isArray(rendering.content) || rendering.content.length !== 1 ||
      !rendering.content[0] || typeof rendering.content[0] !== "object" ||
      Array.isArray(rendering.content[0]) || rendering.content[0].type !== "tool_result" ||
      rendering.content[0].tool_use_id !== safe.tool_call_id))
      fail("MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED")
    const input = this.input(rendering)
    // Only content representability/limits can make the Hook unavailable; fixed facts stay strict.
    validateFunctionSessionAppendInput({ ...input, message: { ...rendering,
      content: rendering.type === "system" ? [{ type: "text", text: "" }] : [] } })
    let available: FunctionSessionAppendInput | undefined
    let availability: FunctionRetainedNativeMessage["publicAvailability"] = "bounded"
    try { validateFunctionSessionAppendInput(input); available = input }
    catch (error) {
      const code = error instanceof ModFunctionError ? error.code
        : error instanceof Error ? error.message : undefined
      if (["MODS_SESSION_APPEND_LIMIT", "MODS_JSON_SIZE", "MODS_JSON_DEPTH", "MODS_JSON_NODES"]
        .includes(code ?? "")) availability = "limit"
      else if (code === "MODS_SESSION_APPEND_INVALID") availability = "unrepresentable"
      else throw error
    }
    if (!available) {
      const digest = createHash("sha256").update(JSON.stringify({ input,
        nativePayload: safePayload })).digest("hex")
      const candidate = this.candidate(safe, rendering, digest, owner)
      const plan = await this.prepare(candidate)
      this.assertOriginal()
      const row = this.verified(plan, candidate, plan.commit(() => this.assertCurrent()))
      return { message: deserializeFunctionConversationNativeMessage(row.nativePayload), row,
        publicAvailability: availability }
    }
    let candidate: FunctionNativeRetentionCandidate | undefined
    let plan: FunctionSessionAppendCommitPlan | undefined
    const ticket = new FunctionSessionAppendTicket({ kind: "native", input: available,
      target: this.options.target, signal: this.signal, assertCurrent: () => this.assertCurrent(),
      protect: async input => {
        const applied = this.options.host.apply(safe, input.message)
        const appliedPayload = serializeFunctionConversationNativeMessage(applied)
        if (!equal(fixedNativeData(appliedPayload), safeFacts))
          fail("MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED")
        const protectedMessage = await this.protectedNative(applied)
        const payload = serializeFunctionConversationNativeMessage(protectedMessage)
        if (!equal(fixedNativeData(payload), safeFacts))
          fail("MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED")
        candidate = this.candidate(protectedMessage, this.options.host.project(protectedMessage),
          ticket.inputDigest, owner)
        return { ...input, message: copy(candidate.rendering) }
      },
      prepare: async input => {
        if (!candidate || !equal(candidate.rendering, input.message)) fail()
        plan = await this.prepare(candidate)
        return plan
      } })
    const returned = await this.options.host.dispatch(ticket)
    await this.yieldPhase()
    this.assertOriginal()
    try { ticket.acceptResult(returned) }
    catch {
      this.assertOriginal()
      // Native deny/fake success is not storage. This same ticket core may run only once.
      ticket.acceptResult(await ticket.core(ticket.input))
    }
    const row = ticket.committedRow
    if (!row || !candidate || !plan) fail("MODS_SESSION_APPEND_NOT_COMMITTED")
    const saved = this.verified(plan, candidate, row)
    return { message: deserializeFunctionConversationNativeMessage(saved.nativePayload), row: saved,
      publicAvailability: "bounded" }
  }
}

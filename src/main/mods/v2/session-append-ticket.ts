import { createHash } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  normalizeFunctionSessionAppendInput,
  validateFunctionSessionAppendArgs,
  validateFunctionSessionAppendInput,
  validateFunctionSessionAppendResultShape,
  type FunctionSessionAppendInput,
  type FunctionSessionAppendResult
} from "../../../shared/mods/v2/session-append"
import type { FunctionConversationRow } from "../../db/function-conversation-store"
import type {
  FunctionConversationMutationSource,
  FunctionConversationTarget
} from "./conversation-registry"

/** These closures are native capabilities, never fields on the public Hook event. */
export interface FunctionSessionAppendCommitPlan {
  commit(assertCurrent: () => void): FunctionConversationRow
  /** Strictly join the canonical native row and its complete saved receipt, not a write count. */
  read(): FunctionConversationRow | undefined
}

export interface FunctionSessionAppendTicketOptions {
  readonly kind: "sdk" | "native"
  readonly input: FunctionSessionAppendInput
  readonly target: FunctionConversationTarget
  readonly source?: FunctionConversationMutationSource
  readonly signal: AbortSignal
  /** Native callers must check the original source and this target in full. */
  assertCurrent(): void
  protect(
    input: FunctionSessionAppendInput,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<unknown>
  prepare(
    input: FunctionSessionAppendInput,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<FunctionSessionAppendCommitPlan>
}

function fail(code: string): never {
  throw new ModFunctionError(code)
}

function copyJson<T extends ModJson>(value: T): T {
  // All callers first validate the public projection or read native stored data.
  return JSON.parse(JSON.stringify(value)) as T
}

function freezeJson<T extends ModJson>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item)
    Object.freeze(value)
  }
  return value
}

function equalJson(left: ModJson, right: ModJson): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

function sameRow(left: FunctionConversationRow, right: FunctionConversationRow): boolean {
  return left.uuid === right.uuid && left.sequence === right.sequence &&
    left.receiptId === right.receiptId && left.branchId === right.branchId &&
    left.inputDigest === right.inputDigest && left.door === right.door &&
    left.nativePayload === right.nativePayload && left.createdAt === right.createdAt &&
    left.inbox === right.inbox && left.bytes === right.bytes &&
    equalJson(left.message, right.message) && equalJson(left.origin, right.origin) &&
    equalJson(left.orderAnchor, right.orderAnchor)
}

function validateSdkMessage(input: FunctionSessionAppendInput): void {
  validateFunctionSessionAppendArgs({ message: {
    type: input.message.type, content: input.message.content
  } })
}

/** One actual row admission. A public success shape is never evidence of a saved row. */
export class FunctionSessionAppendTicket {
  readonly input: FunctionSessionAppendInput
  readonly inputDigest: string
  readonly signal: AbortSignal
  private readonly target: FunctionConversationTarget
  private readonly source?: FunctionConversationMutationSource
  private readonly checkHost: () => void
  private readonly protect: FunctionSessionAppendTicketOptions["protect"]
  private readonly prepare: FunctionSessionAppendTicketOptions["prepare"]
  private readonly canDeny: boolean
  private once?: Promise<FunctionSessionAppendResult>
  private plan?: FunctionSessionAppendCommitPlan
  private saved?: FunctionConversationRow
  private denied?: string
  private commitStarted = false

  constructor(options: FunctionSessionAppendTicketOptions) {
    validateFunctionSessionAppendInput(options.input)
    if (options.kind === "sdk" && (!options.source || options.input.door !== "note" ||
      options.input.origin.kind !== "plugin" || typeof options.input.origin.name !== "string" ||
      Object.hasOwn(options.input.origin, "asUser") ||
      !["user", "system"].includes(options.input.message.type) ||
      (options.input.message.type === "user" &&
        (options.input.message.role !== "user" || options.input.message.isMeta !== true))))
      fail("MODS_SESSION_APPEND_SOURCE")
    if (options.kind === "sdk") validateSdkMessage(options.input)
    this.input = freezeJson(copyJson(options.input))
    this.inputDigest = createHash("sha256").update(encodeModJson(this.input)).digest("hex")
    this.target = options.target
    this.source = options.source ? Object.freeze({ ...options.source,
      assertCurrent: options.source.assertCurrent.bind(options.source) }) : undefined
    this.signal = AbortSignal.any([options.signal, options.target.signal,
      ...(this.source ? [this.source.signal] : [])])
    this.checkHost = options.assertCurrent.bind(options)
    this.protect = options.protect.bind(options)
    this.prepare = options.prepare.bind(options)
    this.canDeny = options.kind === "sdk"
    this.assertCurrent()
  }

  assertCurrent(): void {
    this.signal.throwIfAborted()
    this.source?.assertCurrent()
    if (this.canDeny) this.target.assertCurrent()
    this.checkHost()
    if (this.denied !== undefined) fail("MODS_SESSION_APPEND_DENIED")
  }

  normalizeInput(candidate: unknown): FunctionSessionAppendInput {
    this.assertCurrent()
    const normalized = normalizeFunctionSessionAppendInput(candidate, this.input)
    // A note must remain readable by the actual inbox serializer, including after a Hook.
    if (this.canDeny) validateSdkMessage(normalized)
    return normalized
  }

  /** Invalid candidates fail synchronously before claiming the once core. */
  core(candidate: unknown): Promise<FunctionSessionAppendResult> {
    const normalized = this.normalizeInput(candidate)
    if (!this.once) {
      const admitted = freezeJson(copyJson(normalized))
      // Install the once Promise before invoking any host closure that could reenter next().
      this.once = Promise.resolve().then(() => this.commit(admitted))
    }
    return this.once
  }

  private async commit(input: FunctionSessionAppendInput): Promise<FunctionSessionAppendResult> {
    this.assertCurrent()
    const protectedInput = await this.protect(input, this.signal, () => this.assertCurrent())
    this.assertCurrent()
    const normalized = normalizeFunctionSessionAppendInput(protectedInput, input)
    if (this.canDeny) validateSdkMessage(normalized)
    const safe = freezeJson(normalized)
    const prepared = await this.prepare(safe, this.signal, () => this.assertCurrent())
    this.assertCurrent()
    const plan = Object.freeze({ commit: prepared.commit.bind(prepared),
      read: prepared.read.bind(prepared) })
    this.plan = plan
    // No await from the final native guard through commit and complete stored-row verification.
    this.assertCurrent()
    this.commitStarted = true
    const returned = plan.commit(() => this.assertCurrent())
    const stored = plan.read()
    if (!stored || !sameRow(returned, stored) || stored.uuid !== safe.uuid ||
      stored.branchId !== this.target.ref.branchId || stored.door !== safe.door ||
      stored.inputDigest !== this.inputDigest || !equalJson(stored.origin, safe.origin) ||
      !equalJson(stored.message, safe.message) || !stored.receiptId ||
      !Number.isSafeInteger(stored.sequence) || stored.sequence < 1 ||
      !Number.isSafeInteger(stored.bytes) || stored.bytes < 1 ||
      !Number.isSafeInteger(stored.createdAt) || stored.createdAt < 0)
      fail("MODS_SESSION_APPEND_NOT_COMMITTED")
    // Keep this actual fact even if the original owner expires before the public ACK.
    this.saved = Object.freeze({ ...stored, origin: freezeJson(copyJson(stored.origin)),
      message: freezeJson(copyJson(stored.message)),
      orderAnchor: freezeJson(copyJson(stored.orderAnchor)) })
    this.assertCurrent()
    return { message: copyJson(safe.message), uuid: stored.uuid }
  }

  acceptResult(candidate: unknown): FunctionSessionAppendResult {
    // A denied ticket still validates the original source/target; it never changes owner.
    this.signal.throwIfAborted()
    this.source?.assertCurrent()
    if (this.canDeny) this.target.assertCurrent()
    this.checkHost()
    validateFunctionSessionAppendResultShape(candidate)
    const deny = candidate.deny
    if (typeof deny === "string") {
      if (!this.canDeny || this.commitStarted || this.saved)
        fail("MODS_SESSION_APPEND_DENY")
      if (this.denied !== undefined && this.denied !== deny)
        fail("MODS_SESSION_APPEND_DENY")
      this.denied = deny
      return { deny }
    }
    if (this.denied !== undefined) fail("MODS_SESSION_APPEND_DENIED")
    const stored = this.plan?.read()
    if (!this.saved || !stored || !sameRow(stored, this.saved) ||
      candidate.uuid !== stored.uuid || !equalJson(candidate.message ?? null, stored.message))
      fail("MODS_SESSION_APPEND_RESULT")
    this.assertCurrent()
    const result = { message: copyJson(stored.message), uuid: stored.uuid }
    validateFunctionSessionAppendResultShape(result)
    return result
  }

  /** Already verified durable data, not a permission receipt or an ACK to a stale caller. */
  get committedRow(): FunctionConversationRow | undefined {
    return this.saved
  }
}

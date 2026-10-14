import { ModFunctionError } from "./contracts"
import {
  FUNCTION_SESSION_APPEND_DOORS,
  validateFunctionSessionAppendOrigin,
  type FunctionSessionAppendDoor,
  type FunctionSessionAppendOrigin
} from "./session-append"

export const FUNCTION_CONVERSATION_TRANSCRIPT_KEY = "function_row"
export const FUNCTION_CONVERSATION_TRANSCRIPT_INVALID_KEY = "function_row_invalid"

/** A durable host-produced data stamp. It is never an invocation or permission proof. */
export interface FunctionConversationTranscriptStamp {
  conversationId: string
  branchId: string
  uuid: string
  sequence: number
  door: FunctionSessionAppendDoor
  messageType: "user" | "assistant" | "attachment" | "system"
  isMeta?: true
  origin: FunctionSessionAppendOrigin
}

const FIELDS = ["conversationId", "branchId", "uuid", "sequence", "door", "messageType",
  "isMeta", "origin"]

function invalid(): never {
  throw new ModFunctionError("MODS_CONVERSATION_TRANSCRIPT_INVALID")
}

function own(value: unknown, key: string): { present: boolean; value?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { present: false }
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field ? { present: true, value: "value" in field ? field.value : undefined } :
    { present: false }
}

export function validateFunctionConversationTranscriptStamp(value: unknown):
  asserts value is FunctionConversationTranscriptStamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) invalid()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !FIELDS.includes(key)) invalid()
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field) || !field.enumerable) invalid()
  }
  for (const key of ["conversationId", "branchId", "uuid"]) {
    const item = own(value, key).value
    if (typeof item !== "string" || !item.trim()) invalid()
  }
  const sequence = own(value, "sequence").value
  if (!Number.isSafeInteger(sequence) || typeof sequence !== "number" || sequence < 1) invalid()
  const door = own(value, "door").value
  if (typeof door !== "string" ||
    !FUNCTION_SESSION_APPEND_DOORS.some((item) => item === door)) invalid()
  const type = own(value, "messageType").value
  if (typeof type !== "string" || !["user", "assistant", "attachment", "system"].includes(type))
    invalid()
  const meta = own(value, "isMeta")
  if (meta.present && meta.value !== true) invalid()
  validateFunctionSessionAppendOrigin(own(value, "origin").value)
}

export function isFunctionConversationTranscriptStamp(value: unknown):
  value is FunctionConversationTranscriptStamp {
  try { validateFunctionConversationTranscriptStamp(value); return true }
  catch { return false }
}

/** Key ordering is irrelevant; all allowed provenance fields are primitive data. */
export function sameFunctionConversationTranscriptStamp(
  first: FunctionConversationTranscriptStamp,
  second: FunctionConversationTranscriptStamp
): boolean {
  return first.conversationId === second.conversationId && first.branchId === second.branchId &&
    first.uuid === second.uuid && first.sequence === second.sequence && first.door === second.door &&
    first.messageType === second.messageType && first.isMeta === second.isMeta &&
    Object.keys(first.origin).length === Object.keys(second.origin).length &&
    Object.keys(first.origin).every((key) => first.origin[key] === second.origin[key])
}

type TranscriptStampRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; stamp: FunctionConversationTranscriptStamp }

function inspectTranscriptStamp(message: unknown): TranscriptStampRead {
  const kwargs = own(message, "kwargs").value
  const sources = [message, own(message, "additional_kwargs").value,
    own(kwargs, "additional_kwargs").value]
  let stamp: FunctionConversationTranscriptStamp | undefined
  for (const source of sources) {
    // Host hydration preserves this fact even when the stored JSON cannot be decoded.
    // A malformed/copied false flag is not allowed to turn a damaged row into a legacy row.
    if (own(source, FUNCTION_CONVERSATION_TRANSCRIPT_INVALID_KEY).present)
      return { kind: "invalid" }
    const field = own(source, FUNCTION_CONVERSATION_TRANSCRIPT_KEY)
    if (!field.present) continue
    if (!isFunctionConversationTranscriptStamp(field.value) ||
      (stamp && !sameFunctionConversationTranscriptStamp(stamp, field.value)))
      return { kind: "invalid" }
    stamp = field.value
  }
  return stamp ? { kind: "valid", stamp } : { kind: "absent" }
}

/** Supports durable rows, live LangChain instances and their actual checkpoint serialization. */
export function readFunctionConversationTranscriptStamp(message: unknown):
  FunctionConversationTranscriptStamp | undefined {
  const result = inspectTranscriptStamp(message)
  return result.kind === "valid" ? result.stamp : undefined
}

/** A damaged native marker is not an old unmarked row or a recovery authorization. */
export function hasInvalidFunctionConversationTranscriptStamp(message: unknown): boolean {
  return inspectTranscriptStamp(message).kind === "invalid"
}

/** Data-only projection for hydration and stream bridges; never drops an invalid native marker. */
export function functionConversationTranscriptFields(message: unknown, actualUuid?: string,
  actualRole?: string
): {
  function_row?: FunctionConversationTranscriptStamp
  function_row_invalid?: true
} {
  const result = inspectTranscriptStamp(message)
  if (result.kind === "invalid" || (result.kind === "valid" && actualRole !== undefined &&
    (typeof actualUuid !== "string" || !actualUuid.trim())) ||
    (result.kind === "valid" && actualUuid !== undefined &&
    result.stamp.uuid !== actualUuid) || (result.kind === "valid" && actualRole !== undefined &&
    ((result.stamp.door === "note" && result.stamp.messageType === "user" &&
      actualRole !== "user" && actualRole !== "human") ||
      (result.stamp.messageType === "system" && actualRole !== "system"))))
    return { function_row_invalid: true }
  return result.kind === "valid" ? { function_row: result.stamp } : {}
}

export function conflictingFunctionConversationTranscriptStamps(first: unknown,
  second: unknown
): boolean {
  const baseline = readFunctionConversationTranscriptStamp(first)
  const incoming = readFunctionConversationTranscriptStamp(second)
  return !!baseline && !!incoming && !sameFunctionConversationTranscriptStamp(baseline, incoming)
}

export function isFunctionConversationHiddenNote(message: unknown): boolean {
  const stamp = readFunctionConversationTranscriptStamp(message)
  return stamp?.door === "note" && stamp.messageType === "user" && stamp.isMeta === true
}

/** Selects a strict provider System recovery path; this data classification grants no access. */
export function isFunctionConversationToolSystemSide(message: unknown): boolean {
  const stamp = readFunctionConversationTranscriptStamp(message)
  return stamp?.messageType === "system" && stamp.door === "tool-message" &&
    stamp.origin.kind === "tool" && stamp.isMeta === undefined
}

export function isFunctionConversationNotice(message: unknown): boolean {
  const stamp = readFunctionConversationTranscriptStamp(message)
  // Actual Tool System sides retain their provider class. SDK/engine notices remain UI-only.
  return stamp?.messageType === "system" && !isFunctionConversationToolSystemSide(message)
}

/** Preserve native provenance when an older live/checkpoint projection omits it. */
export function mergeFunctionConversationTranscriptStamp(first: unknown, second: unknown):
  FunctionConversationTranscriptStamp | undefined {
  const baseline = readFunctionConversationTranscriptStamp(first)
  const incoming = readFunctionConversationTranscriptStamp(second)
  // Never classify one native row using a different conversation/branch occurrence.
  if (baseline && incoming && !sameFunctionConversationTranscriptStamp(baseline, incoming))
    return baseline
  return incoming ?? baseline
}

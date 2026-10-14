import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  type FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import { readFunctionConversationNativeToolHuman, readFunctionConversationNativeToolHumanCurrent,
  type FunctionNativeToolHumanReceipt } from
  "../agent/function-conversation-native-tool-human"

import { readFunctionNativeHumanCandidateCurrent } from "../agent/function-conversation-native-human-presentation"

const brand = Symbol("native-human-projection")
export interface FunctionNativeHumanProjectionVariant { readonly [brand]: true }
export interface FunctionNativeHumanProjectionContext {
  readonly producer: object
  readonly run: object
  readonly occurrence: object
  readonly target: FunctionConversationRef
  readonly threadId: string
  readonly uuid: string
}
interface Variant extends FunctionNativeHumanProjectionContext {
  readonly kind?: "tool-side"
  readonly transcript?: {
    readonly baseline: FunctionConversationProjectionColumns | undefined
    readonly freshColumns: FunctionConversationProjectionColumns | undefined
  }
  assertCurrent(): void
  assertCandidate(row: FunctionConversationRow): void
}
const variants = new WeakMap<FunctionNativeHumanProjectionVariant, Variant & { readonly pairedCandidate?: true }>()
const apply = Reflect.apply
const nativeThen = Promise.prototype.then

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_HUMAN_PROJECTION_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) fail()
  return value
}
function ref(value: FunctionConversationRef): FunctionConversationRef {
  if (types.isProxy(value) || Reflect.ownKeys(value).length !== 8) fail()
  const incarnation = own(value, "incarnation")
  if (!incarnation || typeof incarnation !== "object" || types.isProxy(incarnation) ||
    Reflect.ownKeys(incarnation).length !== 2) fail()
  const token = own(incarnation, "token"), createdAt = own(incarnation, "legacyCreatedAt")
  if ((token !== null && (typeof token !== "string" || !token)) ||
    typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) fail()
  const kind = own(value, "kind"), namespace = own(value, "checkpointNamespace")
  if ((kind !== "main" && kind !== "child") || typeof namespace !== "string") fail()
  return Object.freeze({ logicalSessionId: text(own(value, "logicalSessionId")),
    conversationId: text(own(value, "conversationId")), branchId: text(own(value, "branchId")),
    threadId: text(own(value, "threadId")), workspace: text(own(value, "workspace")),
    kind: kind === "main" ? "main" : "child", checkpointNamespace: namespace,
    incarnation: Object.freeze({ token, legacyCreatedAt: createdAt }) })
}
function same(a: FunctionConversationRef, b: FunctionConversationRef): boolean {
  return a.logicalSessionId === b.logicalSessionId && a.conversationId === b.conversationId &&
    a.branchId === b.branchId && a.threadId === b.threadId && a.workspace === b.workspace &&
    a.kind === b.kind && a.checkpointNamespace === b.checkpointNamespace &&
    a.incarnation.token === b.incarnation.token &&
    a.incarnation.legacyCreatedAt === b.incarnation.legacyCreatedAt
}
function synchronous(value: unknown): void {
  if (value === undefined) return
  if (value && typeof value === "object" && !types.isProxy(value) && types.isPromise(value) &&
    Object.getPrototypeOf(value) === Promise.prototype &&
    !Object.getOwnPropertyDescriptor(value, "constructor"))
    void apply(nativeThen, value, [undefined, () => undefined])
  fail()
}
function columns(value: unknown): FunctionConversationProjectionColumns | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    Reflect.ownKeys(value).length !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length) fail()
  const output = {} as Record<typeof FUNCTION_CONVERSATION_PROJECTION_COLUMNS[number],
    string | number | null>
  for (const key of FUNCTION_CONVERSATION_PROJECTION_COLUMNS) {
    const item = own(value, key)
    if (!(item === null || typeof item === "string" ||
      typeof item === "number" && Number.isFinite(item))) fail()
    output[key] = item
  }
  return Object.freeze(output)
}

/** Native presentation factory only. This opaque adapter is never serialized or SDK authority. */
export function captureFunctionNativeHumanProjectionVariant(input: Omit<Variant, "kind">):
  FunctionNativeHumanProjectionVariant {
  return captureVariant(input)
}

/** This distinct factory requires the original ToolReturn source, not a caller-supplied kind. */
export function captureFunctionNativeToolHumanProjectionVariant(
  input: Omit<Variant, "kind" | "transcript"> & { readonly source: FunctionNativeToolHumanReceipt }
): FunctionNativeHumanProjectionVariant {
  const token = own(input, "source") as FunctionNativeToolHumanReceipt
  if (Object.getOwnPropertyDescriptor(input, "transcript")) fail()
  const source = readFunctionConversationNativeToolHuman(token)
  const target = own(input, "target")
  if (!target || typeof target !== "object" || source.runtime.run !== own(input, "run") ||
    source.occurrence !== own(input, "occurrence") || source.uuid !== own(input, "uuid") ||
    source.runtime.destination.threadId !== own(input, "threadId") ||
    !same(source.runtime.target.ref, ref(target as FunctionConversationRef))) fail()
  const current = own(input, "assertCurrent")
  if (typeof current !== "function" || types.isProxy(current)) fail()
  const candidate = own(input, "assertCandidate")
  if (typeof candidate !== "function" || types.isProxy(candidate)) fail()
  const certifiedCurrent = readFunctionConversationNativeToolHumanCurrent(token, current)
  return captureVariant({ producer: own(input, "producer") as object,
    run: own(input, "run") as object, occurrence: own(input, "occurrence") as object,
    target: target as FunctionConversationRef, threadId: text(own(input, "threadId")),
    uuid: text(own(input, "uuid")), assertCandidate(row) {
      synchronous(apply(candidate, input, [row]))
    }, assertCurrent() {
      if (certifiedCurrent) {
        synchronous(apply(current, input, []))
        certifiedCurrent.assertTail()
      } else {
        source.assertCurrent()
        synchronous(apply(current, input, []))
        source.assertCurrent()
      }
    } }, "tool-side")
}

function captureVariant(input: Variant, kind?: "tool-side"): FunctionNativeHumanProjectionVariant {
  const rawTarget = own(input, "target")
  if (!rawTarget || typeof rawTarget !== "object") fail()
  const target = ref(rawTarget as FunctionConversationRef)
  const threadId = text(own(input, "threadId")), uuid = text(own(input, "uuid"))
  const producer = own(input, "producer"), run = own(input, "run")
  const occurrence = own(input, "occurrence")
  if (!producer || typeof producer !== "object" || types.isProxy(producer) ||
    !run || typeof run !== "object" || types.isProxy(run) ||
    !occurrence || typeof occurrence !== "object" || types.isProxy(occurrence)) fail()
  const current = own(input, "assertCurrent"), candidate = own(input, "assertCandidate")
  if (typeof current !== "function" || types.isProxy(current) ||
    typeof candidate !== "function" || types.isProxy(candidate)) fail()
  const field = Object.getOwnPropertyDescriptor(input, "transcript")
  let transcript: Variant["transcript"]
  if (field) {
    const raw = own(input, "transcript")
    if (!raw || typeof raw !== "object" || types.isProxy(raw) || Reflect.ownKeys(raw).length !== 2)
      fail()
    const baseline = columns(own(raw, "baseline")), freshColumns = columns(own(raw, "freshColumns"))
    if ((baseline === undefined) === (freshColumns === undefined) ||
      baseline && (baseline.role !== "user" || baseline.message_id !== uuid ||
        baseline.thread_id !== threadId || baseline.function_row_json !== null) ||
      freshColumns && (freshColumns.role !== "user" || freshColumns.message_id !== uuid ||
        freshColumns.thread_id !== threadId || freshColumns.function_row_json !== null)) fail()
    transcript = Object.freeze({ baseline, freshColumns })
  }
  const pairedCandidate = !kind && readFunctionNativeHumanCandidateCurrent(
    candidate as (row: FunctionConversationRow) => void, current as () => void,
    { producer, run, occurrence, target: rawTarget as FunctionConversationRef, threadId, uuid })
  const record: Variant & { readonly pairedCandidate?: true } = Object.freeze({ producer, run, occurrence, target, threadId, uuid,
    ...(pairedCandidate ? { pairedCandidate: true as const } : {}),
    ...(kind ? { kind } : {}),
    ...(transcript ? { transcript } : {}),
    assertCurrent() { synchronous(apply(current, input, [])) },
    assertCandidate(row) { synchronous(apply(candidate, input, [row])) } })
  record.assertCurrent()
  const token = Object.freeze({ [brand]: true as const })
  variants.set(token, record)
  return token
}

/** Original producer qualification only. Fresh columns are never a general Human insertion grant. */
export function functionNativeHumanProjectionFreshColumns(token: FunctionNativeHumanProjectionVariant,
  context: FunctionNativeHumanProjectionContext, baseline: FunctionConversationProjectionColumns | undefined):
  FunctionConversationProjectionColumns | undefined {
  assertFunctionNativeHumanProjectionVariant(token, context)
  const record = variants.get(token)
  if (!record) fail()
  if (record.kind === "tool-side") {
    if (baseline) fail()
    return Object.freeze(Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key =>
      [key, key === "thread_id" ? record.threadId : key === "message_id" ? record.uuid
        : key === "role" ? "user" : key === "content_json" ? JSON.stringify("")
          : key === "stream_authority" ? 7 : key === "recovery_integrity" ? 1
            : key === "created_at" || key === "ordinal" ? 0 : null]))) as
      FunctionConversationProjectionColumns
  }
  if (!record.transcript) return undefined
  const expected = record.transcript.baseline
  if (expected ? !baseline || FUNCTION_CONVERSATION_PROJECTION_COLUMNS.some(key =>
    own(baseline, key) !== own(expected, key)) : baseline !== undefined) fail()
  return record.transcript.freshColumns
}

/** Data only; the caller still must perform the original full context/source checks. */
export function functionNativeHumanProjectionKind(token: FunctionNativeHumanProjectionVariant):
  "input" | "tool-side" {
  const record = variants.get(token)
  if (!record) fail()
  return record.kind ?? "input"
}

/** Exact factory identities plus the original full source guard; no DB/value imports here. */
export function assertFunctionNativeHumanProjectionVariant(
  token: FunctionNativeHumanProjectionVariant,
  context: FunctionNativeHumanProjectionContext,
  row?: FunctionConversationRow
): void {
  const record = variants.get(token)
  const target = own(context, "target")
  if (!target || typeof target !== "object" || !record ||
    record.producer !== own(context, "producer") || record.run !== own(context, "run") ||
    record.occurrence !== own(context, "occurrence") || record.threadId !== own(context, "threadId") ||
    record.uuid !== own(context, "uuid") || !same(record.target, ref(target as FunctionConversationRef)))
    fail()
  if (row && record.pairedCandidate) {
    // The exact factory checker already executes both original current callbacks, result
    // policy verification and callback-free source/row/selection/authority tails.
    record.assertCandidate(row)
    return
  }
  record.assertCurrent()
  if (row) record.assertCandidate(row)
  record.assertCurrent()
}

import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { readFunctionConversationNativeToolSide, type FunctionNativeToolSideReceipt,
  type FunctionNativeToolSideSource } from "../agent/function-conversation-native-tool-side"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import type { FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"

const brand = Symbol("native-tool-side-projection")
export interface FunctionNativeToolSideProjection { readonly [brand]: true }
export interface FunctionNativeToolSideProjectionContext {
  readonly producer: object
  readonly run: object
  readonly occurrence: object
  readonly target: FunctionConversationRef
  readonly threadId: string
  readonly uuid: string
  readonly role: "assistant" | "system" | "user" | "tool"
}
interface Projection {
  readonly source: FunctionNativeToolSideSource
  readonly producer: object
  readonly target: FunctionConversationRef
}
const projections = new WeakMap<FunctionNativeToolSideProjection, Projection>()
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_TOOL_SIDE_PROJECTION_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function sameRef(first: FunctionConversationRef, second: unknown): boolean {
  if (!second || typeof second !== "object" || types.isProxy(second) ||
    Reflect.ownKeys(second).length !== 8) fail()
  for (const key of ["logicalSessionId", "conversationId", "branchId", "threadId", "workspace",
    "kind", "checkpointNamespace"] as const) if (own(second, key) !== first[key]) return false
  const incarnation = own(second, "incarnation")
  if (!incarnation || typeof incarnation !== "object" || types.isProxy(incarnation) ||
    Reflect.ownKeys(incarnation).length !== 2) fail()
  return own(incarnation, "token") === first.incarnation.token &&
    own(incarnation, "legacyCreatedAt") === first.incarnation.legacyCreatedAt
}

/** A fresh side is selected by its original ToolReturn, never a public type or caller flag. */
export function captureFunctionNativeToolSideProjection(input: {
  readonly source: FunctionNativeToolSideReceipt
  readonly producer: object
}): FunctionNativeToolSideProjection {
  const source = readFunctionConversationNativeToolSide(own(input, "source") as
    FunctionNativeToolSideReceipt)
  const producer = own(input, "producer")
  if (!producer || typeof producer !== "object" || types.isProxy(producer)) fail()
  const target = source.runtime.target.ref
  source.assertCurrent()
  const token = Object.freeze({ [brand]: true as const })
  projections.set(token, Object.freeze({ source, producer, target }))
  return token
}

export function assertFunctionNativeToolSideProjection(token: FunctionNativeToolSideProjection,
  context: FunctionNativeToolSideProjectionContext, row?: FunctionConversationRow): void {
  const record = projections.get(token)
  if (!record) fail()
  const source = record.source, role = source.nativeType === "ai" ? "assistant" : "system"
  const data = () => {
    if (projections.get(token) !== record || own(context, "producer") !== record.producer ||
      own(context, "run") !== source.runtime.run ||
      own(context, "occurrence") !== source.occurrence || own(context, "uuid") !== source.uuid ||
      own(context, "threadId") !== source.runtime.destination.threadId ||
      own(context, "role") !== role || !sameRef(record.target, own(context, "target"))) fail()
    source.assertDataCurrent()
    if (row) {
      const message = own(row, "message"), origin = own(row, "origin")
      if (own(row, "uuid") !== source.uuid || own(row, "branchId") !== record.target.branchId ||
        own(row, "door") !== "tool-message" || own(message, "type") !== role ||
        Object.getOwnPropertyDescriptor(message as object, "isMeta") ||
        !origin || typeof origin !== "object" || types.isProxy(origin) ||
        Reflect.ownKeys(origin).length !== 2 ||
        own(origin, "kind") !== "tool" || own(origin, "tool") !== source.origin.tool) fail()
      const payload = own(row, "nativePayload")
      if (typeof payload !== "string") fail()
      let native: unknown
      try { native = JSON.parse(payload) } catch { fail() }
      const nativeMessage = own(native, "message")
      if (own(native, "version") !== 1 || own(nativeMessage, "type") !== source.nativeType ||
        own(own(nativeMessage, "data"), "id") !== source.uuid) fail()
    }
  }
  data()
  source.assertCurrent()
  data()
}

/** Baseline absence is rechecked at capture and in the actual Keeper transaction. */
export function assertFunctionNativeToolSideProjectionFresh(token: FunctionNativeToolSideProjection,
  context: FunctionNativeToolSideProjectionContext,
  baseline: FunctionConversationProjectionColumns | undefined): void {
  assertFunctionNativeToolSideProjection(token, context)
  if (baseline !== undefined) fail()
}

import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { validateFunctionSessionAppendOrigin } from "../../shared/mods/v2/session-append"
import type { ContentBlock, ThreadMessageWrite } from "../types"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { FunctionConversationRow } from "../db/function-conversation-store"
import { captureFunctionNativeHumanProjectionVariant,
  captureFunctionNativeToolHumanProjectionVariant,
  type FunctionNativeHumanProjectionContext,
  type FunctionNativeHumanProjectionVariant } from "../db/function-conversation-native-human-projection"
import { bindFunctionConversationNativeInput,
  readInputTranscriptIntent,
  type FunctionConversationNativeInputReceipt } from "./function-conversation-native-input"
import { readFunctionConversationNativeToolHuman, captureFunctionConversationNativeToolHumanCurrent,
  type FunctionNativeToolHumanReceipt,
  type FunctionNativeToolHumanSource } from "./function-conversation-native-tool-human"
import { projectFunctionConversationThreadMessageStorageColumns } from "../db"
import type { FunctionConversationProjectionColumns } from
  "../db/function-conversation-projection-receipt"
import type { FunctionConversationPresentationAnchor } from
  "../db/function-conversation-presentation-disposition"
import { readFunctionConversationNativePolicySource, snapshotFunctionNativeDeployment } from "../mods/native-conversation-policy-source"
import { captureNativeMessage, captureNativeMessageForOccurrence, NATIVE_CAPTURE_MAX_EXPANDED_NODES,
  type CapturedNativeMessage } from "./native-message-capture"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { FunctionNativeMessageProtector, type FunctionProtectedNativeMessage } from
  "./native-message-protector"

const brand = Symbol("native-human-presentation")
export interface FunctionNativeHumanPresentation { readonly [brand]: true }
export interface FunctionNativeInputPresentationOptions {
  readonly source: FunctionConversationNativeInputReceipt
  readonly runtime: FunctionNativeConversationRuntime
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly producer: object
  readonly occurrence: object
  readonly protector: FunctionNativeMessageProtector
}
export interface FunctionNativeToolHumanPresentationOptions {
  readonly source: FunctionNativeToolHumanReceipt
  readonly producer: object
  readonly protector: FunctionNativeMessageProtector
}
interface Protected {
  readonly result: FunctionProtectedNativeMessage
  readonly message: HumanMessage
  readonly digest: string
  readonly receipt: FunctionProtectedNativeMessage["receipt"]
}
interface Presentation {
  readonly kind: "input" | "tool-side"
  readonly runtime: FunctionNativeConversationRuntime
  readonly producer: object
  readonly uuid: string
  readonly variant: FunctionNativeHumanProjectionVariant
  readonly enhanced: boolean
  readonly anchor?: FunctionConversationPresentationAnchor
  readonly protector: FunctionNativeMessageProtector
  readonly policy: FunctionNativeInputPresentationOptions["policy"]["value"]
  readonly results: WeakMap<BaseMessage, Protected>
  readonly registering: WeakSet<BaseMessage>
  readonly certifying: WeakSet<BaseMessage>
  selected?: Protected
  assertCurrent(): void
  invalidate(): void
  certify(result: FunctionProtectedNativeMessage, message: HumanMessage,
    digest?: string): Protected
  assertRow(row: FunctionConversationRow): void
  project(value: Protected, row: FunctionConversationRow): ThreadMessageWrite
}
interface Creating { failed: boolean }
const presentations = new WeakMap<FunctionNativeHumanPresentation, Presentation>()
const creating = new WeakMap<FunctionNativeConversationRuntime, WeakMap<object, Creating>>()
const creatingTools = new WeakMap<FunctionNativeToolHumanReceipt, Creating>()
const stringify = JSON.stringify
const dateTime = Date.prototype.getTime
const apply = Reflect.apply
const nativeThen = Promise.prototype.then
const nativeAbortCheck = AbortSignal.prototype.throwIfAborted
const pairGet = WeakMap.prototype.get, pairSet = WeakMap.prototype.set
const candidatePairs = new WeakMap<(row: FunctionConversationRow) => void, {
  current: () => void
  context: FunctionNativeHumanProjectionContext
}>()
/** Read-only qualification of this factory's own complete row checker; there is no registration API. */
export function readFunctionNativeHumanCandidateCurrent(candidate: (row: FunctionConversationRow) => void,
  current: () => void, context: FunctionNativeHumanProjectionContext): boolean {
  const original = apply(pairGet, candidatePairs, [candidate]) as ReturnType<typeof candidatePairs.get>
  return Boolean(original && original.current === current &&
    original.context.producer === context.producer && original.context.run === context.run &&
    original.context.occurrence === context.occurrence && original.context.target === context.target &&
    original.context.threadId === context.threadId && original.context.uuid === context.uuid)
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_HUMAN_PRESENTATION_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function originText(value: unknown): string {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail()
  const output: Record<string, string | boolean> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail()
    const item = own(value, key)
    if (typeof item !== "string" && typeof item !== "boolean") fail()
    Object.defineProperty(output, key, { value: item, enumerable: true })
  }
  validateFunctionSessionAppendOrigin(output)
  return stringify(output)
}
function freshTranscriptColumns(write: ThreadMessageWrite, threadId: string):
  FunctionConversationProjectionColumns {
  const raw = projectFunctionConversationThreadMessageStorageColumns(write,
    apply(dateTime, write.created_at, []))
  return Object.freeze({ thread_id: threadId, message_id: raw.message_id,
    provider_source_id: raw.provider_source_id, provider_occurrence: raw.provider_occurrence,
    role: raw.role, content_json: raw.content_json, prompt_origin_json: raw.prompt_origin_json,
    function_row_json: null, reasoning: raw.reasoning, tool_calls_json: raw.tool_calls_json,
    tool_call_id: raw.tool_call_id, name: raw.name, status: raw.status, is_error: raw.is_error,
    content_priority: raw.content_priority, stream_authority: raw.stream_authority,
    recovery_integrity: raw.recovery_integrity, goal_id: raw.goal_id,
    active_window_id: raw.active_window_id, created_at: raw.created_at,
    start_at: raw.start_at, end_at: raw.end_at, ordinal: 0 })
}
function human(value: unknown): HumanMessage {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== HumanMessage.prototype) fail()
  return value as HumanMessage
}
function metadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail()
  return value as Record<string, unknown>
}

function copyContent(value: unknown): unknown {
  const output: Record<string, unknown> = Object.create(null)
  type Task = { value: unknown; parent: Record<string, unknown> | unknown[]; key: string }
    | { exit: object }
  const tasks: Task[] = [{ value, parent: output, key: "content" }]
  const ancestors = new Set<object>()
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES
  while (tasks.length) {
    const task = tasks.pop()
    if (!task) fail()
    if ("exit" in task) { ancestors.delete(task.exit); continue }
    if (--remaining < 0) fail()
    const input = task.value
    if (input === null || typeof input === "string" || typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))) {
      Object.defineProperty(task.parent, task.key, { value: input, enumerable: true })
      continue
    }
    if (!input || typeof input !== "object" || types.isProxy(input) || ancestors.has(input)) fail()
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      fail()
    const keys = Reflect.ownKeys(input)
    const length: unknown = array ? Object.getOwnPropertyDescriptor(input, "length")?.value : undefined
    if (array && (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      length > remaining || keys.length !== length + 1)) fail()
    const copied: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    Object.defineProperty(task.parent, task.key, { value: copied, enumerable: true })
    ancestors.add(input); tasks.push({ exit: input })
    for (const key of keys) {
      if (array && key === "length") continue
      if (typeof key !== "string" || (array &&
        (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= Number(length)))) fail()
      tasks.push({ value: own(input, key), parent: copied, key })
    }
  }
  return output.content
}

function sameCopiedData(value: unknown, expected: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[value, expected]]
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES
  while (pending.length) {
    if (--remaining < 0) fail()
    const pair = pending.pop()
    if (!pair) fail()
    const [actual, fixed] = pair
    if (actual === null || typeof actual !== "object") {
      if (!Object.is(actual, fixed)) return false
      continue
    }
    if (!actual || typeof actual !== "object" || types.isProxy(actual) ||
      !fixed || typeof fixed !== "object" || types.isProxy(fixed)) return false
    const array = Array.isArray(actual), prototype = Object.getPrototypeOf(actual)
    if (array !== Array.isArray(fixed) || (array ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null)) return false
    const keys = Reflect.ownKeys(actual), expectedKeys = Reflect.ownKeys(fixed)
    if (keys.length !== expectedKeys.length) return false
    for (const key of keys) {
      if (typeof key !== "string") return false
      if (array && key === "length") {
        if (Object.getOwnPropertyDescriptor(actual, key)?.value !==
          Object.getOwnPropertyDescriptor(fixed, key)?.value) return false
        continue
      }
      const field = Object.getOwnPropertyDescriptor(fixed, key)
      if (!field || !field.enumerable || !("value" in field)) return false
      pending.push([own(actual, key), field.value])
    }
  }
  return true
}

/** Pure shape conversion only. It neither registers a candidate nor creates persistence proof. */
export function functionConversationHumanTranscriptContent(value: unknown): ThreadMessageWrite["content"] {
  if (typeof value === "string") return value
  const copied = copyContent(value)
  if (!Array.isArray(copied)) fail()
  const result: ContentBlock[] = []
  for (let index = 0; index < copied.length; index++) {
    const block = copied[index]
    if (!block || typeof block !== "object" || types.isProxy(block) || Array.isArray(block) ||
      typeof own(block, "type") !== "string") fail()
    const kind = own(block, "type")
    if (kind !== "text" && kind !== "image" && kind !== "tool_use" && kind !== "tool_result") fail()
    // This descriptor-safe data conversion grants no persistence or source provenance.
    result.push(block as ContentBlock)
  }
  return result
}

/** Actual input source only; a structurally equal binding or public metadata cannot open this. */
export function captureFunctionConversationNativeInputPresentation(
  input: FunctionNativeInputPresentationOptions
): FunctionNativeHumanPresentation {
  return capturePresentation(input)
}

/** Only a real ToolReturn source can open the separate fresh Tool-Human producer. */
export function captureFunctionConversationNativeToolHumanPresentation(
  input: FunctionNativeToolHumanPresentationOptions
): FunctionNativeHumanPresentation {
  const token = own(input, "source") as FunctionNativeToolHumanReceipt
  if (!token || typeof token !== "object" || types.isProxy(token)) fail()
  const prior = creatingTools.get(token)
  if (prior) { prior.failed = true; fail() }
  const latch = { failed: false }
  creatingTools.set(token, latch)
  try {
    const source = readFunctionConversationNativeToolHuman(token)
    if (latch.failed) fail()
    const result = capturePresentation({ runtime: source.runtime, policy: source.policy,
      occurrence: source.occurrence, producer: own(input, "producer") as object,
      protector: own(input, "protector") as FunctionNativeMessageProtector },
    { token, source, latch })
    if (latch.failed) fail()
    return result
  } catch (error) { latch.failed = true; throw error }
}

function capturePresentation(
  input: Omit<FunctionNativeInputPresentationOptions, "source"> & {
    readonly source?: FunctionConversationNativeInputReceipt
  }, tool?: { readonly token: FunctionNativeToolHumanReceipt;
    readonly source: FunctionNativeToolHumanSource; readonly latch: Creating }
): FunctionNativeHumanPresentation {
  const runtime = own(input, "runtime"), occurrence = own(input, "occurrence")
  if (!runtime || typeof runtime !== "object" || types.isProxy(runtime) ||
    !occurrence || typeof occurrence !== "object" || types.isProxy(occurrence)) fail()
  const actualRuntime = runtime as FunctionNativeConversationRuntime
  let byOccurrence = creating.get(actualRuntime)
  if (!byOccurrence) { byOccurrence = new WeakMap(); creating.set(actualRuntime, byOccurrence) }
  const prior = byOccurrence.get(occurrence)
  if (prior) { prior.failed = true; fail() }
  const latch = { failed: false }
  byOccurrence.set(occurrence, latch)
  try {
    const policy = own(input, "policy") as FunctionNativeInputPresentationOptions["policy"]
    const inputSource = tool ? undefined : bindFunctionConversationNativeInput(
      own(input, "source") as FunctionConversationNativeInputReceipt, actualRuntime, policy)
    const source = tool?.source ?? inputSource
    if (!source) fail()
    const inputCertificate = tool ? undefined : readFunctionConversationNativePolicySource(policy, actualRuntime)
    const transcript = inputSource?.transcript
      ? readInputTranscriptIntent(inputSource.transcript) : undefined
    const anchor: FunctionConversationPresentationAnchor | undefined = transcript ? Object.freeze({
      version: 1, disposition: transcript.disposition, intentDigest: transcript.intentDigest }) : undefined
    const noBubble = transcript !== undefined && transcript.disposition !== "persisted"
    const freshColumns = noBubble
      ? freshTranscriptColumns(transcript.write, actualRuntime.destination.threadId) : undefined
    const policyValue = own(policy, "value") as FunctionNativeInputPresentationOptions["policy"]["value"]
    const protectedPolicy = own(policyValue, "protected"), policyDigest = own(policyValue, "digest")
    const policyIdentity = own(policyValue, "identity"), policyEpoch = own(policyValue, "epoch")
    if (typeof protectedPolicy !== "boolean" || typeof policyDigest !== "string" ||
      !policyIdentity || typeof policyIdentity !== "object" || types.isProxy(policyIdentity) ||
      typeof policyEpoch !== "number" || !Number.isSafeInteger(policyEpoch) || policyEpoch < 0) fail()
    const policyDeployment = stringify(snapshotFunctionNativeDeployment(own(policyValue, "deployment")))
    const producer = own(input, "producer"), protector = own(input, "protector")
    if (!producer || typeof producer !== "object" || types.isProxy(producer) ||
      !protector || typeof protector !== "object" || types.isProxy(protector) ||
      Object.getPrototypeOf(protector) !== FunctionNativeMessageProtector.prototype) fail()
    const actualProtector = protector as FunctionNativeMessageProtector
    const original = tool ? captureNativeMessageForOccurrence(source.message, source.uuid,
      () => apply(nativeAbortCheck, source.signal, [])).snapshot
      : captureNativeMessage(source.message, () => apply(nativeAbortCheck, source.signal, []))
    const additional = metadata(original.data.additional_kwargs)
    const enhanced = inputSource?.visible !== undefined
    if (enhanced ? additional.cmb_coordinator_augmented_user_message !== true ||
        additional.cmb_visible_user_message !== inputSource?.visible :
        additional.cmb_coordinator_augmented_user_message === true ||
        Object.hasOwn(additional, "cmb_visible_user_message")) fail()
    const fixedOrigin = originText(source.origin)
    const branchId = actualRuntime.target.ref.branchId
    const results = new WeakMap<BaseMessage, Protected>()
    const current = tool ? captureFunctionConversationNativeToolHumanCurrent(tool.token,
      latch, tool.latch) : () => {
      if (latch.failed) fail()
      source.assertCurrent()
      if (latch.failed) fail()
    }
    const pureResult = (value: Protected, expectedDigest?: string): CapturedNativeMessage => {
      if (latch.failed || tool?.latch.failed || own(value.result, "message") !== value.message ||
        own(value.result, "receipt") !== value.receipt ||
        own(value.result, "policyDigest") !== policyDigest ||
        own(value.result, "protected") !== protectedPolicy) fail()
      const snapshot = captureNativeMessage(value.message, () => apply(nativeAbortCheck, source.signal, []))
      if (snapshot.type !== "human" || snapshot.executionSuppressed ||
        snapshot.data.id !== source.uuid ||
        (expectedDigest !== undefined && snapshot.digest !== expectedDigest)) fail()
      const data = metadata(snapshot.data.additional_kwargs)
      if (Object.hasOwn(data, "function_row") || Object.hasOwn(data, "function_row_invalid") ||
        (enhanced && (data.cmb_coordinator_augmented_user_message !== true ||
          typeof data.cmb_visible_user_message !== "string")) ||
        (!enhanced && (data.cmb_coordinator_augmented_user_message === true ||
          Object.hasOwn(data, "cmb_visible_user_message")))) fail()
      if (latch.failed || tool?.latch.failed) fail()
      return snapshot
    }
    const pureSourceAndPolicy = () => {
      if (latch.failed || tool?.latch.failed || own(policy, "value") !== policyValue ||
        own(policyValue, "identity") !== policyIdentity || own(policyValue, "epoch") !== policyEpoch ||
        own(policyValue, "digest") !== policyDigest || own(policyValue, "protected") !== protectedPolicy ||
        stringify(snapshotFunctionNativeDeployment(own(policyValue, "deployment"))) !== policyDeployment)
        fail()
      // Actual bound source closure; pure complete raw equality, no lifecycle/source callback.
      source.assertDataCurrent()
      transcript?.assertDataCurrent()
    }
    // Both inspect and pureTail are module-local synchronous operations, never caller callbacks.
    // No scope or successful check is inherited by a later invocation or an await continuation.
    const certifyScope = <T>(result: FunctionProtectedNativeMessage, message: HumanMessage,
      expectedDigest: string | undefined, inspect: (snapshot: CapturedNativeMessage) => T,
      pureTail: () => void): { proof: Protected; value: T } => {
      if (record.certifying.has(message)) { latch.failed = true; fail() }
      const previous = results.get(message), selected = record.selected
      record.certifying.add(message)
      try {
        const receipt = own(result, "receipt") as FunctionProtectedNativeMessage["receipt"]
        current()
        // This exact private policy/result proof also proves the protected=true field.
        actualProtector.assertResultPolicy(result, producer, policyValue)
        const preliminary: Protected = { result, message, receipt, digest: expectedDigest ?? "" }
        const snapshot = pureResult(preliminary, expectedDigest)
        const value = inspect(snapshot)
        if (value && typeof value === "object") {
          if (types.isProxy(value)) fail()
          const then = Object.getOwnPropertyDescriptor(value, "then")
          if (types.isPromise(value) || then && (!("value" in then) || typeof then.value === "function")) {
            if (types.isPromise(value) && Object.getPrototypeOf(value) === Promise.prototype &&
              !Object.hasOwn(value, "constructor"))
              void nativeThen.call(value, undefined, () => undefined)
            fail()
          }
        }
        current()
        // After the last original callback, only full typed/data and private CAS checks run.
        pureResult(preliminary, snapshot.digest)
        pureSourceAndPolicy()
        pureTail()
        inputCertificate?.assertTail()
        if (latch.failed || results.get(message) !== previous || record.selected !== selected) fail()
        return { proof: Object.freeze({ result, message, receipt, digest: snapshot.digest }), value }
      } finally { record.certifying.delete(message) }
    }
    const certify = (result: FunctionProtectedNativeMessage, message: HumanMessage,
      expectedDigest?: string): Protected => certifyScope(result, message, expectedDigest,
        () => undefined, () => undefined).proof
    const checkRow = (row: FunctionConversationRow, payload: string, timestamp?: number): number => {
      if (own(row, "uuid") !== source.uuid ||
        own(row, "branchId") !== branchId ||
        own(row, "door") !== (tool ? "tool-message" : "prompt") ||
        originText(own(row, "origin")) !== fixedOrigin ||
        own(row, "nativePayload") !== payload) fail()
      if (anchor) {
        const marker = own(own(row, "orderAnchor"), "presentation")
        if (!marker || typeof marker !== "object" || types.isProxy(marker) ||
          Reflect.ownKeys(marker).length !== 3 || own(marker, "version") !== anchor.version ||
          own(marker, "disposition") !== anchor.disposition ||
          own(marker, "intentDigest") !== anchor.intentDigest) fail()
      }
      const message = metadata(own(row, "message"))
      const meta = Object.getOwnPropertyDescriptor(message, "isMeta")
      if (own(message, "type") !== "user" || meta && (!meta.enumerable || !("value" in meta) ||
        typeof meta.value !== "boolean" || meta.value)) fail()
      const createdAt = own(row, "createdAt")
      if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 ||
        timestamp !== undefined && timestamp !== createdAt) fail()
      return createdAt
    }
    const assertRow = (row: FunctionConversationRow) => {
      const selected = record.selected
      if (!selected || results.get(selected.message) !== selected) fail()
      let payload = "", timestamp = 0, fixedRow: unknown
      certifyScope(selected.result, selected.message, selected.digest, () => {
        fixedRow = copyContent(row)
        payload = serializeFunctionConversationNativeMessage(selected.message)
        timestamp = checkRow(row, payload)
      }, () => {
        checkRow(row, payload, timestamp)
        if (!sameCopiedData(row, fixedRow)) fail()
      })
    }
    const project = (value: Protected, row: FunctionConversationRow): ThreadMessageWrite => {
      if (results.get(value.message) !== value) fail()
      let payload = "", timestamp = 0, fixedRow: unknown
      const projected = certifyScope(value.result, value.message, value.digest, snapshot => {
        fixedRow = copyContent(row)
        const visible = enhanced ? metadata(snapshot.data.additional_kwargs)
          .cmb_visible_user_message : snapshot.data.content
        const content = noBubble ? "" : functionConversationHumanTranscriptContent(visible)
        payload = serializeFunctionConversationNativeMessage(value.message)
        timestamp = checkRow(row, payload)
        return { ...(transcript?.write ?? {}), id: source.uuid, role: "user" as const, content,
          created_at: transcript ? new Date(apply(dateTime, transcript.write.created_at, []))
            : new Date(timestamp),
          recovery_integrity: noBubble ? "unverified" as const : "verified" as const,
          ...(tool ? { content_mode: "snapshot" as const, reasoning_mode: "snapshot" as const,
            tool_calls_mode: "snapshot" as const } : {}) }
      }, () => {
        checkRow(row, payload, timestamp)
        if (!sameCopiedData(row, fixedRow)) fail()
      })
      // certifyScope checked the exact previous selection; this synchronous set publishes only
      // the candidate whose complete safe/input/row data passed its final callback-free tail.
      record.selected = value
      return projected.value
    }
    const variantInput = { producer, run: actualRuntime.run,
      occurrence, target: actualRuntime.target.ref, threadId: actualRuntime.destination.threadId,
      uuid: source.uuid, ...(transcript ? { transcript: { baseline: transcript.baseline,
        freshColumns } } : {}), assertCurrent: current, assertCandidate: assertRow }
    if (!tool && inputCertificate) apply(pairSet, candidatePairs, [assertRow,
      { current, context: Object.freeze({ producer, run: actualRuntime.run, occurrence,
        target: actualRuntime.target.ref, threadId: actualRuntime.destination.threadId, uuid: source.uuid }) }])
    const variant = tool ? captureFunctionNativeToolHumanProjectionVariant({
      ...variantInput, source: tool.token }) : captureFunctionNativeHumanProjectionVariant(variantInput)
    const record: Presentation = { kind: tool ? "tool-side" : "input", runtime: actualRuntime,
      producer, uuid: source.uuid, variant, enhanced,
      ...(anchor ? { anchor } : {}),
      protector: actualProtector, policy: policyValue, results, registering: new WeakSet(),
      certifying: new WeakSet(),
      assertCurrent: current, invalidate: () => { latch.failed = true },
      certify, assertRow, project }
    current()
    const token = Object.freeze({ [brand]: true as const })
    presentations.set(token, record)
    return token
  } catch (error) { latch.failed = true; throw error }
}

/** Immutable data on the actual opaque presentation, never a public metadata selector. */
export function functionConversationNativeHumanPresentationKind(token: FunctionNativeHumanPresentation):
  "input" | "tool-side" {
  const record = presentations.get(token)
  if (!record) fail()
  record.assertCurrent()
  return record.kind
}

/** Actual source-bound commit marker only. Public metadata cannot supply this anchor. */
export function functionConversationNativeHumanPresentationAnchor(token: FunctionNativeHumanPresentation):
  FunctionConversationPresentationAnchor | undefined {
  const record = presentations.get(token)
  if (!record) fail()
  record.assertCurrent()
  return record.anchor
}

/** Only called by the Keeper after its actual protection receipt has passed the original checks. */
export function registerFunctionConversationNativeHumanProtection(
  token: FunctionNativeHumanPresentation, result: FunctionProtectedNativeMessage
): void {
  const record = presentations.get(token)
  if (!record) fail()
  const message = human(own(result, "message"))
  const receipt = own(result, "receipt")
  if (!receipt || typeof receipt !== "object") fail()
  if (record.registering.has(message)) { record.invalidate(); fail() }
  const previous = record.results.get(message), selected = record.selected
  record.registering.add(message)
  try {
    // One genuine receipt/policy check precedes the first codec, including inactive policy.
    const value = record.certify(result, message)
    if (record.results.get(message) !== previous || record.selected !== selected) fail()
    record.results.set(message, value)
  } finally { record.registering.delete(message) }
}

export function functionConversationNativeHumanProjection(token: FunctionNativeHumanPresentation):
  FunctionNativeHumanProjectionVariant {
  const record = presentations.get(token)
  if (!record) fail()
  record.assertCurrent()
  return record.variant
}

/** This selects a protected candidate; the actual index formatter still performs its one clamp. */
export function projectFunctionConversationNativeHuman(token: FunctionNativeHumanPresentation,
  native: BaseMessage, row: FunctionConversationRow): ThreadMessageWrite {
  const record = presentations.get(token), value = record?.results.get(native)
  if (!record || !value) fail()
  return record.project(value, row)
}

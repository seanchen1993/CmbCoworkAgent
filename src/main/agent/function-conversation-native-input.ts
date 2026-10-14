import { HumanMessage } from "@langchain/core/messages"
import { realpathSync, statSync } from "node:fs"
import { types } from "node:util"
import { getDb, getThreadCore, getThreadMessageCanonicalId } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "./thread-run-lease"
import { captureNativeMessage } from "./native-message-capture"
import { captureNativeInputCompleteValues } from "./native-input-complete-values"
import { captureNativeInputTranscriptData } from "./native-input-transcript-data"
import { readFunctionConversationRawProjection,
  type FunctionConversationProjectionColumns } from "../db/function-conversation-projection-receipt"
import type { ThreadMessageWrite } from "../types"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource } from "../mods/native-conversation-policy-source"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { validateFunctionSessionAppendOrigin,
  type FunctionSessionAppendOrigin } from "../../shared/mods/v2/session-append"

const inputBrand = Symbol("function-conversation-native-input")
const transcriptBrand = Symbol("function-conversation-native-input-transcript")
const nativeThen = Promise.prototype.then
const stringify = JSON.stringify
const apply = Reflect.apply
const throwIfAborted = AbortSignal.prototype.throwIfAborted

export interface FunctionConversationNativeInputReceipt { readonly [inputBrand]: true }
export interface FunctionNativeInputTranscriptIntent { readonly [transcriptBrand]: true }
export type FunctionNativeInputTranscriptDisposition = "persisted" | "blank" | "plumbing"
export interface FunctionNativeInputTranscriptView {
  readonly uuid: string
  readonly threadId: string
  readonly physicalRunId: string
  readonly disposition: FunctionNativeInputTranscriptDisposition
  readonly intentDigest: string
  readonly write: ThreadMessageWrite
  /** Original pre-adoption qualification, not a later UI authority lookup. */
  readonly baseline: FunctionConversationProjectionColumns | undefined
  /** Pure original/copy data tail; not a source or policy admission. */
  assertDataCurrent(): void
  assertCurrent(): void
}
export interface FunctionConversationNativeInputCapture {
  readonly message: HumanMessage
  readonly threadId: string
  readonly physicalRunId: string
  readonly workspace: string
  readonly signal: AbortSignal
  readonly origin: FunctionSessionAppendOrigin
  readonly visible?: string
  readonly transcript?: {
    readonly write: ThreadMessageWrite
    readonly disposition: FunctionNativeInputTranscriptDisposition
  }
  /** Original physical transport/source guard; never an old candidate's runtime authority. */
  assertCurrent(): void
}
export interface FunctionConversationNativeInputSource {
  readonly message: HumanMessage
  readonly uuid: string
  readonly threadId: string
  readonly physicalRunId: string
  readonly workspace: string
  readonly signal: AbortSignal
  readonly origin: FunctionSessionAppendOrigin
  readonly visible?: string
  readonly transcript?: FunctionNativeInputTranscriptIntent
  /** Pure original data equality only; never authority, lifecycle or a source callback. */
  assertDataCurrent(): void
  assertCurrent(): void
}
export interface FunctionConversationNativeInputBinding extends FunctionConversationNativeInputSource {
  readonly runtime: FunctionNativeConversationRuntime
}

interface CaptureState { failed: boolean }
const captured = new WeakMap<HumanMessage, CaptureState>()
const inputs = new WeakMap<FunctionConversationNativeInputReceipt,
  FunctionConversationNativeInputSource>()
const transcripts = new WeakMap<FunctionNativeInputTranscriptIntent, {
  readonly source: FunctionConversationNativeInputSource
  readonly disposition: FunctionNativeInputTranscriptDisposition
  readonly data: ReturnType<typeof captureNativeInputTranscriptData>
  readonly baseline: FunctionConversationProjectionColumns | undefined
}>()

function fail(code = "MODS_CONVERSATION_NATIVE_INPUT_INVALID"): never {
  throw new ModFunctionError(code)
}
function own(value: object, key: string): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
  return descriptor.value
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) fail()
  return value
}
function origin(value: unknown): FunctionSessionAppendOrigin {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const output: Record<string, string | boolean> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail()
    const entry = own(value, key)
    if (typeof entry !== "string" && typeof entry !== "boolean") fail()
    Object.defineProperty(output, key, { value: entry, enumerable: true })
  }
  validateFunctionSessionAppendOrigin(output)
  return Object.freeze(output)
}
function synchronous(result: unknown): void {
  if (result === undefined) return
  // Observe only a real native Promise through the captured builtin; no foreign then/getter.
  if (result && typeof result === "object" && !types.isProxy(result) && types.isPromise(result) &&
    Object.getPrototypeOf(result) === Promise.prototype && !Object.hasOwn(result, "constructor"))
    void nativeThen.call(result, undefined, () => undefined)
  fail("MODS_CONVERSATION_NATIVE_INPUT_GUARD_ASYNC")
}
function workspacePath(raw: string | null): string {
  let value: unknown
  try { value = JSON.parse(raw ?? "null") } catch { fail() }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  return text(own(value, "workspacePath"))
}
function canonical(path: string): string {
  let value: string
  try { value = process.platform === "win32" ? realpathSync.native(path) : realpathSync(path) }
  catch { return fail() }
  return process.platform === "win32" ? value.toLowerCase() : value
}
interface Directory { readonly device: bigint; readonly inode: bigint; readonly birth: bigint }
function directory(path: string): Directory | undefined {
  try {
    const value = statSync(path, { bigint: true })
    if (!value.isDirectory() || value.dev <= 0n || value.ino <= 0n || value.birthtimeNs <= 0n)
      return undefined
    return Object.freeze({ device: value.dev, inode: value.ino, birth: value.birthtimeNs })
  } catch { return fail() }
}
function sameDirectory(actual: Directory | undefined, expected: Directory): boolean {
  return actual?.device === expected.device && actual.inode === expected.inode &&
    actual.birth === expected.birth
}

/** Actual user-entry factory only. This proof neither grants authority nor mints a saved ACK. */
export function captureFunctionConversationNativeInput(
  input: FunctionConversationNativeInputCapture
): FunctionConversationNativeInputReceipt {
  const raw = own(input, "message")
  if (!raw || typeof raw !== "object" || types.isProxy(raw) ||
    Object.getPrototypeOf(raw) !== HumanMessage.prototype) fail()
  const message = raw as HumanMessage
  const prior = captured.get(message)
  if (prior) { prior.failed = true; fail("MODS_CONVERSATION_NATIVE_INPUT_CAPTURE_ONCE") }
  const state: CaptureState = { failed: false }
  captured.set(message, state)
  try {
    const threadId = text(own(input, "threadId")), physicalRunId = text(own(input, "physicalRunId"))
    const workspace = text(own(input, "workspace")), signal = own(input, "signal")
    if (!signal || typeof signal !== "object" || types.isProxy(signal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail()
    const active = signal as AbortSignal
    const originalOrigin = own(input, "origin"), fixedOrigin = origin(originalOrigin)
    const originDigest = stringify(fixedOrigin)
    const visibleField = Object.getOwnPropertyDescriptor(input, "visible")
    if (visibleField && (!visibleField.enumerable || !("value" in visibleField) ||
      typeof visibleField.value !== "string")) fail()
    const visible: string | undefined = visibleField?.value
    const sourceGuard = own(input, "assertCurrent")
    if (typeof sourceGuard !== "function" || types.isProxy(sourceGuard)) fail()
    // Reject raw methods/getters and forged stamps before invoking any host source callback.
    const snapshot = captureNativeMessage(message, () => active.throwIfAborted())
    if (snapshot.type !== "human" || snapshot.executionSuppressed) fail()
    const uuid = text(snapshot.data.id), additional = snapshot.data.additional_kwargs
    if (additional && typeof additional === "object" &&
      (Object.hasOwn(additional, "function_row") || Object.hasOwn(additional, "function_row_invalid")))
      fail()
    const transcriptField = Object.getOwnPropertyDescriptor(input, "transcript")
    if (transcriptField && (!transcriptField.enumerable || !("value" in transcriptField))) fail()
    const rawTranscript: unknown = transcriptField?.value
    const transcriptPrototype = rawTranscript && typeof rawTranscript === "object" &&
      !types.isProxy(rawTranscript) ? Object.getPrototypeOf(rawTranscript) : undefined
    let transcriptData: ReturnType<typeof captureNativeInputTranscriptData> | undefined
    let disposition: FunctionNativeInputTranscriptDisposition | undefined
    let originalWrite: unknown
    if (transcriptField) {
      if (!rawTranscript || typeof rawTranscript !== "object" || types.isProxy(rawTranscript) ||
        Array.isArray(rawTranscript) || (Object.getPrototypeOf(rawTranscript) !== Object.prototype &&
        Object.getPrototypeOf(rawTranscript) !== null) || Reflect.ownKeys(rawTranscript).length !== 2)
        fail()
      const mode = own(rawTranscript, "disposition")
      if (mode !== "persisted" && mode !== "blank" && mode !== "plumbing") fail()
      disposition = mode
      originalWrite = own(rawTranscript, "write")
      transcriptData = captureNativeInputTranscriptData(originalWrite, uuid)
    }
    const boundedData = () => { apply(throwIfAborted, active, []) }
    const completeValues = snapshot.executionSuppressed ? undefined
      : captureNativeInputCompleteValues(message, boundedData)
    // No original callback can run between the initial typed capture and this calibration.
    // Recheck the complete raw descriptor tree after the original full typed hash, too.
    if (completeValues && (captureNativeMessage(message, boundedData).digest !== snapshot.digest ||
      !completeValues())) fail()
    const assertDataCurrent = () => {
      if (state.failed) fail()
      boundedData()
      if (stringify(origin(originalOrigin)) !== originDigest ||
        (completeValues ? !completeValues()
          : captureNativeMessage(message, boundedData).digest !== snapshot.digest)) fail()
      if (transcriptData && (!rawTranscript || typeof rawTranscript !== "object" ||
        own(input, "transcript") !== rawTranscript || Reflect.ownKeys(rawTranscript).length !== 2 ||
        Object.getPrototypeOf(rawTranscript) !== transcriptPrototype ||
        own(rawTranscript, "write") !== originalWrite ||
        own(rawTranscript, "disposition") !== disposition ||
        !transcriptData.matches(originalWrite))) fail()
    }
    const database = getDb(), thread = getThreadCore(threadId)
    if (!thread || canonical(workspacePath(thread.metadata)) !== workspace) fail()
    const incarnation = Object.freeze(captureThreadIncarnation(thread))
    const lease = getLocalThreadRunLease(threadId), ownsLease = captureLocalThreadRunLease(threadId)
    if (!lease || !ownsLease || lease.runId !== physicalRunId) fail()
    let directoryIdentity: Directory | undefined
    if (process.platform === "win32") {
      const path = workspacePath(thread.metadata), original = directory(path)
      const target = path === workspace ? original : directory(workspace)
      if (original && target) {
        if (!sameDirectory(target, original)) fail()
        directoryIdentity = original
      }
    }
    const assertFacts = () => {
      if (state.failed) fail()
      active.throwIfAborted()
      if (getDb() !== database || !ownsLease()) fail()
      const current = getThreadCore(threadId), currentLease = getLocalThreadRunLease(threadId)
      if (!current || !matchesThreadIncarnation(current, incarnation) || !currentLease ||
        currentLease.owner !== lease.owner || currentLease.runId !== lease.runId ||
        currentLease.acquiredAt !== lease.acquiredAt) fail()
      const path = workspacePath(current.metadata)
      if (directoryIdentity) {
        const original = directory(path), target = path === workspace ? original : directory(workspace)
        if (!sameDirectory(original, directoryIdentity) || !sameDirectory(target, directoryIdentity))
          fail()
      } else if (canonical(path) !== workspace) fail()
      assertDataCurrent()
    }
    const assertCurrent = () => {
      assertFacts()
      synchronous(apply(sourceGuard, input, []))
      assertFacts()
    }
    // Only the real after-success callback can qualify an existing row; a skipped UI path
    // must have no row or residual stream facts. This is captured before any adoption.
    const qualifyTranscript = () => {
      if (!transcriptData) return undefined
      if (getThreadMessageCanonicalId(threadId, uuid) !== uuid) fail()
      const columns = readFunctionConversationRawProjection(database, threadId, uuid)
      const fragments = database.exec(`SELECT * FROM thread_message_fragments
        WHERE thread_id=? AND message_id=? ORDER BY fragment_id`, [threadId, uuid])
      const fragmentStates = database.exec(`SELECT * FROM thread_message_fragment_states
        WHERE thread_id=? AND message_id=?`, [threadId, uuid])
      const parts = stringify([fragments, fragmentStates])
      if (disposition === "persisted") {
        if (!columns || columns.role !== "user" || columns.function_row_json !== null) fail()
      } else if (columns || fragments.some(result => result.values.length) ||
        fragmentStates.some(result => result.values.length)) fail()
      return { columns, parts }
    }
    const qualification = qualifyTranscript()
    assertCurrent()
    if (qualification) {
      const current = qualifyTranscript()
      if (!current || stringify(current) !== stringify(qualification)) fail()
    }
    const transcript = transcriptData
      ? Object.freeze({ [transcriptBrand]: true as const }) : undefined
    const source: FunctionConversationNativeInputSource = Object.freeze({ message, uuid,
      threadId, physicalRunId, workspace, signal: active, origin: fixedOrigin,
      ...(visible === undefined ? {} : { visible }), ...(transcript ? { transcript } : {}),
      assertDataCurrent, assertCurrent })
    if (transcript && transcriptData && disposition)
      transcripts.set(transcript, { source, data: transcriptData, disposition,
        baseline: qualification?.columns })
    const receipt: FunctionConversationNativeInputReceipt = Object.freeze({ [inputBrand]: true as const })
    inputs.set(receipt, source)
    return receipt
  } catch (error) { state.failed = true; throw error }
}

/** Opaque actual source only. Returned copies and baseline data cannot create an intent. */
export function readInputTranscriptIntent(token: FunctionNativeInputTranscriptIntent):
  FunctionNativeInputTranscriptView {
  const record = transcripts.get(token)
  if (!record) fail("MODS_CONVERSATION_INPUT_TRANSCRIPT_INVALID")
  record.source.assertCurrent()
  const write = record.data.copy()
  // Independently capture the returned copy so mutation cannot cross a later source callback.
  const copied = captureNativeInputTranscriptData(write, record.source.uuid)
  const assertDataCurrent = () => {
    record.source.assertDataCurrent()
    if (!copied.matches(write)) fail()
  }
  const assertCurrent = () => {
    assertDataCurrent()
    record.source.assertCurrent()
    assertDataCurrent()
  }
  assertCurrent()
  return Object.freeze({ uuid: record.source.uuid, threadId: record.source.threadId,
    physicalRunId: record.source.physicalRunId, disposition: record.disposition,
    intentDigest: record.data.digest, write, baseline: record.baseline,
    assertDataCurrent, assertCurrent })
}

export function readFunctionConversationNativeInput(
  receipt: FunctionConversationNativeInputReceipt
): FunctionConversationNativeInputSource {
  const source = inputs.get(receipt)
  if (!source) fail()
  source.assertCurrent()
  return source
}

/** Each candidate has fresh actual runtime/policy proof. No closed prior runtime is consulted. */
export function bindFunctionConversationNativeInput(
  receipt: FunctionConversationNativeInputReceipt,
  runtime: FunctionNativeConversationRuntime,
  policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
): FunctionConversationNativeInputBinding {
  const certificate = readFunctionConversationNativePolicySource(policy, runtime)
  if (!certificate) fail()
  const source = readFunctionConversationNativeInput(receipt)
  const assertCurrent = () => {
    source.assertCurrent()
    certificate.assertCurrent()
    if (getDb() !== runtime.database || runtime.target.ref.threadId !== source.threadId ||
      runtime.target.ref.workspace !== source.workspace || runtime.target.ref.kind !== "main" ||
      runtime.target.checkpointThreadId !== source.threadId ||
      runtime.binding.checkpointThreadId !== source.threadId) fail()
    source.assertCurrent()
    certificate.assertTail()
  }
  assertCurrent()
  return Object.freeze({ ...source, runtime, assertCurrent })
}

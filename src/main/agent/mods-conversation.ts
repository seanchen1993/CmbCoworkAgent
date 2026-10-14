import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { z } from "zod"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativeMessage,
  constructCapturedNativeMessage } from "./native-message-capture"
import { preflightFunctionConversationMessage } from "./function-conversation-message-preflight"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { currentSharedNativeDomainRecord } from "./function-conversation-shared-native-domain"
import { functionConversationRowDigest } from
  "../checkpointer/function-conversation-checkpoint-membership"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import {
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import type { FunctionConversationRef, FunctionConversationRow, FunctionConversationStore } from "../db/function-conversation-store"
import {
  FUNCTION_CONVERSATION_CHANNEL,
  assertFunctionConversationState,
  readFunctionConversationState,
  type FunctionConversationState
} from "../checkpointer/function-conversation-delivery"

export interface FunctionConversationGraphRuntime {
  readonly configurable?: { thread_id?: string; [key: string]: unknown }
  readonly signal?: AbortSignal
}

export interface FunctionConversationGraphBinding {
  readonly target: FunctionConversationRef
  readonly checkpointThreadId: string
  readonly checkpointIncarnation?: ThreadIncarnation
  /** Exact native task namespace, verified by the host against its actual parent graph config. */
  readonly runtimeCheckpointNamespace: string
  readonly signal: AbortSignal
  /** Required for a genuinely new graph or host-verified legacy checkpoint migration. */
  readonly initialState?: FunctionConversationState
  /** An actual admission/restore cut, not a lookup of the latest same-thread checkpoint. */
  readonly admission?: { highWater: number; notAfterCreatedAt?: number }
  assertCurrent(): void
}

export interface FunctionConversationMiddlewareHost {
  readonly store: FunctionConversationStore
  capture(runtime: FunctionConversationGraphRuntime, state: FunctionConversationState | undefined):
    FunctionConversationGraphBinding | undefined
  prepareNote?(row: FunctionConversationRow, target: FunctionConversationRef,
    signal: AbortSignal): Promise<HumanMessage>
  onIntakeNotes?(publication: FunctionConversationIntakePublication): void
}

const intakePublicationBrand = Symbol("function-conversation-intake-publication")
export interface FunctionConversationIntakePublication {
  readonly [intakePublicationBrand]: true
}
interface IntakePublicationRecord {
  readonly store: FunctionConversationStore
  readonly target: FunctionConversationRef
  readonly notes: readonly HumanMessage[]
  readonly rows: readonly FunctionConversationRow[]
  readonly nativeDigests: readonly string[]
  readonly rowDigests: readonly string[]
  readonly highWater: number
  readonly notAfterCreatedAt?: number
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
}
const intakePublications = new WeakMap<FunctionConversationIntakePublication, IntakePublicationRecord>()

/** Only a real intake publication grants read access to its exact admitted note objects. */
export function readFunctionConversationIntakePublication(
  publication: FunctionConversationIntakePublication,
  store: FunctionConversationStore,
  target: FunctionConversationRef
): { notes: readonly HumanMessage[]; rows: readonly FunctionConversationRow[];
  assertCurrent(): void } {
  const record = intakePublications.get(publication)
  if (!record || record.store !== store || record.target !== target)
    throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
  const assertCurrent = () => {
    record.signal.throwIfAborted()
    record.assertCurrent()
    store.assertCurrent(target)
    for (let index = 0; index < record.notes.length; index += 1) {
      const captured = captureNativeMessage(record.notes[index], () => record.signal.throwIfAborted())
      const row = store.readRowAtCut(target, record.rows[index].uuid, {
        frontier: record.highWater, notAfterCreatedAt: record.notAfterCreatedAt
      }, () => { record.signal.throwIfAborted(); record.assertCurrent() })
      if (captured.executionSuppressed || captured.digest !== record.nativeDigests[index] ||
        functionConversationRowDigest(row) !== record.rowDigests[index] ||
        serializeFunctionConversationNativeMessage(constructCapturedNativeMessage(
          captured.type, { ...captured.data })) !== row.nativePayload)
        throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
    }
    record.assertCurrent()
    record.signal.throwIfAborted()
  }
  assertCurrent()
  return { notes: record.notes, rows: record.rows, assertCurrent }
}

/** The graph supplies its actual node namespace and parent checkpoint map at this boundary. */
export function captureFunctionConversationTaskBinding(runtime: FunctionConversationGraphRuntime,
  binding: FunctionConversationGraphBinding): FunctionConversationGraphBinding {
  binding.assertCurrent()
  const config = runtime.configurable
  const namespace = config?.checkpoint_ns
  const map = config?.checkpoint_map
  if (config?.thread_id !== binding.checkpointThreadId || typeof namespace !== "string" ||
    !map || typeof map !== "object" || Array.isArray(map) ||
    typeof (map as Record<string, unknown>)[binding.target.checkpointNamespace] !== "string")
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  return { ...binding, runtimeCheckpointNamespace: namespace }
}

export function functionConversationState(target: FunctionConversationRef, frontier = 0): FunctionConversationState {
  return readFunctionConversationState({ version: 1, logicalSessionId: target.logicalSessionId,
    conversationId: target.conversationId, branchId: target.branchId, frontier })
}

function rowStamp(row: FunctionConversationRow, target: FunctionConversationRef): FunctionConversationTranscriptStamp {
  const stamp: unknown = { conversationId: target.conversationId, branchId: row.branchId,
    uuid: row.uuid, sequence: row.sequence, door: row.door,
    messageType: row.message.type, isMeta: true, origin: row.origin }
  validateFunctionConversationTranscriptStamp(stamp)
  return stamp
}

/** SDK note content is text blocks. Unknown native content requires its actual host adapter. */
export function functionConversationNoteMessage(row: FunctionConversationRow, target: FunctionConversationRef): HumanMessage {
  if (!row.inbox || row.message.type !== "user" || row.message.isMeta !== true ||
    !Array.isArray(row.message.content)) throw new ModFunctionError("MODS_CONVERSATION_NOTE_INVALID")
  const content: Array<{ type: "text"; text: string }> = row.message.content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block) || block.type !== "text" ||
      typeof block.text !== "string" || Object.keys(block).some((key) => !["type", "text"].includes(key)))
      throw new ModFunctionError("MODS_CONVERSATION_NOTE_INVALID")
    return { type: "text", text: block.text }
  })
  return new HumanMessage({ id: row.uuid, content,
    additional_kwargs: { isMeta: true, function_row: rowStamp(row, target) } })
}

/** A pending tool batch remains owned by the graph; append never splices into its pairing. */
export function isFunctionConversationModelBoundary(messages: readonly BaseMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!AIMessage.isInstance(message)) continue
    const calls = message.tool_calls ?? []
    if (!calls.length) return true
    if (new Set(calls.map((call) => call.id)).size !== calls.length) return false
    const results = messages.slice(index + 1).filter((row) => ToolMessage.isInstance(row))
    return calls.every((call) => typeof call.id === "string" &&
      results.filter((row) => row.tool_call_id === call.id).length === 1)
  }
  return true
}

export interface FunctionConversationIntake {
  readonly store: FunctionConversationStore
  readonly target: FunctionConversationRef
  /** Captured from the exact checkpoint, or a host-verified genuinely new/migrated graph. */
  readonly state: FunctionConversationState
  readonly signal: AbortSignal
  readonly highWater?: number
  readonly notAfterCreatedAt?: number
  readonly prepareNote?: FunctionConversationMiddlewareHost["prepareNote"]
  readonly publish?: boolean
  assertCurrent(): void
}

/**
 * Captures one native high-water before awaiting protection. A host can include these notes before
 * its new user input, or the middleware can add them after an actually completed tool batch.
 * This helper updates neither a graph nor a checkpoint and starts no model.
 */
export async function prepareFunctionConversationIntake(
  input: FunctionConversationIntake,
  existingMessages: readonly BaseMessage[]
): Promise<{ notes: HumanMessage[]; state: FunctionConversationState;
  publication?: FunctionConversationIntakePublication }> {
  const current = readFunctionConversationState(input.state)
  const target = input.target
  const signal = input.signal
  const assertCurrent = () => {
    signal.throwIfAborted()
    input.assertCurrent()
    input.store.assertCurrent(target)
    assertFunctionConversationState(target, current)
  }
  assertCurrent()
  const checkedExisting = input.publish ? existingMessages.map(message =>
    preflightFunctionConversationMessage(message, () => signal.throwIfAborted())) : existingMessages
  if (!isFunctionConversationModelBoundary(checkedExisting)) return { notes: [], state: current }
  const highWater = input.highWater ?? input.store.highWater(target)
  const inbox = input.store.captureInbox(target, current.frontier, highWater)
  const time = input.notAfterCreatedAt
  if (time !== undefined && (!Number.isSafeInteger(time) || time < 0))
    throw new ModFunctionError("MODS_CONVERSATION_RECOVERY_CUT")
  const eligible: FunctionConversationRow[] = []
  let frontier = inbox.highWater
  for (const row of inbox.rows) {
    if (time !== undefined && row.createdAt > time) {
      // Do not skip a future row and silently lose its delivery in a later actual turn.
      frontier = eligible.at(-1)?.sequence ?? current.frontier
      break
    }
    eligible.push(row)
  }
  const notes: HumanMessage[] = []
  for (const row of eligible) {
    assertCurrent()
    const note = input.prepareNote
      ? await input.prepareNote(row, target, signal)
      : functionConversationNoteMessage(row, target)
    assertCurrent()
    const checkedNote = input.publish ? (() => {
      const captured = captureNativeMessage(note, () => signal.throwIfAborted())
      if (captured.executionSuppressed || captured.type !== "human" ||
        Object.getPrototypeOf(note) !== HumanMessage.prototype)
        throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
      return constructCapturedNativeMessage(captured.type, { ...captured.data })
    })() : note
    const expected = rowStamp(row, target), received = readFunctionConversationTranscriptStamp(checkedNote)
    if (!HumanMessage.isInstance(checkedNote) || checkedNote.id !== row.uuid || !received ||
      !sameFunctionConversationTranscriptStamp(expected, received))
      throw new ModFunctionError("MODS_CONVERSATION_NOTE_IDENTITY")
    const existing = checkedExisting.filter((message) => message.id === row.uuid)
    if (existing.length) {
      const prior = readFunctionConversationTranscriptStamp(existing[0])
      if (existing.length !== 1 || !HumanMessage.isInstance(existing[0]) || !prior ||
        !sameFunctionConversationTranscriptStamp(prior, received) ||
        JSON.stringify(existing[0].content) !== JSON.stringify(checkedNote.content))
        throw new ModFunctionError("MODS_CONVERSATION_NOTE_IDENTITY")
    } else notes.push(note)
  }
  assertCurrent()
  let publication: FunctionConversationIntakePublication | undefined
  if (input.publish && notes.length) {
    const rows: FunctionConversationRow[] = [], nativeDigests: string[] = []
    for (const note of notes) {
      const captured = captureNativeMessage(note, () => signal.throwIfAborted())
      const row = eligible.find(candidate => candidate.uuid === captured.data.id)
      if (!row || captured.executionSuppressed ||
        serializeFunctionConversationNativeMessage(constructCapturedNativeMessage(
          captured.type, { ...captured.data })) !== row.nativePayload)
        throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
      rows.push(row)
      nativeDigests.push(captured.digest)
    }
    assertCurrent()
    publication = Object.freeze({ [intakePublicationBrand]: true as const })
    intakePublications.set(publication, Object.freeze({ store: input.store, target,
      notes: Object.freeze([...notes]), rows: Object.freeze(rows),
      nativeDigests: Object.freeze(nativeDigests),
      rowDigests: Object.freeze(rows.map(functionConversationRowDigest)),
      highWater, notAfterCreatedAt: time, signal, assertCurrent }))
  }
  assertCurrent()
  return { notes, state: functionConversationState(target, frontier),
    ...(publication ? { publication } : {}) }
}

/** Notes enter through a graph update with their frontier, never a model jump or temporary HTTP list. */
export function createFunctionConversationMiddleware(host: FunctionConversationMiddlewareHost) {
  return createMiddleware({
    name: "functionConversation",
    stateSchema: z.object({ [FUNCTION_CONVERSATION_CHANNEL]: z.unknown().optional() }),
    beforeModel: async (state, runtime) => {
      const raw = state[FUNCTION_CONVERSATION_CHANNEL]
      const previous = raw === undefined ? undefined : readFunctionConversationState(raw)
      const actual = host.capture(runtime, previous)
      if (!actual) {
        if (previous) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
        return undefined
      }
      const binding = Object.freeze({ target: actual.target,
        checkpointThreadId: actual.checkpointThreadId,
        runtimeCheckpointNamespace: actual.runtimeCheckpointNamespace, signal: actual.signal,
        initialState: actual.initialState ? readFunctionConversationState(actual.initialState) : undefined,
        admission: actual.admission ? Object.freeze({ ...actual.admission }) : undefined,
        assertCurrent: actual.assertCurrent.bind(actual) })
      const signal = runtime.signal ? AbortSignal.any([runtime.signal, binding.signal]) : binding.signal
      const threadId = runtime.configurable?.thread_id, namespace = runtime.configurable?.checkpoint_ns ?? ""
      const assertCurrent = () => {
        signal.throwIfAborted()
        binding.assertCurrent()
        host.store.assertCurrent(binding.target)
        if (threadId !== binding.checkpointThreadId || namespace !== binding.runtimeCheckpointNamespace)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      }
      assertCurrent()
      const current = previous ?? binding.initialState
      if (!current) throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
      assertFunctionConversationState(binding.target, current)
      if (!isFunctionConversationModelBoundary(state.messages)) return undefined
      const domain = currentSharedNativeDomainRecord()
      const view = domain?.phase === "ready" ? domain.view : undefined
      const original = view ? domain?.original?.binding : undefined
      view?.assertDataCurrent()
      const sameSharedBinding = () => {
        if (!original || types.isProxy(host) || types.isProxy(actual)) return false
        const store = Object.getOwnPropertyDescriptor(host, "store")
        if (!store || !("value" in store) || store.value !== domain?.factory.options.store)
          return false
        const fields = ["target", "checkpointThreadId", "checkpointIncarnation", "signal",
          "initialState", "admission"]
        for (let index = 0; index < fields.length; index++) {
          const received = Object.getOwnPropertyDescriptor(actual, fields[index])
          const expected = Object.getOwnPropertyDescriptor(original, fields[index])
          if (received && !("value" in received) || expected && !("value" in expected) ||
            received?.value !== expected?.value) return false
        }
        const actualNamespace = Object.getOwnPropertyDescriptor(actual, "runtimeCheckpointNamespace")
        return !!actualNamespace && "value" in actualNamespace && actualNamespace.value === namespace
      }
      const sharedIntake = view && sameSharedBinding() ? view : undefined
      const assertSharedIntakeCurrent = () => {
        if (!sharedIntake) return
        if (currentSharedNativeDomainRecord() !== domain || domain?.phase !== "ready" ||
          domain.view !== sharedIntake)
          throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
        sharedIntake.assertDataCurrent()
        if (!sameSharedBinding())
          throw new ModFunctionError("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
      }
      assertSharedIntakeCurrent()
      const onIntakeNotes = host.onIntakeNotes
      const intake = await prepareFunctionConversationIntake({ store: host.store,
        target: binding.target, state: current, signal, assertCurrent, prepareNote: host.prepareNote,
        publish: onIntakeNotes !== undefined || sharedIntake !== undefined,
        highWater: binding.admission?.highWater,
        notAfterCreatedAt: binding.admission?.notAfterCreatedAt }, state.messages)
      assertCurrent()
      assertSharedIntakeCurrent()
      if (intake.publication) {
        onIntakeNotes?.(intake.publication)
        assertCurrent()
        assertSharedIntakeCurrent()
        if (sharedIntake && onIntakeNotes !== sharedIntake.host.registerIntake)
          sharedIntake.host.registerIntake(intake.publication)
      }
      assertCurrent()
      assertSharedIntakeCurrent()
      if (previous && !intake.notes.length && intake.state.frontier === current.frontier) return undefined
      const update = { [FUNCTION_CONVERSATION_CHANNEL]: intake.state }
      return intake.notes.length ? { ...update, messages: intake.notes } : update
    }
  })
}

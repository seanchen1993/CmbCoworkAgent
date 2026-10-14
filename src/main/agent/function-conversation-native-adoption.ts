import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { FunctionConversationStore, FunctionConversationRow } from
  "../db/function-conversation-store"
import {
  captureFunctionConversationMessageAliasAccess
} from "../db"
import {
  createFunctionConversationNativeProjectionAccess,
  type FunctionNativeProjectionFacts
} from "../db/function-conversation-native-projection"
import {
  createFunctionConversationTranscriptAccess,
  type FunctionConversationTranscriptNativeCapture
} from "../db/function-conversation-transcript"
import type { FunctionNativeFinalExecutionReceipt } from
  "../db/function-conversation-final-execution"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ThreadMessageWrite } from "../types"
import { persistedMessageFromStreamPayload } from "../ipc/stream-transcript-payload"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY,
  STREAM_MESSAGE_TOOL_CALLS_MODE_KEY
} from "../../shared/stream-message-wire-mode"
import type { FunctionNativeRetentionCandidate } from "./function-conversation-native-retainer"
import type { FunctionSessionAppendCommitPlan } from "../mods/v2/session-append-ticket"
import { captureNativeMessage } from "./native-message-capture"
import { functionConversationNativeHumanProjection, projectFunctionConversationNativeHuman,
  functionConversationNativeHumanPresentationAnchor,
  functionConversationNativeHumanPresentationKind,
  type FunctionNativeHumanPresentation } from "./function-conversation-native-human-presentation"
import type { FunctionNativeToolSideProjection } from
  "../db/function-conversation-native-tool-side-projection"
import { readFunctionConversationNativeToolSideCurrent } from
  "./function-conversation-native-tool-side"
import { readFunctionConversationNativeModelCurrent,
  readFunctionConversationNativeSharedToolCurrent } from "./native-model-current"

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_ADOPTION_INVALID")
}

/** Host projection only. Its complete native payload is retained separately without UI clipping. */
function project(message: BaseMessage, row: FunctionConversationRow,
  facts: FunctionNativeProjectionFacts): ThreadMessageWrite {
  captureNativeMessage(message)
  const role = AIMessage.isInstance(message) ? "assistant"
    : ToolMessage.isInstance(message) ? "tool"
      : SystemMessage.isInstance(message) ? "system" : undefined
  if (!role || role !== facts.role || message.id !== facts.uuid) fail()
  const serialized: unknown = JSON.parse(JSON.stringify(message))
  const projected = persistedMessageFromStreamPayload([serialized, {
    [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot",
    ...(role === "system" ? {} : {
      [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot",
      [STREAM_MESSAGE_TOOL_CALLS_MODE_KEY]: "snapshot"
    })
  }])
  const body: ThreadMessageWrite = projected ?? {
    id: facts.uuid, role, content: "", created_at: new Date(row.createdAt)
  }
  const rendering = Array.isArray(row.message.content) ? row.message.content[0] : undefined
  const publicError = ToolMessage.isInstance(message) && rendering &&
    typeof rendering === "object" && !Array.isArray(rendering) &&
    rendering.type === "tool_result" && rendering.is_error === true
  return {
    ...body,
    id: facts.uuid,
    role,
    provider_source_id: facts.providerSourceId,
    provider_occurrence: facts.providerOccurrence,
    created_at: new Date(row.createdAt),
    content_mode: "snapshot",
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(role === "system" ? {} : {
      reasoning_mode: "snapshot" as const,
      tool_calls_mode: "snapshot" as const
    }),
    ...(ToolMessage.isInstance(message) ? {
      tool_call_id: message.tool_call_id,
      name: message.name,
      status: message.status,
      is_error: publicError === true
    } : {})
  }
}

/**
 * Installed by one actual producer after typed capture. No caller-provided stamp, serialized
 * projection or SDK row can replace the original runtime, occurrence or alias capture.
 */
export function createFunctionConversationNativeAdoption(input: {
  readonly runtime: FunctionNativeConversationRuntime
  readonly store: FunctionConversationStore
  readonly producer: object
  readonly occurrence: object
  readonly facts: FunctionNativeProjectionFacts
  readonly nativeHumanPresentation?: FunctionNativeHumanPresentation
  readonly nativeToolSideProjection?: FunctionNativeToolSideProjection
  assertCurrent(): void
  seal(): void
  flush(): void | Promise<void>
}) {
  const runtime = input.runtime, store = input.store
  const producer = input.producer, occurrence = input.occurrence
  const humanPresentation = input.nativeHumanPresentation
  const humanProjection = humanPresentation
    ? functionConversationNativeHumanProjection(humanPresentation) : undefined
  const toolSideProjection = input.nativeToolSideProjection
  if (humanProjection && toolSideProjection) fail()
  const toolHuman = humanPresentation &&
    functionConversationNativeHumanPresentationKind(humanPresentation) === "tool-side"
  const facts = Object.freeze({ ...input.facts })
  const originalCurrent = input.assertCurrent
  const sideCurrent = readFunctionConversationNativeToolSideCurrent(originalCurrent, runtime)
  const certifiedCurrent = sideCurrent ??
    readFunctionConversationNativeModelCurrent(originalCurrent, runtime) ??
    readFunctionConversationNativeSharedToolCurrent(originalCurrent, runtime)
  // A genuine current's mutable own bind/call properties cannot replace its original closure.
  const nativeGuard = certifiedCurrent ? () => originalCurrent() : originalCurrent.bind(input)
  const seal = input.seal.bind(input), flush = input.flush.bind(input)
  const guard = () => {
    if (!certifiedCurrent) runtime.assertCurrent()
    nativeGuard()
    store.assertCurrent(runtime.target.ref)
    certifiedCurrent?.assertTail()
  }
  guard()
  const aliases = captureFunctionConversationMessageAliasAccess({
    threadId: runtime.destination.threadId,
    incarnation: runtime.destination.incarnation,
    uuid: facts.uuid,
    providerSourceId: facts.providerSourceId,
    assertCurrent: guard
  })
  let captured: Promise<FunctionConversationTranscriptNativeCapture> | undefined
  let executionDriver: ((row: FunctionConversationRow) => FunctionNativeFinalExecutionReceipt)
    | undefined
  const captureProjection = (finalExecution?: (row: FunctionConversationRow) =>
    FunctionNativeFinalExecutionReceipt): Promise<FunctionConversationTranscriptNativeCapture> => {
    if (captured) {
      if (finalExecution !== executionDriver) fail()
      return captured
    }
    executionDriver = finalExecution
    let resolve!: (value: FunctionConversationTranscriptNativeCapture) => void
    let reject!: (error: unknown) => void
    // Install once before any native guard, seal or flush can synchronously reenter.
    captured = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
    void captured.catch(() => { /* The original caller still receives the sticky failure. */ })
    try {
      const access = createFunctionConversationNativeProjectionAccess({
      database: runtime.database,
      target: runtime.target.ref,
      threadId: runtime.destination.threadId,
      incarnation: runtime.destination.incarnation,
      producer,
      run: runtime.run,
      signal: runtime.signal,
      ...(humanProjection ? { humanProjection } : {}),
      ...(toolSideProjection ? { toolSideProjection } : {}),
      assertCurrent: guard,
      bindOccurrence(actual) {
        guard()
        if (actual !== occurrence) fail()
        return {
          facts, seal, flush,
          captureAliases: aliases.captureAliases,
          assertAliases: aliases.assertAliases,
          ...(finalExecution ? { finalExecution } : {})
        }
      }
      })
      void access.capture(occurrence).then(receipt => resolve({ access, receipt }), reject)
    } catch (error) { reject(error) }
    return captured
  }
  const prepare = async (candidate: FunctionNativeRetentionCandidate,
    projection: FunctionConversationTranscriptNativeCapture, signal: AbortSignal,
    assertCurrent: () => void): Promise<FunctionSessionAppendCommitPlan> => {
    signal.throwIfAborted()
    if (!captured || await captured !== projection || candidate.projectionOwner !== projection ||
      candidate.producer !== producer || candidate.target !== runtime.target ||
      candidate.uuid !== facts.uuid) fail()
    signal.throwIfAborted()
    guard()
    assertCurrent()
    const transcript = createFunctionConversationTranscriptAccess(
      (_target, row) => humanPresentation
        ? { ...projectFunctionConversationNativeHuman(humanPresentation, candidate.native, row),
          ...(toolHuman ? {} : { provider_source_id: facts.providerSourceId,
            provider_occurrence: facts.providerOccurrence,
            ...(facts.name === undefined ? {} : { name: facts.name }),
            ...(facts.status === undefined ? {} : { status: facts.status }) }) }
        : project(candidate.native, row, facts), runtime.destination,
      ToolMessage.isInstance(candidate.native) ? candidate.native : undefined, projection)
    return {
      commit(check) {
        const presentation = humanPresentation
          ? functionConversationNativeHumanPresentationAnchor(humanPresentation) : undefined
        return store.commit(runtime.target.ref, {
          uuid: facts.uuid,
          inputDigest: candidate.inputDigest,
          door: candidate.door,
          origin: candidate.origin,
          message: candidate.rendering,
          nativePayload: candidate.nativePayload,
          orderAnchor: { kind: "native-producer", uuid: facts.uuid,
            ...(presentation ? { presentation: { ...presentation } } : {}) },
          sdk: false,
          inbox: false
        }, () => { check(); guard() }, transcript.write, transcript.verify)
      },
      read() {
        guard()
        const row = store.readReceipt(runtime.target.ref, facts.uuid)
        if (row) transcript.verify(runtime.database, runtime.target.ref, row)
        guard()
        return row
      }
    }
  }
  return Object.freeze({ captureProjection, prepare })
}

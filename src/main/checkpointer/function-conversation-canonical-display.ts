import { types } from "node:util"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import type { BaseMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  hasInvalidFunctionConversationTranscriptStamp,
  isFunctionConversationHiddenNote,
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { captureNativeMessageForOccurrence, constructCapturedNativeMessage } from
  "../agent/native-message-capture"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import {
  getDb, getThreadCore, getThreadMessages, withCanonicalThreadMessageReadScope,
  type CanonicalThreadMessageReadScope
} from "../db"
import type { FunctionConversationRef, FunctionConversationStore } from
  "../db/function-conversation-store"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation, matchesThreadIncarnation,
  type ThreadIncarnationRow } from "../services/thread-incarnation"
import type { Message, ThreadMessageWrite } from "../types"
import {
  captureConversationCheckpointRead, functionConversationCanonicalStamp,
  functionConversationMembershipDigest, readFunctionConversationCheckpointMembership,
  type FunctionConversationCheckpointMembershipProof,
  type FunctionConversationCheckpointMembershipSnapshot
} from "./function-conversation-checkpoint-membership"
import { assertFunctionConversationState, readFunctionConversationState } from
  "./function-conversation-delivery"
import { SqlJsSaver } from "./sqljs-saver"
import { canonicalDisplayColumnsDigest, canonicalDisplayValueDigest, canonicalCheckpointValueDigest,
  copyCanonicalCheckpointDisplayJson, canonicalCheckpointDisplayMembershipFingerprint,
  createCanonicalCheckpointDisplayOmissionDigest, createCanonicalCheckpointDisplayVerifier,
  readCanonicalCheckpointDisplayMemberRow } from
  "./function-conversation-canonical-display-worker"
import { formatSealedThreadMessageColumns } from "../thread-message-hydration/page-reader"
import type { CanonicalThreadDisplayWitness } from "../thread-message-hydration/protocol"

import { readOrdinaryToolDisplayCoverage, ORDINARY_CHECKPOINT_COVERAGE_BYTE_LIMIT } from
  "./function-conversation-ordinary-display"

const sourceBrand = Symbol("canonical-checkpoint-display-source")
export interface FunctionConversationCanonicalDisplaySource {
  readonly [sourceBrand]: true
}
export interface FunctionConversationCanonicalDisplayView {
  /** A display copy. The original native checkpoint is never changed. */
  readonly checkpoint: Checkpoint
  read(index: number): Message | undefined
  assertCheckpoint(checkpoint: unknown): void
}
export interface FunctionConversationCanonicalDisplayInput {
  readonly database: NativeSqliteAdapter
  readonly store: FunctionConversationStore
  readonly saver: SqlJsSaver
  readonly threadId: string
  readonly workspace: string
  readonly originalThread: ThreadIncarnationRow
  readonly checkpointId: string
  readonly signal: AbortSignal
  assertCurrent(): void
}
interface Capture {
  readonly raw: BaseMessage
  readonly digest: string
  readonly payload: string
  readonly safe: BaseMessage
}
interface Source {
  readonly input: FunctionConversationCanonicalDisplayInput
  readonly tuple: CheckpointTuple
  readonly target: FunctionConversationRef
  readonly proof: FunctionConversationCheckpointMembershipProof
  readonly membership: FunctionConversationCheckpointMembershipSnapshot
  readonly captures: readonly Capture[]
  readonly membershipRows: string
  readonly checkpointDigest: string
  readonly guard: () => void
  active: boolean
}
const sources = new WeakMap<FunctionConversationCanonicalDisplaySource, Source>()
const views = new WeakMap<FunctionConversationCanonicalDisplayView, {
  active: boolean; checkpoint: Checkpoint; messages: Map<number, Message>
}>()

function fail(code = "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"): never {
  throw new ModFunctionError(code)
}

/** Classify already sealed display DTOs before the export adapter drops their native stamp. */
export function selectFunctionConversationCanonicalExportMessages(
  messages: readonly Message[]
): Message[] {
  return messages.filter(message => {
    if (hasInvalidFunctionConversationTranscriptStamp(message)) fail()
    return !isFunctionConversationHiddenNote(message)
  })
}

/** The native transcript read shares its full column/ledger A/B fence with export and merging. */
export function readFunctionConversationCanonicalThreadMessages(threadId: string,
  assertCurrent: () => void): Message[] {
  return withCanonicalThreadMessageReadScope(threadId, reader => {
    reader.runGuard(assertCurrent)
    const messages = getThreadMessages(threadId).flatMap((message): Message[] => {
      const snapshot = reader.readSnapshot(message.id)
      if (!snapshot) {
        if (message.function_row || message.function_row_invalid) fail()
        return [message]
      }
      const presentation = reader.readPresentation(message.id)
      if (!presentation) fail()
      if (presentation.kind !== "visible") return []
      const { content_mode, tool_calls_mode, reasoning_mode, ...display } = snapshot
      void content_mode; void tool_calls_mode; void reasoning_mode
      return [display]
    })
    reader.runGuard(assertCurrent)
    return messages
  })
}

function nativeArray(value: unknown): readonly BaseMessage[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail()
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !("value" in field) || !field.value || typeof field.value !== "object") fail()
  }
  return value
}
function copy(message: BaseMessage, signal: AbortSignal): Capture {
  signal.throwIfAborted()
  const captured = captureNativeMessageForOccurrence(message, "canonical-display-history-copy",
    () => signal.throwIfAborted())
  if (captured.snapshot.executionSuppressed) fail()
  let safe = constructCapturedNativeMessage(captured.snapshot.type, { ...captured.snapshot.data })
  Object.defineProperty(safe, "id", { value: captured.originalId, enumerable: true,
    writable: true, configurable: true })
  if (hasInvalidFunctionConversationTranscriptStamp(safe)) fail()
  const stamp = readFunctionConversationTranscriptStamp(safe)
  const payload = stamp ? serializeFunctionConversationNativeMessage(safe) : JSON.stringify(safe.toDict())
  const additional = captured.snapshot.data.additional_kwargs as Record<string, unknown> | undefined
  const visible = additional?.cmb_visible_user_message
  if (!stamp && captured.snapshot.type === "human" && typeof visible === "string" &&
    visible.length > 0 && visible !== captured.snapshot.data.content) {
    // Keep the full native payload above; only the display copy uses the visible input alias.
    safe = constructCapturedNativeMessage("human", { ...captured.snapshot.data, content: visible })
    Object.defineProperty(safe, "id", { value: captured.originalId, enumerable: true,
      writable: true, configurable: true })
  }
  return { raw: message, digest: captured.originalDigest, safe, payload }
}
function captureMessages(tuple: CheckpointTuple, signal: AbortSignal): readonly Capture[] {
  return nativeArray(tuple.checkpoint.channel_values.messages ?? []).map(message => copy(message, signal))
}
function assertRaw(source: Source): void {
  source.input.signal.throwIfAborted()
  if (checkpointDigest(source.tuple, source.input.signal) !== source.checkpointDigest) fail()
  const messages = nativeArray(source.tuple.checkpoint.channel_values.messages ?? [])
  if (messages.length !== source.captures.length) fail()
  for (let index = 0; index < messages.length; index++) {
    const expected = source.captures[index]
    if (messages[index] !== expected.raw || copy(messages[index], source.input.signal).digest !== expected.digest)
      fail("MODS_CONVERSATION_CHECKPOINT_CHANGED")
  }
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field) return undefined
  if (!("value" in field)) fail()
  return field.value
}
function checkpointDigest(tuple: CheckpointTuple, signal: AbortSignal): string {
  const checkpoint = own(tuple, "checkpoint"), channels = own(checkpoint, "channel_values")
  const config = own(own(tuple, "config"), "configurable")
  const parent = own(tuple, "parentConfig")
  const parentConfig = parent === undefined ? undefined : own(parent, "configurable")
  const facts = { id: own(checkpoint, "id"), ts: own(checkpoint, "ts"),
    state: own(channels, "cmbFunctionConversation") ?? null,
    threadId: own(config, "thread_id"), namespace: own(config, "checkpoint_ns") ?? "",
    checkpointId: own(config, "checkpoint_id"),
    parentThreadId: parentConfig ? own(parentConfig, "thread_id") : null,
    parentNamespace: parentConfig ? own(parentConfig, "checkpoint_ns") ?? "" : null,
    parentCheckpointId: parentConfig ? own(parentConfig, "checkpoint_id") : null,
    nativeCheckpointDigest: canonicalCheckpointValueDigest(checkpoint) }
  return functionConversationMembershipDigest(copyCanonicalCheckpointDisplayJson(facts,
    () => signal.throwIfAborted()))
}

function copiedFields(value: unknown, replacement: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail()
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail()
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field) || !field.enumerable) fail()
    Object.defineProperty(output, key, { value: Object.hasOwn(replacement, key)
      ? replacement[key] : field.value, enumerable: true, writable: true, configurable: true })
  }
  return output
}

/** Pure tail only. No original or consumer-supplied method is called to fingerprint a view. */
function displayCheckpointDigest(checkpoint: Checkpoint, record: Source,
  members: ReadonlyMap<number, unknown>): string {
  const channels = own(checkpoint, "channel_values"), display = own(channels, "messages")
  if (!Array.isArray(display) || types.isProxy(display) ||
    Object.getPrototypeOf(display) !== Array.prototype || display.length !== record.captures.length ||
    Reflect.ownKeys(display).length !== display.length + 1) fail()
  const fingerprints: string[] = []
  for (let index = 0; index < display.length; index++) {
    const field = Object.getOwnPropertyDescriptor(display, String(index))
    if (!field || !("value" in field)) fail()
    if (members.has(index)) fingerprints.push(canonicalDisplayValueDigest(field.value))
    else {
      if (field.value !== record.captures[index].safe) fail()
      fingerprints.push(copy(record.captures[index].safe, record.input.signal).digest)
    }
  }
  return canonicalDisplayValueDigest(copiedFields(checkpoint, { channel_values:
    copiedFields(channels, { messages: fingerprints }) }))
}

/** Called only for evidence from the exact pending native Worker response. */
export function verifyCanonicalThreadDisplayWitnesses(threadId: string,
  witnesses: readonly CanonicalThreadDisplayWitness[], assertCurrent: () => void): void {
  const fingerprint = canonicalDisplayValueDigest(witnesses)
  withCanonicalThreadMessageReadScope(threadId, reader => {
    reader.runGuard(assertCurrent)
    verifyCanonicalThreadDisplayWitnessesInScope(reader, witnesses)
    reader.runGuard(assertCurrent)
  })
  // The exact pending evidence cannot be changed by a synchronous original source callback.
  if (canonicalDisplayValueDigest(witnesses) !== fingerprint) fail()
}

function verifyCanonicalThreadDisplayWitnessesInScope(reader: CanonicalThreadMessageReadScope,
  witnesses: readonly CanonicalThreadDisplayWitness[]): void {
    const seen = new Set<string>()
    for (const witness of witnesses) {
      if (!witness.messageId || seen.has(witness.messageId)) fail()
      seen.add(witness.messageId)
      const columns = reader.readColumns(witness.messageId)
      if (!columns || canonicalDisplayColumnsDigest(columns) !==
        witness.columnsDigest) fail("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      const presentation = reader.readPresentation(witness.messageId)
      if (!presentation || witness.presentation &&
        (presentation.kind !== witness.presentation.kind ||
          presentation.fingerprint !== witness.presentation.fingerprint) ||
        !witness.presentation && presentation.kind !== "visible") fail()
      if (presentation.kind !== "visible") {
        if (witness.display) fail()
        continue
      }
      if (witness.display) {
        const evidence = witness.display
        if (evidence.kind !== "page" && evidence.kind !== "checkpoint" ||
          typeof evidence.digest !== "string" || evidence.kind === "page" &&
          (!Number.isSafeInteger(evidence.byteBudget) || Number(evidence.byteBudget) < 1)) fail()
        const formatted = formatSealedThreadMessageColumns(columns, new Int32Array(1),
          evidence.kind === "page" ? evidence.byteBudget : undefined).message
        const display = evidence.kind === "page" ? formatted : { ...formatted,
          type: formatted.role === "user" ? "human" : formatted.role === "assistant" ? "ai" : formatted.role,
          additional_kwargs: { function_row: formatted.function_row,
            ...(formatted.function_row?.isMeta ? { isMeta: true } : {}) },
          __cmb_checkpoint_raw_index: evidence.rawIndex }
        if (evidence.kind === "checkpoint" && (!Number.isSafeInteger(evidence.rawIndex) ||
          Number(evidence.rawIndex) < 0) || canonicalDisplayValueDigest(display) !== evidence.digest) fail()
      }
    }
}

/** Only the native pending Worker response calls this adapter; JSON does not mint its source. */
export function verifyCanonicalCheckpointWorkerDisplay(value: unknown, threadId: string,
  checkpointId: string, assertCurrent: () => void,
  onCompleteCanonicalTranscript?: () => void): unknown {
  let completeCanonicalTranscript = false
  const fingerprint = canonicalDisplayValueDigest(value)
  const ordinaryCoverage = own(value, "__cmb_ordinary_display_coverage")
  const ordinaryFinalChecks: Array<() => void> = []
  const witnesses = own(value, "__cmb_canonical_display_witnesses")
  const membership = own(value, "__cmb_canonical_display_membership")
  const omissions = own(value, "__cmb_canonical_display_omissions")
  const omissionCount = own(omissions, "count"), omissionDigest = own(omissions, "digest")
  if (typeof omissionCount !== "number" || !Number.isSafeInteger(omissionCount) || omissionCount < 0 ||
    typeof omissionDigest !== "string" || !/^[a-f0-9]{64}$/.test(omissionDigest) ||
    Reflect.ownKeys(omissions as object).length !== 2) fail()
  const checkpoint = own(value, "checkpoint")
  if (own(checkpoint, "id") !== checkpointId || !Array.isArray(witnesses) || types.isProxy(witnesses)) fail()
  const evidence = witnesses.map(witness => {
    const messageId = own(witness, "messageId"), columnsDigest = own(witness, "columnsDigest")
    if (typeof messageId !== "string" || typeof columnsDigest !== "string") fail()
    const display = own(witness, "display")
    const kind = own(display, "kind"), digest = own(display, "digest"), rawIndex = own(display, "rawIndex")
    if (kind !== "checkpoint" || typeof digest !== "string" ||
      typeof rawIndex !== "number" || !Number.isSafeInteger(rawIndex) || rawIndex < 0) fail()
    const messages = own(own(checkpoint, "channel_values"), "messages")
    if (!Array.isArray(messages) || types.isProxy(messages) || !messages.some(message =>
      own(message, "id") === messageId && canonicalDisplayValueDigest(message) === digest)) fail()
    return { messageId, columnsDigest, display: { kind: "checkpoint" as const, digest, rawIndex } }
  })
  const sourceGuard = () => {
    if (assertCurrent() !== undefined) fail("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
    if (membership !== null) {
      const conversationId = own(membership, "conversationId"), branchId = own(membership, "branchId")
      const incarnation = own(membership, "incarnation"), namespace = own(membership, "namespace")
      const fingerprint = own(membership, "fingerprint")
      if (typeof conversationId !== "string" || typeof branchId !== "string" ||
        typeof incarnation !== "string" || namespace !== "" || typeof fingerprint !== "string" ||
        own(membership, "threadId") !== threadId || own(membership, "checkpointId") !== checkpointId ||
        canonicalCheckpointDisplayMembershipFingerprint(getDb(), { conversationId, branchId,
          threadId, incarnation, namespace, checkpointId }) !== fingerprint) fail()
    }
  }
  withCanonicalThreadMessageReadScope(threadId, reader => {
    reader.runGuard(sourceGuard)
    const aggregate = createCanonicalCheckpointDisplayOmissionDigest()
    const hidden = new Set<string>()
    if (membership !== null) {
      const database = getDb(), physical = getThreadCore(threadId)
      if (!physical) fail("MODS_CONVERSATION_THREAD_CHANGED")
      const metadata: unknown = JSON.parse(physical.metadata ?? "{}")
      const workspacePath = own(metadata, "workspacePath")
      if (typeof workspacePath !== "string" || !workspacePath) fail()
      // Independently derive the same native key as ModsManager.workspaceKey.
      // Windows display casing and path aliases are not distinct workspace authorities.
      const realWorkspace = realpathSync(workspacePath)
      const workspace = process.platform === "win32" ? realWorkspace.toLowerCase() : realWorkspace
      const parentConfig = own(value, "parentConfig")
      const parentId = parentConfig === undefined || parentConfig === null ? null :
        own(own(parentConfig, "configurable"), "checkpoint_id")
      const checkpointTs = own(checkpoint, "ts")
      if (typeof checkpointTs !== "string" || !(parentId === null || typeof parentId === "string")) fail()
      const channels = own(checkpoint, "channel_values")
      const stateJson = own(membership, "stateJson")
      if (typeof stateJson !== "string") fail()
      const verifier = createCanonicalCheckpointDisplayVerifier(database, {
        messageDatabasePath: "", threadId, workspace, incarnation: captureThreadIncarnation(physical),
        checkpointId
      }, { checkpointId, namespace: "", checkpointTs, parentCheckpointId: parentId,
        state: JSON.parse(stateJson) }, () => undefined)
      const actual = verifier.membership()
      if (!actual || own(channels, "__cmb_original_message_count") !== actual.snapshot.nativeMessageCount)
        fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
      completeCanonicalTranscript = actual.snapshot.members.length === actual.snapshot.nativeMessageCount
      // Ordinary rows stay ordinary. Complete native payload evidence proves only that the
      // already-durable transcript covers this exact checkpoint, so no migration is needed.
      if (ordinaryCoverage !== undefined && ordinaryCoverage !== null) {
        if (!Array.isArray(ordinaryCoverage) || types.isProxy(ordinaryCoverage)) fail()
        const byOrdinal = new Map<number, { payload: string; messageId: string }>()
        const seenIds = new Set(actual.snapshot.members.map(member => member.uuid))
        const memberOrdinals = new Set(actual.snapshot.members.map(member => member.ordinal))
        let bytes = 0
        for (const entry of ordinaryCoverage) {
          const ordinal = own(entry, "ordinal"), payload = own(entry, "payload")
          const columnsDigest = own(entry, "columnsDigest")
          if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0 ||
            ordinal >= actual.snapshot.nativeMessageCount || byOrdinal.has(ordinal) ||
            memberOrdinals.has(ordinal) ||
            typeof payload !== "string" || typeof columnsDigest !== "string") fail()
          bytes += Buffer.byteLength(payload, "utf8") + 128
          if (bytes > ORDINARY_CHECKPOINT_COVERAGE_BYTE_LIMIT) fail()
          const covered = readOrdinaryToolDisplayCoverage(database, threadId, payload)
          if (!covered || covered.columnsDigest !== columnsDigest || seenIds.has(covered.messageId)) fail()
          if (reader.readColumns(covered.messageId) !== undefined) fail()
          seenIds.add(covered.messageId)
          byOrdinal.set(ordinal, { payload, messageId: covered.messageId })
          ordinaryFinalChecks.push(() => {
            const current = readOrdinaryToolDisplayCoverage(database, threadId, payload)
            if (getDb() !== database || current?.messageId !== covered.messageId ||
              current.columnsDigest !== columnsDigest) fail()
          })
        }
        if (byOrdinal.size) {
          if (byOrdinal.size + actual.snapshot.members.length !== actual.snapshot.nativeMessageCount) fail()
          const digest = createHash("sha256").update("[")
          const members = new Map(actual.snapshot.members.map(member => [member.ordinal, member]))
          for (let ordinal = 0; ordinal < actual.snapshot.nativeMessageCount; ordinal++) {
            const member = members.get(ordinal), ordinary = byOrdinal.get(ordinal)
            const payload = member ? readCanonicalCheckpointDisplayMemberRow(database,
              actual.target, actual.snapshot, member).nativePayload : ordinary?.payload
            if (payload === undefined) fail()
            if (ordinal) digest.update(",")
            digest.update(JSON.stringify(payload))
          }
          if (digest.update("]").digest("hex") !== actual.snapshot.nativeSnapshotDigest)
            fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
          completeCanonicalTranscript = true
        } else if (!completeCanonicalTranscript) fail()
      }
      for (const member of actual.snapshot.members) {
        // One full row at a time: the reader keeps only private fingerprints and ledger receipts.
        readCanonicalCheckpointDisplayMemberRow(database, actual.target, actual.snapshot, member)
        const summary = reader.readPresentationSummary(member.uuid)
        if (!summary) fail()
        if (summary.presentation.kind !== "visible") {
          hidden.add(member.uuid)
          aggregate.append(member.ordinal, member.uuid, summary.columnsDigest, summary.presentation)
        }
      }
      const messages = own(channels, "messages")
      if (!Array.isArray(messages) || types.isProxy(messages)) fail()
      for (const message of messages) {
        const uuid = own(message, "id")
        if (typeof uuid === "string" && hidden.has(uuid)) fail()
        if (hasInvalidFunctionConversationTranscriptStamp(message)) fail()
        if (readFunctionConversationTranscriptStamp(message) && !evidence.some(witness =>
          witness.messageId === uuid && witness.display.rawIndex === own(message, "__cmb_checkpoint_raw_index")))
          fail()
      }
    } else if (evidence.length) fail()
    const expected = aggregate.finish()
    if (expected.count !== omissionCount || expected.digest !== omissionDigest) fail()
    verifyCanonicalThreadDisplayWitnessesInScope(reader, evidence)
    reader.runGuard(sourceGuard)
  })
  // The scope ran the final source callback and canonical B read. Re-read every ordinary
  // column/side-table classification afterwards too; no host callback follows these reads.
  for (const check of ordinaryFinalChecks) check()
  if (canonicalDisplayValueDigest(value) !== fingerprint) fail()
  if (!value || typeof value !== "object") fail()
  const { __cmb_canonical_display_witnesses, __cmb_canonical_display_membership,
    __cmb_canonical_display_omissions, __cmb_ordinary_display_coverage, ...tuple } =
    value as Record<string, unknown>
  void __cmb_canonical_display_witnesses
  void __cmb_canonical_display_membership
  void __cmb_canonical_display_omissions
  void __cmb_ordinary_display_coverage
  // Unknown/uncovered mixed history retains the original fail-closed migration path.
  if (completeCanonicalTranscript) onCompleteCanonicalTranscript?.()
  return tuple
}
/** Exact persisted membership rows, with no callback or public marker interpretation. */
function membershipRows(input: FunctionConversationCanonicalDisplayInput,
  target: FunctionConversationRef, snapshot: FunctionConversationCheckpointMembershipSnapshot): string {
  const result = input.database.exec(`SELECT receipt.receipt_id,receipt.target_json,
    receipt.snapshot_digest,receipt.snapshot_json,member.ordinal,member.uuid,member.member_json
    FROM function_conversation_checkpoint_receipts receipt
    LEFT JOIN function_conversation_checkpoint_members member ON member.receipt_id=receipt.receipt_id
    WHERE receipt.conversation_id=? AND receipt.branch_id=? AND receipt.checkpoint_thread_id=?
    AND receipt.checkpoint_incarnation=? AND receipt.checkpoint_namespace=? AND receipt.checkpoint_id=?
    ORDER BY member.ordinal`, [target.conversationId, target.branchId, snapshot.checkpointThreadId,
    snapshot.checkpointIncarnation, snapshot.namespace, snapshot.checkpointId])[0]
  if (!result || !result.values.length) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  return JSON.stringify(result)
}

/** Call inside the original native Saver borrowing scope. It never creates a data owner or ACK. */
export async function prepareFunctionConversationCanonicalDisplay(input:
  FunctionConversationCanonicalDisplayInput): Promise<FunctionConversationCanonicalDisplaySource | undefined> {
  const database = input.database, incarnation = Object.freeze(captureThreadIncarnation(input.originalThread))
  const originalMetadata = input.originalThread.metadata
  if (getDb() !== database || !input.checkpointId || !input.threadId || !input.workspace) fail()
  await SqlJsSaver.prototype.initialize.call(input.saver)
  const lifetime = SqlJsSaver.prototype.captureReadLifetime.call(input.saver)
  let captures: readonly Capture[] | undefined, tuple: CheckpointTuple | undefined
  const guard = () => {
    input.signal.throwIfAborted()
    if (input.assertCurrent() !== undefined) fail("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
    lifetime()
    const thread = getThreadCore(input.threadId)
    if (getDb() !== database || !matchesThreadIncarnation(thread, incarnation) ||
      thread?.metadata !== originalMetadata) fail("MODS_CONVERSATION_THREAD_CHANGED")
    if (tuple && captures) {
      const expected = captures
      const actual = captureMessages(tuple, input.signal)
      if (actual.length !== expected.length || actual.some((value, index) =>
        value.raw !== expected[index].raw || value.digest !== expected[index].digest))
        fail("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    }
  }
  guard()
  let target: FunctionConversationRef | undefined
  let persisted: FunctionConversationCheckpointMembershipSnapshot | undefined
  const captured = await captureConversationCheckpointRead(input.store, input.saver,
    { configurable: { thread_id: input.threadId, checkpoint_ns: "", checkpoint_id: input.checkpointId } },
    actual => {
      tuple = actual
      captures = captureMessages(actual, input.signal)
      const value = actual.checkpoint.channel_values.cmbFunctionConversation
      if (value === undefined) {
        if (captures.some(value => readFunctionConversationTranscriptStamp(value.safe))) fail()
        return undefined
      }
      const state = readFunctionConversationState(value)
      const main = input.store.findMain({ threadId: input.threadId, workspace: input.workspace,
        incarnation, checkpointNamespace: "" }, guard)
      if (!main) fail("MODS_CONVERSATION_RECOVERY_REQUIRED")
      target = input.store.selectBranch(main, state.branchId, guard)
      assertFunctionConversationState(target, state)
      persisted = input.store.readCheckpointRecoverySnapshot(target, {
        checkpointThreadId: input.threadId, checkpointIncarnation: incarnation,
        checkpointId: input.checkpointId }, guard).snapshot
      return { target, checkpointThreadId: input.threadId, checkpointIncarnation: incarnation,
        cut: persisted.cut, frontier: state.frontier,
        stateDigest: functionConversationMembershipDigest(state), assertCurrent: guard }
    }, guard)
  if (!captured.proof) return undefined
  if (!tuple || !captures || !target || !persisted) fail()
  const membership = readFunctionConversationCheckpointMembership(captured.proof, input.store, target)
  if (membership.snapshotDigest !== persisted.snapshotDigest ||
    functionConversationMembershipDigest(membership) !== functionConversationMembershipDigest(persisted) ||
    functionConversationMembershipDigest(captures.map(value => value.payload)) !== membership.nativeSnapshotDigest)
    fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  guard()
  const source = Object.freeze({ [sourceBrand]: true as const })
  sources.set(source, { input, tuple, target, captures, proof: captured.proof, membership,
    membershipRows: membershipRows(input, target, membership),
    checkpointDigest: checkpointDigest(tuple, input.signal), guard, active: false })
  return source
}

function displayMessage(snapshot: ThreadMessageWrite): Message {
  const { content_mode, tool_calls_mode, reasoning_mode, ...message } = snapshot
  void content_mode
  void tool_calls_mode
  void reasoning_mode
  return structuredClone(message)
}

/** Formatting is synchronous. Every callback is before fresh B; saved/clone views cannot be read. */
export function withFunctionConversationCanonicalDisplay<T>(source:
  FunctionConversationCanonicalDisplaySource, run: (view: FunctionConversationCanonicalDisplayView) => T): T {
  const record = sources.get(source)
  if (!record || record.active) fail()
  record.active = true
  let view: FunctionConversationCanonicalDisplayView | undefined
  try {
    return withCanonicalThreadMessageReadScope(record.input.threadId, reader => {
      reader.runGuard(record.guard)
      const messages = new Map<number, Message>(), members = new Map(record.membership.members.map(
        member => [member.ordinal, member]))
      const display = record.captures.map((capture, index) => {
        const member = members.get(index), stamp = readFunctionConversationTranscriptStamp(capture.safe)
        if (!member) {
          if (stamp) fail()
          return capture.safe
        }
        const row = reader.runGuard(() => record.input.store.readCheckpointMember(record.target,
          record.proof, member.uuid, record.guard))
        if (!stamp || capture.safe.id !== member.uuid || capture.payload !== row.nativePayload ||
          !sameFunctionConversationTranscriptStamp(stamp, functionConversationCanonicalStamp(record.target, row)))
          fail()
        const snapshot = reader.readSnapshot(member.uuid)
        if (!snapshot || !snapshot.function_row ||
          !sameFunctionConversationTranscriptStamp(snapshot.function_row, stamp)) fail()
        const presentation = reader.readPresentation(member.uuid)
        if (!presentation) fail()
        // Preserve the native ordinal without making an omitted Human ordinary again.
        if (presentation.kind !== "visible") return null
        const message = displayMessage(snapshot)
        messages.set(index, message)
        return { ...message, type: message.role === "user" ? "human" :
          message.role === "assistant" ? "ai" : message.role,
        additional_kwargs: { function_row: stamp, ...(stamp.isMeta ? { isMeta: true } : {}) } }
      })
      const displayChannels = copiedFields(record.tuple.checkpoint.channel_values, { messages: display })
      // Internal scheduling inputs are resume data, not public conversation history.
      Reflect.deleteProperty(displayChannels, "__pregel_tasks")
      Reflect.deleteProperty(displayChannels, "__start__")
      const checkpoint: Checkpoint = { ...record.tuple.checkpoint, channel_values: displayChannels }
      const displayDigest = displayCheckpointDigest(checkpoint, record, members)
      view = Object.freeze({ checkpoint,
        read(index: number) {
          const actual = views.get(this)
          if (!actual?.active || !Number.isSafeInteger(index)) fail()
          const message = actual.messages.get(index)
          return message ? structuredClone(message) : undefined
        },
        assertCheckpoint(value: unknown) {
          const actual = views.get(this)
          if (!actual?.active || actual.checkpoint !== value) fail()
        } })
      views.set(view, { active: true, checkpoint, messages })
      const actualView = view
      const result = reader.runGuard(() => run(actualView))
      reader.runGuard(() => {
        record.guard()
        const current = readFunctionConversationCheckpointMembership(record.proof, record.input.store,
          record.target)
        if (current !== record.membership) fail()
      })
      // Pure checks only after the final source callback. The outer reader performs fresh B.
      assertRaw(record)
      if (membershipRows(record.input, record.target, record.membership) !== record.membershipRows ||
        displayCheckpointDigest(checkpoint, record, members) !== displayDigest ||
        getDb() !== record.input.database)
        fail()
      return result
    })
  } finally {
    record.active = false
    if (view) {
      const state = views.get(view)
      if (state) state.active = false
    }
  }
}

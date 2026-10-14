import {
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type {
  FunctionConversationTranscriptVerifier,
  FunctionConversationTranscriptWriter,
  FunctionConversationRef,
  FunctionConversationRow
} from "./function-conversation-store"
import {
  getDb,
  getThreadCore,
  projectFunctionConversationThreadMessageStorageColumns,
  upsertThreadMessagesInTransaction,
  writeFunctionConversationNativeProjectionInTransaction
} from "./index"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"
import type { ThreadMessageWrite } from "../types"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import { ToolMessage } from "@langchain/core/messages"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import {
  FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  recordFunctionConversationProjectionReceipt,
  readFunctionConversationProjectionReceipt
} from "./function-conversation-projection-receipt"
import { recordFunctionConversationPresentationDisposition,
  readFunctionConversationPresentationDisposition } from "./function-conversation-presentation-disposition"
import { readStoredFunctionConversationProjection,
  withFunctionConversationProjectionReadScope } from "./function-conversation-projection-read"
import type {
  createFunctionConversationNativeProjectionAccess,
  FunctionNativeProjectionReceipt,
  FunctionNativeProjectionPreparation
} from "./function-conversation-native-projection"

type Project = (target: FunctionConversationRef, row: FunctionConversationRow) => ThreadMessageWrite
const transcriptBind = Function.prototype.bind

/** An actual native transcript destination, captured once for this admission. */
export interface FunctionConversationTranscriptProjection {
  readonly conversation: FunctionConversationRef
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  assertCurrent(): void
}

/** The original producer's private capture. Never derived from a public stamp or SDK arguments. */
export interface FunctionConversationTranscriptNativeCapture {
  readonly access: ReturnType<typeof createFunctionConversationNativeProjectionAccess>
  readonly receipt: FunctionNativeProjectionReceipt
}

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_TRANSCRIPT_NOT_COMMITTED")
}

function assertConnection(database: NativeSqliteAdapter): void {
  // The projection and keeper must share the actual app SQLite transaction.
  if (database !== getDb()) fail()
}

function stamp(
  target: FunctionConversationRef,
  row: FunctionConversationRow
): FunctionConversationTranscriptStamp {
  const value = {
    conversationId: target.conversationId,
    branchId: row.branchId,
    uuid: row.uuid,
    sequence: row.sequence,
    door: row.door,
    messageType: row.message.type,
    ...(row.message.isMeta === true ? { isMeta: true } : {}),
    origin: row.origin
  }
  validateFunctionConversationTranscriptStamp(value)
  return value
}

function storedRow(
  database: NativeSqliteAdapter,
  threadId: string,
  row: FunctionConversationRow
): Record<string, NativeSqliteValue> | undefined {
  const statement = database.prepare(
    "SELECT * FROM thread_messages WHERE thread_id = ? AND message_id = ?"
  )
  statement.bind([threadId, row.uuid])
  try {
    return statement.step() ? statement.getAsObject() : undefined
  } finally {
    statement.free()
  }
}

function readStamp(value: NativeSqliteValue | undefined): FunctionConversationTranscriptStamp {
  if (typeof value !== "string") fail()
  const parsed: unknown = JSON.parse(value)
  validateFunctionConversationTranscriptStamp(parsed)
  return parsed
}

/** Host projection only. The complete model payload remains in the canonical keeper row. */
export function createFunctionConversationTranscriptAccess(
  project: Project,
  destination?: FunctionConversationTranscriptProjection,
  nativeTool?: ToolMessage,
  nativeProjection?: FunctionConversationTranscriptNativeCapture
): {
  write: FunctionConversationTranscriptWriter
  verify: FunctionConversationTranscriptVerifier
} {
  if (nativeTool && !ToolMessage.isInstance(nativeTool)) fail()
  const tool = nativeTool
    ? Object.freeze({
        uuid: nativeTool.id,
        toolCallId: nativeTool.tool_call_id,
        payload: serializeFunctionConversationNativeMessage(nativeTool)
      })
    : undefined
  const native = nativeProjection
    ? Object.freeze({
        receipt: nativeProjection.receipt,
        access: Object.freeze({
          prepare: nativeProjection.access.prepare.bind(nativeProjection.access),
          claim: nativeProjection.access.claim.bind(nativeProjection.access),
          assertPrepared: nativeProjection.access.assertPrepared.bind(nativeProjection.access),
          verify: nativeProjection.access.verify.bind(nativeProjection.access)
        })
      })
    : undefined
  let prepared: FunctionNativeProjectionPreparation | undefined
  const captured = destination
    ? Object.freeze({
        conversation: Object.freeze({
          ...destination.conversation,
          incarnation: Object.freeze({ ...destination.conversation.incarnation })
        }),
        threadId: destination.threadId,
        incarnation: Object.freeze({ ...destination.incarnation }),
        assertCurrent: Reflect.apply(transcriptBind, destination.assertCurrent, [destination]) as () => void
      })
    : undefined
  const destinationThread = (target: FunctionConversationRef): string => {
    const actual = captured?.conversation
    if (
      actual &&
      (target.logicalSessionId !== actual.logicalSessionId ||
        target.conversationId !== actual.conversationId ||
        target.branchId !== actual.branchId ||
        target.kind !== actual.kind ||
        target.threadId !== actual.threadId ||
        target.workspace !== actual.workspace ||
        target.checkpointNamespace !== actual.checkpointNamespace ||
        target.incarnation.token !== actual.incarnation.token ||
        target.incarnation.legacyCreatedAt !== actual.incarnation.legacyCreatedAt)
    )
      fail()
    if (!captured && target.kind !== "main") fail()
    const threadId = captured?.threadId ?? target.threadId
    if (
      typeof threadId !== "string" ||
      !threadId ||
      (target.kind === "main" ? threadId !== target.threadId : threadId === target.threadId)
    )
      fail()
    captured?.assertCurrent()
    if (
      !matchesThreadIncarnation(
        getThreadCore(threadId),
        captured?.incarnation ?? target.incarnation
      )
    )
      fail()
    return threadId
  }
  const expected = (target: FunctionConversationRef, row: FunctionConversationRow) => {
    const threadId = destinationThread(target)
    const projected = project(target, row)
    const input = { ...projected, created_at: projected.created_at ?? new Date(row.createdAt) }
    if (input.id !== row.uuid) fail()
    if (tool) {
      const content = row.message.content
      if (
        tool.uuid !== row.uuid ||
        row.nativePayload !== tool.payload ||
        row.message.type !== "user" ||
        row.message.isMeta === true ||
        !["tool-result", "tool-message"].includes(row.door) ||
        !Array.isArray(content) ||
        content.length !== 1 ||
        !content[0] ||
        typeof content[0] !== "object" ||
        Array.isArray(content[0]) ||
        content[0].type !== "tool_result" ||
        content[0].tool_use_id !== tool.toolCallId ||
        input.role !== "tool" ||
        input.tool_call_id !== tool.toolCallId
      )
        fail()
    } else if (input.role === "tool") fail()
    const fields = projectFunctionConversationThreadMessageStorageColumns(input, row.createdAt)
    if (fields.message_id !== row.uuid) fail()
    return { input, fields, stamp: stamp(target, row), threadId }
  }

  const verifyExpected: FunctionConversationTranscriptVerifier = (database, target, row) => {
    assertConnection(database)
    const projection = expected(target, row)
    const actual = storedRow(database, projection.threadId, row)
    if (
      !actual ||
      !sameFunctionConversationTranscriptStamp(
        readStamp(actual.function_row_json),
        projection.stamp
      )
    )
      fail()
    const fields = { thread_id: projection.threadId, ...projection.fields }
    if (Object.entries(fields).some(([key, item]) => actual[key] !== item)) fail()
    if (!Number.isSafeInteger(actual.ordinal) || Number(actual.ordinal) < 0) fail()
    // Live renderer echoes and forged provider identities cannot substitute for this projection.
    const fragments = database.exec(
      "SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id = ? AND message_id = ?",
      [projection.threadId, row.uuid]
    )[0]?.values[0]?.[0]
    if (fragments !== 0) fail()
  }

  const receiptSelection = (target: FunctionConversationRef, row: FunctionConversationRow) => ({
    target,
    row,
    threadId: destinationThread(target),
    incarnation: captured?.incarnation ?? target.incarnation,
    assertCurrent: () => {
      destinationThread(target)
    }
  })
  const verifyTail = (database: NativeSqliteAdapter,
    selection: ReturnType<typeof receiptSelection>) => {
    // Capture the destination before the original checks. No owner/projector callback may run
    // after this full raw-column/ledger A/B fence or before its caller publishes the ACK.
    assertConnection(database)
    withFunctionConversationProjectionReadScope(database, scope => {
      const columns = readStoredFunctionConversationProjection(database, {
        threadId: selection.threadId, incarnation: selection.incarnation,
        messageId: selection.row.uuid, assertCurrent: () => undefined
      }, scope)
      const actual = readFunctionConversationProjectionReceipt(database, {
        ...selection, assertCurrent: () => undefined })
      if (FUNCTION_CONVERSATION_PROJECTION_COLUMNS.some(key => columns[key] !== actual[key])) fail()
      assertConnection(database)
    })
  }
  const verify: FunctionConversationTranscriptVerifier = (database, target, row) => {
    if (native) {
      assertConnection(database)
      if (!prepared) fail()
      destinationThread(target)
      native.access.assertPrepared(prepared.claim)
      const selection = receiptSelection(target, row)
      const columns = readFunctionConversationProjectionReceipt(database, selection)
      readFunctionConversationPresentationDisposition(database, selection, columns)
      if (!database.inTransaction) native.access.verify(prepared.claim)
      verifyTail(database, selection)
      return
    }
    verifyExpected(database, target, row)
    const selection = receiptSelection(target, row)
    const columns = readFunctionConversationProjectionReceipt(database, selection)
    readFunctionConversationPresentationDisposition(database, selection, columns)
    verifyTail(database, selection)
  }

  return {
    write(database, target, row) {
      assertConnection(database)
      if (!database.inTransaction) fail()
      const projection = expected(target, row)
      if (native) {
        if (prepared) fail()
        prepared = writeFunctionConversationNativeProjectionInTransaction({
          database,
          threadId: projection.threadId,
          message: projection.input,
          target,
          row,
          hostFunctionRow: {
            messageId: row.uuid,
            stamp: projection.stamp,
            ...(tool ? { storageRole: "tool", toolCallId: tool.toolCallId } : {})
          },
          access: native.access,
          receipt: native.receipt
        })
        recordFunctionConversationProjectionReceipt(database, receiptSelection(target, row))
        const selection = receiptSelection(target, row)
        recordFunctionConversationPresentationDisposition(database, selection,
          readFunctionConversationProjectionReceipt(database, selection))
        verify(database, target, row)
        return
      }
      const existing = storedRow(database, projection.threadId, row)
      if (existing) {
        verify(database, target, row)
        return
      }
      upsertThreadMessagesInTransaction(projection.threadId, [projection.input], {
        preserveExistingOrder: true,
        hostFunctionRow: {
          messageId: row.uuid,
          stamp: projection.stamp,
          ...(tool ? { storageRole: "tool", toolCallId: tool.toolCallId } : {})
        }
      })
      verifyExpected(database, target, row)
      recordFunctionConversationProjectionReceipt(database, receiptSelection(target, row))
      const selection = receiptSelection(target, row)
      recordFunctionConversationPresentationDisposition(database, selection,
        readFunctionConversationProjectionReceipt(database, selection))
      verify(database, target, row)
    },
    verify
  }
}

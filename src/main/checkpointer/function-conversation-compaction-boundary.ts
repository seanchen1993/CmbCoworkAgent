import type { RunnableConfig } from "@langchain/core/runnables"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import { ModControlStore } from "../mods/control-store"
import { captureConversationCheckpointRead, functionConversationMembershipDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCheckpointMembershipSnapshot } from "./function-conversation-checkpoint-membership"
import { readFunctionConversationState, assertFunctionConversationState,
  type FunctionConversationDeliveryBinding } from "./function-conversation-delivery"
import { SqlJsSaver } from "./sqljs-saver"

interface Host {
  readonly saver: SqlJsSaver
  readonly store: FunctionConversationStore
  readonly control: ModControlStore
  readonly database: NativeSqliteAdapter
  readonly binding: FunctionConversationDeliveryBinding
}
const sourceBrand = Symbol("host-compaction-source")
export interface FunctionConversationCompactionSource { readonly [sourceBrand]: true }
interface Boundary {
  readonly version: 1
  readonly target: string
  readonly sourceCheckpointId: string
  readonly sourceSnapshotDigest: string
  readonly destinationCheckpointId: string
  readonly destinationSnapshotDigest: string
  readonly destinationCheckpointDigest: string
  readonly uuid: string
  readonly rowDigest: string
  readonly rowReceiptId: string
  readonly projectionDigest: string
}
const sources = new WeakMap<FunctionConversationCompactionSource, {
  host: Host
  source: FunctionConversationCheckpointMembershipSnapshot
  boundary: Omit<Boundary, "destinationCheckpointId" | "destinationSnapshotDigest" | "destinationCheckpointDigest">
}>()
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set
const weakDelete = WeakMap.prototype.delete, apply = Reflect.apply
const getSetting = ModControlStore.prototype.getSetting
const setSetting = ModControlStore.prototype.setSetting
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BOUNDARY") }
const targetKey = ({ binding: { target } }: Host) => JSON.stringify({
  threadId: target.threadId, workspace: target.workspace, incarnation: target.incarnation,
  checkpointNamespace: target.checkpointNamespace, logicalSessionId: target.logicalSessionId,
  conversationId: target.conversationId, branchId: target.branchId, kind: target.kind
})
const settingKey = (host: Host) => `host-compaction-boundary:${host.binding.checkpointThreadId}`
function guard(host: Host): void {
  host.binding.signal.throwIfAborted()
  host.binding.assertCurrent()
  host.store.assertCurrent(host.binding.target)
  host.binding.signal.throwIfAborted()
}
async function verified(host: Host, config: RunnableConfig) {
  guard(host)
  const { binding, store } = host
  const incarnation = binding.checkpointIncarnation ?? binding.target.incarnation
  let saved: ReturnType<FunctionConversationStore["readCheckpointRecoverySnapshot"]> | undefined
  const captured = await captureConversationCheckpointRead(store, host.saver, config, tuple => {
    const state = readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
    assertFunctionConversationState(binding.target, state)
    saved = store.readCheckpointRecoverySnapshot(binding.target, {
      checkpointThreadId: binding.checkpointThreadId, checkpointIncarnation: incarnation,
      checkpointId: tuple.checkpoint.id
    }, () => guard(host))
    return { target: binding.target, checkpointThreadId: binding.checkpointThreadId,
      checkpointIncarnation: incarnation, cut: saved.snapshot.cut, frontier: state.frontier,
      stateDigest: functionConversationMembershipDigest(state), assertCurrent: () => guard(host) }
  }, () => guard(host))
  if (!captured.proof || !captured.tuple || !saved) fail()
  const snapshot = readFunctionConversationCheckpointMembership(captured.proof, store, binding.target)
  if (functionConversationMembershipDigest(snapshot) !== functionConversationMembershipDigest(saved.snapshot)) fail()
  guard(host)
  return { tuple: captured.tuple, snapshot, rows: saved.rows }
}
function projectionDigest(host: Host, uuid: string): string {
  const columns = assertStoredProjectionReceipt(host.database, {
    threadId: host.binding.checkpointThreadId,
    incarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
    messageId: uuid, assertCurrent: () => guard(host)
  })
  if (columns.message_id !== uuid || !["user", "assistant"].includes(String(columns.role))) fail()
  return functionConversationMembershipDigest(columns)
}

/** Only a genuine checkpoint/member read can mint a source; SDK JSON cannot create this token. */
export async function captureFunctionConversationCompactionSource(
  host: Host, config: RunnableConfig
): Promise<FunctionConversationCompactionSource> {
  const original = await verified(host, config)
  const member = original.snapshot.members.at(-1)
  // An unrepresented trailing native/legacy message has no trustworthy SQL boundary.
  if (!member || member.ordinal !== original.snapshot.nativeMessageCount - 1) fail()
  const row = original.rows.at(-1)
  if (!row || row.uuid !== member.uuid || row.receiptId !== member.rowReceiptId ||
    row.message.isMeta === true || !["user", "assistant"].includes(String(row.message.type))) fail()
  const source = Object.freeze({ [sourceBrand]: true as const })
  apply(weakSet, sources, [source, { host, source: original.snapshot, boundary: {
    version: 1, target: targetKey(host), sourceCheckpointId: original.snapshot.checkpointId,
    sourceSnapshotDigest: original.snapshot.snapshotDigest, uuid: row.uuid,
    rowDigest: member.rowDigest, rowReceiptId: row.receiptId,
    projectionDigest: projectionDigest(host, row.uuid)
  } }])
  return source
}

/**
 * The host calls this only after its private plan and durable summary readback both succeed.
 * This receipt supports reopening after SDK success. A crash between checkpoint COMMIT and
 * membership/ledger persistence remains an unknown outcome: preserve the archive and fail
 * closed without treating a public summary marker as recovery authority.
 */
export async function commitFunctionConversationCompactionBoundary(
  source: FunctionConversationCompactionSource, config: RunnableConfig
): Promise<void> {
  const original = apply(weakGet, sources, [source]) as ReturnType<typeof sources.get>
  if (!original) fail()
  apply(weakDelete, sources, [source])
  const destination = await verified(original.host, config)
  if (destination.snapshot.parentCheckpointId !== original.source.checkpointId) fail()
  const record: Boundary = { ...original.boundary,
    destinationCheckpointId: destination.snapshot.checkpointId,
    destinationSnapshotDigest: destination.snapshot.snapshotDigest,
    destinationCheckpointDigest: functionConversationMembershipDigest(destination.tuple.checkpoint) }
  guard(original.host)
  // mods_meta is a host-only namespace. SDK $.store is confined to mods_function_state;
  // a public summary marker or guest store key cannot manufacture a covered prefix.
  apply(setSetting, original.host.control, [settingKey(original.host), JSON.stringify(record)])
  guard(original.host)
}

/** A host-only ledger and exact native membership authenticate a compacted SQL prefix. */
export async function readFunctionConversationCompactionBoundary(
  host: Host, tuple: CheckpointTuple
): Promise<string | undefined> {
  guard(host)
  const raw = apply(getSetting, host.control, [settingKey(host), ""]) as string
  if (!raw) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail() }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  const record = value as Boundary
  // A later ordinary checkpoint has its own visible boundary. Never apply an older anchor.
  if (record.destinationCheckpointId !== tuple.checkpoint.id) return undefined
  if (record.version !== 1 || record.target !== targetKey(host)) fail()
  const current = await verified(host, tuple.config)
  if (current.snapshot.snapshotDigest !== record.destinationSnapshotDigest ||
    functionConversationMembershipDigest(current.tuple.checkpoint) !== record.destinationCheckpointDigest ||
    functionConversationMembershipDigest(current.tuple.checkpoint) !==
      functionConversationMembershipDigest(tuple.checkpoint)) fail()
  const saved = host.store.readCheckpointRecoverySnapshot(host.binding.target, {
    checkpointThreadId: host.binding.checkpointThreadId,
    checkpointIncarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
    checkpointId: record.sourceCheckpointId
  }, () => guard(host))
  const member = saved.snapshot.members.at(-1)
  if (saved.snapshot.snapshotDigest !== record.sourceSnapshotDigest ||
    current.snapshot.parentCheckpointId !== record.sourceCheckpointId ||
    !member || member.ordinal !== saved.snapshot.nativeMessageCount - 1 ||
    member.uuid !== record.uuid || member.rowReceiptId !== record.rowReceiptId ||
    member.rowDigest !== record.rowDigest || projectionDigest(host, record.uuid) !== record.projectionDigest) fail()
  guard(host)
  return record.uuid
}

import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationRef } from "../db/function-conversation-store"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { FunctionConversationCheckpointMembershipSnapshot } from
  "./function-conversation-checkpoint-membership"

/** Exact persisted evidence, compared before/after display; it never authorizes a row. */
export function captureCanonicalCheckpointMembershipEvidence(
  database: NativeSqliteAdapter,
  target: Pick<FunctionConversationRef, "conversationId" | "branchId">,
  snapshot: Pick<FunctionConversationCheckpointMembershipSnapshot,
    "checkpointThreadId" | "checkpointIncarnation" | "namespace" | "checkpointId">
): string {
  // Do not JOIN the full snapshot JSON onto every member: that duplicates O(N)
  // receipt bytes N times. Keep exactly the same receipt/member facts separately.
  const receipt = database.exec(`SELECT receipt_id,target_json,snapshot_digest,snapshot_json
    FROM function_conversation_checkpoint_receipts
    WHERE conversation_id=? AND branch_id=? AND checkpoint_thread_id=?
    AND checkpoint_incarnation=? AND checkpoint_namespace=? AND checkpoint_id=?`, [
    target.conversationId, target.branchId, snapshot.checkpointThreadId,
    snapshot.checkpointIncarnation, snapshot.namespace, snapshot.checkpointId
  ])[0]
  if (!receipt || receipt.values.length !== 1)
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  const members = database.exec(`SELECT ordinal,uuid,member_json
    FROM function_conversation_checkpoint_members WHERE receipt_id=? ORDER BY ordinal`, [
    receipt.values[0][0]
  ])[0] ?? null
  return JSON.stringify({ receipt, members })
}

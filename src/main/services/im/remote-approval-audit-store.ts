import { randomUUID } from "node:crypto"
import { flushStrict, getDb, saveToDisk } from "../../db"
import type { ImPersistenceDependencies } from "./persistence"
import { readAll, readOne } from "./persistence"

export interface ImRemoteApprovalAuditRecord {
  auditId: string
  requestId: string
  toolCallId: string
  threadId: string
  principalId: string
  conversationKey: string
  deviceEpoch: number
  operation: string
  decision: "approve" | "reject"
  summary: string
  createdAt: number
}

interface AuditRow {
  audit_id: string
  request_id: string
  tool_call_id: string
  thread_id: string
  principal_id: string
  conversation_key: string
  device_epoch: number
  operation: string
  decision: "approve" | "reject"
  summary: string
  created_at: number
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function hydrate(row: AuditRow): ImRemoteApprovalAuditRecord {
  return {
    auditId: row.audit_id,
    requestId: row.request_id,
    toolCallId: row.tool_call_id,
    threadId: row.thread_id,
    principalId: row.principal_id,
    conversationKey: row.conversation_key,
    deviceEpoch: Number(row.device_epoch),
    operation: row.operation,
    decision: row.decision,
    summary: row.summary,
    createdAt: Number(row.created_at)
  }
}

export class ImRemoteApprovalAuditStore {
  constructor(
    private readonly dependencies: ImPersistenceDependencies,
    private readonly createId: () => string = randomUUID
  ) {}

  getByRequestId(requestId: string): ImRemoteApprovalAuditRecord | null {
    const row = readOne<AuditRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_remote_approval_audit WHERE request_id = ?",
      [required(requestId, "requestId")]
    )
    return row ? hydrate(row) : null
  }

  listThread(threadId: string, limit = 50): ImRemoteApprovalAuditRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("limit must be between 1 and 200")
    }
    return readAll<AuditRow>(
      this.dependencies.getDatabase(),
      `SELECT * FROM im_remote_approval_audit
       WHERE thread_id = ? ORDER BY created_at DESC, audit_id DESC LIMIT ?`,
      [required(threadId, "threadId"), limit]
    ).map(hydrate)
  }

  async remove(requestId: string): Promise<void> {
    this.dependencies
      .getDatabase()
      .run("DELETE FROM im_remote_approval_audit WHERE request_id = ?", [
        required(requestId, "requestId")
      ])
    if (this.dependencies.getDatabase().getRowsModified() > 0) {
      this.dependencies.markDirty()
    }
    await this.dependencies.flushStrict()
  }

  async record(
    input: Omit<ImRemoteApprovalAuditRecord, "auditId" | "createdAt">
  ): Promise<ImRemoteApprovalAuditRecord> {
    const existing = this.getByRequestId(input.requestId)
    if (existing) {
      if (
        existing.decision !== input.decision ||
        existing.toolCallId !== input.toolCallId ||
        existing.threadId !== input.threadId ||
        existing.principalId !== input.principalId ||
        existing.conversationKey !== input.conversationKey ||
        existing.deviceEpoch !== input.deviceEpoch ||
        existing.operation !== input.operation ||
        existing.summary !== input.summary
      ) {
        throw new Error("remote approval audit idempotency conflict")
      }
      await this.dependencies.flushStrict()
      return existing
    }
    if (!Number.isSafeInteger(input.deviceEpoch) || input.deviceEpoch < 1) {
      throw new Error("deviceEpoch must be a positive integer")
    }
    const auditId = this.createId()
    const createdAt = this.dependencies.now()
    this.dependencies.getDatabase().run(
      `INSERT INTO im_remote_approval_audit (
         audit_id, request_id, tool_call_id, thread_id, principal_id, conversation_key,
         device_epoch, operation, decision, summary, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        required(input.requestId, "requestId"),
        required(input.toolCallId, "toolCallId"),
        required(input.threadId, "threadId"),
        required(input.principalId, "principalId"),
        required(input.conversationKey, "conversationKey"),
        input.deviceEpoch,
        required(input.operation, "operation"),
        input.decision,
        required(input.summary, "summary"),
        createdAt
      ]
    )
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.getByRequestId(input.requestId)!
  }
}

export const imRemoteApprovalAuditStore = new ImRemoteApprovalAuditStore({
  getDatabase: getDb,
  markDirty: saveToDisk,
  flushStrict,
  now: Date.now
})

import { flushStrict, getDb, saveToDisk } from "../../db"
import type { ImPersistenceDependencies } from "./persistence"
import { readAll, readOne, withImTransaction } from "./persistence"

export type ImConversationState = "active" | "suspended" | "revoked"
export type ImTargetState = "pending" | "active" | "suspended" | "revoked"

export type ImTargetSnapshot =
  | {
      kind: "inbox"
      targetId: string
      threadId: string
      workspacePath: string
    }
  | {
      kind: "feature"
      targetId: string
      bindingId: string
      /** Missing only on pre-grant V1 rows; such targets fail capability checks. */
      grantId?: string
      grantVersion?: number
      projectId: string
      featureSlug: string
      projectName?: string
      featureTitle?: string
      threadId: string
      workspacePath: string
    }
  | {
      kind: "thread"
      targetId: string
      grantId: string
      grantVersion: number
      threadId: string
      title: string
      workspacePath: string
    }

export interface ImConversationRecord {
  conversationKey: string
  principalId: string
  deviceEpoch: number
  activeTargetId: string | null
  state: ImConversationState
  lastReceivedSeq: number
  createdAt: number
  updatedAt: number
}

interface ImConversationRow {
  conversation_key: string
  principal_id: string
  device_epoch: number
  active_target_id: string | null
  state: ImConversationState
  last_received_seq: number
  created_at: number
  updated_at: number
}

interface ImTargetRow {
  target_id: string
  conversation_key: string
  kind: "inbox" | "feature" | "thread"
  thread_id: string
  binding_id: string | null
  grant_id: string | null
  grant_version: number | null
  project_id: string | null
  feature_slug: string | null
  project_name: string | null
  feature_title: string | null
  thread_title: string | null
  workspace_path: string
  state: ImTargetState
  suspend_reason: string | null
  created_at: number
  updated_at: number
}

export class ImConversationStateError extends Error {
  constructor(
    readonly code:
      | "CONVERSATION_NOT_FOUND"
      | "PRINCIPAL_MISMATCH"
      | "DEVICE_EPOCH_MISMATCH"
      | "CONVERSATION_REVOKED"
      | "TARGET_NOT_FOUND"
      | "TARGET_NOT_ACTIVE"
      | "TARGET_IDENTITY_CONFLICT",
    message: string
  ) {
    super(message)
    this.name = "ImConversationStateError"
  }
}

function required(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function hydrateConversation(row: ImConversationRow): ImConversationRecord {
  return {
    conversationKey: row.conversation_key,
    principalId: row.principal_id,
    deviceEpoch: Number(row.device_epoch),
    activeTargetId: row.active_target_id ?? null,
    state: row.state,
    lastReceivedSeq: Number(row.last_received_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function targetSnapshot(row: ImTargetRow): ImTargetSnapshot {
  if (row.kind === "inbox") {
    return {
      kind: "inbox",
      targetId: row.target_id,
      threadId: row.thread_id,
      workspacePath: row.workspace_path
    }
  }
  if (row.kind === "thread") {
    if (!row.grant_id || !row.grant_version || !row.thread_title) {
      throw new ImConversationStateError(
        "TARGET_IDENTITY_CONFLICT",
        "Thread target identity is incomplete"
      )
    }
    return {
      kind: "thread",
      targetId: row.target_id,
      grantId: row.grant_id,
      grantVersion: Number(row.grant_version),
      threadId: row.thread_id,
      title: row.thread_title,
      workspacePath: row.workspace_path
    }
  }
  if (!row.binding_id || !row.project_id || !row.feature_slug) {
    throw new ImConversationStateError(
      "TARGET_IDENTITY_CONFLICT",
      "Feature target identity is incomplete"
    )
  }
  return {
    kind: "feature",
    targetId: row.target_id,
    bindingId: row.binding_id,
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.grant_version ? { grantVersion: Number(row.grant_version) } : {}),
    projectId: row.project_id,
    featureSlug: row.feature_slug,
    ...(row.project_name ? { projectName: row.project_name } : {}),
    ...(row.feature_title ? { featureTitle: row.feature_title } : {}),
    threadId: row.thread_id,
    workspacePath: row.workspace_path
  }
}

function sameTarget(row: ImTargetRow, candidate: ImTargetSnapshot): boolean {
  return (
    row.kind === candidate.kind &&
    row.target_id === candidate.targetId &&
    row.thread_id === candidate.threadId &&
    row.workspace_path === candidate.workspacePath &&
    (candidate.kind === "inbox" ||
      (candidate.kind === "thread"
        ? row.grant_id === candidate.grantId &&
          Number(row.grant_version) === candidate.grantVersion &&
          row.thread_title === candidate.title
        : row.binding_id === candidate.bindingId &&
          (row.grant_id ?? undefined) === candidate.grantId &&
          (row.grant_version === null ? undefined : Number(row.grant_version)) ===
            candidate.grantVersion &&
        row.project_id === candidate.projectId &&
        row.feature_slug === candidate.featureSlug &&
        (row.project_name ?? undefined) === candidate.projectName &&
          (row.feature_title ?? undefined) === candidate.featureTitle))
  )
}

export class ImConversationStateStore {
  constructor(private readonly dependencies: ImPersistenceDependencies) {}

  getConversation(conversationKey: string): ImConversationRecord | null {
    const row = readOne<ImConversationRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_conversations WHERE conversation_key = ?",
      [conversationKey]
    )
    return row ? hydrateConversation(row) : null
  }

  listConversations(): ImConversationRecord[] {
    return readAll<ImConversationRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_conversations ORDER BY updated_at DESC, conversation_key ASC"
    ).map(hydrateConversation)
  }

  async ensureConversation(input: {
    conversationKey: string
    principalId: string
    deviceEpoch: number
  }): Promise<{ created: boolean; conversation: ImConversationRecord }> {
    const conversationKey = required(input.conversationKey, "conversationKey")
    const principalId = required(input.principalId, "principalId")
    if (!Number.isSafeInteger(input.deviceEpoch) || input.deviceEpoch < 1) {
      throw new Error("deviceEpoch must be a positive integer")
    }
    const database = this.dependencies.getDatabase()
    const existing = readOne<ImConversationRow>(
      database,
      "SELECT * FROM im_conversations WHERE conversation_key = ?",
      [conversationKey]
    )
    if (existing) {
      this.assertRoute(existing, principalId, input.deviceEpoch)
      await this.dependencies.flushStrict()
      return { created: false, conversation: hydrateConversation(existing) }
    }

    const now = this.dependencies.now()
    database.run(
      `INSERT INTO im_conversations (
         conversation_key, principal_id, device_epoch, active_target_id, state,
         last_received_seq, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'active', 0, ?, ?)`,
      [conversationKey, principalId, input.deviceEpoch, now, now]
    )
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return {
      created: true,
      conversation: hydrateConversation({
        conversation_key: conversationKey,
        principal_id: principalId,
        device_epoch: input.deviceEpoch,
        active_target_id: null,
        state: "active",
        last_received_seq: 0,
        created_at: now,
        updated_at: now
      })
    }
  }

  assertCurrentRoute(conversationKey: string, principalId: string, deviceEpoch: number): void {
    const row = readOne<ImConversationRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_conversations WHERE conversation_key = ?",
      [conversationKey]
    )
    if (!row) {
      throw new ImConversationStateError("CONVERSATION_NOT_FOUND", "Conversation is unknown")
    }
    this.assertRoute(row, principalId, deviceEpoch)
  }

  getActiveTarget(conversationKey: string): ImTargetSnapshot | null {
    const row = readOne<ImTargetRow>(
      this.dependencies.getDatabase(),
      `SELECT target.*
       FROM im_conversations conversation
       JOIN im_targets target ON target.target_id = conversation.active_target_id
       WHERE conversation.conversation_key = ?`,
      [conversationKey]
    )
    if (!row) return null
    if (row.state !== "active") {
      throw new ImConversationStateError("TARGET_NOT_ACTIVE", "Active target is unavailable")
    }
    return targetSnapshot(row)
  }

  getSelectedTarget(conversationKey: string): {
    snapshot: ImTargetSnapshot
    state: ImTargetState
    suspendReason: string | null
  } | null {
    const row = readOne<ImTargetRow>(
      this.dependencies.getDatabase(),
      `SELECT target.*
       FROM im_conversations conversation
       JOIN im_targets target ON target.target_id = conversation.active_target_id
       WHERE conversation.conversation_key = ?`,
      [conversationKey]
    )
    if (!row) return null
    return {
      snapshot: targetSnapshot(row),
      state: row.state,
      suspendReason: row.suspend_reason ?? null
    }
  }

  listTargets(conversationKey: string): Array<{
    snapshot: ImTargetSnapshot
    state: ImTargetState
    suspendReason: string | null
  }> {
    return readAll<ImTargetRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_targets WHERE conversation_key = ? ORDER BY created_at ASC, target_id ASC",
      [conversationKey]
    ).map((row) => ({
      snapshot: targetSnapshot(row),
      state: row.state,
      suspendReason: row.suspend_reason ?? null
    }))
  }

  async registerTarget(
    conversationKey: string,
    target: ImTargetSnapshot,
    options: { activate?: boolean; state?: ImTargetState } = {}
  ): Promise<{ created: boolean; snapshot: ImTargetSnapshot }> {
    required(conversationKey, "conversationKey")
    required(target.targetId, "targetId")
    required(target.threadId, "threadId")
    required(target.workspacePath, "workspacePath")
    if (target.kind === "feature") {
      required(target.bindingId, "bindingId")
      required(target.projectId, "projectId")
      required(target.featureSlug, "featureSlug")
    } else if (target.kind === "thread") {
      required(target.grantId, "grantId")
      required(target.title, "title")
      if (!Number.isSafeInteger(target.grantVersion) || target.grantVersion < 1) {
        throw new Error("grantVersion must be a positive integer")
      }
    }
    const database = this.dependencies.getDatabase()
    const conversation = readOne<ImConversationRow>(
      database,
      "SELECT * FROM im_conversations WHERE conversation_key = ?",
      [conversationKey]
    )
    if (!conversation) {
      throw new ImConversationStateError("CONVERSATION_NOT_FOUND", "Conversation is unknown")
    }
    if (conversation.state === "revoked") {
      throw new ImConversationStateError("CONVERSATION_REVOKED", "Conversation is revoked")
    }

    const existing = readOne<ImTargetRow>(
      database,
      "SELECT * FROM im_targets WHERE target_id = ?",
      [target.targetId]
    )
    if (
      existing &&
      (existing.conversation_key !== conversationKey || !sameTarget(existing, target))
    ) {
      throw new ImConversationStateError(
        "TARGET_IDENTITY_CONFLICT",
        "Target id is already bound to another immutable identity"
      )
    }

    const state = options.state ?? "active"
    const now = this.dependencies.now()
    withImTransaction(database, () => {
      if (!existing) {
        database.run(
          `INSERT INTO im_targets (
             target_id, conversation_key, kind, thread_id, binding_id, grant_id,
             grant_version, project_id, feature_slug, project_name, feature_title,
             thread_title, workspace_path, state,
             suspend_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            target.targetId,
            conversationKey,
            target.kind,
            target.threadId,
            target.kind === "feature" ? target.bindingId : null,
            target.kind === "inbox" ? null : (target.grantId ?? null),
            target.kind === "inbox" ? null : (target.grantVersion ?? null),
            target.kind === "feature" ? target.projectId : null,
            target.kind === "feature" ? target.featureSlug : null,
            target.kind === "feature" ? (target.projectName ?? null) : null,
            target.kind === "feature" ? (target.featureTitle ?? null) : null,
            target.kind === "thread" ? target.title : null,
            target.workspacePath,
            state,
            now,
            now
          ]
        )
        if (target.kind === "feature") {
          database.run(
            `INSERT INTO im_feature_bindings (
               binding_id, conversation_key, target_id, project_id, feature_slug,
               thread_id, workspace_path, state, suspend_reason, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
              target.bindingId,
              conversationKey,
              target.targetId,
              target.projectId,
              target.featureSlug,
              target.threadId,
              target.workspacePath,
              state,
              now,
              now
            ]
          )
        }
      }
      if (options.activate === true) {
        if (state !== "active") {
          throw new ImConversationStateError("TARGET_NOT_ACTIVE", "Cannot activate this target")
        }
        database.run(
          "UPDATE im_conversations SET active_target_id = ?, updated_at = ? WHERE conversation_key = ?",
          [target.targetId, now, conversationKey]
        )
      }
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return { created: !existing, snapshot: { ...target } }
  }

  async setActiveTarget(conversationKey: string, targetId: string): Promise<ImTargetSnapshot> {
    const database = this.dependencies.getDatabase()
    const target = readOne<ImTargetRow>(
      database,
      "SELECT * FROM im_targets WHERE target_id = ? AND conversation_key = ?",
      [targetId, conversationKey]
    )
    if (!target) throw new ImConversationStateError("TARGET_NOT_FOUND", "Target is unknown")
    if (target.state !== "active") {
      throw new ImConversationStateError("TARGET_NOT_ACTIVE", "Target is unavailable")
    }
    database.run(
      "UPDATE im_conversations SET active_target_id = ?, updated_at = ? WHERE conversation_key = ? AND state = 'active'",
      [targetId, this.dependencies.now(), conversationKey]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImConversationStateError("CONVERSATION_REVOKED", "Conversation is unavailable")
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return targetSnapshot(target)
  }

  /**
   * Refresh the mutable grant fence for an already-known remote target. Queued
   * events retain their old snapshot and therefore fail closed after this update.
   */
  async refreshGrantTarget(input: {
    targetId: string
    grantId: string
    grantVersion: number
    workspacePath: string
    title?: string
    activate?: boolean
  }): Promise<ImTargetSnapshot> {
    required(input.targetId, "targetId")
    required(input.grantId, "grantId")
    required(input.workspacePath, "workspacePath")
    if (!Number.isSafeInteger(input.grantVersion) || input.grantVersion < 1) {
      throw new Error("grantVersion must be a positive integer")
    }
    const database = this.dependencies.getDatabase()
    const existing = readOne<ImTargetRow>(database, "SELECT * FROM im_targets WHERE target_id = ?", [
      input.targetId
    ])
    if (!existing) throw new ImConversationStateError("TARGET_NOT_FOUND", "Target is unknown")
    if (existing.kind === "inbox") {
      throw new ImConversationStateError(
        "TARGET_IDENTITY_CONFLICT",
        "Inbox target cannot carry a remote grant"
      )
    }
    if (existing.kind === "thread" && !input.title?.trim()) {
      throw new Error("title is required for a Thread target")
    }
    const now = this.dependencies.now()
    withImTransaction(database, () => {
      database.run(
        `UPDATE im_targets
         SET grant_id = ?, grant_version = ?, thread_title = ?, workspace_path = ?,
             state = 'active', suspend_reason = NULL, updated_at = ?
         WHERE target_id = ?`,
        [
          input.grantId,
          input.grantVersion,
          existing.kind === "thread" ? input.title!.trim() : existing.thread_title,
          input.workspacePath,
          now,
          input.targetId
        ]
      )
      if (existing.kind === "feature") {
        database.run(
          `UPDATE im_feature_bindings
           SET workspace_path = ?, state = 'active', suspend_reason = NULL, updated_at = ?
           WHERE target_id = ?`,
          [input.workspacePath, now, input.targetId]
        )
      }
      if (input.activate) {
        database.run(
          `UPDATE im_conversations
           SET active_target_id = ?, updated_at = ?
           WHERE conversation_key = ? AND state = 'active'`,
          [input.targetId, now, existing.conversation_key]
        )
        if (database.getRowsModified() !== 1) {
          throw new ImConversationStateError("CONVERSATION_REVOKED", "Conversation is unavailable")
        }
      }
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    const refreshed = readOne<ImTargetRow>(
      database,
      "SELECT * FROM im_targets WHERE target_id = ?",
      [input.targetId]
    )
    if (!refreshed) throw new ImConversationStateError("TARGET_NOT_FOUND", "Target is unknown")
    return targetSnapshot(refreshed)
  }

  async updateTargetState(
    targetId: string,
    state: ImTargetState,
    suspendReason?: string
  ): Promise<void> {
    const database = this.dependencies.getDatabase()
    const now = this.dependencies.now()
    withImTransaction(database, () => {
      database.run(
        "UPDATE im_targets SET state = ?, suspend_reason = ?, updated_at = ? WHERE target_id = ?",
        [
          state,
          state === "suspended" ? suspendReason?.trim() || "unavailable" : null,
          now,
          targetId
        ]
      )
      if (database.getRowsModified() !== 1) {
        throw new ImConversationStateError("TARGET_NOT_FOUND", "Target is unknown")
      }
      database.run(
        "UPDATE im_feature_bindings SET state = ?, suspend_reason = ?, updated_at = ? WHERE target_id = ?",
        [
          state,
          state === "suspended" ? suspendReason?.trim() || "unavailable" : null,
          now,
          targetId
        ]
      )
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
  }

  async resetForDeviceTakeover(
    conversationKey: string,
    expectedDeviceEpoch: number,
    nextDeviceEpoch: number
  ): Promise<void> {
    if (nextDeviceEpoch <= expectedDeviceEpoch) throw new Error("nextDeviceEpoch must increase")
    const database = this.dependencies.getDatabase()
    const now = this.dependencies.now()
    withImTransaction(database, () => {
      database.run(
        `UPDATE im_conversations
         SET device_epoch = ?, active_target_id = NULL, state = 'active', updated_at = ?
         WHERE conversation_key = ? AND device_epoch = ?`,
        [nextDeviceEpoch, now, conversationKey, expectedDeviceEpoch]
      )
      if (database.getRowsModified() !== 1) {
        throw new ImConversationStateError("DEVICE_EPOCH_MISMATCH", "Conversation epoch changed")
      }
      database.run(
        `UPDATE im_targets
         SET state = 'revoked', suspend_reason = NULL, updated_at = ?
         WHERE conversation_key = ? AND state != 'revoked'`,
        [now, conversationKey]
      )
      database.run(
        `UPDATE im_feature_bindings
         SET state = 'revoked', suspend_reason = NULL, updated_at = ?
         WHERE conversation_key = ? AND state != 'revoked'`,
        [now, conversationKey]
      )
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
  }

  private assertRoute(row: ImConversationRow, principalId: string, deviceEpoch: number): void {
    if (row.principal_id !== principalId) {
      throw new ImConversationStateError("PRINCIPAL_MISMATCH", "Conversation principal differs")
    }
    if (Number(row.device_epoch) !== deviceEpoch) {
      throw new ImConversationStateError(
        "DEVICE_EPOCH_MISMATCH",
        "Conversation device epoch differs"
      )
    }
    if (row.state === "revoked") {
      throw new ImConversationStateError("CONVERSATION_REVOKED", "Conversation is revoked")
    }
  }
}

export const imConversationStateStore = new ImConversationStateStore({
  getDatabase: getDb,
  markDirty: saveToDisk,
  flushStrict,
  now: Date.now
})

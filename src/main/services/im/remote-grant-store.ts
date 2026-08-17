import { randomUUID } from "node:crypto"
import { flushStrict, getDb, saveToDisk } from "../../db"
import type { ImPersistenceDependencies } from "./persistence"
import { readAll, readOne } from "./persistence"

export type ImRemoteGrantState = "active" | "suspended" | "revoked"

export interface ImGrantRouteIdentity {
  principalId: string
  conversationKey: string
}

export interface ImFeatureGrantIdentity {
  principalId: string
}

export interface ImThreadGrantRecord extends ImGrantRouteIdentity {
  kind: "thread"
  grantId: string
  threadId: string
  titleSnapshot: string
  state: ImRemoteGrantState
  grantVersion: number
  suspendReason: string | null
  createdAt: number
  updatedAt: number
  revokedAt: number | null
}

export interface ImFeatureGrantRecord extends ImFeatureGrantIdentity {
  kind: "feature"
  grantId: string
  projectId: string
  featureSlug: string
  projectNameSnapshot: string
  featureTitleSnapshot: string
  state: ImRemoteGrantState
  grantVersion: number
  suspendReason: string | null
  createdAt: number
  updatedAt: number
  revokedAt: number | null
}

interface ThreadGrantRow {
  grant_id: string
  principal_id: string
  conversation_key: string
  thread_id: string
  title_snapshot: string
  state: ImRemoteGrantState
  grant_version: number
  suspend_reason: string | null
  created_at: number
  updated_at: number
  revoked_at: number | null
}

interface FeatureGrantRow {
  grant_id: string
  principal_id: string
  project_id: string
  feature_slug: string
  project_name_snapshot: string
  feature_title_snapshot: string
  state: ImRemoteGrantState
  grant_version: number
  suspend_reason: string | null
  created_at: number
  updated_at: number
  revoked_at: number | null
}

export class ImRemoteGrantError extends Error {
  constructor(
    readonly code:
      | "GRANT_NOT_FOUND"
      | "GRANT_INACTIVE"
      | "GRANT_VERSION_MISMATCH"
      | "GRANT_ROUTE_MISMATCH",
    message: string
  ) {
    super(message)
    this.name = "ImRemoteGrantError"
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function route(input: ImGrantRouteIdentity): ImGrantRouteIdentity {
  return {
    principalId: required(input.principalId, "principalId"),
    conversationKey: required(input.conversationKey, "conversationKey")
  }
}

function featureIdentity(input: ImFeatureGrantIdentity): ImFeatureGrantIdentity {
  return { principalId: required(input.principalId, "principalId") }
}

function hydrateThread(row: ThreadGrantRow): ImThreadGrantRecord {
  return {
    kind: "thread",
    grantId: row.grant_id,
    principalId: row.principal_id,
    conversationKey: row.conversation_key,
    threadId: row.thread_id,
    titleSnapshot: row.title_snapshot,
    state: row.state,
    grantVersion: Number(row.grant_version),
    suspendReason: row.suspend_reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  }
}

function hydrateFeature(row: FeatureGrantRow): ImFeatureGrantRecord {
  return {
    kind: "feature",
    grantId: row.grant_id,
    principalId: row.principal_id,
    projectId: row.project_id,
    featureSlug: row.feature_slug,
    projectNameSnapshot: row.project_name_snapshot,
    featureTitleSnapshot: row.feature_title_snapshot,
    state: row.state,
    grantVersion: Number(row.grant_version),
    suspendReason: row.suspend_reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  }
}

function sameRoute(left: ImGrantRouteIdentity, right: ImGrantRouteIdentity): boolean {
  return left.principalId === right.principalId && left.conversationKey === right.conversationKey
}

export class ImRemoteGrantStore {
  constructor(
    private readonly dependencies: ImPersistenceDependencies,
    private readonly createId: () => string = randomUUID
  ) {}

  getThreadGrant(threadId: string): ImThreadGrantRecord | null {
    const row = readOne<ThreadGrantRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_thread_grants WHERE thread_id = ?",
      [required(threadId, "threadId")]
    )
    return row ? hydrateThread(row) : null
  }

  getThreadGrantById(grantId: string): ImThreadGrantRecord | null {
    const row = readOne<ThreadGrantRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_thread_grants WHERE grant_id = ?",
      [required(grantId, "grantId")]
    )
    return row ? hydrateThread(row) : null
  }

  getFeatureGrant(projectId: string, featureSlug: string): ImFeatureGrantRecord | null {
    const row = readOne<FeatureGrantRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_feature_grants WHERE project_id = ? AND feature_slug = ?",
      [required(projectId, "projectId"), required(featureSlug, "featureSlug")]
    )
    return row ? hydrateFeature(row) : null
  }

  getFeatureGrantById(grantId: string): ImFeatureGrantRecord | null {
    const row = readOne<FeatureGrantRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_feature_grants WHERE grant_id = ?",
      [required(grantId, "grantId")]
    )
    return row ? hydrateFeature(row) : null
  }

  listThreadGrants(conversationKey?: string): ImThreadGrantRecord[] {
    const database = this.dependencies.getDatabase()
    return readAll<ThreadGrantRow>(
      database,
      conversationKey
        ? "SELECT * FROM im_thread_grants WHERE conversation_key = ? ORDER BY updated_at DESC, grant_id ASC"
        : "SELECT * FROM im_thread_grants ORDER BY updated_at DESC, grant_id ASC",
      conversationKey ? [required(conversationKey, "conversationKey")] : []
    ).map(hydrateThread)
  }

  listFeatureGrants(principalId?: string): ImFeatureGrantRecord[] {
    const database = this.dependencies.getDatabase()
    return readAll<FeatureGrantRow>(
      database,
      principalId
        ? "SELECT * FROM im_feature_grants WHERE principal_id = ? ORDER BY updated_at DESC, grant_id ASC"
        : "SELECT * FROM im_feature_grants ORDER BY updated_at DESC, grant_id ASC",
      principalId ? [required(principalId, "principalId")] : []
    ).map(hydrateFeature)
  }

  async enableThreadGrant(input: {
    route: ImGrantRouteIdentity
    threadId: string
    title: string
  }): Promise<ImThreadGrantRecord> {
    const identity = route(input.route)
    const threadId = required(input.threadId, "threadId")
    const title = required(input.title, "title")
    const database = this.dependencies.getDatabase()
    const existing = this.getThreadGrant(threadId)
    const now = this.dependencies.now()
    if (!existing) {
      database.run(
        `INSERT INTO im_thread_grants (
           grant_id, principal_id, conversation_key, thread_id,
           title_snapshot, state, grant_version, suspend_reason, created_at, updated_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, 'active', 1, NULL, ?, ?, NULL)`,
        [this.createId(), identity.principalId, identity.conversationKey, threadId, title, now, now]
      )
    } else {
      database.run(
        `UPDATE im_thread_grants
         SET principal_id = ?, conversation_key = ?, title_snapshot = ?,
             state = 'active', grant_version = grant_version + 1, suspend_reason = NULL,
             updated_at = ?, revoked_at = NULL
         WHERE grant_id = ?`,
        [identity.principalId, identity.conversationKey, title, now, existing.grantId]
      )
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.getThreadGrant(threadId)!
  }

  async enableFeatureGrant(input: {
    principalId: string
    projectId: string
    featureSlug: string
    projectName: string
    featureTitle: string
  }): Promise<ImFeatureGrantRecord> {
    const identity = featureIdentity(input)
    const projectId = required(input.projectId, "projectId")
    const featureSlug = required(input.featureSlug, "featureSlug")
    const projectName = required(input.projectName, "projectName")
    const featureTitle = required(input.featureTitle, "featureTitle")
    const database = this.dependencies.getDatabase()
    const existing = this.getFeatureGrant(projectId, featureSlug)
    const now = this.dependencies.now()
    if (!existing) {
      database.run(
        `INSERT INTO im_feature_grants (
           grant_id, principal_id, project_id, feature_slug,
           project_name_snapshot, feature_title_snapshot, state, grant_version,
           suspend_reason, created_at, updated_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, NULL, ?, ?, NULL)`,
        [
          this.createId(),
          identity.principalId,
          projectId,
          featureSlug,
          projectName,
          featureTitle,
          now,
          now
        ]
      )
    } else {
      database.run(
        `UPDATE im_feature_grants
         SET principal_id = ?, project_name_snapshot = ?, feature_title_snapshot = ?, state = 'active',
             grant_version = grant_version + 1, suspend_reason = NULL,
             updated_at = ?, revoked_at = NULL
         WHERE grant_id = ?`,
        [identity.principalId, projectName, featureTitle, now, existing.grantId]
      )
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.getFeatureGrant(projectId, featureSlug)!
  }

  async revokeThreadGrant(threadId: string): Promise<ImThreadGrantRecord | null> {
    const existing = this.getThreadGrant(threadId)
    if (!existing || existing.state === "revoked") {
      await this.dependencies.flushStrict()
      return existing
    }
    await this.updateGrantState("thread", existing.grantId, "revoked")
    return this.getThreadGrant(threadId)
  }

  async revokeFeatureGrant(
    projectId: string,
    featureSlug: string
  ): Promise<ImFeatureGrantRecord | null> {
    const existing = this.getFeatureGrant(projectId, featureSlug)
    if (!existing || existing.state === "revoked") {
      await this.dependencies.flushStrict()
      return existing
    }
    await this.updateGrantState("feature", existing.grantId, "revoked")
    return this.getFeatureGrant(projectId, featureSlug)
  }

  async suspendGrant(
    kind: "thread" | "feature",
    grantId: string,
    reasonCode: string
  ): Promise<void> {
    await this.updateGrantState(kind, grantId, "suspended", required(reasonCode, "reasonCode"))
  }

  assertActiveThreadGrant(input: {
    grantId: string
    grantVersion: number
    route: ImGrantRouteIdentity
    threadId: string
  }): ImThreadGrantRecord {
    const grant = this.getThreadGrantById(input.grantId)
    this.assertActive(grant, input.grantVersion)
    if (!sameRoute(grant!, route(input.route))) {
      throw new ImRemoteGrantError("GRANT_ROUTE_MISMATCH", "Remote grant route changed")
    }
    if (grant!.threadId !== input.threadId) {
      throw new ImRemoteGrantError("GRANT_ROUTE_MISMATCH", "Thread grant target differs")
    }
    return grant!
  }

  assertActiveFeatureGrant(input: {
    grantId: string
    grantVersion: number
    principalId: string
    projectId: string
    featureSlug: string
  }): ImFeatureGrantRecord {
    const grant = this.getFeatureGrantById(input.grantId)
    this.assertActive(grant, input.grantVersion)
    if (grant!.principalId !== required(input.principalId, "principalId")) {
      throw new ImRemoteGrantError("GRANT_ROUTE_MISMATCH", "Feature grant principal changed")
    }
    if (grant!.projectId !== input.projectId || grant!.featureSlug !== input.featureSlug) {
      throw new ImRemoteGrantError("GRANT_ROUTE_MISMATCH", "Feature grant target differs")
    }
    return grant!
  }

  private assertActive(
    grant: ImThreadGrantRecord | ImFeatureGrantRecord | null,
    expectedVersion: number
  ): void {
    if (!grant) throw new ImRemoteGrantError("GRANT_NOT_FOUND", "Remote grant is missing")
    if (grant.state !== "active") {
      throw new ImRemoteGrantError("GRANT_INACTIVE", "Remote grant is not active")
    }
    if (grant.grantVersion !== expectedVersion) {
      throw new ImRemoteGrantError("GRANT_VERSION_MISMATCH", "Remote grant version changed")
    }
  }

  private async updateGrantState(
    kind: "thread" | "feature",
    grantId: string,
    state: ImRemoteGrantState,
    suspendReason?: string
  ): Promise<void> {
    const table = kind === "thread" ? "im_thread_grants" : "im_feature_grants"
    const database = this.dependencies.getDatabase()
    const now = this.dependencies.now()
    database.run(
      `UPDATE ${table}
       SET state = ?, grant_version = grant_version + 1, suspend_reason = ?,
           updated_at = ?, revoked_at = ?
       WHERE grant_id = ?`,
      [
        state,
        state === "suspended" ? (suspendReason ?? "unavailable") : null,
        now,
        state === "revoked" ? now : null,
        required(grantId, "grantId")
      ]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImRemoteGrantError("GRANT_NOT_FOUND", "Remote grant is missing")
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
  }
}

export const imRemoteGrantStore = new ImRemoteGrantStore({
  getDatabase: getDb,
  markDirty: saveToDisk,
  flushStrict,
  now: Date.now
})

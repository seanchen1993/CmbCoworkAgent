import { randomUUID } from "node:crypto"
import { flushStrict, getDb, saveToDisk } from "../../db"
import type { ImPersistenceDependencies } from "./persistence"
import { readOne, withImTransaction } from "./persistence"

export type ImSelectionKind = "project" | "feature" | "remote_target"

export interface ImSelectionCandidate {
  id: string
  label: string
  targetKind?: "thread_grant" | "feature_grant"
  grantId?: string
  grantVersion?: number
}

export interface ImSelectionContext {
  token: string
  conversationKey: string
  kind: ImSelectionKind
  candidates: ImSelectionCandidate[]
  expiresAt: number
  createdAt: number
}

interface ImSelectionContextRow {
  token: string
  conversation_key: string
  kind: ImSelectionKind
  candidates_json: string
  expires_at: number
  created_at: number
}

export class ImSelectionContextError extends Error {
  constructor(
    readonly code: "SELECTION_MISSING" | "SELECTION_EXPIRED" | "SELECTION_INDEX_INVALID",
    message: string
  ) {
    super(message)
    this.name = "ImSelectionContextError"
  }
}

function candidatesFromRow(row: ImSelectionContextRow): ImSelectionCandidate[] {
  try {
    const value = JSON.parse(row.candidates_json) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(
      (candidate): candidate is ImSelectionCandidate =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        typeof (candidate as ImSelectionCandidate).id === "string" &&
        typeof (candidate as ImSelectionCandidate).label === "string"
    )
  } catch {
    return []
  }
}

function hydrate(row: ImSelectionContextRow): ImSelectionContext {
  return {
    token: row.token,
    conversationKey: row.conversation_key,
    kind: row.kind,
    candidates: candidatesFromRow(row),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at)
  }
}

export class ImSelectionContextStore {
  constructor(
    private readonly dependencies: ImPersistenceDependencies,
    private readonly createToken: () => string = randomUUID,
    private readonly ttlMs = 5 * 60_000
  ) {}

  async create(
    conversationKey: string,
    kind: ImSelectionKind,
    candidates: readonly ImSelectionCandidate[]
  ): Promise<ImSelectionContext> {
    if (!conversationKey.trim()) throw new Error("conversationKey is required")
    if (candidates.length === 0) throw new Error("selection candidates are required")
    const normalized = candidates.map((candidate) => ({
      id: candidate.id.trim(),
      label: candidate.label.trim(),
      ...(candidate.targetKind ? { targetKind: candidate.targetKind } : {}),
      ...(candidate.grantId ? { grantId: candidate.grantId.trim() } : {}),
      ...(candidate.grantVersion !== undefined
        ? { grantVersion: candidate.grantVersion }
        : {})
    }))
    if (normalized.some((candidate) => !candidate.id || !candidate.label)) {
      throw new Error("selection candidate id and label are required")
    }
    const token = this.createToken()
    const now = this.dependencies.now()
    const expiresAt = now + this.ttlMs
    const database = this.dependencies.getDatabase()
    withImTransaction(database, () => {
      // A new list invalidates every older numbered list for this conversation.
      database.run("DELETE FROM im_selection_contexts WHERE conversation_key = ?", [
        conversationKey
      ])
      database.run(
        `INSERT INTO im_selection_contexts (
           token, conversation_key, kind, candidates_json, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [token, conversationKey, kind, JSON.stringify(normalized), expiresAt, now]
      )
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return { token, conversationKey, kind, candidates: normalized, expiresAt, createdAt: now }
  }

  async select(
    conversationKey: string,
    kind: ImSelectionKind,
    oneBasedIndex: number
  ): Promise<ImSelectionCandidate> {
    const database = this.dependencies.getDatabase()
    const row = readOne<ImSelectionContextRow>(
      database,
      `SELECT * FROM im_selection_contexts
       WHERE conversation_key = ? AND kind = ?
       ORDER BY created_at DESC LIMIT 1`,
      [conversationKey, kind]
    )
    if (!row) {
      throw new ImSelectionContextError(
        "SELECTION_MISSING",
        kind === "project"
          ? "请先发送 /项目 获取最新项目编号。"
          : kind === "feature"
            ? "请先发送 /功能 获取最新 Feature 编号。"
            : "请先发送 /会话 获取最新会话编号。"
      )
    }
    if (Number(row.expires_at) <= this.dependencies.now()) {
      database.run("DELETE FROM im_selection_contexts WHERE token = ?", [row.token])
      this.dependencies.markDirty()
      await this.dependencies.flushStrict()
      throw new ImSelectionContextError("SELECTION_EXPIRED", "编号列表已过期，请重新获取。")
    }
    if (!Number.isSafeInteger(oneBasedIndex) || oneBasedIndex < 1) {
      throw new ImSelectionContextError("SELECTION_INDEX_INVALID", "编号必须是正整数。")
    }
    const context = hydrate(row)
    const selected = context.candidates[oneBasedIndex - 1]
    if (!selected) {
      throw new ImSelectionContextError(
        "SELECTION_INDEX_INVALID",
        `编号超出范围，请选择 1-${context.candidates.length}。`
      )
    }
    return selected
  }

  async clearAll(): Promise<void> {
    const database = this.dependencies.getDatabase()
    database.run("DELETE FROM im_selection_contexts")
    if (database.getRowsModified() > 0) this.dependencies.markDirty()
    await this.dependencies.flushStrict()
  }

  async clearConversation(conversationKey: string): Promise<void> {
    const database = this.dependencies.getDatabase()
    database.run("DELETE FROM im_selection_contexts WHERE conversation_key = ?", [conversationKey])
    if (database.getRowsModified() > 0) this.dependencies.markDirty()
    await this.dependencies.flushStrict()
  }
}

export const imSelectionContextStore = new ImSelectionContextStore({
  getDatabase: getDb,
  markDirty: saveToDisk,
  flushStrict,
  now: Date.now
})

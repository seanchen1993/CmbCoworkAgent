import { randomUUID } from "node:crypto"
import { isAbsolute, normalize } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { ThreadBinding } from "../../../shared/bot/contracts.generated"
import type { NativeSqliteAdapter, NativeSqliteValue } from "../../db/native-sqlite-adapter"
import { insertThreadRecord } from "../../db/thread-record"
import { THREAD_INCARNATION_METADATA_KEY } from "../thread-incarnation"

export interface PartnerTaskThreadContext {
  spaceId: string
  taskId: string
  stageId: string
  runtimeNodeId: string
  groupId: string
  ownerPrincipalId: string
  workspaceRef: string
  /** Explicit trusted local resolution, never an IM/body supplied path.
   * Preparation does NOT open files or prove symlink/tool sandbox confinement. */
  workspacePath: string
}

export class PartnerTaskThreadFault extends Error {
  constructor(
    readonly code:
      | "PARTNER_THREAD_INPUT_INVALID"
      | "PARTNER_THREAD_BINDING_CHANGED"
      | "PARTNER_THREAD_MISSING"
      | "PARTNER_THREAD_CONTEXT_CHANGED"
      | "PARTNER_THREAD_STORE_UNAVAILABLE"
  ) {
    super(code)
  }
}

const METADATA_KEY = "cmb_devclaw_partner_task"
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SCOPE_KEYS = ["spaceId", "taskId", "stageId", "runtimeNodeId"] as const
const CONTEXT_KEYS = [...SCOPE_KEYS, "groupId", "ownerPrincipalId", "workspaceRef"] as const
const METADATA_KEYS = [
  METADATA_KEY,
  THREAD_INCARNATION_METADATA_KEY,
  "title",
  "workspacePath",
  "agentMode",
  "subagentsEnabled",
  "memoryEnabled"
]

function context(input: PartnerTaskThreadContext): PartnerTaskThreadContext {
  if (
    !input ||
    CONTEXT_KEYS.some((key) => typeof input[key] !== "string" || !ID.test(input[key])) ||
    typeof input.workspacePath !== "string" ||
    input.workspacePath.length > 4096 ||
    input.workspacePath.includes("\0") ||
    !isAbsolute(input.workspacePath) ||
    normalize(input.workspacePath) !== input.workspacePath
  )
    throw new PartnerTaskThreadFault("PARTNER_THREAD_INPUT_INVALID")
  return Object.fromEntries(
    ([...CONTEXT_KEYS, "workspacePath"] as const).map((key) => [key, input[key]])
  ) as unknown as PartnerTaskThreadContext
}

function identity(input: PartnerTaskThreadContext) {
  return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, input[key]]))
}

/** Lazy internal App store, not IPC or execution authorization. Call only after
 * current node/owner/grant/Task validation. No default startup caller added.
 * Deleted/corrupt/repurposed Threads fail closed, never silently re-created.
 * One Thread per stage and node; requirements history cannot bleed into another
 * Task/node/stage. This does NOT enforce file/tool privacy at actual start. */
export class PartnerTaskThreadStore {
  constructor(private readonly database: NativeSqliteAdapter) {
    database.run(`CREATE TABLE IF NOT EXISTS bot_task_threads (
      space_id TEXT NOT NULL, task_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      node_id TEXT NOT NULL, group_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      workspace_ref TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
      incarnation TEXT NOT NULL,
      PRIMARY KEY(space_id, task_id, stage_id, node_id)
    )`)
  }

  private row(sql: string, values: readonly string[]) {
    const statement = this.database.prepare(sql)
    statement.bind(values)
    try {
      return statement.step() ? statement.getAsObject() : null
    } finally {
      statement.free()
    }
  }

  /** Read-only execution check: never recreates a missing binding/Thread. */
  verify(
    input: PartnerTaskThreadContext,
    threadId: string,
    resolved?: { workspacePath: string | undefined; metadata: Record<string, unknown> }
  ): void {
    const value = context(input)
    const binding = this.row(
      "SELECT * FROM bot_task_threads WHERE space_id=? AND task_id=? AND stage_id=? AND node_id=?",
      SCOPE_KEYS.map((key) => value[key])
    )
    if (!binding || binding.thread_id !== threadId)
      throw new PartnerTaskThreadFault("PARTNER_THREAD_MISSING")
    if (
      binding.group_id !== value.groupId ||
      binding.owner_principal_id !== value.ownerPrincipalId ||
      binding.workspace_ref !== value.workspaceRef
    )
      throw new PartnerTaskThreadFault("PARTNER_THREAD_BINDING_CHANGED")
    this.validateThread(value, binding)
    if (resolved) {
      const stored = this.row("SELECT metadata FROM threads WHERE thread_id=?", [threadId])
      if (
        resolved.workspacePath !== value.workspacePath ||
        !stored ||
        !isDeepStrictEqual(JSON.parse(String(stored.metadata)), resolved.metadata)
      )
        throw new PartnerTaskThreadFault("PARTNER_THREAD_CONTEXT_CHANGED")
    }
  }

  private validateThread(
    input: PartnerTaskThreadContext,
    binding: Record<string, NativeSqliteValue>
  ): void {
    if (typeof binding.thread_id !== "string" || !ID.test(binding.thread_id))
      throw new PartnerTaskThreadFault("PARTNER_THREAD_CONTEXT_CHANGED")
    const stored = this.row("SELECT metadata FROM threads WHERE thread_id = ?", [
      String(binding.thread_id)
    ])
    if (!stored) throw new PartnerTaskThreadFault("PARTNER_THREAD_MISSING")
    let metadata: Record<string, unknown>
    try {
      if (typeof stored.metadata !== "string" || stored.metadata.length > 16_384) throw Error()
      metadata = JSON.parse(stored.metadata)
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw Error()
      const marker = metadata[METADATA_KEY]
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw Error()
      if (
        Object.keys(marker).length !== CONTEXT_KEYS.length ||
        CONTEXT_KEYS.some((key) => (marker as Record<string, unknown>)[key] !== input[key]) ||
        Object.keys(metadata).length !== METADATA_KEYS.length ||
        Object.keys(metadata).some((key) => !METADATA_KEYS.includes(key)) ||
        typeof metadata.title !== "string" ||
        metadata.title.length > 1000 ||
        typeof binding.incarnation !== "string" ||
        !binding.incarnation ||
        metadata[THREAD_INCARNATION_METADATA_KEY] !== binding.incarnation ||
        metadata.workspacePath !== input.workspacePath ||
        metadata.agentMode !== "normal" ||
        metadata.subagentsEnabled !== false ||
        metadata.memoryEnabled !== false
      )
        throw Error()
    } catch {
      throw new PartnerTaskThreadFault("PARTNER_THREAD_CONTEXT_CHANGED")
    }
  }

  ensure(input: PartnerTaskThreadContext): Readonly<ThreadBinding> {
    const value = context(input)
    const scope = SCOPE_KEYS.map((key) => value[key])
    let transaction = false
    try {
      // Same-process calls are synchronous; IMMEDIATE also serializes distinct
      // App connections/processes. No await/settings/files/runtime in this lock.
      this.database.run("BEGIN IMMEDIATE")
      transaction = true
      let binding = this.row(
        "SELECT * FROM bot_task_threads WHERE space_id = ? AND task_id = ? AND stage_id = ? AND node_id = ?",
        scope
      )
      if (binding) {
        if (
          binding.group_id !== value.groupId ||
          binding.owner_principal_id !== value.ownerPrincipalId ||
          binding.workspace_ref !== value.workspaceRef
        )
          throw new PartnerTaskThreadFault("PARTNER_THREAD_BINDING_CHANGED")
      } else {
        const thread = insertThreadRecord(this.database, randomUUID(), {
          title: "DevClaw伙伴协作任务",
          workspacePath: value.workspacePath,
          agentMode: "normal",
          subagentsEnabled: false,
          memoryEnabled: false,
          [METADATA_KEY]: identity(value)
        })
        const incarnation = JSON.parse(thread.metadata)[THREAD_INCARNATION_METADATA_KEY] as string
        this.database.run(
          `INSERT INTO bot_task_threads
           (space_id, task_id, stage_id, node_id, group_id, owner_principal_id, workspace_ref, thread_id, incarnation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ...scope,
            value.groupId,
            value.ownerPrincipalId,
            value.workspaceRef,
            thread.thread_id,
            incarnation
          ]
        )
        binding = { thread_id: thread.thread_id, incarnation }
      }
      this.validateThread(value, binding)
      const result = Object.freeze({
        spaceId: value.spaceId,
        taskId: value.taskId,
        stageId: value.stageId,
        runtimeNodeId: value.runtimeNodeId,
        provider: "devclaw-desktop",
        localThreadId: String(binding.thread_id)
      })
      this.database.run("COMMIT")
      transaction = false
      return result
    } catch (error) {
      if (transaction) {
        try {
          this.database.run("ROLLBACK")
        } catch {
          // Retain WAL state; caller may inspect, never erase/re-create database.
        }
      }
      if (error instanceof PartnerTaskThreadFault) throw error
      throw new PartnerTaskThreadFault("PARTNER_THREAD_STORE_UNAVAILABLE")
    }
  }
}

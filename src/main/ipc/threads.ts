import { IpcMain, BrowserWindow } from "electron"
import { existsSync } from "fs"
import Store from "electron-store"
import { v4 as uuid } from "uuid"
import {
  getAllThreads,
  getThread,
  getThreadGoalEvents,
  getThreadGoalEventsForRestore,
  createThread as dbCreateThread,
  updateThread as dbUpdateThread,
  mergeThreadValues as dbMergeThreadValues,
  deleteThread as dbDeleteThread
} from "../db"
import { getCheckpointer, closeCheckpointer } from "../agent/runtime"
import { deleteThreadCheckpoint, getOpenworkDir } from "../storage"
import { generateTitle } from "../services/title-generator"
import { fireSessionEnd } from "../hooks/session-lifecycle"
import { makeHookResultCallback } from "../hooks/result-callback"
import { disposeAgentThreadState } from "./agent"
import type { Thread, ThreadUpdateParams, ThreadValuesMergeParams } from "../types"
import { SqlGoalStore } from "../agent/goals/goal-store"
import type { ThreadGoal } from "../agent/goals/types"
import { GOAL_UI_EVENT_LIMIT } from "../../shared/goal-events"

// 复用主进程 settings 存储，用于读取“最近一次选择的工作区”。
// 这里不存敏感信息，只读写路径类配置。
const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

function serializeGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal
    ? {
        ...goal,
        ledger: {
          progress: [...goal.ledger.progress],
          evidence: [...goal.ledger.evidence],
          blockers: [...goal.ledger.blockers]
        },
        context: { ...goal.context }
      }
    : null
}

export function registerThreadHandlers(ipcMain: IpcMain): void {
  // List all threads
  ipcMain.handle("threads:list", async () => {
    const threads = getAllThreads()
    return threads.map((row) => ({
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      title: row.title
    }))
  })

  // Get a single thread
  ipcMain.handle("threads:get", async (_event, threadId: string) => {
    const row = getThread(threadId)
    if (!row) return null
    return {
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
      title: row.title
    }
  })

  // Create a new thread
  ipcMain.handle("threads:create", async (_event, metadata?: Record<string, unknown>) => {
    const threadId = uuid()
    // 先拷贝一份，避免直接修改调用方传入的 metadata 对象。
    const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) }

    // 仅当调用方没有显式传 workspacePath 时，才自动继承最近工作区。
    // 这样可以兼容两种场景：
    // 1) 用户手动点“新任务” -> 自动带上最近目录；
    // 2) 业务方显式指定 workspacePath -> 保持调用方优先。
    const hasWorkspacePath = Object.prototype.hasOwnProperty.call(nextMetadata, "workspacePath")
    if (!hasWorkspacePath) {
      const lastWorkspacePath = settingsStore.get("workspacePath", null)
      // 仅在路径存在时回填，避免写入无效目录导致后续报错。
      if (
        typeof lastWorkspacePath === "string" &&
        lastWorkspacePath &&
        existsSync(lastWorkspacePath)
      ) {
        nextMetadata.workspacePath = lastWorkspacePath
      }
    }

    // title 仍保持原有规则：优先使用调用方传入，否则使用日期默认值。
    const title = (nextMetadata.title as string) || `Thread ${new Date().toLocaleDateString()}`
    nextMetadata.title = title

    const thread = dbCreateThread(threadId, nextMetadata)

    return {
      thread_id: thread.thread_id,
      created_at: new Date(thread.created_at),
      updated_at: new Date(thread.updated_at),
      metadata: thread.metadata ? JSON.parse(thread.metadata) : undefined,
      status: thread.status as Thread["status"],
      thread_values: thread.thread_values ? JSON.parse(thread.thread_values) : undefined,
      title
    } as Thread
  })

  // Update a thread
  ipcMain.handle("threads:update", async (_event, { threadId, updates }: ThreadUpdateParams) => {
    const updateData: Parameters<typeof dbUpdateThread>[1] = {}

    if (updates.title !== undefined) updateData.title = updates.title
    if (updates.status !== undefined) updateData.status = updates.status
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata)
    if (updates.thread_values !== undefined)
      updateData.thread_values = JSON.stringify(updates.thread_values)

    const row = dbUpdateThread(threadId, updateData)
    if (!row) throw new Error("Thread not found")

    return {
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
      title: row.title
    }
  })

  ipcMain.handle(
    "threads:mergeThreadValues",
    async (_event, { threadId, patch }: ThreadValuesMergeParams) => {
      const row = dbMergeThreadValues(threadId, patch)
      if (!row) throw new Error("Thread not found")

      return {
        thread_id: row.thread_id,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        status: row.status as Thread["status"],
        thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
        title: row.title
      }
    }
  )

  // Delete a thread
  ipcMain.handle("threads:delete", async (event, threadId: string) => {
    console.log("[Threads] Deleting thread:", threadId)

    // Fire SessionEnd before teardown so hooks can observe a valid thread record.
    // No-op if SessionStart never fired for this thread.
    const existingThread = getThread(threadId)
    let workspacePath: string | undefined
    if (existingThread?.metadata) {
      try {
        const metadata = JSON.parse(existingThread.metadata) as Record<string, unknown>
        workspacePath =
          typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
      } catch {
        workspacePath = undefined
      }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const hookChannel = `agent:stream:${threadId}`
    await fireSessionEnd(
      threadId,
      workspacePath,
      window ? makeHookResultCallback(window, hookChannel) : undefined
    )
    disposeAgentThreadState(threadId)

    // Delete from our metadata store
    dbDeleteThread(threadId)
    console.log("[Threads] Deleted from metadata store")

    // Close any open checkpointer for this thread
    try {
      await closeCheckpointer(threadId)
      console.log("[Threads] Closed checkpointer")
    } catch (e) {
      console.warn("[Threads] Failed to close checkpointer:", e)
    }

    // Delete the thread's checkpoint file
    try {
      deleteThreadCheckpoint(threadId)
      console.log("[Threads] Deleted checkpoint file")
    } catch (e) {
      console.warn("[Threads] Failed to delete checkpoint file:", e)
    }
  })

  // Get thread history (checkpoints)
  ipcMain.handle("threads:history", async (_event, threadId: string) => {
    try {
      const checkpointer = await getCheckpointer(threadId)

      const history: unknown[] = []
      const config = { configurable: { thread_id: threadId } }

      for await (const checkpoint of checkpointer.list(config, { limit: 50 })) {
        history.push(checkpoint)
      }

      return history
    } catch (e) {
      console.warn("Failed to get thread history:", e)
      return []
    }
  })

  ipcMain.handle("threads:goalEvents", async (_event, threadId: string, options?: { restore?: boolean }) => {
    const events = options?.restore
      ? getThreadGoalEventsForRestore(threadId, { recentLimit: GOAL_UI_EVENT_LIMIT })
      : getThreadGoalEvents(threadId)
    return events.map((event) => ({
      ...event,
      created_at: new Date(event.created_at)
    }))
  })

  ipcMain.handle(
    "threads:goalState",
    async (_event, threadId: string, options?: { includeEvents?: boolean }) => {
      const goalStore = new SqlGoalStore()
      const includeEvents = options?.includeEvents !== false
      return {
        goal: serializeGoal(goalStore.get(threadId)),
        events: includeEvents
          ? getThreadGoalEvents(threadId, { limit: GOAL_UI_EVENT_LIMIT }).map((event) => ({
              ...event,
              created_at: new Date(event.created_at)
            }))
          : []
      }
    }
  )

  // Generate a title from a message
  ipcMain.handle("threads:generateTitle", async (_event, message: string) => {
    return generateTitle(message)
  })
}

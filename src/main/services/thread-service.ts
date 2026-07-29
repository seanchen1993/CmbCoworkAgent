import { existsSync } from "fs"
import Store from "electron-store"
import { v4 as uuid } from "uuid"
import { createThread as dbCreateThread } from "../db"
import { buildHarnessFeatureAgentContext } from "../harness-board/service"
import { getOpenworkDir } from "../storage"
import type { Thread } from "../types"
import { getDefaultModel } from "../ipc/models"

const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

export async function createThreadService(
  metadata?: Record<string, unknown>
): Promise<Thread> {
  const threadId = uuid()
  const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) }

  const hasWorkspacePath = Object.prototype.hasOwnProperty.call(nextMetadata, "workspacePath")
  if (!hasWorkspacePath) {
    const lastWorkspacePath = settingsStore.get("workspacePath", null)
    if (
      typeof lastWorkspacePath === "string" &&
      lastWorkspacePath &&
      existsSync(lastWorkspacePath)
    ) {
      nextMetadata.workspacePath = lastWorkspacePath
    }
  }

  if (!Object.prototype.hasOwnProperty.call(nextMetadata, "agentMode")) {
    try {
      const workspacePath =
        typeof nextMetadata.workspacePath === "string" ? nextMetadata.workspacePath : undefined
      const harnessContext = buildHarnessFeatureAgentContext(nextMetadata, { workspacePath })
      const initialAgentMode = harnessContext?.agentConfig?.agentMode
      if (initialAgentMode === "solo") nextMetadata.agentMode = "normal"
      if (initialAgentMode === "agent_team") nextMetadata.agentMode = "coordinator"
    } catch (error) {
      console.warn("[Threads] Failed to apply Harness initial agent mode:", error)
    }
  }

  const hasModel = Object.prototype.hasOwnProperty.call(nextMetadata, "model")
  if (!hasModel) {
    const defaultModelId = getDefaultModel()
    if (defaultModelId) {
      nextMetadata.model = defaultModelId
    }
  }

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
  }
}

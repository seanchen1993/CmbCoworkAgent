import { existsSync } from "fs"
import Store from "electron-store"
import { v4 as uuid } from "uuid"
import { createThread as dbCreateThread } from "../db"
import { getAgentModeFromMetadata } from "../agent/coordinator-mode"
import {
  buildHarnessFeatureAgentContext,
  DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG
} from "../harness-board/service"
import { getOpenworkDir } from "../storage"
import type { Thread } from "../types"
import { getDefaultModel } from "../ipc/models"

const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

export async function createThreadService(metadata?: Record<string, unknown>): Promise<Thread> {
  const threadId = uuid()
  const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) }
  const harnessFeatureMetadata =
    nextMetadata.harnessFeature &&
    typeof nextMetadata.harnessFeature === "object" &&
    !Array.isArray(nextMetadata.harnessFeature)
      ? (nextMetadata.harnessFeature as Record<string, unknown>)
      : undefined
  if (harnessFeatureMetadata) {
    nextMetadata.harnessFeature = {
      ...harnessFeatureMetadata,
      requestUserInputConfig: { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
    }
  }

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

  let harnessContext: ReturnType<typeof buildHarnessFeatureAgentContext> | null = null
  try {
    const workspacePath =
      typeof nextMetadata.workspacePath === "string" ? nextMetadata.workspacePath : undefined
    harnessContext = buildHarnessFeatureAgentContext(nextMetadata, {
      workspacePath,
      requestUserInputConfigSource: "plugin"
    })
    if (harnessFeatureMetadata && harnessContext?.agentConfig?.toolConfig?.requestUserInput) {
      nextMetadata.harnessFeature = {
        ...harnessFeatureMetadata,
        requestUserInputConfig: harnessContext.agentConfig.toolConfig.requestUserInput
      }
    }
  } catch (error) {
    console.warn("[Threads] Failed to resolve Harness request_user_input policy:", error)
  }

  if (!Object.prototype.hasOwnProperty.call(nextMetadata, "agentMode")) {
    try {
      const initialAgentMode = harnessContext?.agentConfig?.agentMode
      if (initialAgentMode === "solo") {
        nextMetadata.agentMode = "normal"
        nextMetadata.subagentsEnabled = false
      }
      if (initialAgentMode === "multi") {
        nextMetadata.agentMode = "normal"
        nextMetadata.subagentsEnabled = true
      }
      if (initialAgentMode === "agent_team") nextMetadata.agentMode = "coordinator"
    } catch (error) {
      console.warn("[Threads] Failed to apply Harness initial agent mode:", error)
    }
  }
  if (
    getAgentModeFromMetadata(nextMetadata) === "normal" &&
    typeof nextMetadata.subagentsEnabled !== "boolean"
  ) {
    nextMetadata.subagentsEnabled = true
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

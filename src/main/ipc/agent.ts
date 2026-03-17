import { IpcMain, BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { createAgentRuntime } from "../agent/runtime"
import { getThread } from "../db"
import { summarizeAndSave } from "../memory/summarizer"
import { getMemoryStore } from "../memory/store"
import { ChatOpenAI } from "@langchain/openai"
import { getCustomModelConfigs, isMemoryEnabled } from "../storage"
import { notifyIfBackground } from "../services/notify"
import { getEnabledHooks } from "../storage"
import { runHooks } from "../hooks/runner"
import type {
  AgentInvokeParams,
  AgentResumeParams,
  AgentInterruptParams,
  AgentCancelParams
} from "../types"

const MIN_CHARS_FOR_MEMORY = 200

// Track active runs for cancellation
const activeRuns = new Map<string, AbortController>()

export function registerAgentHandlers(ipcMain: IpcMain): void {
  console.log("[Agent] Registering agent handlers...")

  // Handle agent invocation with streaming
  ipcMain.on("agent:invoke", async (event, { threadId, message, modelId }: AgentInvokeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received invoke request:", {
      threadId,
      message: message.substring(0, 50),
      modelId
    })

    if (!window) {
      console.error("[Agent] No window found")
      return
    }

    // Abort any existing stream for this thread before starting a new one
    // This prevents concurrent streams which can cause checkpoint corruption
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      console.log("[Agent] Aborting existing stream for thread:", threadId)
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    // Abort the stream if the window is closed/destroyed
    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    try {
      // Get workspace path from thread metadata - REQUIRED
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      console.log("[Agent] Thread metadata:", metadata)

      const workspacePath = metadata.workspacePath as string | undefined

      if (!workspacePath) {
        window.webContents.send(channel, {
          type: "error",
          error: "WORKSPACE_REQUIRED",
          message: "Please select a workspace folder before sending messages."
        })
        return
      }

      // Sync FTS index with any memory files changed since last invocation
      if (isMemoryEnabled()) {
        try {
          const memoryStore = await getMemoryStore()
          memoryStore.syncMemoryFiles()
        } catch { /* non-critical */ }
      }

      const effectiveModelId = modelId || (metadata.model as string | undefined)
      const agent = await createAgentRuntime({
        threadId,
        workspacePath,
        modelId: effectiveModelId
      })
      const humanMessage = new HumanMessage(message)

      // Stream with both modes:
      // - 'messages' for real-time token streaming
      // - 'values' for full state (todos, files, etc.)
      const stream = await agent.stream(
        { messages: [humanMessage] },
        {
          configurable: { thread_id: threadId },
          signal: abortController.signal,
          streamMode: ["messages", "values"],
          recursionLimit: 1000
        }
      )

      let assistantText = ""
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break

        const [mode, data] = chunk as [string, unknown]

        if (mode === "messages") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [msgChunk] = data as [any]
            const type = msgChunk?._getType?.() ?? msgChunk?.type
            if (type === "ai" && msgChunk?.content) {
              const c = msgChunk.content
              if (typeof c === "string") {
                assistantText += c
              } else if (Array.isArray(c)) {
                assistantText += c
                  .filter((b: { type: string }) => b?.type === "text")
                  .map((b: { text?: string }) => b.text ?? "")
                  .join("")
              }
            }
          } catch { /* best-effort */ }
        }

        const serialized = JSON.parse(JSON.stringify(data))

        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: serialized
        })
      }

      if (!abortController.signal.aborted) {
        // Run Stop hooks before signaling done
        runHooks(getEnabledHooks(), "Stop", {
          workspacePath
        }).catch((e) => console.warn("[Agent] Stop hook error:", e))

        window.webContents.send(channel, { type: "done" })
        notifyIfBackground("✅ 任务完成", assistantText.trim() || "对话已完成")

        const conversation = assistantText.trim()
          ? `User: ${message}\n\nAssistant: ${assistantText}`
          : ""

        if (isMemoryEnabled() && conversation.length >= MIN_CHARS_FOR_MEMORY) {
          const memoryStore = await getMemoryStore()
          const allConfigs = getCustomModelConfigs()
          const config = allConfigs.find((c) => c.id === (modelId?.replace("custom:", "") ?? "")) || allConfigs[0]
          if (!config) {
            console.warn("[Agent] No model config available — skipping memory summarization")
          } else if (config?.apiKey) {
            summarizeAndSave({
              model: new ChatOpenAI({
                model: config.model,
                apiKey: config.apiKey,
                configuration: { baseURL: config.baseUrl }
              }),
              conversation,
              memoryDir: memoryStore.getMemoryDir()
            }).catch((e) => console.warn("[Agent] Memory summarize failed:", e))
          }
        }
      }
    } catch (error) {
      // Ignore abort-related errors (expected when stream is cancelled)
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        const errMsg = error instanceof Error ? error.message : "Unknown error"
        console.error("[Agent] Error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: errMsg
        })
        notifyIfBackground("❌ 任务失败", errMsg)
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle agent resume (after interrupt approval/rejection via useStream)
  ipcMain.on("agent:resume", async (event, { threadId, command, modelId }: AgentResumeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received resume request:", { threadId, command, modelId })

    if (!window) {
      console.error("[Agent] No window found for resume")
      return
    }

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      return
    }

    // Abort any existing stream before resuming
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting resume stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    try {
      const effectiveModelId = modelId || (metadata.model as string | undefined)
      const agent = await createAgentRuntime({
        threadId,
        workspacePath,
        modelId: effectiveModelId
      })
      const config = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      // Resume from checkpoint by streaming with Command containing the decision
      // The HITL middleware expects one decision per pending tool call
      const decisionType = command?.resume?.decision || "approve"
      const pendingCount = command?.resume?.pendingCount ?? 1
      const decisions = Array.from({ length: pendingCount }, () => ({ type: decisionType }))
      const resumeValue = { decisions }
      const stream = await agent.stream(new Command({ resume: resumeValue }), config)

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break

        const [mode, data] = chunk as unknown as [string, unknown]

        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: JSON.parse(JSON.stringify(data))
        })
      }

      if (!abortController.signal.aborted) {
        window.webContents.send(channel, { type: "done" })
      }
    } catch (error) {
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Resume error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle HITL interrupt response
  ipcMain.on("agent:interrupt", async (event, { threadId, decision }: AgentInterruptParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      console.error("[Agent] No window found for interrupt response")
      return
    }

    // Get workspace path from thread metadata - REQUIRED
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined
    const modelId = metadata.model as string | undefined

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      return
    }

    // Abort any existing stream before continuing
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting interrupt stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    try {
      const agent = await createAgentRuntime({ threadId, workspacePath, modelId })
      const config = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      if (decision.type === "approve") {
        // Resume execution by invoking with null (continues from checkpoint)
        const stream = await agent.stream(null, config)

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break

          const [mode, data] = chunk as unknown as [string, unknown]
          window.webContents.send(channel, {
            type: "stream",
            mode,
            data: JSON.parse(JSON.stringify(data))
          })
        }

        if (!abortController.signal.aborted) {
          window.webContents.send(channel, { type: "done" })
        }
      } else if (decision.type === "reject") {
        // For reject, we need to send a Command with reject decision
        // For now, just send done - the agent will see no resumption happened
        window.webContents.send(channel, { type: "done" })
      }
      // edit case handled similarly to approve with modified args
    } catch (error) {
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Interrupt error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle cancellation
  ipcMain.handle("agent:cancel", async (_event, { threadId }: AgentCancelParams) => {
    const controller = activeRuns.get(threadId)
    if (controller) {
      controller.abort()
      activeRuns.delete(threadId)
    }
  })
}

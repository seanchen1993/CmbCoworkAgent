import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { CustomModelConfig } from "../../storage"
import { getModelByTier, getModelConfigByRef, getModelConfigs } from "../../models/registry"
import { resolveModel } from "../../routing"
import { renderTaskMmdCompilePrompt } from "./prompts"
import {
  getTaskMmdSettings,
  getTaskMmdState,
  isTaskMmdThreadDeleted,
  readTaskMmd,
  readTaskMmdEntriesAsync,
  withTaskMmdThreadQueue,
  writeTaskMmd,
  writeTaskMmdState
} from "./storage"
import { stripAnsiText } from "./sanitizer"
import type { TaskMmdCompileModelInfo, TaskMmdToolEntry } from "./types"

const compileInFlight = new Set<string>()
const MIN_FAILURE_BACKOFF_MS = 60_000
const MAX_FAILURE_BACKOFF_MS = 15 * 60_000

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "")
}

function parseMmdFromResponse(text: string): string | null {
  const clean = stripThinkBlocks(text).trim()
  const mermaidFence = /```mermaid\s*([\s\S]*?)```/i.exec(clean)
  if (mermaidFence?.[1]?.trim()) return mermaidFence[1].trim()

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean)
  const jsonText = fenced ? fenced[1].trim() : clean
  try {
    const parsed = JSON.parse(jsonText) as { mmd?: unknown }
    if (typeof parsed.mmd === "string" && parsed.mmd.trim()) {
      return parsed.mmd.trim()
    }
  } catch {
    // Fall through to Mermaid extraction.
  }

  const flowchartIndex = clean.indexOf("flowchart")
  if (flowchartIndex >= 0) {
    const candidate = clean.slice(flowchartIndex).trim()
    const fenceEnd = candidate.indexOf("```")
    return (fenceEnd >= 0 ? candidate.slice(0, fenceEnd) : candidate).trim()
  }
  return null
}

function escapeMermaidLabel(value: string): string {
  return stripAnsiText(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "'")
    .replace(/[<>]/g, "")
    .replace(/\r?\n/g, " ")
    .trim()
}

function ellipsize(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function readableToolName(toolName: string): string {
  return toolName.replace(/^(functions|mcp__[.\w-]+)\./, "").replace(/_/g, " ")
}

function extractPathBasename(text: string): string | null {
  const normalized = text.replace(/\\\\/g, "\\")
  const pathPattern =
    /(?:[A-Za-z]:\\|\.{1,2}[\\/]|[\\/])(?:[^\s"'`<>|{}[\],;:)]+[\\/])*[^\s"'`<>|{}[\],;:)]+/g
  const relativePathPattern = /(?:[A-Za-z0-9_.-]+[\\/]){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g
  const matches = [
    ...(normalized.match(pathPattern) ?? []),
    ...(normalized.match(relativePathPattern) ?? [])
  ]
  const candidate = matches
    .map(
      (pathValue) =>
        pathValue
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ?? ""
    )
    .find((basename) => basename.length > 0)
  return candidate || null
}

function summarizeEntry(entry: TaskMmdToolEntry): string {
  const preview = stripAnsiText([entry.argsPreview, entry.resultPreview].filter(Boolean).join(" "))
  const basename = extractPathBasename(preview)
  const toolName = readableToolName(entry.toolName)
  if (basename) return `${toolName}: ${ellipsize(basename, 72)}`

  const source = stripAnsiText([entry.toolName, entry.argsPreview, entry.resultPreview]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim())
  if (!source) return entry.toolName
  return ellipsize(source, 72)
}

function fallbackMmd(entries: TaskMmdToolEntry[]): string {
  const recent = entries.slice(-12)
  if (recent.length === 0) return "flowchart TD\n  N1[\"等待任务记录<br/>status: paused\"]"

  const lines = ["flowchart TD"]
  recent.forEach((entry, index) => {
    const node = `N${index + 1}`
    const status = entry.status === "error" ? "blocked" : index === recent.length - 1 ? "doing" : "done"
    const label = escapeMermaidLabel(summarizeEntry(entry))
    lines.push(`  ${node}["${label}<br/>status: ${status}"]`)
    if (index > 0) lines.push(`  N${index} --> ${node}`)
  })
  return lines.join("\n")
}

function tierLabel(tier: "economy" | "premium"): string {
  return tier === "economy" ? "经济" : "高级"
}

function buildCompileModelInfo(
  requestedTier: "economy" | "premium",
  cfg: CustomModelConfig | null,
  source: TaskMmdCompileModelInfo["source"],
  reason: string
): TaskMmdCompileModelInfo {
  const resolvedTier = cfg ? (cfg.tier ?? "premium") : null
  const missing: string[] = []
  if (cfg && !cfg.apiKey) missing.push("API Key")
  if (cfg && !cfg.baseUrl) missing.push("Base URL")
  if (cfg && !cfg.model) missing.push("模型 ID")

  return {
    requestedTier,
    resolvedTier,
    id: cfg?.id ?? null,
    name: cfg?.name ?? null,
    model: cfg?.model ?? null,
    baseUrl: cfg?.baseUrl ?? null,
    hasApiKey: Boolean(cfg?.apiKey),
    source,
    reason: missing.length > 0 ? `${reason}，但缺少 ${missing.join(" / ")}` : reason
  }
}

async function resolveTaskMmdCompileModel(
  threadId: string
): Promise<{ cfg: CustomModelConfig | null; info: TaskMmdCompileModelInfo }> {
  const settings = getTaskMmdSettings()
  const configs = getModelConfigs()
  const requestedTier = settings.compileModelTier
  const exact = configs.find((item) => (item.tier ?? "premium") === requestedTier) ?? null

  if (exact) {
    return {
      cfg: exact,
      info: buildCompileModelInfo(
        requestedTier,
        exact,
        "tier",
        `使用${tierLabel(requestedTier)}档模型配置`
      )
    }
  }

  let routingReason: string | null = null
  if (requestedTier === "economy") {
    try {
      const result = await resolveModel({
        taskSource: "task_mmd",
        threadId,
        message: "Compile a compact Mermaid task map from recent tool-call summaries.",
        routingMode: "auto"
      })
      routingReason = result.routeReason
      const routed = getModelConfigByRef(result.resolvedModelId)
      if (routed) {
        return {
          cfg: routed,
          info: buildCompileModelInfo(
            requestedTier,
            routed,
            "routing",
            `未找到经济档模型，按路由结果使用：${result.routeReason}`
          )
        }
      }
    } catch (error) {
      routingReason = `路由失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const fallback = getModelByTier(requestedTier) ?? null
  if (fallback) {
    const suffix = routingReason ? `；${routingReason}` : ""
    return {
      cfg: fallback,
      info: buildCompileModelInfo(
        requestedTier,
        fallback,
        "fallback",
        `未找到${tierLabel(requestedTier)}档模型，回退到可用模型${suffix}`
      )
    }
  }

  return {
    cfg: null,
    info: buildCompileModelInfo(requestedTier, null, "none", "未配置可用模型")
  }
}

export async function getTaskMmdCompileModelInfo(
  threadId: string
): Promise<TaskMmdCompileModelInfo> {
  return (await resolveTaskMmdCompileModel(threadId)).info
}

async function createCompileModel(threadId: string): Promise<ChatOpenAI | null> {
  const { cfg } = await resolveTaskMmdCompileModel(threadId)

  if (!cfg?.apiKey || !cfg.model || !cfg.baseUrl) return null

  return new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseUrl },
    maxTokens: Math.min(cfg.maxOutputTokens ?? 2000, 2000),
    temperature: 0,
    maxRetries: 0
  })
}

async function runCompile(threadId: string, reason: string): Promise<void> {
  if (isTaskMmdThreadDeleted(threadId)) return

  await withTaskMmdThreadQueue(threadId, async () => {
    if (isTaskMmdThreadDeleted(threadId)) return

    const settings = getTaskMmdSettings()
    if (!settings.enabled) return

    const state = getTaskMmdState(threadId)
    const allEntries = await readTaskMmdEntriesAsync(threadId)
    if (allEntries.length === 0) return

    const newEntries = allEntries.slice(state.compiledEntryCount)
    const entriesForPrompt = (newEntries.length > 0 ? newEntries : allEntries).slice(
      -settings.maxEntriesPerCompile
    )
    const existingMmd = readTaskMmd(threadId)

    await writeTaskMmdState(threadId, { compileStatus: "compiling", lastError: undefined })

    let nextMmd: string | null = null
    let compileMode: "llm" | "fallback" = "llm"
    let lastError: string | undefined
    let backoffError: string | undefined
    try {
      const model = await createCompileModel(threadId)
      if (model) {
        const response = await model.invoke([
          new SystemMessage("You update Mermaid task maps for long-running coding-agent tasks."),
          new HumanMessage(renderTaskMmdCompilePrompt(existingMmd, entriesForPrompt))
        ])
        const text =
          typeof response.content === "string" ? response.content : JSON.stringify(response.content)
        nextMmd = parseMmdFromResponse(text)
        if (!nextMmd) {
          backoffError = "Compiler model did not return a valid Mermaid graph."
          lastError = `${backoffError} Used fallback graph.`
        }
      } else {
        lastError =
          "No configured model is available for task map compilation. Used fallback graph."
      }
    } catch (error) {
      backoffError = error instanceof Error ? error.message : String(error)
      lastError = backoffError
      console.warn("[TaskMMD] Model compile failed, using fallback graph:", error)
    }

    if (!nextMmd) {
      compileMode = "fallback"
      nextMmd = fallbackMmd(allEntries)
    }

    if (nextMmd.length > settings.maxMmdChars) {
      compileMode = "fallback"
      backoffError = `Compiler Mermaid exceeded maxMmdChars (${nextMmd.length}/${settings.maxMmdChars}).`
      lastError = `${backoffError} Used fallback graph.`
      nextMmd = fallbackMmd(allEntries.slice(-settings.maxEntriesPerCompile))
    }

    const now = new Date().toISOString()
    await writeTaskMmd(threadId, nextMmd)
    await writeTaskMmdState(threadId, {
      lastCompiledAt: now,
      compiledEntryCount: allEntries.length,
      totalEntryCount: allEntries.length,
      compileStatus: "idle",
      lastCompileMode: compileMode,
      lastError,
      lastFailedAt: backoffError ? now : null,
      lastFailureCount: backoffError ? (state.lastFailureCount ?? 0) + 1 : 0
    })
    console.log(`[TaskMMD] Compiled task map for thread ${threadId}: ${reason}`)
  })
}

export function shouldCompileTaskMmd(threadId: string): boolean {
  const settings = getTaskMmdSettings()
  if (!settings.enabled) return false

  const state = getTaskMmdState(threadId)
  if (state.lastError && state.lastFailedAt) {
    const failureCount = Math.max(1, state.lastFailureCount ?? 1)
    const backoffMs = Math.min(
      MAX_FAILURE_BACKOFF_MS,
      MIN_FAILURE_BACKOFF_MS * 2 ** Math.min(failureCount - 1, 8)
    )
    const failedAt = new Date(state.lastFailedAt).getTime()
    if (Number.isFinite(failedAt) && Date.now() - failedAt < backoffMs) {
      return false
    }
  }

  const pending = Math.max(0, state.totalEntryCount - state.compiledEntryCount)
  if (pending >= settings.l2NullThreshold) return true
  if (pending <= 0 || !state.lastCompiledAt) return false

  const elapsedSeconds = (Date.now() - new Date(state.lastCompiledAt).getTime()) / 1000
  return elapsedSeconds >= settings.l2TimeoutSeconds
}

export function scheduleTaskMmdCompile(threadId: string, reason: string): void {
  if (compileInFlight.has(threadId)) return
  compileInFlight.add(threadId)
  void runCompile(threadId, reason)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[TaskMMD] Compile failed for thread ${threadId}:`, error)
      const now = new Date().toISOString()
      let lastFailureCount = 1
      try {
        lastFailureCount = (getTaskMmdState(threadId).lastFailureCount ?? 0) + 1
      } catch {
        // Best effort: the state path may be the source of the compile failure.
      }
      await writeTaskMmdState(threadId, {
        compileStatus: "error",
        lastError: message,
        lastFailedAt: now,
        lastFailureCount
      }).catch(() => undefined)
    })
    .finally(() => {
      compileInFlight.delete(threadId)
    })
}

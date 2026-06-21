import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

type DebugPayload = Record<string, unknown>

let modelCallSequence = 0

function isDebugDumpEnabled(): boolean {
  const value = process.env.CMB_COWORK_AGENT_DEBUG_DUMP
  return value === "1" || value?.toLowerCase() === "true"
}

function safePathSegment(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback
  return raw.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || fallback
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function resolveDebugDir(workspacePath: string, threadId?: string): string {
  const root =
    process.env.CMB_COWORK_AGENT_DEBUG_DIR ||
    join(workspacePath, ".cmbdevclaw", "debug", "agent-payloads")
  return join(root, safePathSegment(threadId, "unknown-thread"))
}

function writeDebugJson(
  workspacePath: string,
  threadId: string | undefined,
  fileName: string,
  latestName: string,
  payload: DebugPayload
): void {
  if (!isDebugDumpEnabled()) return
  try {
    const dir = resolveDebugDir(workspacePath, threadId)
    mkdirSync(dir, { recursive: true })
    const seen = new WeakSet<object>()
    const text = JSON.stringify(
      payload,
      (_key, value) => {
        if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
        if (typeof value === "bigint") return value.toString()
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[Circular]"
          seen.add(value)
        }
        return value
      },
      2
    )
    writeFileSync(join(dir, fileName), text, "utf-8")
    writeFileSync(join(dir, latestName), text, "utf-8")
  } catch (error) {
    console.warn("[AgentDebugDump] failed to write debug payload:", error)
  }
}

export function dumpSystemPromptDebug(input: {
  workspacePath: string
  threadId?: string
  runtimeThreadId?: string
  modelId?: string
  agentMode?: string
  systemPrompt: string
  toolNames?: string[]
  metadata?: Record<string, unknown>
}): void {
  const payload = {
    kind: "system_prompt",
    capturedAt: new Date().toISOString(),
    threadId: input.threadId,
    runtimeThreadId: input.runtimeThreadId,
    workspacePath: input.workspacePath,
    modelId: input.modelId,
    agentMode: input.agentMode,
    chars: input.systemPrompt.length,
    toolNames: input.toolNames ?? [],
    metadata: input.metadata ?? {},
    systemPrompt: input.systemPrompt
  }
  writeDebugJson(
    input.workspacePath,
    input.threadId,
    `system-prompt-${timestampForFile()}.json`,
    "latest-system-prompt.json",
    payload
  )
}

export function dumpModelCallDebug(input: {
  workspacePath: string
  threadId?: string
  modelId?: string
  messageId?: string
  inputMessages: unknown[]
  outputMessage?: unknown
  toolCalls?: unknown[]
  tokenUsage?: unknown
  metadata?: Record<string, unknown>
}): void {
  const sequence = ++modelCallSequence
  const payload = {
    kind: "model_call",
    capturedAt: new Date().toISOString(),
    sequence,
    threadId: input.threadId,
    workspacePath: input.workspacePath,
    modelId: input.modelId,
    messageId: input.messageId,
    inputMessages: input.inputMessages,
    outputMessage: input.outputMessage,
    toolCalls: input.toolCalls ?? [],
    tokenUsage: input.tokenUsage,
    metadata: input.metadata ?? {}
  }
  writeDebugJson(
    input.workspacePath,
    input.threadId,
    `model-call-${String(sequence).padStart(6, "0")}-${timestampForFile()}.json`,
    "latest-model-call.json",
    payload
  )
}

export function dumpAgentInputDebug(input: {
  workspacePath: string
  threadId?: string
  modelId?: string
  input: unknown
  metadata?: Record<string, unknown>
}): void {
  const payload = {
    kind: "agent_stream_input",
    capturedAt: new Date().toISOString(),
    threadId: input.threadId,
    workspacePath: input.workspacePath,
    modelId: input.modelId,
    input: input.input,
    metadata: input.metadata ?? {}
  }
  writeDebugJson(
    input.workspacePath,
    input.threadId,
    `agent-input-${timestampForFile()}.json`,
    "latest-agent-input.json",
    payload
  )
}

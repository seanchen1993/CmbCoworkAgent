import { IpcMain, BrowserWindow } from "electron"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import {
  createAgentRuntime,
  getSkillEvolutionThreshold
} from "../agent/runtime"
import { getThread } from "../db"
import { summarizeAndSave } from "../memory/summarizer"
import { getMemoryStore } from "../memory/store"
import { ChatOpenAI } from "@langchain/openai"
import {
  getCustomModelConfigs,
  isMemoryEnabled,
  getCustomSkillsDir,
  invalidateEnabledSkillsCache,
  isOnlineSkillEvolutionEnabled,
  isSkillAutoProposeEnabled
} from "../storage"
import { notifyIfBackground, stripThink } from "../services/notify"
import { trySendChatXReply } from "../services/chatx"
import { TraceCollector } from "../agent/trace/collector"
import {
  requestSkillIntent,
  requestSkillConfirmation,
  sanitizeSkillId
} from "../agent/tools/skill-evolution-tool"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"
import { LocalSandbox } from "../agent/local-sandbox"
import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"
import { ToolCallCounter } from "../agent/skill-evolution/tool-call-counter"
import {
  resetSkillEvolutionSession,
  shouldResetSkillEvolutionSessionAfterIntent
} from "../agent/skill-evolution/session-state"
import {
  appendSkillProposalWindowTurn,
  buildSkillProposalWindowContext,
  snapshotSkillProposalWindow,
  isSkillProposalWindowContext,
  type SkillProposalWindowContext
} from "../agent/skill-evolution/proposal-window"
import {
  buildWorthinessPrompt,
  getSkillProposalMode,
  parseWorthinessResponse,
  parseSkillProposal,
  shouldEvaluateSkillProposalWindow,
  shouldJudgeSkillWorthiness,
  shouldProposeSkill,
  type SkillProposal,
  type WorthinessResult
} from "../agent/skill-evolution/skill-proposal-logic"
import type {
  AgentInvokeParams,
  AgentResumeParams,
  AgentInterruptParams,
  AgentCancelParams
} from "../types"

const MIN_CHARS_FOR_MEMORY = 200

// Track active runs for cancellation
const activeRuns = new Map<string, AbortController>()

// ─────────────────────────────────────────────────────────
// Auto skill proposal: generate a skill from conversation context
// ─────────────────────────────────────────────────────────


const SKILL_PROPOSAL_SYSTEM_PROMPT = `You are an expert at capturing reusable agent skills from conversation history.

Given a conversation between a user and an AI agent, your job is to extract a GENERALIZED, reusable skill.
Your primary task is to identify the underlying repeatable WORKFLOW or METHOD — not to describe the specific task instance.
Strip out all one-off details (file names, component names, specific bug descriptions, exact error messages, ticket IDs) and abstract to the task family.

Output ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "name": "Short Human-Readable Name (3-6 words)",
  "skillId": "snake_case_identifier",
  "description": "One sentence: WHEN should this skill be loaded? Describe the recurring task pattern, not the one-off artifact.",
  "content": "Full SKILL.md content (including YAML frontmatter)"
}

SKILL.md format:
---
name: skill-name
description: Trigger description
version: 1.0.0
---

# Overview
Brief description of the generalized workflow.

## When to use
Recurring trigger patterns and task families.

## Steps / Guidelines
Concrete, generalizable instructions the agent should follow.

Generalization rules (CRITICAL — read carefully):
Target the right abstraction level — not too narrow, not too broad:
- TOO NARROW (bad):  "当用户要找 ChatContainer.tsx 里的 null pointer bug 时" — single file + single bug
- TOO BROAD (bad):   "当用户遇到任何代码问题时" — no useful specificity
- JUST RIGHT (good): "当用户要系统排查 React 组件的渲染或状态类 bug 时" — task family with clear domain boundary

More examples:
- BAD name:  "Fix ChatContainer Null Pointer Bug" | GOOD name: "React Component Bug Investigation"
- BAD steps: "1. Open ChatContainer.tsx 2. Check line 47" | GOOD steps: "1. Identify component boundary 2. Check state/prop flow"
- BAD trigger: "用户说 ChatContainer 崩溃" | GOOD trigger: "用户要排查 React 组件异常行为"

What to keep vs. strip:
- STRIP: specific file names, component names, exact error strings, line numbers, ticket IDs, one-off data values
- KEEP: framework names (React, Electron), patterns (IPC, state management), domain types (bug investigation, deployment, refactor)
- A skill scoped to a stable tool/framework (e.g. "Electron IPC debugging") is valid and reusable — don't over-generalize it to "any debugging"

Steps should describe the METHOD (how to approach the problem class), not the SOLUTION to this specific instance.
If the conversation is narrow, lift it one level: "how we fixed X" → "systematic approach to X-type problems".

Other rules:
- description is the MOST important field — it controls when the skill is injected in future sessions
- Output ONLY valid JSON, no other text`

/**
 * Broadcast a skill generation progress event to all renderer windows.
 * `phase`:
 *   "start"    — generation beginning (clears previous output)
 *   "token"    — incremental token chunk
 *   "done"     — generation complete, full raw text in `text`
 *   "error"    — generation failed
 */
function emitSkillGenerating(
  threadId: string,
  phase: "start" | "token" | "done" | "error",
  text = ""
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skill:generating", { threadId, phase, text })
  }
}

/**
 * Ask the LLM whether this conversation is worth saving as a skill.
 * Called unconditionally for every threshold-passing conversation.
 * Returns true if worthy, false if not (or if no model / parse error).
 */
async function judgeSkillWorthiness(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<WorthinessResult | null> {
  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config?.apiKey) {
    console.log(`[SkillEvolution][${threadId}] Worthiness LLM skipped: missing model config or API key`)
    return null
  }

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 1024,
    temperature: 0
  })

  const userPrompt = `## Conversation window since last skill-evolution reset (${context.turnCount} turns)
${context.transcript.slice(0, 3200)}

## Tools used (${context.toolCallCount} total)
${context.toolCallSummary}

Is this conversation worth saving as a reusable skill?`

  try {
    console.log(`[SkillEvolution][${threadId}] Worthiness LLM invoke start ${JSON.stringify({
      toolCallCount: context.toolCallCount,
      threshold: getSkillEvolutionThreshold(),
      turnCount: context.turnCount,
      errorCount: context.errorCount,
      toolCallSummary: context.toolCallSummary
    })}`)
    const response = await model.invoke([
      new SystemMessage(buildWorthinessPrompt(context.toolCallCount, getSkillEvolutionThreshold())),
      new HumanMessage(userPrompt)
    ])
    const raw = typeof response.content === "string" ? response.content : ""
    console.log(`[SkillEvolution][${threadId}] Worthiness LLM raw ${JSON.stringify({
      preview: raw.slice(0, 400)
    })}`)
    const result = parseWorthinessResponse(raw)
    if (!result) {
      console.warn(`[SkillEvolution][${threadId}] Failed to parse worthiness response:`, raw.slice(0, 200))
      return null
    }
    console.log(`[SkillEvolution][${threadId}] Worthiness LLM invoke done ${JSON.stringify({
      worthy: result.worthy,
      reason: result.reason
    })}`)
    return result
  } catch (e) {
    console.warn(`[SkillEvolution][${threadId}] Failed to judge worthiness:`, e)
    return null
  }
}

/**
 * Use the default configured LLM to generate a skill proposal from the
 * given conversation context.  Streams tokens to the renderer via
 * `skill:generating` events so the user can see progress in real time.
 * Returns null if no model is configured or the LLM response cannot be parsed.
 */
async function generateSkillProposal(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<SkillProposal | null> {
  // Always emit "start" first so the renderer card resets to generating state,
  // both on the initial run and on manual retry.
  emitSkillGenerating(threadId, "start")

  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config?.apiKey) {
    emitSkillGenerating(threadId, "error", "未配置模型或 API Key，无法生成技能草稿")
    return null
  }

  const userPrompt = `# Conversation window to analyze

## Transcript (${context.turnCount} turns)
${context.transcript.slice(0, 4000)}

## Tools used (${context.toolCallCount} total)
${context.toolCallSummary}

Based on this conversation, generate a reusable skill. Output JSON only.`

  try {
    const model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      maxTokens: 2048,
      temperature: 0.3,
      streaming: true
    })

    // Per-token idle timeout: if no new chunk arrives within this window the
    // internal model has likely stalled mid-stream without closing the connection.
    const TOKEN_IDLE_TIMEOUT_MS = 60_000

    const abortController = new AbortController()
    let timedOut = false
    let idleTimer = setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, TOKEN_IDLE_TIMEOUT_MS)
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, TOKEN_IDLE_TIMEOUT_MS)
    }

    let fullText = ""
    const stream = await model.stream(
      [new SystemMessage(SKILL_PROPOSAL_SYSTEM_PROMPT), new HumanMessage(userPrompt)],
      { signal: abortController.signal }
    )

    try {
      for await (const chunk of stream) {
        resetIdleTimer()
        const token = typeof chunk.content === "string" ? chunk.content : ""
        if (token) {
          fullText += token
          emitSkillGenerating(threadId, "token", token)
        }
      }
    } catch (streamErr) {
      clearTimeout(idleTimer)
      if (timedOut) {
        throw new Error(`技能草稿生成超时（${TOKEN_IDLE_TIMEOUT_MS / 1000}s 内无新内容），请点击重试`)
      }
      throw streamErr
    }
    clearTimeout(idleTimer)

    emitSkillGenerating(threadId, "done", fullText)

    // Strip <think>...</think> reasoning blocks and markdown fences, then parse JSON
    const proposal = parseSkillProposal(fullText)
    if (!proposal) {
      console.warn("[Agent] Failed to parse skill proposal JSON")
      // Emit error so the renderer card transitions out of "generating" state
      emitSkillGenerating(threadId, "error", "技能草稿解析失败，请重试")
      return null
    }
    return proposal
  } catch (e) {
    console.warn("[Agent] Failed to generate skill proposal:", e)
    emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Write an approved skill proposal to disk and notify the renderer.
 */
async function writeSkillToDisk(skillId: string, content: string, name: string): Promise<void> {
  const skillDir = join(getCustomSkillsDir(), skillId)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
  invalidateEnabledSkillsCache()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skills:changed")
  }
  console.log(`[Agent] Wrote skill "${name}" to ${skillDir}`)
}

/**
 * Show the detail confirm dialog and, on adoption, write the skill to disk.
 * Extracted so it can be shared between the normal flow and manual retry.
 */
async function confirmAndWriteSkillProposal(
  threadId: string,
  proposal: SkillProposal
): Promise<void> {
  const skillId = sanitizeSkillId(proposal.skillId || proposal.name)
  if (!skillId) return

  const confirmId = uuid()
  const adopted = await requestSkillConfirmation({
    threadId,
    requestId: confirmId,
    skillId,
    name: proposal.name,
    description: proposal.description,
    content: proposal.content
  })

  if (!adopted) {
    console.log(`[Agent][${threadId}] User rejected skill detail for "${proposal.name}"`)
    return
  }

  await writeSkillToDisk(skillId, proposal.content, proposal.name)
}

/**
 * Shared tail of the skill proposal flow (used by both modes):
 *   1. Ask user intent via banner
 *   2. On yes → LLM generates skill (streaming)
 *   3. Show detail confirm dialog
 *   4. On adopt → write to disk
 */
async function runSkillProposalFlow(
  threadId: string,
  context: SkillProposalWindowContext,
  intentMode: "mode_a_rule" | "mode_b_llm",
  recommendationReason?: string
): Promise<void> {
  const latestUserMessage = context.turns[context.turns.length - 1]?.userMessage ?? context.transcript

  // Step 1 — Intent banner: ask user whether they want to save as a skill.
  // We include the proposal context so the renderer can cache it for manual retry.
  const intentId = uuid()
  const wantsSkill = await requestSkillIntent({
    threadId,
    requestId: intentId,
    summary: latestUserMessage.slice(0, 120),
    toolCallCount: context.toolCallCount,
    mode: intentMode,
    recommendationReason,
    context
  })

  if (shouldResetSkillEvolutionSessionAfterIntent(wantsSkill ? "accept" : "skip")) {
    resetSkillEvolutionSession(threadId)
  }

  if (!wantsSkill) {
    console.log(`[Agent][${threadId}] User declined skill intent`)
    return
  }

  // Step 2 — LLM generates skill draft (streaming, visible in right panel)
  // generateSkillProposal() is responsible for emitting skill:generating events
  // (including the terminal "error" event) before returning null, so the renderer
  // card will always transition to a final state.
  console.log(`[Agent][${threadId}] User confirmed intent, generating skill proposal…`)
  const proposal = await generateSkillProposal(threadId, context)
  if (!proposal) {
    console.log(`[Agent][${threadId}] Could not generate skill proposal (no model or parse error)`)
    return
  }

  // Step 3+4 — Detail confirm dialog → write to disk
  await confirmAndWriteSkillProposal(threadId, proposal)
}

/**
 * After a conversation meets the tool-call threshold, decide whether to
 * propose a skill and, if so, run the shared proposal flow.
 *
 * Mode A (toggle ON):
 *   threshold reached -> enter proposal flow directly
 *
 * Mode B (toggle OFF):
 *   threshold reached -> ask worthiness LLM -> only continue when worthy=true
 *
 * Both modes then share the same user-facing flow:
 *   Intent Banner → LLM generates draft → Detail confirm → Write to disk
 */
async function autoProposeSKill(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<void> {
  const autoProposeEnabled = isSkillAutoProposeEnabled()
  const mode = getSkillProposalMode(autoProposeEnabled)

  console.log(`[SkillEvolution][${threadId}] Decision start ${JSON.stringify({
    mode,
    toolCallCount: context.toolCallCount,
    turnCount: context.turnCount,
    errorCount: context.errorCount,
    toolCallSummary: context.toolCallSummary
  })}`)

  let llmWorthy = false
  let worthinessReason: string | undefined
  if (shouldJudgeSkillWorthiness(mode)) {
    const worthiness = await judgeSkillWorthiness(threadId, context)
    llmWorthy = worthiness?.worthy ?? false
    worthinessReason = worthiness?.reason
  } else {
    console.log(`[SkillEvolution][${threadId}] Mode A selected, skipping worthiness LLM`)
  }

  const shouldPropose = shouldProposeSkill(mode, llmWorthy)

  if (!shouldPropose) {
    console.log(`[SkillEvolution][${threadId}] Decision skip ${JSON.stringify({
      mode,
      llmWorthy,
      reason: "proposal_flow_not_triggered"
    })}`)
    return
  }

  console.log(`[SkillEvolution][${threadId}] Decision enter proposal flow ${JSON.stringify({
    mode,
    llmWorthy,
    toolCallCount: context.toolCallCount,
    turnCount: context.turnCount
  })}`)
  await runSkillProposalFlow(threadId, context, mode, worthinessReason)
}


export function registerAgentHandlers(ipcMain: IpcMain): void {
  console.log("[Agent] Registering agent handlers...")

  // Manual retry for skill generation — triggered when the user clicks the retry button
  // in the right panel after a generation failure.  Skips the intent banner (user already
  // accepted), jumps straight to generate → confirm → write.
  ipcMain.handle(
    "skill:retryGeneration",
    async (_event, payload: { threadId: string; context: unknown; intentMode: string }) => {
      const { threadId, context, intentMode } = payload

      if (!threadId) return
      if (!isSkillProposalWindowContext(context)) {
        emitSkillGenerating(threadId, "error", "技能草稿上下文无效，请等待下次重新触发")
        return
      }
      if (intentMode !== "mode_a_rule" && intentMode !== "mode_b_llm") {
        emitSkillGenerating(threadId, "error", "技能触发模式无效，请等待下次重新触发")
        return
      }

      console.log(`[SkillEvolution][${threadId}] Manual retry requested ${JSON.stringify({
        intentMode,
        toolCallCount: context.toolCallCount,
        turnCount: context.turnCount
      })}`)

      try {
        const proposal = await generateSkillProposal(threadId, context)
        if (!proposal) return
        await confirmAndWriteSkillProposal(threadId, proposal)
      } catch (e) {
        console.warn(`[SkillEvolution][${threadId}] Retry flow failed:`, e)
        emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
      }
    }
  )

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

    // Start trace collection for this invocation (modelId resolved later)
    const tracer = new TraceCollector(threadId, message, modelId ?? "unknown")
    const skillUsageDetector = new SkillUsageDetector()
    const toolCallCounter = new ToolCallCounter()
    let assistantText = ""

    const appendTurnToProposalWindow = (
      status: "success" | "error",
      errorMessage?: string
    ): SkillProposalWindowContext => {
      appendSkillProposalWindowTurn(threadId, {
        userMessage: message,
        assistantText,
        toolCallNames: toolCallCounter.getNames(),
        toolCallCount: toolCallCounter.getCount(),
        status,
        errorMessage,
        usedSkills: skillUsageDetector.getUsedSkillNames(),
        finishedAt: new Date().toISOString()
      })

      const context = buildSkillProposalWindowContext(snapshotSkillProposalWindow(threadId))
      console.log(`[SkillEvolution][${threadId}] Window append ${JSON.stringify({
        status,
        currentTurnToolCallCount: toolCallCounter.getCount(),
        windowTurnCount: context.turnCount,
        windowToolCallCount: context.toolCallCount,
        usedSkills: context.usedSkills
      })}`)
      return context
    }

    try {
      // Get workspace path from thread metadata - REQUIRED
      const thread = getThread(threadId)
      let metadata: Record<string, unknown> = {}
      if (thread?.metadata) {
        try {
          metadata = JSON.parse(thread.metadata)
        } catch {
          console.warn("[Agent] Failed to parse thread metadata, using empty object")
        }
      }
      console.log("[Agent] Thread metadata:", metadata)

      const workspacePath = metadata.workspacePath as string | undefined

      if (!workspacePath) {
        window.webContents.send(channel, {
          type: "error",
          error: "WORKSPACE_REQUIRED",
          message: "Please select a workspace folder before sending messages."
        })
        await tracer.finish("error", "WORKSPACE_REQUIRED")
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
        modelId: effectiveModelId,
        abortSignal: abortController.signal,
        noSkillEvolutionTool: true
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

      // Update tracer with resolved modelId
      if (effectiveModelId) tracer.setModelId(effectiveModelId)

      // ── Tool-call extraction (tested in __tests__/tool-call-extraction.test.ts)
      //
      // "messages" mode delivers one [msgChunk, metadata?] tuple per LangGraph message.
      // AI messages carry a complete tool_calls array even in streaming mode —
      // confirmed by stream-converter.ts and unit tests.
      //
      // Deduplication: same AI message ID can appear in multiple chunks
      // (e.g. once as AIMessageChunk, once as AIMessage in a values snapshot).
      // We track seen IDs to count each unique tool invocation exactly once.
      // ─────────────────────────────────────────────────────────────────────────

      const _countedAiMsgIds = new Set<string>()
      const _countedModelMsgIds = new Set<string>()
      const _countedToolResultMsgIds = new Set<string>()
      const _llmNodeByMessageId = new Map<string, string>()
      const _toolNodeByRef = new Map<string, string>()
      const MODEL_INPUT_WINDOW = 12
      const MAX_TRACE_CONTENT = 2000

      const trimContent = (s: string): string =>
        s.length > MAX_TRACE_CONTENT ? `${s.slice(0, MAX_TRACE_CONTENT)}\n…(truncated)` : s

      const normalizeMessageText = (s: string): string =>
        s.replace(/\r\n/g, "\n").trim()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractText = (raw: any): string => {
        if (typeof raw === "string") return trimContent(raw)
        if (!Array.isArray(raw)) return ""
        const text = raw
          .map((b) => {
            if (typeof b === "string") return b
            if (!b || typeof b !== "object") return ""
            if (typeof b.text === "string") return b.text
            if (typeof b.content === "string") return b.content
            return ""
          })
          .filter(Boolean)
          .join("\n")
        return trimContent(text)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toRole = (className: string, kwargs: any): "system" | "user" | "assistant" | "tool" | "unknown" => {
        if (className.includes("Human")) return "user"
        if (className.includes("AI")) return "assistant"
        if (className.includes("System")) return "system"
        if (className.includes("Tool")) return "tool"
        if (kwargs?.type === "human") return "user"
        if (kwargs?.type === "ai") return "assistant"
        if (kwargs?.type === "system") return "system"
        if (kwargs?.type === "tool") return "tool"
        return "unknown"
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalizeTokenUsage = (usage: any): {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
      } | undefined => {
        if (!usage || typeof usage !== "object") return undefined
        const toNum = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined
        const inputTokens = toNum(usage.input_tokens ?? usage.inputTokens)
        const outputTokens = toNum(usage.output_tokens ?? usage.outputTokens)
        const totalTokens = toNum(usage.total_tokens ?? usage.totalTokens)
        const cacheReadTokens = toNum(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens)
        const cacheCreationTokens = toNum(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens)
        if (
          inputTokens === undefined &&
          outputTokens === undefined &&
          totalTokens === undefined &&
          cacheReadTokens === undefined &&
          cacheCreationTokens === undefined
        ) return undefined
        return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens }
      }

      let lastFinalText = ""  // 最终回复（不含中间工具推理），用于 ChatX HTTP 回复

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break

        const [mode, data] = chunk as [string, unknown]

        // Serialize first — live BaseMessage objects must be serialized before
        // we can inspect the LangChain class path (msgChunk.id becomes the
        // class array ["langchain_core","messages","AIMessageChunk"] only after
        // toJSON() / JSON.stringify; on the live object, .id is the msg-id string).
        const serialized = JSON.parse(JSON.stringify(data))

        if (mode === "values") {
          try {
            const state = serialized as {
              skillsMetadata?: Array<{ name?: string; path?: string }>
              messages?: Array<{
                id?: string[]
                kwargs?: {
                  id?: string
                  type?: string
                  content?: unknown
                  name?: string
                  tool_call_id?: string
                  usage_metadata?: unknown
                  response_metadata?: { token_usage?: unknown }
                  tool_calls?: Array<{
                    id?: string
                    name?: string
                    args?: Record<string, unknown>
                  }>
                }
              }>
            }
            const skillsMetadata = Array.isArray(state.skillsMetadata) ? state.skillsMetadata : []
            if (skillsMetadata.length > 0) {
              skillUsageDetector.onSkillsMetadata(skillsMetadata)
              tracer.setUsedSkills(skillUsageDetector.getUsedSkillNames())
            }

            // Values mode usually carries fuller tool-call args than messages mode.
            if (Array.isArray(state.messages)) {
              let currentTurnStartIndex = -1
              for (let i = state.messages.length - 1; i >= 0; i--) {
                const msg = state.messages[i]
                const kwargs = msg?.kwargs || {}
                const classId = Array.isArray(msg?.id) ? msg.id : []
                const className = classId[classId.length - 1] || ""
                const role = toRole(className, kwargs)
                if (role !== "user") continue
                if (normalizeMessageText(extractText(kwargs.content)) === normalizeMessageText(message)) {
                  currentTurnStartIndex = i
                  break
                }
              }

              const valuesStartIndex = currentTurnStartIndex >= 0 ? currentTurnStartIndex + 1 : 0

              for (let i = valuesStartIndex; i < state.messages.length; i++) {
                const msg = state.messages[i]
                const tcs = msg?.kwargs?.tool_calls

                const kwargs = msg?.kwargs || {}
                const classId = Array.isArray(msg?.id) ? msg.id : []
                const className = classId[classId.length - 1] || ""
                const isAI = className.includes("AI") || kwargs.type === "ai"
                const isToolMessage = className.includes("Tool") || kwargs.type === "tool"
                const aiMsgId = typeof kwargs.id === "string" ? kwargs.id : ""
                if (isAI && aiMsgId && !_countedModelMsgIds.has(aiMsgId)) {
                  _countedModelMsgIds.add(aiMsgId)

                  const inputSlice = state.messages
                    .slice(Math.max(0, i - MODEL_INPUT_WINDOW), i)
                    .map((m) => {
                      const k = m?.kwargs || {}
                      const cid = Array.isArray(m?.id) ? m.id : []
                      const cname = cid[cid.length - 1] || ""
                      return {
                        role: toRole(cname, k),
                        content: extractText(k.content),
                        ...(typeof k.name === "string" ? { name: k.name } : {}),
                        ...(typeof k.tool_call_id === "string" ? { toolCallId: k.tool_call_id } : {})
                      }
                    })
                    .filter((m) => m.content || m.role === "tool")

                  const outputToolCalls = Array.isArray(tcs)
                    ? tcs.map((tc) => ({
                      name: tc?.name ?? "unknown",
                      args: tc?.args ?? {}
                    }))
                    : []

                  const llmNodeId = tracer.beginLlmNode({
                    messageId: aiMsgId,
                    startedAt: new Date().toISOString(),
                    input: inputSlice,
                    metadata: {
                      toolCallCount: outputToolCalls.length
                    }
                  })
                  _llmNodeByMessageId.set(aiMsgId, llmNodeId)

                  tracer.recordModelCall({
                    messageId: aiMsgId,
                    startedAt: new Date().toISOString(),
                    inputMessages: inputSlice,
                    outputMessage: {
                      role: "assistant",
                      content: extractText(kwargs.content),
                    },
                    toolCalls: outputToolCalls,
                    tokenUsage: normalizeTokenUsage(kwargs.usage_metadata ?? kwargs.response_metadata?.token_usage)
                  })

                  tracer.endLlmNode({
                    nodeId: llmNodeId,
                    output: extractText(kwargs.content),
                    status: "success",
                    metadata: {
                      tokenUsage: normalizeTokenUsage(kwargs.usage_metadata ?? kwargs.response_metadata?.token_usage)
                    }
                  })
                }

                if (Array.isArray(tcs)) {
                  for (let tcIndex = 0; tcIndex < tcs.length; tcIndex++) {
                    const tc = tcs[tcIndex]
                    const tcId = typeof tc?.id === "string" ? tc.id : ""
                    const toolRef = tcId || `${aiMsgId || "ai_unknown"}:${tcIndex}:${JSON.stringify(tc?.args ?? {})}`
                    const counted = toolCallCounter.register(tc, aiMsgId, tcIndex)
                    if (!_toolNodeByRef.has(toolRef)) {
                      const parentId = aiMsgId ? _llmNodeByMessageId.get(aiMsgId) : undefined
                      const toolNodeId = tracer.addToolNode({
                        name: tc?.name ?? "unknown",
                        input: tc?.args ?? {},
                        parentId,
                        llmMessageId: aiMsgId || undefined,
                        toolCallId: tcId || undefined,
                        metadata: { index: tcIndex }
                      })
                      _toolNodeByRef.set(toolRef, toolNodeId)
                    }

                    if (counted) {
                      const turnCount = toolCallCounter.getCount()
                      console.log(`[Agent] Turn tool call #${turnCount} (${tc?.name ?? "unknown"}) in thread ${threadId} [values]`)
                    }

                    if (tc?.name !== "read_file") continue
                    const readPathRaw =
                      (typeof tc.args?.path === "string" && tc.args.path) ||
                      (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
                      ""
                    if (readPathRaw) {
                      skillUsageDetector.onReadFilePath(readPathRaw)
                    }
                  }
                }

                if (isToolMessage) {
                  const toolMsgId = typeof kwargs.id === "string"
                    ? kwargs.id
                    : `${kwargs.tool_call_id ?? "tool"}:${i}:${extractText(kwargs.content)}`
                  if (_countedToolResultMsgIds.has(toolMsgId)) continue
                  const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
                  _countedToolResultMsgIds.add(toolMsgId)
                  const parentId = toolCallId ? _toolNodeByRef.get(toolCallId) : undefined
                  tracer.addToolResultNode({
                    parentId,
                    toolCallId: toolCallId || undefined,
                    output: extractText(kwargs.content),
                    status: "success",
                    metadata: {
                      messageId: toolMsgId
                    }
                  })
                }
              }
            }
          } catch (e) {
            console.error("[Agent] skillsMetadata extraction error:", e)
          }
        }

        if (mode === "messages") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [msgChunk] = serialized as [any]
            if (!msgChunk) continue

            const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
            const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
            const className = classId[classId.length - 1] || ""
            const isAI = className.includes("AI")
            if (!isAI) continue

            // Accumulate visible assistant text
            const rawContent = kwargs.content ?? msgChunk.content
            if (rawContent) {
              if (typeof rawContent === "string") {
                assistantText += rawContent
              } else if (Array.isArray(rawContent)) {
                assistantText += (rawContent as Array<{ type?: string; text?: string }>)
                  .filter((b) => b?.type === "text")
                  .map((b) => b.text ?? "")
                  .join("")
              }
            }

            // Tool-call extraction — deduped by message ID
            const toolCalls = kwargs.tool_calls as Array<{
              id?: string; name?: string; args?: Record<string, unknown>
            }> | undefined
            const msgId = (kwargs.id as string) || ""
            if (!toolCalls || toolCalls.length === 0) continue
            if (msgId && _countedAiMsgIds.has(msgId)) continue
            if (msgId) _countedAiMsgIds.add(msgId)

            // Extract step text (text blocks only from array content)
            let stepText = ""
            if (typeof rawContent === "string") {
              stepText = rawContent
            } else if (Array.isArray(rawContent)) {
              stepText = (rawContent as Array<{ type?: string; text?: string }>)
                .filter((b) => b?.type === "text")
                .map((b) => b.text ?? "")
                .join("")
            }

            // Record trace step + increment skill-evolution counter
            tracer.beginStep()
            for (let tcIndex = 0; tcIndex < toolCalls.length; tcIndex++) {
              const tc = toolCalls[tcIndex]
              const tcName = tc.name ?? "unknown"
              tracer.recordToolCall({ name: tcName, args: tc.args ?? {} })
              const counted = toolCallCounter.register(tc, msgId, tcIndex)

              if (tcName === "read_file") {
                const readPathRaw =
                  (typeof tc.args?.path === "string" && tc.args.path) ||
                  (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
                  ""
                if (readPathRaw) {
                  skillUsageDetector.onReadFilePath(readPathRaw)
                }
              }

              if (counted) {
                const turnCount = toolCallCounter.getCount()
                console.log(`[Agent] Turn tool call #${turnCount} (${tcName}) in thread ${threadId}`)
              }
            }
            tracer.endStep(stepText)
          } catch (e) {
            console.error("[Agent] Tool-call extraction error:", e)
          }
        }

        if (mode === "values") {
          try {
            const state = serialized as { messages?: Array<{ kwargs?: Record<string, unknown>; id?: string[] }> }
            if (state?.messages) {
              const finalMsgs = state.messages.filter((m) => {
                const cn = Array.isArray(m.id) ? m.id[m.id.length - 1] || "" : ""
                const kw = m.kwargs || {}
                return cn.includes("AI") && (!kw.tool_calls || !Array.isArray(kw.tool_calls) || kw.tool_calls.length === 0)
              })
              const last = finalMsgs[finalMsgs.length - 1]
              if (last) {
                const kw = last.kwargs || {}
                const content = kw.content
                let text = ""
                if (typeof content === "string") text = content
                else if (Array.isArray(content)) {
                  text = (content as Array<{ type: string; text?: string }>)
                    .filter((b) => b.type === "text" && typeof b.text === "string")
                    .map((b) => b.text!)
                    .join("")
                }
                if (text.trim()) lastFinalText = text.trim()
              }
            }
          } catch { /* best-effort */ }
        }

        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: serialized
        })
      }

      if (!abortController.signal.aborted) {
        window.webContents.send(channel, { type: "done" })
        notifyIfBackground("✅ 任务完成", assistantText.trim() || "对话已完成")

        // Finish trace
        tracer.setUsedSkills(skillUsageDetector.getUsedSkillNames())
        await tracer.finish("success")

        if (isOnlineSkillEvolutionEnabled()) {
          const proposalContext = appendTurnToProposalWindow("success")

          // Check if this turn crossed the skill-evolution threshold.
          const sessionToolCallCount = proposalContext.toolCallCount
          const threshold = getSkillEvolutionThreshold()
          if (shouldEvaluateSkillProposalWindow(sessionToolCallCount, threshold)) {
            const mode = getSkillProposalMode(isSkillAutoProposeEnabled())
            console.log(`[SkillEvolution][${threadId}] Threshold reached ${JSON.stringify({
              toolCallCount: sessionToolCallCount,
              windowToolCallCount: proposalContext.toolCallCount,
              threshold,
              mode,
              usedSkills: proposalContext.usedSkills,
              turnCount: proposalContext.turnCount,
              errorCount: proposalContext.errorCount,
              toolCallSummary: proposalContext.toolCallSummary
            })}`)
            if (proposalContext.usedSkills.length > 0) {
              const names = ` [${proposalContext.usedSkills.join(", ")}]`
              console.log(
                `[SkillEvolution][${threadId}] Threshold skip because used skills were detected${names}`
              )
            } else {
              console.log(`[SkillEvolution][${threadId}] Threshold passed without used skills, evaluating proposal mode`)
              await autoProposeSKill(threadId, proposalContext).catch((e) =>
                console.warn("[Agent] autoProposeSKill failed:", e)
              )
            }
          }
        } else {
          resetSkillEvolutionSession(threadId)
        }

        // If this is a ChatX-linked thread, also send reply via HTTP (only final answer, no tool reasoning)
        const chatxReply = lastFinalText || stripThink(assistantText).trim()
        if (metadata.chatxRobotChatId && chatxReply) {
          trySendChatXReply(metadata.chatxRobotChatId as string, chatxReply)
        }

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
        if (isOnlineSkillEvolutionEnabled()) {
          appendTurnToProposalWindow("error", errMsg)
        } else {
          resetSkillEvolutionSession(threadId)
        }
        tracer.setUsedSkills(skillUsageDetector.getUsedSkillNames())
        tracer.finish("error", errMsg).catch(() => {})
      } else {
        tracer.setUsedSkills(skillUsageDetector.getUsedSkillNames())
        tracer.finish("cancelled").catch(() => {})
      }
    } finally {
      activeRuns.delete(threadId)
      // Clean up sandbox ACLs granted during this run (unelevated mode keeps them
      // across commands for performance, so we revoke them when the run ends).
      // Uses threadId to only release this run's ref-counts, not other concurrent runs'.
      LocalSandbox.revokeGrantedAclsForRun(threadId).catch((err) => {
        console.warn("[Agent] ACL cleanup error:", err)
      })
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
        modelId: effectiveModelId,
        abortSignal: abortController.signal,
        noSkillEvolutionTool: true
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
      activeRuns.delete(threadId)
    }
  })

  // Handle HITL interrupt response
  // NOTE: With the orchestrator-based approval system, execute commands are no
  // longer interrupted via HITL middleware. This handler remains for backward
  // compatibility and non-execute tool interrupts.
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
      const agent = await createAgentRuntime({ threadId, workspacePath, modelId, abortSignal: abortController.signal, noSkillEvolutionTool: true })
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
      activeRuns.delete(threadId)
    }
  })

  // Handle cancellation
  ipcMain.handle("agent:cancel", async (_event, { threadId }: AgentCancelParams) => {
    const controller = activeRuns.get(threadId)
    console.log(`[Agent] cancel: threadId=${threadId}, hasController=${!!controller}, activeRuns=[${Array.from(activeRuns.keys()).join(", ")}]`)
    // Cancel any background tasks belonging to this thread (e.g. builds, tests)
    LocalSandbox.cancelBackgroundTasks(threadId)
    if (controller) {
      controller.abort()
      activeRuns.delete(threadId)
      console.log(`[Agent] cancel: aborted controller for thread ${threadId}`)
    } else {
      console.warn(`[Agent] cancel: no active run found for thread ${threadId}`)
    }
  })
}

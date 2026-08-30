import { createHash } from "crypto"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { getGlobalRoutingMode, DEFAULT_MAX_TOKENS, DEFAULT_TOP_P, DEFAULT_TOP_K } from "../storage"
import {
  getAvailableModelConfigOrDefault,
  getModelByTier,
  getModelConfigByRef,
  getModelConfigs,
  toModelRef
} from "../models/registry"
import { getThread, updateThread } from "../db"
import type { RoutingTrace, RoutingLayerRecord } from "../agent/trace/types"

export interface RoutingContext {
  taskSource:
    | "chat"
    | "heartbeat"
    | "scheduler_reminder"
    | "scheduler_action"
    | "memory_summarize"
    | "task_mmd"
    | "optimizer"
  message?: string
  threadId?: string
  requestedModelId?: string
  routingMode: "auto" | "pinned"
  /** Set for resume/interrupt continuations so routing reuses the previous model */
  continuation?: "resume" | "interrupt"
}

export interface RoutingResult {
  resolvedModelId: string
  resolvedTier: "premium" | "economy"
  routeReason: string
  fallbackChain: string[]
  layer: "pinned" | "layer1" | "thread" | "layer2" | "layer3"
  /** Complete three-layer funnel record for offline analysis (never throws) */
  routingTrace?: RoutingTrace
}

// ─── Thread-level routing state ──────────────────────────────────────────────

interface ThreadRoutingState {
  lastResolvedTier?: "premium" | "economy"
  lastResolvedModelId?: string
  lastRoutedAt?: number
  lastRunOutcome?: "success" | "error" | "cancelled"
  lastToolCallCount?: number
  lastToolErrorCount?: number
  /** Sticky premium: any turn with tool calls activates this for 20 min */
  premiumStickyUntil?: number
  /** Force premium: economy mis-route (tool errors / failed run) activates this for 30 min */
  forcePremiumUntil?: number
  /** Failover sticky: after a model API failover, prefer the successful model for a period */
  failoverStickyModelId?: string
  failoverStickyUntil?: number
  /** Last known input token count — used for context window capacity guard */
  lastInputTokens?: number
}

export interface RoutingFeedback {
  resolvedTier: "premium" | "economy"
  resolvedModelId: string
  outcome: "success" | "error" | "cancelled"
  toolCallCount: number
  toolErrorCount: number
  /** High-water mark of input tokens from the completed run */
  lastInputTokens?: number
}

const PREMIUM_STICKY_TTL_MS = 40 * 60 * 1000 // 40 min
const FORCE_PREMIUM_TTL_MS = 60 * 60 * 1000 // 60 min
const FAILOVER_STICKY_TTL_MS = 30 * 60 * 1000 // 30 min — after failover, prefer the successful model

function readThreadRoutingState(threadId: string | undefined): ThreadRoutingState | null {
  if (!threadId) return null
  const row = getThread(threadId)
  if (!row?.metadata) return null
  try {
    const meta = JSON.parse(row.metadata) as Record<string, unknown>
    return (meta.routingState as ThreadRoutingState) ?? null
  } catch {
    return null
  }
}

function writeThreadRoutingState(threadId: string, patch: Partial<ThreadRoutingState>): void {
  const row = getThread(threadId)
  if (!row) return
  let meta: Record<string, unknown> = {}
  try {
    meta = row.metadata ? JSON.parse(row.metadata) : {}
  } catch {
    /* keep empty */
  }
  const prev = (meta.routingState as ThreadRoutingState | undefined) ?? {}
  meta.routingState = { ...prev, ...patch }
  updateThread(threadId, { metadata: JSON.stringify(meta) })
}

/** Called after a successful failover — makes subsequent turns prefer the failover model. */
export function setFailoverSticky(threadId: string | undefined, modelId: string): void {
  if (!threadId) return
  try {
    writeThreadRoutingState(threadId, {
      failoverStickyModelId: modelId,
      failoverStickyUntil: Date.now() + FAILOVER_STICKY_TTL_MS
    })
    console.log(
      `[ROUTING] Failover sticky set for thread ${threadId}: ${modelId} (${FAILOVER_STICKY_TTL_MS / 60_000}min)`
    )
  } catch (err) {
    console.warn(`[ROUTING] Failed to set failover sticky for thread ${threadId}:`, err)
  }
}

/** Called after routing decision is made — remembers what tier/model was chosen.
 *  When `failoverStickyModelId` is provided, the failover sticky fields are written
 *  in the same atomic patch to avoid a double read-modify-write race. */
export function rememberRoutingDecision(
  threadId: string | undefined,
  result: RoutingResult,
  failoverStickyModelId?: string
): void {
  if (!threadId) return
  try {
    const patch: Partial<ThreadRoutingState> = {
      lastResolvedTier: result.resolvedTier,
      lastResolvedModelId: result.resolvedModelId,
      lastRoutedAt: Date.now()
    }
    if (failoverStickyModelId) {
      patch.failoverStickyModelId = failoverStickyModelId
      patch.failoverStickyUntil = Date.now() + FAILOVER_STICKY_TTL_MS
      console.log(
        `[ROUTING] Failover sticky set for thread ${threadId}: ${failoverStickyModelId} (${FAILOVER_STICKY_TTL_MS / 60_000}min)`
      )
    }
    writeThreadRoutingState(threadId, patch)
  } catch (err) {
    console.warn(`[ROUTING] Failed to persist routing decision for thread ${threadId}:`, err)
  }
}

/**
 * Called after a run completes — writes feedback so the next routing decision
 * can account for mis-routes (economy used when tool calls were needed).
 */
export function rememberRoutingFeedback(threadId: string | undefined, fb: RoutingFeedback): void {
  if (!threadId) return
  try {
    const now = Date.now()
    const prev = readThreadRoutingState(threadId) ?? {}

    const touchedTools = fb.toolCallCount > 0
    // economy mis-route: economy model was used but either errored or made tool calls it botched
    const misroutedEconomy =
      fb.resolvedTier === "economy" && (fb.toolErrorCount > 0 || fb.outcome === "error")

    writeThreadRoutingState(threadId, {
      lastResolvedTier: fb.resolvedTier,
      lastResolvedModelId: fb.resolvedModelId,
      lastRunOutcome: fb.outcome,
      lastToolCallCount: fb.toolCallCount,
      lastToolErrorCount: fb.toolErrorCount,
      // any tool work → stick to premium for 20 min (follow-up messages likely need same context)
      premiumStickyUntil: touchedTools ? now + PREMIUM_STICKY_TTL_MS : prev.premiumStickyUntil,
      // economy failure → force premium for 30 min
      forcePremiumUntil: misroutedEconomy ? now + FORCE_PREMIUM_TTL_MS : prev.forcePremiumUntil,
      // Persist input token high-water mark for context window capacity guard
      lastInputTokens: fb.lastInputTokens ?? prev.lastInputTokens
    })
  } catch (err) {
    console.warn(`[ROUTING] Failed to persist routing feedback for thread ${threadId}:`, err)
  }
}

// ─── Layer 2 regex rules ─────────────────────────────────────────────────────

/**
 * Pure in-context requests — the model answers entirely from its own knowledge,
 * no file/tool access needed. Economy model handles these well.
 *
 * Positive signals:
 *   - "帮我写|实现|生成 X"  (code gen without a file target)
 *   - "解释|说明|讲解 X"    (concept explanation)
 *   - "X 和 Y 的区别"       (comparison)
 *   - "翻译 X"              (translation)
 *
 * Guard: must NOT contain a file path (caught by FILE_OR_REPO_PATTERN later).
 * Guard: must NOT be too long (>200 chars likely has pasted code/context).
 */
const INCTX_ECONOMY_PATTERN =
  /^(帮(我|忙)?(写|实现|生成|创建|做)(一个|个|段|下)?|写(一个|个|段)|实现(一个|个)?|生成(一个|个)?|解释(一下|下)?|说明(一下|下)?|讲解(一下|下)?|介绍(一下|下)?|[^？?]{0,30}(和|与|vs\.?)[^？?]{0,30}的?(区别|对比|不同)|翻译)/i

/**
 * Filesystem/shell operations — verbs that require the agent to invoke a tool
 * regardless of whether a file path is mentioned.
 * "查看这个文件" / "运行一下" / "帮我 grep" → definitely needs tool access.
 */
const FILESYSTEM_OP_PATTERN =
  /\b(read|open|inspect|look at|check|search|grep|find|run|execute|edit|patch|debug|trace|review|refactor|resume)\b|查看|检查|搜索|查找|读取|打开|运行|执行|调试|排查|重构/i

// Note: code-generation verbs (write/implement/fix/optimize…) without a file path
// are intentionally NOT routed to premium here — the economy model handles them
// in-context. FILE_OR_REPO_PATTERN above already catches the "fix src/foo.ts" case.

/**
 * Detects file paths or filenames — a strong signal the agent needs to touch the filesystem.
 */
const FILE_OR_REPO_PATTERN =
  /(?:^|[\s`"'(])(src\/|app\/|lib\/|packages\/|components\/|tests?\/|[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|json|ya?ml|toml|md|sh|env))/

/**
 * Strict economy allow-list: ONLY these patterns are safe to send to economy.
 * Must not contain any tool-intent or file-reference signals.
 */
const STRICT_ECONOMY_PATTERN =
  /^(你好|hi|hello|ok|okay|好的|收到|谢谢|thanks?|明白了?|嗯+|哦+|👍|✅|翻译|总结一下|概括一下|什么意思|是什么意思|怎么读)/i

/**
 * Technical/question intent signals — any match means the message has depth and
 * should NOT be classified as economy by the scorer.
 */
const TECH_QUESTION_PATTERN =
  /为什么|怎么|如何|帮(我|忙)|能不能|有没有|什么是|是什么|原理|机制|区别|对比|报错|错误|异常|问题|bug|issue|error|why|how|what|when|where|which/i

/**
 * Ambiguous continuation words — short but carry task intent; must go to Layer 3.
 */
const AMBIGUOUS_SHORT_PATTERN = /^(继续|接着|然后|下一步|next|go on|proceed|continue)$/i

/**
 * Lightweight feature-scoring classifier — runs in <1ms, zero dependencies.
 *
 * Returns "economy" only when high-confidence that the message is a pure social /
 * acknowledgement exchange with no technical depth.
 * Returns "uncertain" otherwise → falls through to Layer 3.
 *
 * Scoring rubric (economy threshold = 4):
 *   +2  very short  (≤ 10 chars)
 *   +1  short       (≤ 25 chars)
 *   +1  no question/command punctuation (no ? ？ ! ！ : ；)
 *   +1  no multi-char English words (pure CJK / emoji / single letters)
 *   +2  no technical/question intent  (TECH_QUESTION_PATTERN not matched)
 *   −3  contains question mark
 *   −2  contains ≥3-digit number (port, line, error code)
 *   −99 ambiguous continuation word (继续, next, …) → always uncertain
 */
function scoreSocialEconomy(trimmed: string): { result: "economy" | "uncertain"; score: number } {
  // Hard gate: too long to be pure social
  if (trimmed.length > 40) return { result: "uncertain", score: -1 }

  // Ambiguous continuation words look short but carry implicit task context
  if (AMBIGUOUS_SHORT_PATTERN.test(trimmed)) return { result: "uncertain", score: -1 }

  let score = 0

  // Length signals
  if (trimmed.length <= 10) score += 2
  else if (trimmed.length <= 25) score += 1

  // No punctuation that implies a question or structured command
  if (!/[?？!！:：;；]/.test(trimmed)) score += 1

  // No multi-char English words (pure CJK greetings or short emoji combos)
  if (!/[a-zA-Z]{2,}/.test(trimmed)) score += 1

  // No technical/question intent keywords — required for economy; penalise if matched
  if (!TECH_QUESTION_PATTERN.test(trimmed)) score += 2
  else score -= 2 // tech keyword found → strong signal against economy

  // Explicit penalties
  if (/[?？]/.test(trimmed)) score -= 3
  if (/\d{3,}/.test(trimmed)) score -= 2

  return { result: score >= 4 ? "economy" : "uncertain", score }
}

/** Rough token estimate: 1 token ≈ 1.5 Chinese chars or 4 English chars */
function estimateTokens(text: string): number {
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const nonChinese = text.length - chineseCount
  return Math.ceil(chineseCount / 1.5 + nonChinese / 4)
}

function countCodeBlocks(text: string): number {
  return (text.match(/```/g) ?? []).length / 2
}

function requiresToolCapability(message: string): boolean {
  // Filesystem/shell verbs always require tool access
  if (FILESYSTEM_OP_PATTERN.test(message)) return true
  // File path present → agent must touch the filesystem
  if (FILE_OR_REPO_PATTERN.test(message)) return true
  // In-context code verbs (write/fix/implement…) only require tool access when
  // paired with a file reference — otherwise the model can answer in-context.
  // FILE_OR_REPO_PATTERN already caught the path above, so nothing extra here.
  // Error output pasted in → agent needs to debug real code → premium
  if (
    /```/.test(message) &&
    /(error|traceback|exception|stack trace|npm |pnpm |tsc |jest |pytest)/i.test(message)
  )
    return true
  return false
}

function isStrictEconomy(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (requiresToolCapability(trimmed)) return false
  return trimmed.length <= 80 && STRICT_ECONOMY_PATTERN.test(trimmed)
}

type Layer2Result = "premium" | "economy" | "uncertain"

interface Layer2Detail {
  result: Layer2Result
  matchedRule: string
  estimatedTokens?: number
  codeBlockCount?: number
  /** Matched fragment from FILESYSTEM_OP_PATTERN (previously toolIntentMatch) */
  fsOpMatch?: string
  filePatternMatch?: string
  /** Matched fragment from INCTX_ECONOMY_PATTERN */
  inCtxMatch?: boolean
  /** Social-score details from scoreSocialEconomy() */
  socialScore?: number
  messageLength?: number
}

function applyLayer2RulesWithDetail(message: string): Layer2Detail {
  const trimmed = message.trim()
  if (!trimmed) return { result: "premium", matchedRule: "empty-message" }

  const estimatedTokens = estimateTokens(trimmed)
  if (estimatedTokens > 3000) {
    return { result: "premium", matchedRule: "token-limit-exceeded", estimatedTokens }
  }

  const codeBlockCount = countCodeBlocks(trimmed)
  if (codeBlockCount >= 2) {
    return { result: "premium", matchedRule: "multiple-code-blocks", codeBlockCount }
  }

  // Filesystem/shell verbs (查看/运行/调试…) always require tool access → premium
  const fsMatch = FILESYSTEM_OP_PATTERN.exec(trimmed)
  if (fsMatch) {
    return { result: "premium", matchedRule: "FILESYSTEM_OP_PATTERN", fsOpMatch: fsMatch[0] }
  }

  // File path present → must touch filesystem → premium
  const fileMatch = FILE_OR_REPO_PATTERN.exec(trimmed)
  if (fileMatch) {
    return {
      result: "premium",
      matchedRule: "FILE_OR_REPO_PATTERN",
      filePatternMatch: fileMatch[0]
    }
  }

  // In-context code verbs without file reference → let Layer 3 decide.
  // "帮我写一个快排" / "实现 debounce" are within economy model capability.

  // Check pasted error output
  if (
    /```/.test(trimmed) &&
    /(error|traceback|exception|stack trace|npm |pnpm |tsc |jest |pytest)/i.test(trimmed)
  ) {
    return { result: "premium", matchedRule: "pasted-error-output", codeBlockCount }
  }

  // Pure in-context requests: code gen / explanation / comparison / translation
  // without any file reference → economy model handles these well
  if (trimmed.length <= 200 && INCTX_ECONOMY_PATTERN.test(trimmed)) {
    return {
      result: "economy",
      matchedRule: "INCTX_ECONOMY_PATTERN",
      inCtxMatch: true,
      messageLength: trimmed.length
    }
  }

  // Strict economy allow-list
  if (isStrictEconomy(trimmed)) {
    return { result: "economy", matchedRule: "STRICT_ECONOMY_PATTERN" }
  }

  // Lightweight feature-scoring: catches social/ack short messages not in the allow-list
  // (e.g. "好兄弟", "辛苦了", "还在吗", "加油") without needing an LLM call
  const scored = scoreSocialEconomy(trimmed)
  if (scored.result === "economy") {
    return {
      result: "economy",
      matchedRule: "social-score→economy",
      socialScore: scored.score,
      messageLength: trimmed.length
    }
  }

  return { result: "uncertain", matchedRule: "no-rule-matched", messageLength: trimmed.length }
}

// ─── Layer 3 LLM classifier ──────────────────────────────────────────────────

const CLASSIFIER_CACHE = new Map<string, { tier: "premium" | "economy"; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CACHE_MAX_SIZE = 200 // hard cap — evict oldest entries when exceeded

/** Evict all expired entries; if still over cap, drop the oldest half. */
function evictClassifierCache(): void {
  const now = Date.now()
  for (const [key, entry] of CLASSIFIER_CACHE) {
    if (entry.expiresAt <= now) CLASSIFIER_CACHE.delete(key)
  }
  if (CLASSIFIER_CACHE.size > CACHE_MAX_SIZE) {
    // Map preserves insertion order — delete the first (oldest) half
    const toDelete = Math.floor(CLASSIFIER_CACHE.size / 2)
    let deleted = 0
    for (const key of CLASSIFIER_CACHE.keys()) {
      if (deleted >= toDelete) break
      CLASSIFIER_CACHE.delete(key)
      deleted++
    }
  }
}

function hashMessage(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Read the build-time injected internal fallback model for Layer 3 classifier.
 *  Only available in internal builds — all three VITE_ROUTING_CLASSIFIER_* env vars must be set.
 *  Returns null if any of the three is missing.
 */
function getInternalClassifierModel(): {
  id: string
  name: string
  model: string
  apiKey: string
  baseUrl: string
  topP: number
  topK: number
} | null {
  const model = import.meta.env.VITE_ROUTING_CLASSIFIER_MODEL ?? ""
  const apiKey = import.meta.env.VITE_ROUTING_CLASSIFIER_API_KEY ?? ""
  const baseUrl = import.meta.env.VITE_ROUTING_CLASSIFIER_BASE_URL ?? ""
  if (!model || !apiKey || !baseUrl) return null
  return {
    id: "__internal_classifier__",
    name: "Internal Classifier",
    model,
    apiKey,
    baseUrl,
    topP: DEFAULT_TOP_P,
    topK: DEFAULT_TOP_K
  }
}

/** Pick the best model for Layer 3 classification.
 *
 *  Priority (Qwen-first — supports enable_thinking=false natively):
 *    1. User-configured Qwen economy model
 *    2. Internal fallback Qwen model (build-time env vars, only in internal builds)
 *    3. User-configured non-Qwen economy model
 *    4. null → caller defaults to premium
 *
 *  The internal fallback is invisible to users and never used for task execution.
 */
function pickClassifierModel() {
  const configs = getModelConfigs()
  const economyConfigs = configs.filter((c) => (c.tier ?? "premium") === "economy" && c.apiKey)

  // 1. User-configured Qwen economy model
  const userQwen = economyConfigs.find((c) => /qwen/i.test(c.model))

  // 2. Internal fallback (build-time env vars)
  const internalFallback = getInternalClassifierModel()

  // 3. User-configured non-Qwen economy model
  const userNonQwen = economyConfigs.find((c) => !/qwen/i.test(c.model))

  const selected = userQwen ?? internalFallback ?? userNonQwen ?? null

  console.log(
    `[ROUTING] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      layer: "layer3",
      event: "classifier-model-selected",
      selected: selected
        ? {
            id: selected.id,
            name: selected.name,
            model: selected.model,
            baseUrl: selected.baseUrl,
            source:
              selected === userQwen
                ? "user-qwen"
                : selected === internalFallback
                  ? "internal-fallback"
                  : "user-non-qwen"
          }
        : null,
      hasInternalFallback: !!internalFallback,
      candidates: economyConfigs.map((c) => ({
        id: c.id,
        name: c.name,
        model: c.model,
        baseUrl: c.baseUrl,
        isQwen: /qwen/i.test(c.model)
      }))
    })}`
  )
  return selected
}

const LAYER3_TIMEOUT_MS = 1000

interface Layer3Result {
  tier: "premium" | "economy"
  /** Which model was used for classification (null if cache hit or no model available) */
  classifierModel?: string
  /** Whether the result came from cache */
  cacheHit: boolean
  /** Whether the LLM call timed out */
  timedOut?: boolean
  /** Whether LLM response contained <think> blocks */
  containsThink?: boolean
  /** Raw LLM output preview (first 200 chars) for debugging */
  rawPreview?: string
}

async function classifyWithLlm(message: string): Promise<Layer3Result> {
  const key = hashMessage(message)
  const cached = CLASSIFIER_CACHE.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[ROUTING] ${JSON.stringify({
        timestamp: new Date().toISOString(),
        layer: "layer3",
        event: "classifier-cache-hit",
        cacheKey: key,
        tier: cached.tier
      })}`
    )
    return { tier: cached.tier, cacheHit: true }
  }

  const classifierModel = pickClassifierModel()
  if (!classifierModel) {
    // No economy model with API key available — default to premium
    return { tier: "premium", cacheHit: false }
  }

  try {
    // Extra params to disable thinking — each field targets a different model family.
    // Models that don't recognise a field silently ignore it.
    //   reasoning_effort: "none"          — OpenAI o-series
    //   enable_thinking: false            — Qwen3 / some open-source models
    //   chat_template_kwargs.enable_thinking: false — internal vLLM-served models (company-internal)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noThinkParams: Record<string, any> = {
      reasoning_effort: "none",
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false }
    }

    console.log(
      `[ROUTING] ${JSON.stringify({
        timestamp: new Date().toISOString(),
        layer: "layer3",
        event: "classifier-invoke-start",
        cacheKey: key,
        model: {
          id: classifierModel.id,
          name: classifierModel.name,
          model: classifierModel.model,
          baseUrl: classifierModel.baseUrl
        },
        messageLength: message.length,
        timeoutMs: LAYER3_TIMEOUT_MS,
        noThinkParams: {
          reasoning_effort: noThinkParams.reasoning_effort,
          enable_thinking: noThinkParams.enable_thinking,
          chat_template_kwargs: noThinkParams.chat_template_kwargs
        }
      })}`
    )

    const llm = new ChatOpenAI({
      model: classifierModel.model,
      apiKey: classifierModel.apiKey,
      configuration: { baseURL: classifierModel.baseUrl },
      // 1000 tokens: reasoning models emit a <think> block (~200-500 tok) before the final word
      maxTokens: 1000,
      temperature: 0,
      topP: classifierModel.topP,
      modelKwargs: {
        ...(classifierModel.topK && classifierModel.topK > 0 ? { top_k: classifierModel.topK } : {})
      },
      ...noThinkParams
    })

    const systemPrompt = `You are a routing classifier for an AI coding agent that can read/write files, run commands, and execute code.

Reply with exactly one word: "premium" or "economy".
Default to "premium" if uncertain — task quality and agent stability come first.

Evaluate the request on TWO dimensions:

[1] Agentic need — Does answering require the agent to use tools? (read/write files, run commands, search codebase, debug real errors)
[2] Cognitive depth — Does answering require deep reasoning, multi-step planning, or understanding of a specific codebase?

Route "premium" if EITHER dimension is YES.
Route "economy" only if BOTH dimensions are clearly NO.

--- economy examples (no tools needed, answerable from knowledge) ---
• "好兄弟" / "辛苦了" / "lgtm" → pure social, zero task
• "帮我写一个快排" / "实现 debounce" → generic code gen, in-context
• "解释一下 useEffect 的原理" → concept explanation
• "== 和 === 的区别是什么" → factual comparison
• "把这句话翻译成英文" → translation

--- premium examples (need tools or deep codebase reasoning) ---
• "帮我看看 src/main/index.ts" → must read a specific file
• "查一下哪里调用了 parseDate" → must search the codebase
• "运行 npm install 然后告诉我报错" → must execute a command
• "调试这个报错" / "帮我修复这个 bug" → needs real execution context
• "重构 components/ 目录下的组件" → multi-file, agentic task
• "帮我优化这段代码" (with pasted code + file context) → needs codebase awareness`

    // 1 s hard timeout — if the classifier is slow, fall back to premium immediately
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("layer3-timeout")), LAYER3_TIMEOUT_MS)
    )
    const response = await Promise.race([
      llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(
          `Classify this request (reply only "premium" or "economy"):\n\n${message.slice(0, 600)}`
        )
      ]),
      timeoutPromise
    ])

    const raw = (typeof response.content === "string" ? response.content : "").toLowerCase()
    const containsThink = /<think>[\s\S]*?<\/think>/.test(raw) || raw.includes("<think>")
    // Strip <think>...</think> reasoning blocks emitted by reasoning models (DeepSeek-R1, Qwen3, MiniMax-M2.5, etc.)
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    // Use the last occurrence of "economy"/"premium" — reasoning chains state the conclusion last
    const lastEconomy = text.lastIndexOf("economy")
    const lastPremium = text.lastIndexOf("premium")
    const tier: "premium" | "economy" =
      lastEconomy > lastPremium && lastEconomy !== -1 ? "economy" : "premium"

    console.log(
      `[ROUTING] ${JSON.stringify({
        timestamp: new Date().toISOString(),
        layer: "layer3",
        event: "classifier-invoke-done",
        cacheKey: key,
        model: {
          id: classifierModel.id,
          name: classifierModel.name,
          model: classifierModel.model
        },
        containsThink,
        derivedTier: tier,
        rawPreview: raw.slice(0, 200)
      })}`
    )

    evictClassifierCache()
    CLASSIFIER_CACHE.set(key, { tier, expiresAt: Date.now() + CACHE_TTL_MS })
    return {
      tier,
      classifierModel: classifierModel.model,
      cacheHit: false,
      containsThink,
      rawPreview: raw.slice(0, 200)
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "layer3-timeout"
    const reason = isTimeout ? `timeout >${LAYER3_TIMEOUT_MS}ms` : String(err)
    console.warn(
      `[ROUTING] Layer 3 LLM classifier failed (${reason}), defaulting to premium ${JSON.stringify({
        model: {
          id: classifierModel.id,
          name: classifierModel.name,
          model: classifierModel.model,
          baseUrl: classifierModel.baseUrl
        },
        cacheKey: key,
        timeoutMs: LAYER3_TIMEOUT_MS
      })}`
    )
    return {
      tier: "premium",
      classifierModel: classifierModel.model,
      cacheHit: false,
      timedOut: isTimeout
    }
  }
}

// ─── Fallback chain builder ───────────────────────────────────────────────────

function buildFallbackChain(primaryTier: "premium" | "economy"): string[] {
  const configs = getModelConfigs()
  const fallbackTier: "premium" | "economy" = primaryTier === "economy" ? "premium" : "economy"

  const primary = configs
    .filter((c) => (c.tier ?? "premium") === primaryTier)
    .map((c) => toModelRef(c))
  const fallback = configs
    .filter((c) => (c.tier ?? "premium") === fallbackTier)
    .map((c) => toModelRef(c))
  const all = configs.map((c) => toModelRef(c))

  // deduplicate while preserving order
  const seen = new Set<string>()
  const chain: string[] = []
  for (const id of [...primary, ...fallback, ...all]) {
    if (!seen.has(id)) {
      seen.add(id)
      chain.push(id)
    }
  }
  return chain
}

// ─── Context window capacity guard ──────────────────────────────────────────
//
// When routing decides "economy", verify the chosen economy model's context
// window can handle the current conversation.  If not, try other economy
// models with a larger window; escalate to premium as a last resort.
//
// Threshold: currentInputTokens < 0.75 × model.maxTokens
// Aligned with summarization trigger ratio so guard fires before context compaction.
//
const CONTEXT_CAPACITY_RATIO = 0.75

/**
 * Guard: ensure the economy model's context window is large enough.
 *
 * Returns the original result untouched when:
 *  - tier is premium (no guard needed)
 *  - no lastInputTokens data (first turn in thread — context is tiny)
 *  - economy model has enough capacity
 *
 * Otherwise returns a new RoutingResult pointing to a larger-context economy
 * model, or escalates to premium.
 */
function guardContextCapacity(
  result: RoutingResult,
  threadId: string | undefined,
  layerRecords: RoutingLayerRecord[]
): RoutingResult {
  if (result.resolvedTier !== "economy") return result

  const state = readThreadRoutingState(threadId)
  const lastInputTokens = state?.lastInputTokens
  if (!lastInputTokens || lastInputTokens <= 0) return result

  const configs = getModelConfigs()
  const currentCfg = getModelConfigByRef(result.resolvedModelId)
  const currentCfgRef = currentCfg ? toModelRef(currentCfg) : result.resolvedModelId
  const currentMax = currentCfg?.maxTokens ?? DEFAULT_MAX_TOKENS
  const threshold = Math.floor(currentMax * CONTEXT_CAPACITY_RATIO)

  if (lastInputTokens < threshold) {
    // Current economy model can handle it — no guard needed
    return result
  }

  // Current economy model is near capacity — try other economy models sorted by maxTokens desc
  const otherEconomy = configs
    .filter((c) => (c.tier ?? "premium") === "economy" && toModelRef(c) !== currentCfgRef)
    .sort((a, b) => (b.maxTokens ?? DEFAULT_MAX_TOKENS) - (a.maxTokens ?? DEFAULT_MAX_TOKENS))

  for (const candidate of otherEconomy) {
    const candidateMax = candidate.maxTokens ?? DEFAULT_MAX_TOKENS
    if (lastInputTokens < Math.floor(candidateMax * CONTEXT_CAPACITY_RATIO)) {
      const guardReason = `context-guard:switch-economy(${lastInputTokens}/${candidateMax})`
      console.log(
        `[ROUTING] ${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "context-capacity-guard",
          action: "switch-economy",
          lastInputTokens,
          originalModelMax: currentMax,
          newModelId: toModelRef(candidate),
          newModelMax: candidateMax
        })}`
      )
      layerRecords.push({
        layer: "layer2",
        durationMs: 0,
        result: "economy",
        reason: guardReason,
        detail: {
          lastInputTokens,
          originalMax: currentMax,
          switchedTo: toModelRef(candidate),
          switchedMax: candidateMax
        }
      })
      return {
        ...result,
        resolvedModelId: toModelRef(candidate),
        routeReason: `${result.routeReason}→${guardReason}`,
        fallbackChain: [
          toModelRef(candidate),
          ...result.fallbackChain.filter((id) => id !== toModelRef(candidate))
        ]
      }
    }
  }

  // No economy model can handle the context — escalate to premium
  const guardReason = `context-guard:escalate-premium(${lastInputTokens}/${currentMax})`
  console.log(
    `[ROUTING] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "context-capacity-guard",
      action: "escalate-premium",
      lastInputTokens,
      economyModelMax: currentMax,
      checkedCandidates: otherEconomy.length
    })}`
  )
  layerRecords.push({
    layer: "layer2",
    durationMs: 0,
    result: "premium",
    reason: guardReason,
    detail: { lastInputTokens, economyMax: currentMax, candidatesChecked: otherEconomy.length }
  })
  // Guard only runs for layer2/layer3 economy results, but TS doesn't know — cast safely
  const safeLayer = (result.layer === "pinned" ? "layer2" : result.layer) as
    | "layer1"
    | "thread"
    | "layer2"
    | "layer3"
  const premiumResult = resolveFromTier(
    "premium",
    `${result.routeReason}→${guardReason}`,
    safeLayer
  )
  return premiumResult
}

// ─── Resolve model from tier ─────────────────────────────────────────────────

function resolveFromTier(
  tier: "premium" | "economy",
  reason: string,
  layer: "layer1" | "thread" | "layer2" | "layer3"
): RoutingResult {
  const model = getModelByTier(tier)
  const configs = getModelConfigs()
  const availableFallback = configs.find((config) => Boolean(config.apiKey))
  const fallbackId = model
    ? toModelRef(model)
    : availableFallback
      ? toModelRef(availableFallback)
      : ""
  const fallbackChain = buildFallbackChain(tier)

  const result: RoutingResult = {
    resolvedModelId: fallbackId,
    resolvedTier: tier,
    routeReason: reason,
    fallbackChain,
    layer
  }

  console.log(
    `[ROUTING] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      layer,
      taskSource: "<logged by caller>",
      resolvedModelId: result.resolvedModelId,
      resolvedTier: result.resolvedTier,
      routeReason: result.routeReason
    })}`
  )

  return result
}

function resolveFromExactModel(
  modelId: string,
  tier: "premium" | "economy",
  reason: string
): RoutingResult {
  const fallbackChain = [modelId, ...buildFallbackChain(tier).filter((id) => id !== modelId)]
  const result: RoutingResult = {
    resolvedModelId: modelId,
    resolvedTier: tier,
    routeReason: reason,
    fallbackChain,
    layer: "thread"
  }
  console.log(
    `[ROUTING] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      layer: "thread",
      resolvedModelId: modelId,
      resolvedTier: tier,
      routeReason: reason
    })}`
  )
  return result
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Resolve the user-configured model name from a resolvedModelId like "custom:minmax2.7". */
function resolveModelName(resolvedModelId: string): string {
  const cfg = getModelConfigByRef(resolvedModelId)
  const cfgId = cfg?.id ?? resolvedModelId.replace(/^(?:custom|builtin):/, "")
  // Return the actual model name (e.g. "MiniMax-M2.7"), fall back to display name, then raw id
  return cfg?.model ?? cfg?.name ?? cfgId
}

/** Safely build a RoutingTrace — never throws. */
function buildRoutingTrace(
  ctx: RoutingContext,
  layers: RoutingLayerRecord[],
  finalResult: RoutingResult
): RoutingTrace | undefined {
  try {
    const message = ctx.message ?? ""
    return {
      messageSnippet: message.slice(0, 100),
      taskSource: ctx.taskSource,
      ...(ctx.continuation ? { continuation: ctx.continuation } : {}),
      routingMode: ctx.routingMode,
      resolvedTier: finalResult.resolvedTier,
      resolvedModelId: finalResult.resolvedModelId,
      resolvedModelName: resolveModelName(finalResult.resolvedModelId),
      decidedByLayer: finalResult.layer,
      routingTotalDurationMs: layers.reduce((sum, l) => sum + l.durationMs, 0),
      layers
    }
  } catch {
    return undefined
  }
}

export async function resolveModel(ctx: RoutingContext): Promise<RoutingResult> {
  const logCtx = {
    timestamp: new Date().toISOString(),
    taskSource: ctx.taskSource,
    threadId: ctx.threadId,
    routingMode: ctx.routingMode,
    requestedModelId: ctx.requestedModelId
  }

  // Accumulates per-layer records (side-effect only, never throws)
  const layerRecords: RoutingLayerRecord[] = []

  /** Safely push a layer record — never throws. */
  function recordLayer(rec: RoutingLayerRecord): void {
    try {
      layerRecords.push(rec)
    } catch {
      /* ignore */
    }
  }

  /** Attach routingTrace to result and return — never throws. */
  function withTrace(result: RoutingResult): RoutingResult {
    try {
      result.routingTrace = buildRoutingTrace(ctx, layerRecords, result)
    } catch {
      /* ignore */
    }
    return result
  }

  // ── Pinned mode ─────────────────────────────────────────────────────────────
  if (ctx.routingMode === "pinned") {
    const t0 = Date.now()
    const requestedId = ctx.requestedModelId
    const requestedConfig = requestedId ? getModelConfigByRef(requestedId) : null
    const selectedConfig =
      (requestedConfig?.apiKey ? requestedConfig : null) ?? getAvailableModelConfigOrDefault()
    const modelId = selectedConfig ? toModelRef(selectedConfig) : ""
    const tier = selectedConfig?.tier ?? "premium"
    const usedRequestedModel = Boolean(requestedConfig?.apiKey)

    recordLayer({
      layer: "pinned",
      durationMs: Date.now() - t0,
      result: tier,
      reason: usedRequestedModel ? "user-pinned-model" : "fallback-to-first-config",
      detail: { requestedModelId: requestedId, resolvedModelId: modelId }
    })

    const result: RoutingResult = {
      resolvedModelId: modelId,
      resolvedTier: tier,
      routeReason: "pinned",
      fallbackChain: buildFallbackChain(tier),
      layer: "pinned"
    }
    console.log(`[ROUTING] ${JSON.stringify({ ...logCtx, ...result })}`)
    return withTrace(result)
  }

  // ── Auto mode ───────────────────────────────────────────────────────────────

  // Layer 1: task source fast path
  {
    const t0 = Date.now()
    switch (ctx.taskSource) {
      case "heartbeat":
      case "memory_summarize":
      case "task_mmd":
      case "scheduler_reminder": {
        recordLayer({
          layer: "layer1",
          durationMs: Date.now() - t0,
          result: "economy",
          reason: `taskSource=${ctx.taskSource}→economy`
        })
        const r = resolveFromTier("economy", `layer1:${ctx.taskSource}→economy`, "layer1")
        console.log(
          `[ROUTING] ${JSON.stringify({ ...logCtx, layer: r.layer, resolvedTier: r.resolvedTier, routeReason: r.routeReason })}`
        )
        return withTrace(r)
      }
      case "optimizer": {
        recordLayer({
          layer: "layer1",
          durationMs: Date.now() - t0,
          result: "premium",
          reason: "taskSource=optimizer→premium"
        })
        const r = resolveFromTier("premium", "layer1:optimizer→premium", "layer1")
        console.log(
          `[ROUTING] ${JSON.stringify({ ...logCtx, layer: r.layer, resolvedTier: r.resolvedTier, routeReason: r.routeReason })}`
        )
        return withTrace(r)
      }
      default:
        // chat / scheduler_action — record skip and fall through
        recordLayer({
          layer: "layer1",
          durationMs: Date.now() - t0,
          result: "uncertain",
          reason: `taskSource=${ctx.taskSource}→pass-through`
        })
    }
  }

  // ── Thread continuity (chat only) ───────────────────────────────────────────
  {
    const t0 = Date.now()
    const threadState = readThreadRoutingState(ctx.threadId)
    const now = Date.now()

    if (ctx.taskSource === "chat" && threadState) {
      // resume/interrupt must reuse the exact previous model
      if (ctx.continuation && threadState.lastResolvedModelId) {
        const previousConfig = getModelConfigByRef(threadState.lastResolvedModelId)
        if (previousConfig?.apiKey) {
          const previousRef = toModelRef(previousConfig)
          recordLayer({
            layer: "thread",
            durationMs: Date.now() - t0,
            result: "reuse",
            reason: `${ctx.continuation}→reuse-last-model`,
            detail: {
              lastResolvedModelId: previousRef,
              lastResolvedTier: threadState.lastResolvedTier
            }
          })
          const r = resolveFromExactModel(
            previousRef,
            previousConfig.tier ?? threadState.lastResolvedTier ?? "premium",
            `thread:${ctx.continuation}→reuse-last-model`
          )
          return withTrace(r)
        }
        console.warn(
          `[ROUTING] Previous model ${threadState.lastResolvedModelId} is no longer available; rerouting continuation`
        )
      }

      // Failover sticky: after a model API failover, prefer the successful model
      if (threadState.failoverStickyModelId && (threadState.failoverStickyUntil ?? 0) > now) {
        const foCfg = getModelConfigByRef(threadState.failoverStickyModelId)
        // Only use sticky if the model is still configured and has an API key
        if (foCfg?.apiKey) {
          const remainingMs = (threadState.failoverStickyUntil ?? 0) - now
          recordLayer({
            layer: "thread",
            durationMs: Date.now() - t0,
            result: foCfg.tier ?? "premium",
            reason: "failover-sticky",
            detail: { failoverStickyModelId: threadState.failoverStickyModelId, remainingMs }
          })
          const r = resolveFromExactModel(
            threadState.failoverStickyModelId,
            foCfg.tier ?? "premium",
            "thread:failover-sticky"
          )
          return withTrace(r)
        }
        // Sticky model no longer available, fall through to normal routing
        console.warn(
          `[ROUTING] Failover sticky model ${threadState.failoverStickyModelId} no longer available, skipping`
        )
      }

      // Force premium: economy mis-route detected
      if ((threadState.forcePremiumUntil ?? 0) > now) {
        const remainingMs = (threadState.forcePremiumUntil ?? 0) - now
        recordLayer({
          layer: "thread",
          durationMs: Date.now() - t0,
          result: "premium",
          reason: "force-premium-after-economy-failure",
          detail: { forcePremiumUntil: threadState.forcePremiumUntil, remainingMs }
        })
        const r = resolveFromTier("premium", "thread:force-premium-after-economy-failure", "thread")
        return withTrace(r)
      }

      // Sticky premium: recent tool work
      if ((threadState.premiumStickyUntil ?? 0) > now && !isStrictEconomy(ctx.message ?? "")) {
        const remainingMs = (threadState.premiumStickyUntil ?? 0) - now
        recordLayer({
          layer: "thread",
          durationMs: Date.now() - t0,
          result: "premium",
          reason: "sticky-premium-after-tool-work",
          detail: { premiumStickyUntil: threadState.premiumStickyUntil, remainingMs }
        })
        const r = resolveFromTier("premium", "thread:sticky-premium-after-tool-work", "thread")
        return withTrace(r)
      }

      // Thread state exists but no override triggered
      recordLayer({
        layer: "thread",
        durationMs: Date.now() - t0,
        result: "uncertain",
        reason: "thread-state-no-override",
        detail: {
          hasForcePremium: (threadState.forcePremiumUntil ?? 0) > now,
          hasStickyPremium: (threadState.premiumStickyUntil ?? 0) > now,
          continuation: ctx.continuation ?? null
        }
      })
    } else {
      recordLayer({
        layer: "thread",
        durationMs: Date.now() - t0,
        result: "uncertain",
        reason: threadState ? "non-chat-taskSource" : "no-thread-state"
      })
    }
  }

  // ── Layer 2: capability-first heuristics ────────────────────────────────────
  const message = ctx.message ?? ""
  {
    const t0 = Date.now()
    const l2Detail = applyLayer2RulesWithDetail(message)

    if (l2Detail.result !== "uncertain") {
      recordLayer({
        layer: "layer2",
        durationMs: Date.now() - t0,
        result: l2Detail.result,
        reason: l2Detail.matchedRule,
        detail: {
          estimatedTokens: l2Detail.estimatedTokens,
          codeBlockCount: l2Detail.codeBlockCount,
          fsOpMatch: l2Detail.fsOpMatch,
          filePatternMatch: l2Detail.filePatternMatch,
          inCtxMatch: l2Detail.inCtxMatch,
          socialScore: l2Detail.socialScore,
          messageLength: l2Detail.messageLength
        }
      })
      let r = resolveFromTier(l2Detail.result, `layer2:rules→${l2Detail.result}`, "layer2")
      // Context window capacity guard — ensure economy model can handle current context
      r = guardContextCapacity(r, ctx.threadId, layerRecords)
      console.log(
        `[ROUTING] ${JSON.stringify({ ...logCtx, layer: r.layer, resolvedTier: r.resolvedTier, routeReason: r.routeReason })}`
      )
      return withTrace(r)
    }

    recordLayer({
      layer: "layer2",
      durationMs: Date.now() - t0,
      result: "uncertain",
      reason: l2Detail.matchedRule,
      detail: { estimatedTokens: l2Detail.estimatedTokens, messageLength: l2Detail.messageLength }
    })
  }

  // ── Layer 3: LLM classifier ─────────────────────────────────────────────────
  {
    const t0 = Date.now()
    const l3 = await classifyWithLlm(message)
    const durationMs = Date.now() - t0
    recordLayer({
      layer: "layer3",
      durationMs,
      result: l3.tier,
      reason: l3.cacheHit
        ? `cache-hit→${l3.tier}`
        : l3.timedOut
          ? `timeout→premium`
          : `llm-classifier→${l3.tier}`,
      detail: {
        messageLength: message.length,
        classifierModel: l3.classifierModel,
        cacheHit: l3.cacheHit,
        timedOut: l3.timedOut,
        containsThink: l3.containsThink,
        rawPreview: l3.rawPreview,
        timeoutMs: LAYER3_TIMEOUT_MS
      }
    })
    let r = resolveFromTier(l3.tier, `layer3:llm→${l3.tier}`, "layer3")
    // Context window capacity guard — ensure economy model can handle current context
    r = guardContextCapacity(r, ctx.threadId, layerRecords)
    console.log(
      `[ROUTING] ${JSON.stringify({ ...logCtx, layer: r.layer, resolvedTier: r.resolvedTier, routeReason: r.routeReason })}`
    )
    return withTrace(r)
  }
}

export { getGlobalRoutingMode }

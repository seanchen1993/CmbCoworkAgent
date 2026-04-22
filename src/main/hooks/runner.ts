import { spawn } from "node:child_process"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import type { HookConfig, HookEvent, HookResult } from "./types"
import { joinHookText } from "./text"
import { getCustomModelConfigs } from "../storage"

const DEFAULT_TIMEOUT = 10_000
const MAX_OUTPUT_BYTES = 1_000_000 // 1 MB per hook
const CHARDET_CONFIDENCE_THRESHOLD = 0.8

export interface HookContext {
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  workspacePath?: string
  /** Session / thread identifier — exposed to hooks as SESSION_ID and session_id in stdin JSON */
  sessionId?: string
  /** User prompt text for UserPromptSubmit — exposed as USER_PROMPT env and prompt in stdin JSON */
  userPrompt?: string
  /** Subagent descriptor for SubagentStop — exposed in stdin JSON */
  subagent?: { id?: string; name?: string; status?: string }
  /** Stop event context — gives hooks visibility into what the agent did this turn */
  stopContext?: {
    userMessage?: string
    assistantResponse?: string
    toolCalls?: string[]
    usedSkills?: string[]
  }
}

/**
 * Detect whether a matcher string looks like a regex pattern.
 *
 * `.` is deliberately excluded — tool names commonly contain dots (e.g. `mcp.server_name`),
 * and a matcher like `foo.bar` almost always means "literal foo.bar", not the regex
 * `foo<any>bar`. Users who actually want regex can signal intent with other metachars
 * (`*`, `?`, `+`, `|`, anchors, groups, character classes, escapes).
 */
function isRegexPattern(matcher: string): boolean {
  return /[|*+?^$()[\]{}\\]/.test(matcher)
}

/**
 * Match a hook's matcher against a tool name.
 * - undefined/empty/"*" matches everything
 * - if matcher contains regex metacharacters, treat as regex (case-insensitive)
 * - otherwise exact case-insensitive match
 */
function matchesToolName(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true
  if (!toolName) return false
  if (isRegexPattern(matcher)) {
    try {
      return new RegExp(matcher, "i").test(toolName)
    } catch {
      // Invalid regex — fall back to exact match
      return matcher.toLowerCase() === toolName.toLowerCase()
    }
  }
  return matcher.toLowerCase() === toolName.toLowerCase()
}

/**
 * Build environment variables for a hook command.
 */
function buildHookEnv(event: HookEvent, context: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOOK_EVENT: event
  }
  if (context.toolName) env.TOOL_NAME = context.toolName
  if (context.toolArgs) env.TOOL_ARGS = JSON.stringify(context.toolArgs)
  // toolResult is already a JSON string from upstream — passing as-is avoids double encoding.
  if (context.toolResult) env.TOOL_RESULT = context.toolResult
  if (context.workspacePath) {
    env.WORKSPACE_PATH = context.workspacePath
    // Claude Code compatibility — the canonical env var hooks expect
    env.CLAUDE_PROJECT_DIR = context.workspacePath
  }
  if (context.sessionId) env.SESSION_ID = context.sessionId
  if (context.userPrompt) env.USER_PROMPT = context.userPrompt
  return env
}

/**
 * Build the structured JSON payload written to the hook's stdin (Claude Code protocol).
 * Keys mirror Claude Code's documented hook input schema so existing community hooks work.
 */
function buildHookStdinPayload(event: HookEvent, context: HookContext): string {
  const payload: Record<string, unknown> = {
    hook_event_name: event,
    session_id: context.sessionId ?? "",
    cwd: context.workspacePath ?? process.cwd()
  }
  if (context.toolName) payload.tool_name = context.toolName
  if (context.toolArgs) payload.tool_input = context.toolArgs
  if (context.toolResult !== undefined) {
    // Upstream passes JSON.stringify(result); parse it back so hooks see a real object
    // (matches Claude Code spec where tool_response is the structured response).
    // If it's not valid JSON, fall back to the raw string so the data isn't lost.
    try {
      payload.tool_response = JSON.parse(context.toolResult)
    } catch {
      payload.tool_response = context.toolResult
    }
  }
  if (context.userPrompt) payload.prompt = context.userPrompt
  if (context.subagent) payload.subagent = context.subagent
  if (context.stopContext) payload.stop_context = context.stopContext
  return JSON.stringify(payload)
}

function isBlockingResult(result: HookResult): boolean {
  return result.blocked || result.decision === "block" || result.continue === false
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function detectHookOutputEncoding(buf: Buffer): string {
  if (buf.length === 0) return "utf-8"
  const detected = chardet.detect(buf)
  if (!detected) return "utf-8"

  const encoding = typeof detected === "string" ? detected : detected.encoding
  const confidence = typeof detected === "object" ? detected.confidence : 1

  if (!encoding || encoding.toLowerCase() === "ascii" || !iconv.encodingExists(encoding)) {
    return "utf-8"
  }

  if (confidence >= CHARDET_CONFIDENCE_THRESHOLD) {
    return encoding
  }

  // On Chinese Windows, short GBK/GB18030 output often comes back with low confidence
  // even though the bytes are definitely not UTF-8. In that case, trust the detector.
  if (!isValidUtf8(buf)) {
    return encoding
  }

  return "utf-8"
}

function decodeHookOutput(
  stdoutBuf: Buffer,
  stderrBuf: Buffer
): { stdout: string; stderr: string } {
  const combined = Buffer.concat([stdoutBuf, stderrBuf])
  const encoding = process.platform === "win32" ? detectHookOutputEncoding(combined) : "utf-8"

  try {
    return {
      stdout: stdoutBuf.length > 0 ? iconv.decode(stdoutBuf, encoding) : "",
      stderr: stderrBuf.length > 0 ? iconv.decode(stderrBuf, encoding) : ""
    }
  } catch {
    return {
      stdout: stdoutBuf.toString("utf-8"),
      stderr: stderrBuf.toString("utf-8")
    }
  }
}

/**
 * Execute a single hook command and return its result.
 */
function executeCommandHook(
  hook: HookConfig,
  env: Record<string, string>,
  stdinPayload: string
): Promise<HookResult> {
  return new Promise((resolve) => {
    const command = hook.command ?? ""
    if (!command.trim()) {
      resolve({ exitCode: 0, stdout: "", stderr: "Hook command is empty", blocked: false })
      return
    }

    const timeout = hook.timeout ?? DEFAULT_TIMEOUT
    const isWindows = process.platform === "win32"
    const cmd = isWindows ? command : "/bin/sh"
    const args = isWindows ? [] : ["-c", command]

    const child = spawn(cmd, args, {
      env,
      shell: isWindows ? true : false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      cwd: env.WORKSPACE_PATH || process.cwd()
    })

    // Write the Claude Code JSON payload to stdin so hooks can parse structured input.
    // Wrapped in try/catch — child may already be dead if spawn failed.
    try {
      child.stdin?.end(stdinPayload)
    } catch {
      /* ignore — error event will fire */
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let outputTruncated = false

    // Guard against double-resolve from concurrent timer + close/error events
    let resolved = false
    const settle = (result: HookResult): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputTruncated) return
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTruncated = true
        try {
          child.kill("SIGKILL")
        } catch {
          /* ignore */
        }
      } else {
        stdoutChunks.push(chunk)
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      if (outputTruncated) return
      outputBytes += chunk.length
      if (outputBytes <= MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk)
      }
    })

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      settle({
        exitCode: null,
        stdout: "",
        stderr: `Hook timed out after ${timeout}ms`,
        blocked: false
      })
    }, timeout + 500)

    child.on("close", (exitCode) => {
      const stdoutBuf = Buffer.concat(stdoutChunks)
      const stderrBuf = Buffer.concat(stderrChunks)
      const decoded = decodeHookOutput(stdoutBuf, stderrBuf)
      const extraNote = outputTruncated ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""
      settle({
        exitCode,
        stdout: decoded.stdout.trim(),
        stderr: decoded.stderr.trim() + extraNote,
        blocked: exitCode === 2
      })
    })

    child.on("error", (err) => {
      settle({
        exitCode: 1,
        stdout: "",
        stderr: `Hook execution error: ${err.message}`,
        blocked: false
      })
    })
  })
}

// ── Prompt Hook ───────────────────────────────────────────────────────────────

const PROMPT_HOOK_SYSTEM = `You are a compliance policy enforcer for a banking AI agent.
You will be given a policy rule and a JSON payload describing a hook event.
For tool events, the payload includes tool_name/tool_args/tool_result.
For Stop events, the payload includes stop_context with the user's request, the assistant's final response, tool calls, and used skills.
Decide whether to allow or block the event based strictly on the policy.

Respond with ONLY valid JSON — no explanation, no markdown, no extra text:
{"decision":"allow"}
or
{"decision":"block","reason":"<one-sentence explanation in the same language as the policy>"}

Rules:
- Be conservative: when in doubt about whether a policy applies, allow.
- The reason must be concise and actionable so the AI agent can adjust its approach.
- NEVER include <think> blocks or any chain-of-thought in your response.`

/**
 * Strip <think>...</think> reasoning blocks emitted by some models (DeepSeek, Qwen, etc.)
 */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/^[\s\S]*?<\/think>\s*/g, "")
    .trim()
}

/**
 * Extract the first JSON object from a string (handles models that wrap JSON in prose).
 */
function extractFirstJson(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Get a lightweight ChatOpenAI instance for prompt-hook evaluation.
 * Prefers the modelId specified on the hook; falls back to the first configured model.
 */
function getPromptHookModel(modelId: string | undefined, timeout: number): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  if (configs.length === 0) return null

  const config = modelId
    ? (configs.find((c) => c.id === modelId || c.model === modelId) ?? configs[0])
    : configs[0]

  if (!config.apiKey) return null

  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    maxRetries: 0,
    timeout,
    configuration: { baseURL: config.baseUrl }
  })
}

/**
 * Execute a prompt-type hook: ask the configured LLM whether to allow or block.
 *
 * The LLM receives:
 *   - The natural-language policy written by the user
 *   - The tool name and its arguments as JSON
 *
 * Decision protocol:
 *   {"decision":"allow"}              → pass through
 *   {"decision":"block","reason":"…"} → blocked; reason is returned as stdout
 *                                       so the calling AI agent can read it and adapt
 *
 * On timeout / model unavailable / parse failure → falls back to hook.fallback
 * ("allow" by default, configurable to "block" for strict environments).
 */
async function executePromptHook(
  hook: HookConfig,
  context: HookContext,
  event: HookEvent
): Promise<HookResult> {
  const fallback = hook.fallback ?? "allow"
  const fallbackResult = (reason: string): HookResult => ({
    exitCode: fallback === "block" ? 1 : 0,
    stdout: fallback === "block" ? reason : "",
    stderr: reason,
    blocked: fallback === "block",
    decision: fallback === "block" ? "block" : "approve",
    reason: fallback === "block" ? reason : undefined
  })

  const policy = hook.prompt?.trim()
  if (!policy) {
    return fallbackResult("[PromptHook] No policy text configured")
  }

  const timeout = hook.timeout ?? DEFAULT_TIMEOUT
  const model = getPromptHookModel(hook.modelId, timeout)
  if (!model) {
    return fallbackResult("[PromptHook] No model configured — cannot evaluate prompt hook")
  }

  const userMsg = JSON.stringify(
    {
      hook_event_name: event,
      policy,
      ...(context.userPrompt ? { prompt: context.userPrompt } : {}),
      tool_name: context.toolName ?? "(unknown)",
      tool_args: context.toolArgs ?? {},
      ...(context.toolResult !== undefined ? { tool_result: context.toolResult } : {}),
      ...(context.stopContext ? { stop_context: context.stopContext } : {}),
      workspace: context.workspacePath ?? ""
    },
    null,
    2
  )

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const abortController = new AbortController()
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new Error(`PromptHook LLM timed out after ${timeout}ms`))
      }, timeout)
    })

    const invokePromise = model.invoke(
      [new SystemMessage(PROMPT_HOOK_SYSTEM), new HumanMessage(userMsg)],
      { signal: abortController.signal }
    )

    const response = await Promise.race([invokePromise, timeoutPromise])
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = undefined
    }

    let raw =
      typeof response.content === "string" ? response.content : JSON.stringify(response.content)

    raw = stripThinkBlocks(raw)

    const jsonStr = extractFirstJson(raw)
    if (!jsonStr) {
      console.warn("[PromptHook] Could not extract JSON from model response:", raw.slice(0, 200))
      return fallbackResult(
        `[PromptHook] Model returned non-JSON response — applying fallback (${fallback})`
      )
    }

    const parsed = JSON.parse(jsonStr) as { decision: string; reason?: string }
    const blocked = parsed.decision === "block"
    const reason = parsed.reason ?? "Blocked by prompt hook policy"

    console.log(
      `[PromptHook] policy="${policy.slice(0, 60)}…" tool=${context.toolName} → decision=${parsed.decision}` +
        (parsed.reason ? ` reason="${parsed.reason}"` : "")
    )

    return {
      exitCode: blocked ? 1 : 0,
      stdout: blocked ? reason : "",
      stderr: "",
      blocked,
      decision: blocked ? "block" : "approve",
      reason: blocked ? reason : undefined
    }
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId)
    const msg = err instanceof Error ? err.message : String(err)
    console.warn("[PromptHook] Evaluation error:", msg)
    return fallbackResult(`[PromptHook] Evaluation failed: ${msg}`)
  }
}

// ── JSON Output Protocol ─────────────────────────────────────────────────────

const MAX_JSON_OUTPUT_CHARS = 10_000

/**
 * Try to parse structured JSON fields from hook stdout (exit 0 only).
 *
 * Recognised top-level fields (Claude Code compatible):
 *   additionalContext, systemMessage, requiredSkill, updatedInput,
 *   suppressOutput, continue, stopReason, decision, reason
 *
 * Also reads nested `hookSpecificOutput.{additionalContext,updatedInput,permissionDecision}`
 * which Claude Code's newer protocol uses for PreToolUse/UserPromptSubmit.
 *
 * If stdout is not valid JSON, these fields remain undefined (treated as plain text).
 */
function parseHookJsonOutput(result: HookResult): HookResult {
  if (result.exitCode !== 0 || !result.stdout) return result
  const raw = result.stdout.slice(0, MAX_JSON_OUTPUT_CHARS)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result

    const nested =
      typeof parsed.hookSpecificOutput === "object" &&
      parsed.hookSpecificOutput !== null &&
      !Array.isArray(parsed.hookSpecificOutput)
        ? (parsed.hookSpecificOutput as Record<string, unknown>)
        : undefined

    const additionalContext =
      typeof parsed.additionalContext === "string"
        ? parsed.additionalContext
        : nested && typeof nested.additionalContext === "string"
          ? nested.additionalContext
          : undefined

    const requiredSkill =
      typeof parsed.requiredSkill === "string"
        ? parsed.requiredSkill
        : nested && typeof nested.requiredSkill === "string"
          ? nested.requiredSkill
          : undefined

    const updatedInputSource = parsed.updatedInput ?? nested?.updatedInput
    const updatedInput =
      typeof updatedInputSource === "object" &&
      updatedInputSource !== null &&
      !Array.isArray(updatedInputSource)
        ? (updatedInputSource as Record<string, unknown>)
        : undefined

    const decisionValue = parsed.decision
    const decision: "block" | "approve" | undefined =
      decisionValue === "block" ? "block" : decisionValue === "approve" ? "approve" : undefined

    // Nested permissionDecision=deny maps to block for backwards compat with our dispatcher
    const permDecision =
      nested && typeof nested.permissionDecision === "string"
        ? nested.permissionDecision
        : undefined
    const effectiveDecision =
      decision ??
      (permDecision === "deny" || permDecision === "ask"
        ? "block"
        : permDecision === "allow"
          ? "approve"
          : undefined)
    const effectiveReason =
      (typeof parsed.reason === "string" ? parsed.reason : undefined) ??
      (nested && typeof nested.permissionDecisionReason === "string"
        ? nested.permissionDecisionReason
        : undefined)

    return {
      ...result,
      additionalContext,
      systemMessage: typeof parsed.systemMessage === "string" ? parsed.systemMessage : undefined,
      requiredSkill,
      updatedInput,
      suppressOutput:
        typeof parsed.suppressOutput === "boolean" ? parsed.suppressOutput : undefined,
      continue: typeof parsed.continue === "boolean" ? parsed.continue : undefined,
      stopReason: typeof parsed.stopReason === "string" ? parsed.stopReason : undefined,
      decision: effectiveDecision,
      reason: effectiveReason
    }
  } catch {
    // stdout is not JSON — treat as plain text (backwards compatible)
    return result
  }
}

function applyConfiguredOnBlock(result: HookResult, hook: HookConfig): HookResult {
  const onBlock = hook.onBlock
  if (!onBlock || !isBlockingResult(result)) return result

  const fallbackReason = onBlock.reason
  const reason = result.reason ?? result.stopReason ?? fallbackReason
  const stopReason = result.stopReason ?? result.reason ?? fallbackReason
  const stdout = result.stdout || result.reason || result.stopReason || fallbackReason || ""

  return {
    ...result,
    stdout,
    reason,
    stopReason,
    systemMessage: joinHookText(result.systemMessage, onBlock.systemMessage),
    additionalContext: joinHookText(result.additionalContext, onBlock.additionalContext),
    requiredSkill: result.requiredSkill ?? onBlock.requiredSkill
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Execute a single hook (command or prompt type).
 */
async function executeHook(
  hook: HookConfig,
  env: Record<string, string>,
  context: HookContext,
  event: HookEvent
): Promise<HookResult> {
  const hookType = hook.type ?? "command"
  let result: HookResult
  if (hookType === "prompt") {
    result = await executePromptHook(hook, context, event)
  } else {
    const stdinPayload = buildHookStdinPayload(event, context)
    result = await executeCommandHook(hook, env, stdinPayload)
  }
  return applyConfiguredOnBlock(parseHookJsonOutput(result), hook)
}

/**
 * Run all matching hooks for a given event.
 *
 * - PreToolUse/UserPromptSubmit: exit code 2 or decision=block stops the turn.
 * - PostToolUse: collects stdout from all hooks as extra context.
 * - Stop/SubagentStop/Notification/SessionStart/SessionEnd: fire-and-forget.
 */
export type HookResultCallback = (event: HookEvent, hook: HookConfig, result: HookResult) => void

export async function runHooks(
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext,
  onHookResult?: HookResultCallback
): Promise<HookResult | null> {
  const matched = hooks.filter(
    (h) => h.enabled && h.event === event && matchesToolName(h.matcher, context.toolName)
  )

  if (matched.length === 0) return null

  const env = buildHookEnv(event, context)

  if (event === "PreToolUse" || event === "UserPromptSubmit") {
    let mergedUpdatedInput: Record<string, unknown> | undefined
    let mergedAdditionalContext: string | undefined
    let mergedSystemMessage: string | undefined
    for (const hook of matched) {
      const result = await executeHook(hook, env, context, event)
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) "${(hook.command ?? hook.prompt ?? "").slice(0, 60)}" → exit=${result.exitCode}, blocked=${result.blocked}`
      )
      onHookResult?.(event, hook, result)
      // continue=false halts the entire agent turn, overrides everything else
      if (result.continue === false) {
        const reason =
          result.stopReason ||
          result.reason ||
          result.stderr ||
          result.stdout ||
          `${event} hook stopped the turn`
        return { ...result, stdout: reason, blocked: true }
      }
      if (result.blocked) {
        return result
      }
      if (result.decision === "block") {
        const reason =
          result.reason ||
          result.stopReason ||
          result.stderr ||
          result.stdout ||
          `${event} hook blocked`
        return {
          ...result,
          stdout: reason,
          blocked: true
        }
      }
      // Non-zero, non-blocking exit (error in hook itself) — log but continue
      if (result.exitCode !== 0 && result.exitCode !== null) {
        console.warn(
          `[Hooks] ${event} hook exited ${result.exitCode} (non-blocking error):`,
          result.stderr || "(no stderr)"
        )
      }
      if (result.updatedInput) {
        mergedUpdatedInput = { ...(mergedUpdatedInput ?? {}), ...result.updatedInput }
      }
      if (result.additionalContext) {
        mergedAdditionalContext = joinHookText(mergedAdditionalContext, result.additionalContext)
      }
      if (result.systemMessage) {
        mergedSystemMessage = joinHookText(mergedSystemMessage, result.systemMessage)
      }
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      updatedInput: mergedUpdatedInput,
      additionalContext: mergedAdditionalContext,
      systemMessage: mergedSystemMessage
    }
  }

  if (event === "PostToolUse") {
    const outputs: string[] = []
    const contexts: string[] = []
    const messages: string[] = []
    const blockReasons: string[] = []
    let shouldHalt = false
    let haltReason: string | undefined
    for (const hook of matched) {
      const result = await executeHook(hook, env, context, event)
      console.log(
        `[Hooks] PostToolUse hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}`
      )
      onHookResult?.(event, hook, result)
      if (result.continue === false) {
        shouldHalt = true
        haltReason = result.stopReason ?? haltReason
      }
      // PostToolUse decision=block: feed reason back to agent for reconsideration
      if (result.decision === "block" && result.reason) {
        blockReasons.push(result.reason)
      }
      if (result.stdout) outputs.push(result.stdout)
      if (result.additionalContext) contexts.push(result.additionalContext)
      if (result.systemMessage) messages.push(result.systemMessage)
    }
    return {
      exitCode: 0,
      stdout: outputs.join("\n"),
      stderr: "",
      blocked: shouldHalt,
      continue: shouldHalt ? false : undefined,
      stopReason: haltReason,
      decision: blockReasons.length > 0 ? "block" : undefined,
      reason: blockReasons.length > 0 ? blockReasons.join("\n") : undefined,
      additionalContext: contexts.length > 0 ? contexts.join("\n") : undefined,
      systemMessage: messages.length > 0 ? messages.join("\n") : undefined
    }
  }

  // Stop: awaited — results can trigger revision or inject feedback
  if (event === "Stop") {
    const blockReasons: string[] = []
    let additionalContext: string | undefined
    let systemMessage: string | undefined
    for (const hook of matched) {
      const result = await executeHook(hook, env, context, event)
      console.log(
        `[Hooks] Stop hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}`
      )
      onHookResult?.(event, hook, result)
      if (result.continue === false || result.blocked || result.decision === "block") {
        blockReasons.push(
          result.reason ||
            result.stopReason ||
            result.stdout ||
            result.stderr ||
            "Stop hook requested revision"
        )
      }
      if (result.additionalContext) {
        additionalContext = joinHookText(additionalContext, result.additionalContext)
      }
      if (result.systemMessage) {
        systemMessage = joinHookText(systemMessage, result.systemMessage)
      }
    }
    if (blockReasons.length > 0 || additionalContext || systemMessage) {
      return {
        exitCode: 0,
        stdout: blockReasons.join("\n"),
        stderr: "",
        blocked: blockReasons.length > 0,
        decision: blockReasons.length > 0 ? "block" : undefined,
        reason: blockReasons.length > 0 ? blockReasons.join("\n") : undefined,
        additionalContext,
        systemMessage
      }
    }
    return null
  }

  // SubagentStop / Notification / SessionStart / SessionEnd: fire-and-forget
  for (const hook of matched) {
    executeHook(hook, env, context, event)
      .then((result) => {
        console.log(`[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}`)
        onHookResult?.(event, hook, result)
        if (result.stderr) {
          console.warn(`[Hooks] ${event} hook stderr:`, result.stderr)
        }
      })
      .catch((err) => {
        console.warn(`[Hooks] ${event} hook error:`, err)
      })
  }

  return null
}

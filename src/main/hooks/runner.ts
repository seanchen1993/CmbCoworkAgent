import { spawn } from "node:child_process"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import type { HookConfig, HookEvent, HookResult } from "./types"
import { getHookModelRef, getTimeoutBounds } from "./types"
import { executeHttpHook } from "./http-runner"
import type { PluginHookMetadata, SkillHookMetadata } from "../types"
import { joinHookText } from "./text"
import { mergeUpdatedInput } from "./updated-input"
import { getCustomModelConfigs, getHookLoggingConfig } from "../storage"
import { persistHookResultRecord } from "./log-record"

/**
 * Resolve the effective timeout (ms) for a hook by consulting the handler-type
 * and async-aware bounds table. Falls back to the hook's own `timeout` when set
 * and within bounds; otherwise uses the type-specific default. Centralised so
 * commandHook / promptHook / future http/agent hook paths all agree.
 */
function getEffectiveTimeout(hook: HookConfig): number {
  const bounds = getTimeoutBounds(hook.type, (hook as { async?: boolean }).async === true)
  return hook.timeout ?? bounds.default
}
const MAX_OUTPUT_BYTES = 1_000_000 // 1 MB per hook
const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192
const MAX_HOOK_ENV_JSON_CHARS = 4_096
const ONCE_HOOK_KEY_SEPARATOR = "\u0000"
// `once` fired-state, partitioned by sessionId so we can drop a session's
// entries when a thread ends (or when a hook is mutated). Aligns conceptually
// with CC's session-scoped session-hooks Map, except we track fired state
// rather than registering ephemeral hooks.
const firedOnceHookKeys = new Map<string, Set<string>>()

// Compiled regex cache keyed by matcher string. null = invalid pattern (fallback to exact match).
const _regexCache = new Map<string, RegExp | null>()

export interface HookContext {
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  workspacePath?: string
  /** Session / thread identifier — exposed to hooks as SESSION_ID and session_id in stdin JSON */
  sessionId?: string
  /** Renderer user message id that owns this hook event, used only for log grouping. */
  turnId?: string
  /** Plugin that owns the capability currently being used, when known. */
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
  hookSourceType?: HookConfig["hookSourceType"]
  hookSourceRoot?: string
  hookSourcePath?: string
  /** User prompt text for UserPromptSubmit — exposed as USER_PROMPT env and prompt in stdin JSON */
  userPrompt?: string
  /** Skill lifecycle context for PreSkillUse/PostSkillUse. */
  skillName?: string
  skillPath?: string
  skillRoot?: string
  skillTriggerToolName?: string
  /** Subagent descriptor for SubagentStop — exposed in stdin JSON */
  subagent?: { id?: string; name?: string; status?: string }
  /** Stop event context — gives hooks visibility into what the agent did this turn */
  stopContext?: {
    userMessage?: string
    assistantResponse?: string
    toolCalls?: string[]
    usedSkills?: string[]
  }
  /**
   * Absolute path to the on-disk conversation history for this session.
   * Exposed to hooks as `transcript_path` in stdin JSON and `TRANSCRIPT_PATH` env.
   * Mirrors Claude Code's hook input — lets hooks read prior turns for audit/analytics.
   */
  transcriptPath?: string
  /**
   * Active permission mode (e.g. "yolo", "approve"). Exposed as `permission_mode`
   * in stdin JSON and `PERMISSION_MODE` env. Lets hooks adapt policy by mode.
   */
  permissionMode?: string
  /**
   * Subagent identifier — non-empty only when the hook fires from inside a
   * subagent (e.g. PreToolUse from a task-tool worker). Mirrors CC's `agent_id`.
   * Use this to distinguish parent-thread hooks from subagent-thread hooks.
   */
  agentId?: string
  /**
   * PR-11 — Setup event trigger source. Emitted as `trigger` in stdin JSON.
   * `"init"` = workspace's first run on this machine (de-duped via
   * `<workspacePath>/.cmbcoworkagent/setup-state.json`);
   * `"maintenance"` = user-initiated re-run via the workspace UI.
   */
  setupTrigger?: "init" | "maintenance"
  /** PR-17 — classifyApiError output for StopFailure / PostToolUseFailure
   *  matchers. Exposed as part of stdin JSON's `tool_input.error_type`. */
  stopFailureError?: string
}

/**
 * Canonical cwd resolver used both for spawning the child process AND for
 * populating `envelope.cwd` in diagnostic logs. Keep these two callers in
 * sync so the UI's reported cwd is always what the hook actually saw.
 */
export function getCommandCwd(context: HookContext): string {
  return context.hookSourceRoot ?? context.workspacePath ?? process.cwd()
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
function getCachedRegex(matcher: string): RegExp | null {
  if (_regexCache.has(matcher)) return _regexCache.get(matcher)!
  try {
    const re = new RegExp(matcher, "i")
    _regexCache.set(matcher, re)
    return re
  } catch {
    _regexCache.set(matcher, null)
    return null
  }
}

function matchesName(matcher: string | undefined, name: string | undefined): boolean {
  if (!matcher || matcher === "*") return true
  if (!name) return false
  if (isRegexPattern(matcher)) {
    const re = getCachedRegex(matcher)
    return re ? re.test(name) : matcher.toLowerCase() === name.toLowerCase()
  }
  return matcher.toLowerCase() === name.toLowerCase()
}

/**
 * PR-16 — Per-event matcher target. For events that today fire with no
 * meaningful `toolName` (SessionStart, SessionEnd, Stop, Subagent*, Setup,
 * PostToolUseFailure, StopFailure) the matcher now interrogates a
 * per-event-specific context slot instead. Sites where users could
 * historically have configured a meaningful matcher (PreToolUse, PostToolUse,
 * Pre/PostSkillUse, Notification) keep the old behaviour — the Notification
 * dual-matcher fallback below preserves `matcher: "execute"` style configs.
 */
function getMatcherTarget(event: HookEvent, context: HookContext): string | undefined {
  switch (event) {
    case "PreSkillUse":
    case "PostSkillUse":
      return context.skillName
    case "SubagentStart":
    case "SubagentStop":
      return context.subagent?.name ?? context.subagent?.id
    case "Setup":
      return context.setupTrigger
    case "PostToolUseFailure":
    case "StopFailure":
      return context.toolName
    default:
      return context.toolName
  }
}

/**
 * PR-16 — Match a hook's `matcher` field against the event-specific target,
 * with a Notification-only fallback that preserves the legacy semantic
 * (`matcher: "execute"` historically matched Notification's tool_name). When
 * no notification_type field exists yet we keep toolName matching.
 */
function matchesEventMatcher(
  matcher: string | undefined,
  event: HookEvent,
  context: HookContext
): boolean {
  if (!matcher || matcher === "*") return true
  const primary = getMatcherTarget(event, context)
  if (matchesName(matcher, primary)) return true
  if (event === "Notification") {
    // legacy fallback path: today getMatcherTarget already returned toolName
    // for Notification, so this branch is mainly future-proof. When a future
    // PR adds `context.notificationType`, primary will be that string and
    // this fallback keeps existing `matcher: "execute"` configs working.
    return matchesName(matcher, context.toolName)
  }
  return false
}

/**
 * Build environment variables for a hook command.
 */
function setBestEffortJsonEnv(
  env: Record<string, string>,
  key: "TOOL_ARGS" | "TOOL_RESULT",
  value: string | undefined
): void {
  if (!value || value.length > MAX_HOOK_ENV_JSON_CHARS) return
  env[key] = value
}

function buildHookEnv(event: HookEvent, context: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOOK_EVENT: event
  }
  if (context.toolName) env.TOOL_NAME = context.toolName
  if (context.hookSourceType) env.HOOK_SOURCE_TYPE = context.hookSourceType
  if (context.hookSourceRoot) env.HOOK_SOURCE_ROOT = context.hookSourceRoot
  if (context.hookSourcePath) env.HOOK_SOURCE_PATH = context.hookSourcePath
  if (context.pluginId) env.PLUGIN_ID = context.pluginId
  if (context.pluginName) env.PLUGIN_NAME = context.pluginName
  if (context.pluginRoot) env.PLUGIN_ROOT = context.pluginRoot
  if (context.skillName) env.SKILL_NAME = context.skillName
  if (context.skillPath) env.SKILL_PATH = context.skillPath
  if (context.skillRoot) env.SKILL_ROOT = context.skillRoot
  // stdin JSON is the canonical payload. TOOL_ARGS / TOOL_RESULT are small-payload
  // compatibility helpers only, so they don't blow up the child-process env block.
  if (context.toolArgs) {
    setBestEffortJsonEnv(env, "TOOL_ARGS", JSON.stringify(context.toolArgs))
  }
  // toolResult is already a JSON string from upstream — passing as-is avoids double encoding.
  setBestEffortJsonEnv(env, "TOOL_RESULT", context.toolResult)
  if (context.workspacePath) {
    env.WORKSPACE_PATH = context.workspacePath
    // Claude Code compatibility — the canonical env var hooks expect
    env.CLAUDE_PROJECT_DIR = context.workspacePath
  }
  if (context.sessionId) env.SESSION_ID = context.sessionId
  if (context.userPrompt) env.USER_PROMPT = context.userPrompt
  // PR-01: Claude Code-compatible env vars. Only set when context provides them
  // — keeps zero-context invocations byte-identical with prior versions.
  if (context.transcriptPath) env.TRANSCRIPT_PATH = context.transcriptPath
  if (context.permissionMode) env.PERMISSION_MODE = context.permissionMode
  if (context.agentId) env.AGENT_ID = context.agentId
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
    cwd: getCommandCwd(context)
  }
  if (context.hookSourceType) payload.hook_source_type = context.hookSourceType
  if (context.hookSourceRoot) payload.hook_source_root = context.hookSourceRoot
  if (context.hookSourcePath) payload.hook_source_path = context.hookSourcePath
  if (context.toolName) payload.tool_name = context.toolName
  if (context.toolArgs) payload.tool_input = context.toolArgs
  if (context.pluginId) payload.plugin_id = context.pluginId
  if (context.pluginName) payload.plugin_name = context.pluginName
  if (context.pluginRoot) payload.plugin_root = context.pluginRoot
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
  // PR-01: Claude Code-compatible payload fields. Only emitted when present so
  // existing hook scripts that don't expect them see the exact same JSON shape.
  if (context.transcriptPath) payload.transcript_path = context.transcriptPath
  if (context.permissionMode) payload.permission_mode = context.permissionMode
  if (context.agentId) payload.agent_id = context.agentId
  // PR-11 — Setup event payload (`trigger` + `workspace_path`).
  if (context.setupTrigger) {
    payload.trigger = context.setupTrigger
    if (context.workspacePath) payload.workspace_path = context.workspacePath
  }
  if (context.skillName) payload.skill_name = context.skillName
  if (context.skillPath) payload.skill_path = context.skillPath
  if (context.skillRoot) payload.skill_root = context.skillRoot
  if (context.skillTriggerToolName) payload.skill_trigger_tool_name = context.skillTriggerToolName
  if (context.subagent) payload.subagent = context.subagent
  if (context.stopContext) payload.stop_context = context.stopContext
  return JSON.stringify(payload)
}

function isBlockingResult(result: HookResult): boolean {
  return result.blocked || result.decision === "block" || result.continue === false
}

/**
 * Rewrite a hook's runtime result based on the hook's static `forcedOutcome`
 * config. Always called once per hook invocation, before any aggregator sees
 * the result, so all event branches can stay agnostic of the override.
 */
function applyForcedOutcome(result: HookResult, hook: HookConfig): HookResult {
  if (!hook.forcedOutcome) return result
  const reason =
    (hook.forcedReason && hook.forcedReason.trim()) ||
    result.reason ||
    result.stopReason ||
    result.stdout ||
    result.stderr ||
    (hook.forcedOutcome === "always-halt"
      ? "Hook 配置为直接终止本轮"
      : "Hook 配置为要求 Agent 修订")

  if (hook.forcedOutcome === "always-halt") {
    return {
      ...result,
      // Halt overrides revision — clear decision/blocked so aggregators don't
      // also feed a revision request.
      blocked: false,
      decision: undefined,
      reason: undefined,
      continue: false,
      stopReason: reason
    }
  }

  // "always-revise" → force decision=block, leave continue alone
  return {
    ...result,
    blocked: true,
    decision: "block",
    reason,
    // If the script already asked for halt, the user's "always-revise" config
    // explicitly opts back into revision — clear the halt signal.
    continue: undefined,
    stopReason: undefined
  }
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
  if (process.platform !== "win32") {
    return {
      stdout: stdoutBuf.length > 0 ? stdoutBuf.toString("utf-8") : "",
      stderr: stderrBuf.length > 0 ? stderrBuf.toString("utf-8") : ""
    }
  }
  // Sample both streams in bounded chunks so stderr-only Chinese diagnostics still
  // influence detection when stdout contains ASCII / JSON.
  const perStreamSampleBytes = Math.floor(CHARDET_SAMPLE_BYTES / 2)
  const sample = Buffer.concat([
    stdoutBuf.subarray(0, perStreamSampleBytes),
    stderrBuf.subarray(0, CHARDET_SAMPLE_BYTES - perStreamSampleBytes)
  ])
  const encoding = detectHookOutputEncoding(sample)
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
  stdinPayload: string,
  cwd: string
): Promise<HookResult> {
  return new Promise((resolve) => {
    const command = hook.command ?? ""
    if (!command.trim()) {
      resolve({ exitCode: 0, stdout: "", stderr: "Hook command is empty", blocked: false })
      return
    }

    const timeout = getEffectiveTimeout(hook)
    const isWindows = process.platform === "win32"

    // PR-13b — honour explicit hook.shell when set, else fall back to the
    // legacy platform-based pick. When `hook.shell` names a non-default
    // interpreter the runner relies on it being resolvable from PATH (e.g.
    // Git Bash / WSL / pwsh installed). spawn will surface a missing-binary
    // error through the existing error path; the hook surfaces as failed
    // (non-blocking, since exit-2 semantics only apply to clean runs).
    let cmd: string
    let args: string[]
    let useShell: boolean
    if (hook.shell === "bash") {
      cmd = "bash"
      args = ["-c", command]
      useShell = false
    } else if (hook.shell === "powershell") {
      cmd = "pwsh"
      args = ["-NoProfile", "-NonInteractive", "-Command", command]
      useShell = false
    } else if (hook.shell === "sh") {
      cmd = "sh"
      args = ["-c", command]
      useShell = false
    } else {
      cmd = isWindows ? command : "/bin/sh"
      args = isWindows ? [] : ["-c", command]
      useShell = isWindows
    }

    const child = spawn(cmd, args, {
      env,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      cwd
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
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    modelKwargs: {
      ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
    },
    configuration: { baseURL: config.baseUrl }
  })
}

function buildPromptHookUserMessage(
  event: HookEvent,
  policy: string,
  context: HookContext
): string {
  return JSON.stringify(
    {
      hook_event_name: event,
      policy,
      ...(context.userPrompt ? { prompt: context.userPrompt } : {}),
      tool_name: context.toolName ?? "(unknown)",
      tool_args: context.toolArgs ?? {},
      ...(context.toolResult !== undefined ? { tool_result: context.toolResult } : {}),
      ...(context.skillName ? { skill_name: context.skillName } : {}),
      ...(context.skillPath ? { skill_path: context.skillPath } : {}),
      ...(context.skillRoot ? { skill_root: context.skillRoot } : {}),
      ...(context.pluginRoot ? { plugin_root: context.pluginRoot } : {}),
      ...(context.hookSourceType ? { hook_source_type: context.hookSourceType } : {}),
      ...(context.hookSourceRoot ? { hook_source_root: context.hookSourceRoot } : {}),
      ...(context.hookSourcePath ? { hook_source_path: context.hookSourcePath } : {}),
      cwd: getCommandCwd(context),
      // PR-01: same CC-compatible fields used in command-hook payloads. The
      // prompt-hook LLM also benefits from knowing transcript / mode / agent id
      // when writing policy decisions.
      ...(context.transcriptPath ? { transcript_path: context.transcriptPath } : {}),
      ...(context.permissionMode ? { permission_mode: context.permissionMode } : {}),
      ...(context.agentId ? { agent_id: context.agentId } : {}),
      ...(context.stopContext ? { stop_context: context.stopContext } : {}),
      workspace: context.workspacePath ?? ""
    },
    null,
    2
  )
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

  const timeout = getEffectiveTimeout(hook)
  const model = getPromptHookModel(getHookModelRef(hook), timeout)
  if (!model) {
    return fallbackResult("[PromptHook] No model configured — cannot evaluate prompt hook")
  }

  const userMsg = buildPromptHookUserMessage(event, policy, context)

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

    // PR-02: Claude Code's SessionStart hook can return `initialUserMessage`
    // to auto-inject a first prompt, and `watchPaths` to register paths with a
    // file watcher. We parse both fields today even though the consumer side
    // is wired in a later PR — emitting hooks can already use the CC shape
    // and we won't need to touch the parser again.
    const initialUserMessage =
      typeof parsed.initialUserMessage === "string"
        ? parsed.initialUserMessage
        : nested && typeof nested.initialUserMessage === "string"
          ? nested.initialUserMessage
          : undefined

    const watchPathsSource = parsed.watchPaths ?? nested?.watchPaths
    const watchPaths =
      Array.isArray(watchPathsSource) && watchPathsSource.every((p) => typeof p === "string")
        ? (watchPathsSource as string[])
        : undefined

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
      reason: effectiveReason,
      initialUserMessage,
      watchPaths
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
 *
 * Always records `durationMs` on the result (wall-clock from entry to return).
 * Also attaches the stdin payload when Hook diagnostic mode is enabled — the
 * UI / persisted log uses it for debugging "what did the hook actually see".
 * Off by default to avoid streaming user input through IPC + disk on every run.
 */
async function executeHook(
  hook: HookConfig,
  env: Record<string, string>,
  context: HookContext,
  event: HookEvent
): Promise<HookResult> {
  // PR-15 — async config-layer fork: return a `pending` placeholder
  // synchronously so the calling event chain doesn't wait, then run the
  // real executor in the background and forward the final result via the
  // global `onLateHookResult` callback (when registered). The placeholder
  // never carries a blocking decision; the late result is informational.
  if (hook.async === true) {
    void executeSyncHook(hook, env, context, event)
      .then((late) => {
        const finalLate: HookResult = {
          ...late,
          asyncStatus: "completed",
          lateCompletedAt: new Date().toISOString()
        }
        lateResultListener?.(event, hook, finalLate)
      })
      .catch((err) => {
        const errStr = err instanceof Error ? err.message : String(err)
        lateResultListener?.(event, hook, {
          exitCode: null,
          stdout: "",
          stderr: errStr,
          blocked: false,
          asyncStatus: "timeout",
          lateCompletedAt: new Date().toISOString()
        })
      })
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      asyncStatus: "pending"
    }
  }
  return executeSyncHook(hook, env, context, event)
}

async function executeSyncHook(
  hook: HookConfig,
  env: Record<string, string>,
  context: HookContext,
  event: HookEvent
): Promise<HookResult> {
  const startedAt = Date.now()
  const diagnostic = getHookLoggingConfig().diagnostic
  const hookType = hook.type ?? "command"
  let result: HookResult
  let stdinPayload: string | undefined
  if (hookType === "prompt") {
    if (diagnostic) {
      const policy = hook.prompt?.trim()
      if (policy) stdinPayload = buildPromptHookUserMessage(event, policy, context)
    }
    result = await executePromptHook(hook, context, event)
  } else if (hookType === "http") {
    const builtPayload = buildHookStdinPayload(event, context)
    if (diagnostic) stdinPayload = builtPayload
    result = await executeHttpHook(hook, builtPayload, getEffectiveTimeout(hook))
  } else {
    const builtPayload = buildHookStdinPayload(event, context)
    if (diagnostic) stdinPayload = builtPayload
    result = await executeCommandHook(hook, env, builtPayload, getCommandCwd(context))
  }
  const finalized = applyConfiguredOnBlock(parseHookJsonOutput(result), hook)
  finalized.durationMs = Date.now() - startedAt
  if (stdinPayload !== undefined) finalized.stdinPayload = stdinPayload
  if (diagnostic) finalized.cwd = getCommandCwd(context)
  return finalized
}

// PR-15 — module-level late-result listener. Set by the IPC/runtime layer to
// forward async hook completions to the UI / log persistence path.
let lateResultListener:
  | ((event: HookEvent, hook: HookConfig, result: HookResult) => void)
  | undefined

export function setLateHookResultListener(
  cb: ((event: HookEvent, hook: HookConfig, result: HookResult) => void) | undefined
): void {
  lateResultListener = cb
}

/**
 * Run all matching hooks for a given event.
 *
 * - PreToolUse/PreSkillUse/UserPromptSubmit: exit code 2 or decision=block stops the turn.
 * - PostToolUse: collects hook output so callers can decide how to surface it.
 * - PostSkillUse: logs every hook result, but only blocking results are returned for revision.
 * - Stop: awaited — can request revision or halt the turn.
 * - SubagentStop: awaited for halt semantics; non-halting output is only logged.
 * - Notification/SessionStart/SessionEnd: fire-and-forget.
 */
export type HookResultCallback = (event: HookEvent, hook: HookConfig, result: HookResult) => void

/**
 * Hook entries reaching this runner may carry plugin or skill ownership metadata
 * from {@link PluginHookMetadata} or {@link SkillHookMetadata}. Use a partial union
 * to recover those fields without forcing every caller to know which kind it is.
 */
type ScopedHook = HookConfig &
  Partial<Pick<PluginHookMetadata, "pluginId" | "pluginName" | "pluginRoot">> &
  Partial<Pick<SkillHookMetadata, "skillName" | "skillPath" | "skillRoot">>

function getOnceSessionId(context: HookContext): string {
  return context.sessionId ?? ""
}

/**
 * Per-hook part of the once-key. sessionId is intentionally excluded — we use
 * it as the outer Map key so a session's entries can be dropped in O(1) on
 * `clearOnceStateForSession`.
 */
function getOnceHookKey(hook: HookConfig, event: HookEvent, context: HookContext): string {
  const scopedHook = hook as ScopedHook
  return [
    event,
    hook.hookSourceType ?? scopedHook.hookSourceType ?? "",
    hook.hookSourceRoot ?? scopedHook.hookSourceRoot ?? "",
    hook.hookSourcePath ?? scopedHook.hookSourcePath ?? "",
    scopedHook.pluginId ?? context.pluginId ?? "",
    scopedHook.skillPath ?? context.skillPath ?? "",
    hook.id
  ].join(ONCE_HOOK_KEY_SEPARATOR)
}

function shouldSkipOnceHook(hook: HookConfig, event: HookEvent, context: HookContext): boolean {
  if (hook.once !== true) return false
  const sessionSet = firedOnceHookKeys.get(getOnceSessionId(context))
  if (!sessionSet) return false
  return sessionSet.has(getOnceHookKey(hook, event, context))
}

function shouldConsumeOnceHook(result: HookResult): boolean {
  return result.exitCode === 0
}

function markOnceHookIfNeeded(
  hook: HookConfig,
  event: HookEvent,
  context: HookContext,
  result: HookResult
): void {
  if (hook.once !== true || !shouldConsumeOnceHook(result)) return
  const sessionId = getOnceSessionId(context)
  let sessionSet = firedOnceHookKeys.get(sessionId)
  if (!sessionSet) {
    sessionSet = new Set<string>()
    firedOnceHookKeys.set(sessionId, sessionSet)
  }
  sessionSet.add(getOnceHookKey(hook, event, context))
}

/** Drop all once-fired entries belonging to a session — call from fireSessionEnd. */
export function clearOnceStateForSession(sessionId: string): void {
  firedOnceHookKeys.delete(sessionId)
}

/**
 * Drop once-fired entries that match a hook id across all sessions. Called
 * after the hook is created/updated/deleted/toggled so a fresh `once` cycle
 * applies — mirrors CC's "register/unregister hook" semantics.
 */
export function clearOnceStateForHook(hookId: string): void {
  const suffix = ONCE_HOOK_KEY_SEPARATOR + hookId
  for (const sessionSet of firedOnceHookKeys.values()) {
    for (const key of [...sessionSet]) {
      if (key.endsWith(suffix)) sessionSet.delete(key)
    }
  }
}

export function resetHookOnceStateForTests(): void {
  firedOnceHookKeys.clear()
}

function enrichContextFromHook(hook: HookConfig, context: HookContext): HookContext {
  const scopedHook = hook as ScopedHook
  return {
    ...context,
    pluginId: context.pluginId ?? scopedHook.pluginId,
    pluginName: context.pluginName ?? scopedHook.pluginName,
    pluginRoot: context.pluginRoot ?? scopedHook.pluginRoot,
    hookSourceType: context.hookSourceType ?? scopedHook.hookSourceType,
    hookSourceRoot: context.hookSourceRoot ?? scopedHook.hookSourceRoot,
    hookSourcePath: context.hookSourcePath ?? scopedHook.hookSourcePath,
    skillName: context.skillName ?? scopedHook.skillName,
    skillPath: context.skillPath ?? scopedHook.skillPath,
    skillRoot: context.skillRoot ?? scopedHook.skillRoot
  }
}

export function hookMatchesRunCriteria(
  hook: HookConfig,
  event: HookEvent,
  context: HookContext
): boolean {
  return (
    hook.enabled &&
    hook.event === event &&
    matchesEventMatcher(hook.matcher, event, context) &&
    matchesIfCondition(hook.if, event, context) &&
    !shouldSkipOnceHook(hook, event, context)
  )
}

/**
 * PR-16 — Lightweight evaluator for the CC `if` field. CC uses permission
 * rule syntax (`"Bash(git *)"`) that requires the Bash tree-sitter parser; we
 * implement a small subset that covers the most common cases without dragging
 * the full parser in:
 *
 *   - `"ToolName(*)"` matches any args to that tool
 *   - `"ToolName(pattern)"` matches when the tool's primary arg
 *     (`command` for execute, `file_path` for read/write, `path` otherwise)
 *     glob-matches the pattern (`*` is the only metachar)
 *   - empty/undefined `if` always matches
 *
 * Future PRs can replace this with a fuller implementation; the contract
 * (returns boolean) is stable.
 */
function matchesIfCondition(
  ifClause: string | undefined,
  _event: HookEvent,
  context: HookContext
): boolean {
  if (!ifClause || !ifClause.trim()) return true
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)$/.exec(ifClause.trim())
  if (!m) return true // unrecognised syntax → permissive (don't block hook)
  const wantTool = m[1].toLowerCase()
  const argPattern = m[2].trim()
  if (!context.toolName) return false
  if (context.toolName.toLowerCase() !== wantTool) return false
  if (!argPattern || argPattern === "*") return true
  const primaryArg =
    (typeof context.toolArgs?.command === "string" && context.toolArgs.command) ||
    (typeof context.toolArgs?.file_path === "string" && context.toolArgs.file_path) ||
    (typeof context.toolArgs?.path === "string" && context.toolArgs.path) ||
    ""
  if (!primaryArg) return false
  const regexSrc = "^" + argPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  try {
    return new RegExp(regexSrc).test(primaryArg)
  } catch {
    return false
  }
}

function recordHookResult(
  event: HookEvent,
  hook: HookConfig,
  result: HookResult,
  context: HookContext,
  onHookResult?: HookResultCallback
): void {
  persistHookResultRecord(event, hook, result, context.turnId)
  onHookResult?.(event, hook, result)
}

export async function runHooks(
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext,
  onHookResult?: HookResultCallback
): Promise<HookResult | null> {
  const matched = hooks.filter((h) => hookMatchesRunCriteria(h, event, context))

  if (matched.length === 0) return null

  if (event === "PreToolUse" || event === "PreSkillUse" || event === "UserPromptSubmit") {
    let mergedUpdatedInput: Record<string, unknown> | undefined
    let mergedAdditionalContext: string | undefined
    let mergedSystemMessage: string | undefined
    let mergedSuppressOutput = false
    for (const hook of matched) {
      const hookContext = enrichContextFromHook(hook, context)
      const result = applyForcedOutcome(
        await executeHook(hook, buildHookEnv(event, hookContext), hookContext, event),
        hook
      )
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) "${(hook.command ?? hook.prompt ?? "").slice(0, 60)}" → exit=${result.exitCode}, blocked=${result.blocked}`
      )
      recordHookResult(event, hook, result, hookContext, onHookResult)
      markOnceHookIfNeeded(hook, event, hookContext, result)
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
        mergedUpdatedInput = mergeUpdatedInput(mergedUpdatedInput ?? {}, result.updatedInput)
      }
      if (result.additionalContext) {
        mergedAdditionalContext = joinHookText(mergedAdditionalContext, result.additionalContext)
      }
      if (result.systemMessage) {
        mergedSystemMessage = joinHookText(mergedSystemMessage, result.systemMessage)
      }
      if (result.suppressOutput === true) {
        mergedSuppressOutput = true
      }
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      updatedInput: mergedUpdatedInput,
      additionalContext: mergedAdditionalContext,
      systemMessage: mergedSystemMessage,
      suppressOutput: mergedSuppressOutput || undefined
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
      const hookContext = enrichContextFromHook(hook, context)
      const result = applyForcedOutcome(
        await executeHook(hook, buildHookEnv(event, hookContext), hookContext, event),
        hook
      )
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}`
      )
      recordHookResult(event, hook, result, hookContext, onHookResult)
      markOnceHookIfNeeded(hook, event, hookContext, result)
      if (result.continue === false) {
        shouldHalt = true
        haltReason = result.stopReason ?? haltReason
      }
      // PostToolUse decision=block: feed reason back to agent for reconsideration.
      if (result.decision === "block" && result.reason) {
        blockReasons.push(result.reason)
      }
      if (result.stdout && result.suppressOutput !== true) outputs.push(result.stdout)
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

  if (event === "PostSkillUse") {
    const contexts: string[] = []
    const messages: string[] = []
    const revisionReasons: string[] = []
    const stopReasons: string[] = []
    for (const hook of matched) {
      const hookContext = enrichContextFromHook(hook, context)
      const result = applyForcedOutcome(
        await executeHook(hook, buildHookEnv(event, hookContext), hookContext, event),
        hook
      )
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}, continue=${result.continue}`
      )
      recordHookResult(event, hook, result, hookContext, onHookResult)
      markOnceHookIfNeeded(hook, event, hookContext, result)

      // continue:false → halt the turn (no revision); takes priority over decision:block.
      // Non-blocking PostSkillUse output is intentionally dropped here — it remains observable
      // through onHookResult callbacks but must not pollute the revision/halt context.
      if (result.continue === false) {
        stopReasons.push(
          result.stopReason ||
            result.reason ||
            result.stdout ||
            result.stderr ||
            "PostSkillUse hook stopped the turn"
        )
        if (result.additionalContext) contexts.push(result.additionalContext)
        if (result.systemMessage) messages.push(result.systemMessage)
      } else if (result.blocked || result.decision === "block") {
        revisionReasons.push(
          result.reason ||
            result.stopReason ||
            result.stdout ||
            result.stderr ||
            "PostSkillUse hook requested revision"
        )
        if (result.additionalContext) contexts.push(result.additionalContext)
        if (result.systemMessage) messages.push(result.systemMessage)
      }
    }

    if (stopReasons.length === 0 && revisionReasons.length === 0) return null

    const halt = stopReasons.length > 0
    const reasons = halt ? stopReasons : revisionReasons
    return {
      exitCode: 0,
      stdout: reasons.join("\n"),
      stderr: "",
      blocked: !halt && revisionReasons.length > 0,
      continue: halt ? false : undefined,
      stopReason: halt ? stopReasons.join("\n") : undefined,
      decision: halt ? undefined : revisionReasons.length > 0 ? "block" : undefined,
      reason: halt
        ? undefined
        : revisionReasons.length > 0
          ? revisionReasons.join("\n")
          : undefined,
      additionalContext: contexts.length > 0 ? contexts.join("\n") : undefined,
      systemMessage: messages.length > 0 ? messages.join("\n") : undefined
    }
  }

  // Stop: awaited — results can trigger revision, inject feedback, or halt the turn
  if (event === "Stop") {
    const revisionReasons: string[] = []
    const stopReasons: string[] = []
    let additionalContext: string | undefined
    let systemMessage: string | undefined
    for (const hook of matched) {
      const hookContext = enrichContextFromHook(hook, context)
      const result = applyForcedOutcome(
        await executeHook(hook, buildHookEnv(event, hookContext), hookContext, event),
        hook
      )
      console.log(
        `[Hooks] Stop hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}, continue=${result.continue}`
      )
      recordHookResult(event, hook, result, hookContext, onHookResult)
      markOnceHookIfNeeded(hook, event, hookContext, result)
      if (result.continue === false) {
        stopReasons.push(
          result.stopReason ||
            result.reason ||
            result.stdout ||
            result.stderr ||
            "Stop hook stopped the turn"
        )
      } else if (result.blocked || result.decision === "block") {
        revisionReasons.push(
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
    if (
      stopReasons.length > 0 ||
      revisionReasons.length > 0 ||
      additionalContext ||
      systemMessage
    ) {
      const halt = stopReasons.length > 0
      return {
        exitCode: 0,
        stdout: (halt ? stopReasons : revisionReasons).join("\n"),
        stderr: "",
        blocked: !halt && revisionReasons.length > 0,
        continue: halt ? false : undefined,
        stopReason: halt ? stopReasons.join("\n") : undefined,
        decision: halt ? undefined : revisionReasons.length > 0 ? "block" : undefined,
        reason: halt
          ? undefined
          : revisionReasons.length > 0
            ? revisionReasons.join("\n")
            : undefined,
        additionalContext,
        systemMessage
      }
    }
    return null
  }

  // SubagentStop: awaited so `continue:false` can halt the parent turn after a task finishes.
  if (event === "SubagentStop") {
    const stopReasons: string[] = []
    let additionalContext: string | undefined
    let systemMessage: string | undefined
    for (const hook of matched) {
      const hookContext = enrichContextFromHook(hook, context)
      const result = applyForcedOutcome(
        await executeHook(hook, buildHookEnv(event, hookContext), hookContext, event),
        hook
      )
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}, continue=${result.continue}`
      )
      recordHookResult(event, hook, result, hookContext, onHookResult)
      markOnceHookIfNeeded(hook, event, hookContext, result)
      if (result.continue === false) {
        stopReasons.push(
          result.stopReason ||
            result.reason ||
            result.stdout ||
            result.stderr ||
            "SubagentStop hook stopped the turn"
        )
      }
      if (result.additionalContext) {
        additionalContext = joinHookText(additionalContext, result.additionalContext)
      }
      if (result.systemMessage) {
        systemMessage = joinHookText(systemMessage, result.systemMessage)
      }
      if (result.stderr) {
        console.warn(`[Hooks] ${event} hook stderr:`, result.stderr)
      }
    }

    if (stopReasons.length === 0) return null
    return {
      exitCode: 0,
      stdout: stopReasons.join("\n"),
      stderr: "",
      blocked: false,
      continue: false,
      stopReason: stopReasons.join("\n"),
      additionalContext,
      systemMessage
    }
  }

  // SessionEnd is awaited by thread deletion and app shutdown paths so hooks
  // can finish and their diagnostic jsonl records can flush before teardown.
  //
  // Run hooks in parallel (each already has its own per-hook timeout — there's
  // no ordering dependency at SessionEnd) and cap the total wall time so a
  // single slow hook can't block the "delete thread" UI or app shutdown.
  // Anything past the cap is allowed to keep running in the background; we
  // just stop blocking the caller.
  // SessionEnd / Setup share "awaited drain": we want to return after every
  // hook settled (so the caller can act on completion), but not let any one
  // slow hook block the UI/app indefinitely.
  //
  // PR-11 follow-up — Setup MUST go through this awaited branch because
  // session-lifecycle uses the resolution of runHooks to decide whether to
  // write the workspace's setup-state marker. The original fire-and-forget
  // path returned null synchronously, which caused the marker to be written
  // before the hook actually completed (so a failed Setup script would
  // never be retried).
  if (event === "SessionEnd" || event === "Setup") {
    const TOTAL_TIMEOUT_MS = event === "Setup" ? 30_000 : 5_000
    const tasks = matched.map(async (hook) => {
      const hookContext = enrichContextFromHook(hook, context)
      try {
        const rawResult = await executeHook(
          hook,
          buildHookEnv(event, hookContext),
          hookContext,
          event
        )
        const result = applyForcedOutcome(rawResult, hook)
        console.log(
          `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}, continue=${result.continue}`
        )
        recordHookResult(event, hook, result, hookContext, onHookResult)
        markOnceHookIfNeeded(hook, event, hookContext, result)
        if (result.stderr) {
          console.warn(`[Hooks] ${event} hook stderr:`, result.stderr)
        }
        return result
      } catch (err) {
        console.warn(`[Hooks] ${event} hook error:`, err)
        return undefined
      }
    })
    let timedOut = false
    const settled = await Promise.race<Array<PromiseSettledResult<HookResult | undefined>> | "timeout">(
      [
        Promise.allSettled(tasks),
        new Promise<"timeout">((resolve) => setTimeout(() => {
          timedOut = true
          resolve("timeout")
        }, TOTAL_TIMEOUT_MS))
      ]
    )
    // For Setup we surface a synthetic blocking result on timeout so the
    // caller (session-lifecycle) does NOT mark the workspace initialised.
    if (event === "Setup") {
      if (timedOut) {
        return {
          exitCode: null,
          stdout: "",
          stderr: `Setup hooks timed out after ${TOTAL_TIMEOUT_MS}ms`,
          blocked: true
        }
      }
      // Any non-zero exit code from at least one Setup hook → treat the
      // whole run as failed so we don't persist init state.
      const results = settled as Array<PromiseSettledResult<HookResult | undefined>>
      const anyFailed = results.some(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && r.value && r.value.exitCode !== 0)
      )
      if (anyFailed) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "at least one Setup hook returned non-zero exit",
          blocked: true
        }
      }
    }
    return null
  }

  // Notification / SessionStart: fire-and-forget
  for (const hook of matched) {
    const hookContext = enrichContextFromHook(hook, context)
    executeHook(hook, buildHookEnv(event, hookContext), hookContext, event)
      .then((rawResult) => {
        const result = applyForcedOutcome(rawResult, hook)
        console.log(
          `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}, decision=${result.decision ?? "-"}, continue=${result.continue}`
        )
        recordHookResult(event, hook, result, hookContext, onHookResult)
        markOnceHookIfNeeded(hook, event, hookContext, result)
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

import { spawn } from "node:child_process"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { HookConfig, HookEvent, HookResult } from "./types"
import { getCustomModelConfigs } from "../storage"

const DEFAULT_TIMEOUT = 10_000
const MAX_OUTPUT_BYTES = 1_000_000 // 1 MB per hook

export interface HookContext {
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  workspacePath?: string
}

/**
 * Match a hook's matcher against a tool name.
 * - undefined/empty/"*" matches everything
 * - otherwise exact case-insensitive match
 */
function matchesToolName(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true
  if (!toolName) return false
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
  if (context.toolResult) env.TOOL_RESULT = JSON.stringify(context.toolResult)
  if (context.workspacePath) env.WORKSPACE_PATH = context.workspacePath
  return env
}

/**
 * Execute a single hook command and return its result.
 */
function executeCommandHook(hook: HookConfig, env: Record<string, string>): Promise<HookResult> {
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
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      cwd: env.WORKSPACE_PATH || process.cwd()
    })

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
        try { child.kill("SIGKILL") } catch { /* ignore */ }
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
      try { child.kill("SIGKILL") } catch { /* ignore */ }
      settle({
        exitCode: null,
        stdout: "",
        stderr: `Hook timed out after ${timeout}ms`,
        blocked: false
      })
    }, timeout + 500)

    child.on("close", (exitCode) => {
      const extraNote = outputTruncated ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""
      settle({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim() + extraNote,
        blocked: exitCode !== 0 && exitCode !== null
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
You will be given a policy rule and a description of a tool call the AI agent is about to make.
Decide whether to allow or block the tool call based strictly on the policy.

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
function getPromptHookModel(modelId: string | undefined): ChatOpenAI | null {
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
    timeout: 30_000,
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
async function executePromptHook(hook: HookConfig, context: HookContext): Promise<HookResult> {
  const fallback = hook.fallback ?? "allow"
  const fallbackResult = (reason: string): HookResult => ({
    exitCode: fallback === "block" ? 1 : 0,
    stdout: fallback === "block" ? reason : "",
    stderr: reason,
    blocked: fallback === "block"
  })

  const policy = hook.prompt?.trim()
  if (!policy) {
    return fallbackResult("[PromptHook] No policy text configured")
  }

  const model = getPromptHookModel(hook.modelId)
  if (!model) {
    return fallbackResult("[PromptHook] No model configured — cannot evaluate prompt hook")
  }

  const userMsg = JSON.stringify({
    policy,
    tool_name: context.toolName ?? "(unknown)",
    tool_args: context.toolArgs ?? {},
    ...(context.toolResult !== undefined ? { tool_result: context.toolResult } : {}),
    workspace: context.workspacePath ?? ""
  }, null, 2)

  const timeout = hook.timeout ?? DEFAULT_TIMEOUT

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`PromptHook LLM timed out after ${timeout}ms`)), timeout)
    )

    const invokePromise = model.invoke([
      new SystemMessage(PROMPT_HOOK_SYSTEM),
      new HumanMessage(userMsg)
    ])

    const response = await Promise.race([invokePromise, timeoutPromise])

    let raw = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content)

    raw = stripThinkBlocks(raw)

    const jsonStr = extractFirstJson(raw)
    if (!jsonStr) {
      console.warn("[PromptHook] Could not extract JSON from model response:", raw.slice(0, 200))
      return fallbackResult(`[PromptHook] Model returned non-JSON response — applying fallback (${fallback})`)
    }

    const parsed = JSON.parse(jsonStr) as { decision: string; reason?: string }
    const blocked = parsed.decision === "block"

    console.log(
      `[PromptHook] policy="${policy.slice(0, 60)}…" tool=${context.toolName} → decision=${parsed.decision}` +
      (parsed.reason ? ` reason="${parsed.reason}"` : "")
    )

    return {
      exitCode: blocked ? 1 : 0,
      stdout: blocked ? (parsed.reason ?? "Blocked by prompt hook policy") : "",
      stderr: "",
      blocked
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn("[PromptHook] Evaluation error:", msg)
    return fallbackResult(`[PromptHook] Evaluation failed: ${msg}`)
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Execute a single hook (command or prompt type).
 */
async function executeHook(hook: HookConfig, env: Record<string, string>, context: HookContext): Promise<HookResult> {
  const hookType = hook.type ?? "command"
  if (hookType === "prompt") {
    return executePromptHook(hook, context)
  }
  return executeCommandHook(hook, env)
}

/**
 * Run all matching hooks for a given event.
 *
 * - PreToolUse: if ANY hook exits non-zero, returns blocked=true with the stdout as feedback.
 * - PostToolUse: collects stdout from all hooks as extra context.
 * - Stop/Notification: fire-and-forget; errors are logged but not propagated.
 */
export async function runHooks(
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext
): Promise<HookResult | null> {
  const matched = hooks.filter(
    (h) => h.enabled && h.event === event && matchesToolName(h.matcher, context.toolName)
  )

  if (matched.length === 0) return null

  const env = buildHookEnv(event, context)

  if (event === "PreToolUse") {
    for (const hook of matched) {
      const result = await executeHook(hook, env, context)
      console.log(
        `[Hooks] PreToolUse hook (${hook.type ?? "command"}) "${(hook.command ?? hook.prompt ?? "").slice(0, 60)}" → exit=${result.exitCode}, blocked=${result.blocked}`
      )
      if (result.blocked) {
        return result
      }
    }
    return { exitCode: 0, stdout: "", stderr: "", blocked: false }
  }

  if (event === "PostToolUse") {
    const outputs: string[] = []
    for (const hook of matched) {
      const result = await executeHook(hook, env, context)
      console.log(
        `[Hooks] PostToolUse hook (${hook.type ?? "command"}) → exit=${result.exitCode}`
      )
      if (result.stdout) {
        outputs.push(result.stdout)
      }
    }
    return {
      exitCode: 0,
      stdout: outputs.join("\n"),
      stderr: "",
      blocked: false
    }
  }

  // Stop / Notification: fire-and-forget
  for (const hook of matched) {
    executeHook(hook, env, context).then((result) => {
      console.log(
        `[Hooks] ${event} hook (${hook.type ?? "command"}) → exit=${result.exitCode}`
      )
      if (result.stderr) {
        console.warn(`[Hooks] ${event} hook stderr:`, result.stderr)
      }
    }).catch((err) => {
      console.warn(`[Hooks] ${event} hook error:`, err)
    })
  }

  return null
}

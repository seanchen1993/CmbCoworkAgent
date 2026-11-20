import { getHookLoggingConfig } from "../storage"
import {
  redactAndTruncateSensitiveText,
  redactLogValue,
  redactSensitiveText
} from "../log-redaction"
import { persistHookExecutionRecord } from "./persistence"
import type { ScopeSkipReason } from "./scope"
import type { HookConfig, HookEvent, HookResult, HookType } from "./types"
import type { HookLoggingConfig } from "../types"

const MAX_STDOUT_PREVIEW_CHARS = 4_000
const MAX_STDERR_PREVIEW_CHARS = 8_000
const MAX_ADDITIONAL_CONTEXT_PREVIEW_CHARS = 4_000
// stdin payload often carries full tool args (file contents, command outputs);
// since diagnostic mode also writes the untruncated record to jsonl this
// preview just needs to be wide enough to be useful at a glance.
const MAX_STDIN_PREVIEW_CHARS = 32_000
const MAX_DIAGNOSTIC_STDIN_CHARS = 64 * 1024
const USER_CONTEXT_SECRET_KEYS = new Set(["yst_id_token"])

function truncatePreview(text: string | undefined, maxChars: number): string {
  if (!text) return ""
  return redactAndTruncateSensitiveText(
    text,
    maxChars,
    (omittedChars) => `\n...[truncated ${omittedChars} chars]`
  )
}

function maybePreview(text: string | undefined, maxChars: number, preview: boolean): string {
  if (!text) return ""
  return preview ? truncatePreview(text, maxChars) : text
}

function redactHookStdinPayload(text: string | undefined): string | undefined {
  if (!text) return text
  if (text.length > MAX_DIAGNOSTIC_STDIN_CHARS) {
    return redactAndTruncateSensitiveText(
      text,
      MAX_DIAGNOSTIC_STDIN_CHARS,
      (omittedChars) => `\n...[truncated ${omittedChars} chars]`
    )
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text
    const payload = parsed as Record<string, unknown>
    if (!payload.user_context || typeof payload.user_context !== "object") return text

    const userContext = { ...(payload.user_context as Record<string, unknown>) }
    for (const key of Object.keys(userContext)) {
      if (USER_CONTEXT_SECRET_KEYS.has(key) || /token/i.test(key)) {
        userContext[key] = "[redacted]"
      }
    }
    return JSON.stringify({ ...payload, user_context: userContext })
  } catch {
    return redactSensitiveText(text)
  }
}

/**
 * Per-execution record shipped to the renderer over the agent stream channel.
 *
 * Default mode (Hook logging enabled, diagnostic off): minimal fields needed
 * to render the chip + per-turn modal.
 *
 * Diagnostic mode: same shape plus `stdinPayload`, `skipped`, `command`, `cwd`,
 * `hookSourcePath` — the inputs you need when a hook misbehaves and you want
 * to know exactly what it saw. Also persisted to the jsonl log file.
 */
export interface HookExecutedEnvelope {
  type: "hook_executed"
  /** "executed" = ran; "skipped" = matched event but scope-filtered out (diagnostic only). */
  kind: "executed" | "skipped"
  event: HookEvent
  hookType: HookType
  /** Concise display label (command preview or prompt preview). */
  label: string
  /** Full command text — present when diagnostic mode is on. */
  command?: string
  toolSuffix: string
  pluginId?: string
  pluginName?: string
  skillName?: string
  skillPath?: string
  hookSourcePath?: string
  cwd?: string
  durationMs?: number
  exitCode?: number | null
  blocked?: boolean
  continue?: boolean
  stopReason?: string
  decision?: string
  reason?: string
  stdout?: string
  stderr?: string
  additionalContext?: string
  systemMessage?: string
  /** Only present in diagnostic mode for executed hooks. */
  stdinPayload?: string
  /** Only present on `kind: "skipped"` records. */
  skipReason?: ScopeSkipReason
  /** ISO timestamp emitted by main so renderer rows are deterministic. */
  timestamp: string
  /** Renderer user message id that owns this hook event, when this is a chat turn. */
  turnId?: string
  /** Coordinator-worker identity, when the hook fired inside an async worker. */
  workerId?: string
  workerThreadId?: string
  workerTurn?: number
  parentThreadId?: string
}

export type ScopedHook = HookConfig & {
  pluginId?: string
  pluginName?: string
  skillName?: string
  skillPath?: string
  workerId?: string
  workerThreadId?: string
  workerTurn?: number
  parentThreadId?: string
}

function buildLabel(hook: HookConfig, diagnostic: boolean): string {
  const text =
    hook.type === "prompt"
      ? (hook.prompt ?? "")
      : hook.type === "http"
        ? (hook.url ?? "")
        : (hook.command ?? "")
  // In diagnostic mode the modal shows the full command separately; for the
  // chip-list label we still want something readable, so cap to 120 chars.
  return redactAndTruncateSensitiveText(text, diagnostic ? 120 : 60, "…")
}

function buildExecutedEnvelope(
  event: HookEvent,
  hook: ScopedHook,
  result: HookResult,
  diagnostic: boolean,
  options: { preview: boolean; turnId?: string }
): HookExecutedEnvelope {
  const hookType = hook.type ?? "command"
  const envelope: HookExecutedEnvelope = {
    type: "hook_executed",
    kind: "executed",
    event,
    hookType,
    label: buildLabel(hook, diagnostic),
    toolSuffix: hook.matcher && hook.matcher !== "*" ? `/${hook.matcher}` : "",
    pluginId: hook.pluginId,
    pluginName: hook.pluginName,
    skillName: hook.skillName,
    skillPath: hook.skillPath,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    blocked: result.blocked,
    continue: result.continue,
    stopReason: result.stopReason,
    decision: result.decision,
    reason: result.reason,
    stdout: maybePreview(
      result.rawStdout ?? result.stdout,
      MAX_STDOUT_PREVIEW_CHARS,
      options.preview
    ),
    stderr: maybePreview(result.stderr, MAX_STDERR_PREVIEW_CHARS, options.preview),
    additionalContext: maybePreview(
      result.additionalContext,
      MAX_ADDITIONAL_CONTEXT_PREVIEW_CHARS,
      options.preview
    ),
    systemMessage: result.systemMessage,
    timestamp: new Date().toISOString(),
    turnId: options.turnId,
    workerId: hook.workerId,
    workerThreadId: hook.workerThreadId,
    workerTurn: hook.workerTurn,
    parentThreadId: hook.parentThreadId
  }
  if (diagnostic) {
    envelope.command =
      hook.type === "prompt" ? hook.prompt : hook.type === "http" ? hook.url : hook.command
    envelope.hookSourcePath = hook.hookSourcePath
    // Prefer the cwd the runner actually used (set on `result.cwd` in
    // diagnostic mode); fall back to hook.hookSourceRoot so log records
    // produced through any pre-cwd code path still carry something sane.
    envelope.cwd = result.cwd ?? hook.hookSourceRoot
    if (result.stdinPayload !== undefined) {
      envelope.stdinPayload = maybePreview(
        redactHookStdinPayload(result.stdinPayload),
        MAX_STDIN_PREVIEW_CHARS,
        options.preview
      )
    }
  }
  return envelope
}

function buildSkippedEnvelope(
  event: HookEvent,
  hook: ScopedHook,
  reason: ScopeSkipReason,
  turnId?: string
): HookExecutedEnvelope {
  const hookType = hook.type ?? "command"
  return {
    type: "hook_executed",
    kind: "skipped",
    event,
    hookType,
    label: buildLabel(hook, true),
    command:
      hook.type === "prompt" ? hook.prompt : hook.type === "http" ? hook.url : hook.command,
    toolSuffix: hook.matcher && hook.matcher !== "*" ? `/${hook.matcher}` : "",
    pluginId: hook.pluginId,
    pluginName: hook.pluginName,
    skillName: hook.skillName,
    skillPath: hook.skillPath,
    hookSourcePath: hook.hookSourcePath,
    cwd: hook.hookSourceRoot,
    skipReason: reason,
    timestamp: new Date().toISOString(),
    turnId,
    workerId: hook.workerId,
    workerThreadId: hook.workerThreadId,
    workerTurn: hook.workerTurn,
    parentThreadId: hook.parentThreadId
  }
}

export function buildHookResultRecord(
  event: HookEvent,
  hook: HookConfig,
  result: HookResult,
  turnId?: string
): HookExecutedEnvelope | null {
  const cfg = getHookLoggingConfig()
  return buildHookResultRecordForConfig(event, hook, result, cfg, turnId)
}

/** Pure record builder for callers/tests that already have a logging config snapshot. */
export function buildHookResultRecordForConfig(
  event: HookEvent,
  hook: HookConfig,
  result: HookResult,
  config: Pick<HookLoggingConfig, "enabled" | "diagnostic">,
  turnId?: string
): HookExecutedEnvelope | null {
  if (!config.enabled) return null
  return redactLogValue(
    buildExecutedEnvelope(event, hook as ScopedHook, result, config.diagnostic, {
      preview: true,
      turnId
    })
  ) as HookExecutedEnvelope
}

function buildPersistedHookResultRecord(
  event: HookEvent,
  hook: HookConfig,
  result: HookResult,
  turnId?: string
): HookExecutedEnvelope | null {
  const cfg = getHookLoggingConfig()
  if (!cfg.enabled) return null
  return redactLogValue(
    buildExecutedEnvelope(event, hook as ScopedHook, result, cfg.diagnostic, {
      preview: false,
      turnId
    })
  ) as HookExecutedEnvelope
}

export function buildHookSkippedRecord(
  event: HookEvent,
  hook: ScopedHook,
  reason: ScopeSkipReason,
  turnId?: string
): HookExecutedEnvelope | null {
  const cfg = getHookLoggingConfig()
  // Skipped rows are diagnostic-only — too noisy to show by default.
  if (!cfg.enabled || !cfg.diagnostic) return null
  return redactLogValue(buildSkippedEnvelope(event, hook, reason, turnId)) as HookExecutedEnvelope
}

export function persistHookRecordOnce(envelope: HookExecutedEnvelope): void {
  persistHookExecutionRecord(envelope)
}

export function persistHookResultRecord(
  event: HookEvent,
  hook: HookConfig,
  result: HookResult,
  turnId?: string
): void {
  // Short-circuit before building the (untruncated) envelope: disk persistence
  // only happens in diagnostic mode, and the full JSON.stringify isn't free.
  // Without this gate, "Hook logging enabled, diagnostic off" still paid the
  // full serialization cost on every hook fire.
  const cfg = getHookLoggingConfig()
  if (!cfg.enabled || !cfg.diagnostic) return
  const envelope = buildPersistedHookResultRecord(event, hook, result, turnId)
  if (!envelope) return
  persistHookRecordOnce(envelope)
}

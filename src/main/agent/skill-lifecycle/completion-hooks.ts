import { runHooksEnriched } from "../../hooks/required-skill"
import type { HookContext, HookResultCallback } from "../../hooks/runner"
import {
  resolveEnabledHooksForRun,
  type HookScopeController,
  type ScopeSkipCallback
} from "../../hooks/scope"
import type { HookConfig, HookEvent, HookResult } from "../../hooks/types"
import type { SkillUseTracker } from "./tracker"

export type StopHookContext = NonNullable<HookContext["stopContext"]>

type HookExecutor = (
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext,
  onHookResult?: HookResultCallback
) => Promise<HookResult | null>

export function getCompletionHookBlockReason(
  result: HookResult,
  fallback = "Completion hook requested revision"
): string {
  return result.reason || result.stopReason || result.stdout || result.stderr || fallback
}

export function getCompletionHookStopReason(
  result: HookResult,
  fallback = "Completion hook stopped the turn"
): string {
  return result.stopReason || result.reason || result.stdout || result.stderr || fallback
}

/**
 * `continue: false` halts the turn immediately — no revision, no error.
 * Aligns with Claude Code's `preventContinuation` semantics.
 *
 * Plain boolean (not a type guard) so the two helpers compose cleanly across
 * `else if` — declaring `is HookResult` for both makes TS infer `never` in the
 * else branch when the input is already typed as HookResult.
 * Callers should narrow nullability themselves: `r && shouldPreventContinuation(r)`.
 */
export function shouldPreventContinuation(result: HookResult): boolean {
  return result.continue === false
}

/**
 * `decision: "block"` (or exit-code-2 `blocked`) requests a revision — the
 * agent reruns with the hook's reason fed back.
 * Mutually exclusive with `shouldPreventContinuation` at runtime: prevent wins.
 */
export function shouldRequestRevision(result: HookResult): boolean {
  return result.continue !== false && (result.decision === "block" || result.blocked === true)
}

/** Outcome of the completion-hook orchestration loop. */
export type CompletionHookOutcome =
  /** Stop hooks didn't block — turn finished normally. */
  | "passed"
  /** A completion hook returned `continue: false` — turn ended deliberately. */
  | "halted"
  /** Revision retries exhausted — treat as error. */
  | "failed"

export function buildCompletionRevisionPrompt({
  result,
  attempt,
  maxRevisionAttempts,
  hookLabel,
  revisionPromptPrefix
}: {
  result: HookResult
  attempt: number
  maxRevisionAttempts: number
  hookLabel: string
  revisionPromptPrefix: string
}): string {
  const parts = [
    `${revisionPromptPrefix} Internal revision request. Do not mention this marker.`,
    "A completion hook reviewed your previous response and requested a revision.",
    "Revise the work now. Address the issue directly, run any checks that are needed, and then provide an updated final answer.",
    `Revision attempt: ${attempt}/${maxRevisionAttempts}`,
    `Hook type: ${hookLabel}`,
    `Hook reason:\n${getCompletionHookBlockReason(result)}`
  ]
  if (result.additionalContext) {
    parts.push(`Additional hook context:\n${result.additionalContext}`)
  }
  if (result.systemMessage) {
    parts.push(`Hook message:\n${result.systemMessage}`)
  }
  return parts.join("\n\n")
}

export function mergePostSkillUseResults(results: HookResult[]): HookResult | null {
  if (results.length === 0) return null

  const contexts: string[] = []
  const messages: string[] = []
  const revisionReasons: string[] = []
  const stopReasons: string[] = []

  for (const result of results) {
    if (shouldPreventContinuation(result)) {
      stopReasons.push(getCompletionHookStopReason(result, "PostSkillUse hook stopped the turn"))
      if (result.additionalContext) contexts.push(result.additionalContext)
      if (result.systemMessage) messages.push(result.systemMessage)
    } else if (shouldRequestRevision(result)) {
      revisionReasons.push(
        getCompletionHookBlockReason(result, "PostSkillUse hook requested revision")
      )
      if (result.additionalContext) contexts.push(result.additionalContext)
      if (result.systemMessage) messages.push(result.systemMessage)
    }
    // Non-blocking hook output stays observable-only via onHookResult callbacks — do not
    // surface it through the completion result, matching existing PostSkillUse semantics.
  }

  if (stopReasons.length === 0 && revisionReasons.length === 0) return null

  // Any single hook requesting halt wins over revision — match CC's preventContinuation priority.
  const halt = stopReasons.length > 0
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: !halt && revisionReasons.length > 0,
    continue: halt ? false : undefined,
    stopReason: halt ? stopReasons.join("\n") : undefined,
    decision: halt ? undefined : revisionReasons.length > 0 ? "block" : undefined,
    reason: halt ? undefined : revisionReasons.length > 0 ? revisionReasons.join("\n") : undefined,
    additionalContext: contexts.length > 0 ? contexts.join("\n") : undefined,
    systemMessage: messages.length > 0 ? messages.join("\n") : undefined
  }
}

export async function runPostSkillUseHooksForActivatedSkills({
  threadId,
  workspacePath,
  turnId,
  pluginOutputDir,
  getStopContext,
  hookScope,
  skillUseTracker,
  onHookResult,
  onHookSkippedFactory,
  executeHooks = runHooksEnriched,
  resolveHooks
}: {
  threadId: string
  workspacePath?: string
  turnId?: string
  pluginOutputDir?: string
  getStopContext: () => StopHookContext
  hookScope: HookScopeController
  skillUseTracker?: SkillUseTracker
  onHookResult?: HookResultCallback
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback | undefined
  executeHooks?: HookExecutor
  resolveHooks?: (event: HookEvent, context: HookContext) => HookConfig[]
}): Promise<HookResult | null> {
  const pending = skillUseTracker?.getPendingPostSkillUses() ?? []
  if (pending.length === 0) return null

  const results: HookResult[] = []
  for (const skill of pending) {
    const context: HookContext = {
      toolName: skill.triggerToolName,
      toolArgs: {
        trigger: skill.trigger,
        skillName: skill.name,
        skillPath: skill.path
      },
      workspacePath,
      pluginOutputDir,
      sessionId: threadId,
      turnId,
      skillName: skill.name,
      skillPath: skill.path,
      skillRoot: skill.rootDir,
      pluginId: skill.pluginId,
      pluginName: skill.pluginName,
      pluginRoot: skill.pluginRoot,
      skillTriggerToolName: skill.triggerToolName,
      stopContext: getStopContext()
    }

    try {
      const hooks = resolveHooks
        ? resolveHooks("PostSkillUse", context)
        : resolveEnabledHooksForRun(
            workspacePath,
            "PostSkillUse",
            context,
            hookScope,
            onHookSkippedFactory?.("PostSkillUse")
          )
      const result = await executeHooks(hooks, "PostSkillUse", context, onHookResult)
      if (result) results.push(result)
    } catch (e) {
      console.warn(`[Hooks] PostSkillUse hook error for skill "${skill.name}":`, e)
    } finally {
      skillUseTracker?.markPostSkillUseFired(skill.key)
    }
  }

  return mergePostSkillUseResults(results)
}

export async function runCompletionHooksWithRevision({
  threadId,
  workspacePath,
  turnId,
  pluginOutputDir,
  abortSignal,
  getStopContext,
  hookScope,
  skillUseTracker,
  runRevision,
  sendNotice,
  sendError,
  onHookResult,
  onHookSkippedFactory,
  maxRevisionAttempts,
  revisionPromptPrefix,
  runPostSkillUseHooks,
  runStopHooks
}: {
  threadId: string
  workspacePath?: string
  turnId?: string
  pluginOutputDir?: string
  abortSignal: AbortSignal
  getStopContext: () => StopHookContext
  hookScope: HookScopeController
  skillUseTracker?: SkillUseTracker
  runRevision: (prompt: string) => Promise<void>
  sendNotice: (message: string) => void
  sendError: (message: string) => void
  onHookResult?: HookResultCallback
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback | undefined
  maxRevisionAttempts: number
  revisionPromptPrefix: string
  runPostSkillUseHooks?: () => Promise<HookResult | null>
  runStopHooks?: () => Promise<HookResult | null>
}): Promise<CompletionHookOutcome> {
  let postSkillRevisionCount = 0
  let stopRevisionCount = 0
  while (!abortSignal.aborted) {
    const postSkillResult = await (runPostSkillUseHooks
      ? runPostSkillUseHooks()
      : runPostSkillUseHooksForActivatedSkills({
          threadId,
          workspacePath,
          turnId,
          pluginOutputDir,
          getStopContext,
          hookScope,
          skillUseTracker,
          onHookResult,
          onHookSkippedFactory
        }))

    // continue:false short-circuits — halt the turn immediately, no revision.
    if (postSkillResult && shouldPreventContinuation(postSkillResult)) {
      if (postSkillResult.systemMessage) sendNotice(postSkillResult.systemMessage)
      const reason = getCompletionHookStopReason(
        postSkillResult,
        "PostSkillUse hook stopped the turn"
      )
      sendNotice(`PostSkillUse hook stopped the turn: ${reason}`)
      return "halted"
    }

    if (postSkillResult && shouldRequestRevision(postSkillResult)) {
      if (postSkillResult.systemMessage) sendNotice(postSkillResult.systemMessage)
      const reason = getCompletionHookBlockReason(
        postSkillResult,
        "PostSkillUse hook requested revision"
      )
      if (postSkillRevisionCount >= maxRevisionAttempts) {
        sendError(
          `PostSkillUse hook blocked completion after ${maxRevisionAttempts} revision attempts: ${reason}`
        )
        return "failed"
      }

      postSkillRevisionCount += 1
      sendNotice(
        `PostSkillUse hook requested revision (${postSkillRevisionCount}/${maxRevisionAttempts}): ${reason}`
      )
      await runRevision(
        buildCompletionRevisionPrompt({
          result: postSkillResult,
          attempt: postSkillRevisionCount,
          maxRevisionAttempts,
          hookLabel: "PostSkillUse",
          revisionPromptPrefix
        })
      )
      continue
    }

    const stopResult = await (runStopHooks
      ? runStopHooks()
      : runHooksEnriched(
          resolveEnabledHooksForRun(
            workspacePath,
            "Stop",
            {
              workspacePath,
              pluginOutputDir,
              sessionId: threadId,
              turnId,
              stopContext: getStopContext()
            },
            hookScope,
            onHookSkippedFactory?.("Stop")
          ),
          "Stop",
          {
            workspacePath,
            pluginOutputDir,
            sessionId: threadId,
            turnId,
            stopContext: getStopContext()
          },
          onHookResult
        ).catch((e) => {
          console.warn("[Hooks] Stop hook error:", e)
          return null
        }))

    if (stopResult && shouldPreventContinuation(stopResult)) {
      if (stopResult.systemMessage) sendNotice(stopResult.systemMessage)
      const reason = getCompletionHookStopReason(stopResult, "Stop hook stopped the turn")
      sendNotice(`Stop hook stopped the turn: ${reason}`)
      return "halted"
    }

    if (!stopResult || !shouldRequestRevision(stopResult)) return "passed"
    if (stopResult.systemMessage) sendNotice(stopResult.systemMessage)

    const reason = getCompletionHookBlockReason(stopResult, "Stop hook requested revision")
    if (stopRevisionCount >= maxRevisionAttempts) {
      sendError(
        `Stop hook blocked completion after ${maxRevisionAttempts} revision attempts: ${reason}`
      )
      return "failed"
    }

    stopRevisionCount += 1
    sendNotice(
      `Stop hook requested revision (${stopRevisionCount}/${maxRevisionAttempts}): ${reason}`
    )
    await runRevision(
      buildCompletionRevisionPrompt({
        result: stopResult,
        attempt: stopRevisionCount,
        maxRevisionAttempts,
        hookLabel: "Stop",
        revisionPromptPrefix
      })
    )
  }
  return "failed"
}

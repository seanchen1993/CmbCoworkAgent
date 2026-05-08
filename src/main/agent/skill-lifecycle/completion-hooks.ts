import { runHooksEnriched } from "../../hooks/required-skill"
import type { HookContext, HookResultCallback } from "../../hooks/runner"
import { resolveEnabledHooksForRun, type HookScopeController } from "../../hooks/scope"
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

export function isCompletionHookBlocking(
  result: HookResult | null | undefined
): result is HookResult {
  return Boolean(
    result && (result.decision === "block" || result.blocked || result.continue === false)
  )
}

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
  const blockReasons: string[] = []

  for (const result of results) {
    if (!isCompletionHookBlocking(result)) continue
    blockReasons.push(getCompletionHookBlockReason(result, "PostSkillUse hook requested revision"))
    if (result.additionalContext) contexts.push(result.additionalContext)
    if (result.systemMessage) messages.push(result.systemMessage)
  }

  if (blockReasons.length === 0) return null

  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: true,
    continue: false,
    decision: "block",
    reason: blockReasons.join("\n"),
    additionalContext: contexts.length > 0 ? contexts.join("\n") : undefined,
    systemMessage: messages.length > 0 ? messages.join("\n") : undefined
  }
}

export async function runPostSkillUseHooksForActivatedSkills({
  threadId,
  workspacePath,
  getStopContext,
  hookScope,
  skillUseTracker,
  onHookResult,
  executeHooks = runHooksEnriched,
  resolveHooks
}: {
  threadId: string
  workspacePath?: string
  getStopContext: () => StopHookContext
  hookScope: HookScopeController
  skillUseTracker?: SkillUseTracker
  onHookResult?: HookResultCallback
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
      sessionId: threadId,
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
        : resolveEnabledHooksForRun(workspacePath, "PostSkillUse", context, hookScope)
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
  abortSignal,
  getStopContext,
  hookScope,
  skillUseTracker,
  runRevision,
  sendNotice,
  sendError,
  onHookResult,
  maxRevisionAttempts,
  revisionPromptPrefix,
  runPostSkillUseHooks,
  runStopHooks
}: {
  threadId: string
  workspacePath?: string
  abortSignal: AbortSignal
  getStopContext: () => StopHookContext
  hookScope: HookScopeController
  skillUseTracker?: SkillUseTracker
  runRevision: (prompt: string) => Promise<void>
  sendNotice: (message: string) => void
  sendError: (message: string) => void
  onHookResult?: HookResultCallback
  maxRevisionAttempts: number
  revisionPromptPrefix: string
  runPostSkillUseHooks?: () => Promise<HookResult | null>
  runStopHooks?: () => Promise<HookResult | null>
}): Promise<boolean> {
  let postSkillRevisionCount = 0
  let stopRevisionCount = 0
  while (!abortSignal.aborted) {
    const postSkillResult = await (runPostSkillUseHooks
      ? runPostSkillUseHooks()
      : runPostSkillUseHooksForActivatedSkills({
          threadId,
          workspacePath,
          getStopContext,
          hookScope,
          skillUseTracker,
          onHookResult
        }))
    if (isCompletionHookBlocking(postSkillResult)) {
      if (postSkillResult.systemMessage) sendNotice(postSkillResult.systemMessage)
      const reason = getCompletionHookBlockReason(
        postSkillResult,
        "PostSkillUse hook requested revision"
      )
      if (postSkillRevisionCount >= maxRevisionAttempts) {
        sendError(
          `PostSkillUse hook blocked completion after ${maxRevisionAttempts} revision attempts: ${reason}`
        )
        return false
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
              sessionId: threadId,
              stopContext: getStopContext()
            },
            hookScope
          ),
          "Stop",
          {
            workspacePath,
            sessionId: threadId,
            stopContext: getStopContext()
          },
          onHookResult
        ).catch((e) => {
          console.warn("[Hooks] Stop hook error:", e)
          return null
        }))

    if (!isCompletionHookBlocking(stopResult)) return true
    if (stopResult.systemMessage) sendNotice(stopResult.systemMessage)

    const reason = getCompletionHookBlockReason(stopResult, "Stop hook requested revision")
    if (stopRevisionCount >= maxRevisionAttempts) {
      sendError(
        `Stop hook blocked completion after ${maxRevisionAttempts} revision attempts: ${reason}`
      )
      return false
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
  return false
}

import {
  getCompletionHookBlockReason,
  getCompletionHookStopReason,
  shouldPreventContinuation,
  shouldRequestRevision,
  buildCompletionRevisionPrompt,
  mergePostSkillUseResults,
  type CompletionHookOutcome
} from "./completion-policy"
export * from "./completion-policy"

import { runHooksEnriched } from "../../hooks/required-skill"
import type { HookContext, HookResultCallback } from "../../hooks/runner"
import {
  resolveEnabledHooksForRun,
  type HookScopeController,
  type ScopeSkipCallback
} from "../../hooks/scope"
import type { HookConfig, HookEvent, HookResult } from "../../hooks/types"
import type { SkillUseTracker } from "./tracker"
import { markHarnessStageAttributionDirty } from "../../services/harness-stage-attribution"

export type StopHookContext = NonNullable<HookContext["stopContext"]>

type HookExecutor = (
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext,
  onHookResult?: HookResultCallback
) => Promise<HookResult | null>

export async function runPostSkillUseHooksForActivatedSkills({
  threadId,
  workspacePath,
  turnId,
  pluginOutputDir,
  systemId,
  pluginWorkspace,
  featureId,
  harnessProjectId,
  harnessAdapterId,
  harnessAdapterName,
  harnessAdapterVersion,
  harnessNodeName,
  harnessNodeStatus,
  projectCode,
  projectDir,
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
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
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
      systemId,
      pluginWorkspace,
      featureId,
      harnessProjectId,
      harnessAdapterId,
      harnessAdapterName,
      harnessAdapterVersion,
      harnessNodeName,
      harnessNodeStatus,
      projectCode,
      projectDir,
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
  systemId,
  pluginWorkspace,
  featureId,
  harnessProjectId,
  harnessAdapterId,
  harnessAdapterName,
  harnessAdapterVersion,
  harnessNodeName,
  harnessNodeStatus,
  projectCode,
  projectDir,
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
  runStopHooks,
  onStopHooksFired,
  hasTerminalModelRefusal
}: {
  threadId: string
  workspacePath?: string
  turnId?: string
  pluginOutputDir?: string
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
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
  onStopHooksFired?: () => void
  hasTerminalModelRefusal?: () => boolean
}): Promise<CompletionHookOutcome> {
  let postSkillRevisionCount = 0
  let stopRevisionCount = 0
  while (!abortSignal.aborted) {
    // A provider terminal is not a completion defect to revise. The transport
    // records the refusal separately; no hook may automatically restart it.
    if (hasTerminalModelRefusal?.()) return "passed"
    const postSkillResult = await (runPostSkillUseHooks
      ? runPostSkillUseHooks()
      : runPostSkillUseHooksForActivatedSkills({
          threadId,
          workspacePath,
          turnId,
          pluginOutputDir,
          systemId,
          pluginWorkspace,
          featureId,
          harnessProjectId,
          harnessAdapterId,
          harnessAdapterName,
          harnessAdapterVersion,
          harnessNodeName,
          harnessNodeStatus,
          projectCode,
          projectDir,
          getStopContext,
          hookScope,
          skillUseTracker,
          onHookResult,
          onHookSkippedFactory
        }))
    markHarnessStageAttributionDirty(harnessProjectId, featureId)

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

    onStopHooksFired?.()
    const stopResult = await (runStopHooks
      ? runStopHooks()
      : runHooksEnriched(
          resolveEnabledHooksForRun(
            workspacePath,
            "Stop",
            {
              workspacePath,
              pluginOutputDir,
              systemId,
              pluginWorkspace,
              featureId,
              harnessProjectId,
              harnessAdapterId,
              harnessAdapterName,
              harnessAdapterVersion,
              harnessNodeName,
              harnessNodeStatus,
              projectCode,
              projectDir,
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
            systemId,
            pluginWorkspace,
            featureId,
            harnessProjectId,
            harnessAdapterId,
            harnessAdapterName,
            harnessAdapterVersion,
            harnessNodeName,
            harnessNodeStatus,
            projectCode,
            projectDir,
            sessionId: threadId,
            turnId,
            stopContext: getStopContext()
          },
          onHookResult
        ).catch((e) => {
          console.warn("[Hooks] Stop hook error:", e)
          return null
        }))
    markHarnessStageAttributionDirty(harnessProjectId, featureId)

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

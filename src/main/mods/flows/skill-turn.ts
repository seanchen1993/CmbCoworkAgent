import {
  prepareStandardUserPrompt,
  getHarnessHookContext,
  type HarnessAgentContext,
  type PromptPreparationTurnState
} from "../../agent/standard-thread-turn"
import { createSkillUseTracker } from "../../agent/skill-lifecycle/tracker"
import {
  getCompletionHookBlockReason,
  getCompletionHookStopReason,
  runPostSkillUseHooksForActivatedSkills,
  shouldPreventContinuation,
  shouldRequestRevision
} from "../../agent/skill-lifecycle/completion-hooks"
import { createHookScope, type ScopeSkipCallback } from "../../hooks/scope"
import type { HookResultCallback } from "../../hooks/runner"
import type { HookEvent } from "../../hooks/types"
import type { WorkflowSubagentRuntime } from "../../agent/workflow/subagent"
import type { ResolvedFlowSkillSource } from "../claw-skills"

export interface FlowSkillTurn {
  turnState: PromptPreparationTurnState
  preparePrompt: NonNullable<WorkflowSubagentRuntime["preparePrompt"]>
  completeTurn: NonNullable<WorkflowSubagentRuntime["completeTurn"]>
  assertCurrent(): void
}

/** One host-owned child turn shares activation state with the real filesystem/runtime. */
export function createFlowSkillTurn(options: {
  source?: ResolvedFlowSkillSource
  harnessContext?: HarnessAgentContext
  threadId: string
  agentId?: string
  workspacePath: string
  signal: AbortSignal
  assertLive(): void
  onHookResult?: HookResultCallback
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback
}): FlowSkillTurn {
  const turnState: PromptPreparationTurnState = {
    hookScope: createHookScope(),
    skillUseTracker: createSkillUseTracker(),
    skillHookKeys: new Set(),
    turnId: options.threadId
  }
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertLive()
    options.source?.assertCurrent()
  }
  let prepared = false
  let preparing = false
  let completed = false
  let rawMessage = ""
  const onHookResult = options.onHookResult ?? (() => {})
  const onHookSkippedFactory = options.onHookSkippedFactory ?? (() => () => {})
  return {
    turnState,
    assertCurrent,
    async preparePrompt(prompt) {
      assertCurrent()
      if (prepared || preparing) throw Error("FLOW_SKILL_TURN_ALREADY_PREPARED")
      preparing = true
      rawMessage = prompt
      try {
        const result = await prepareStandardUserPrompt({
          signal: options.signal,
          rawMessage: prompt,
          initialModelInput: prompt,
          trustedExplicitSkill: options.source?.trustedExplicitSkill,
          allowExplicitSkillFromMessage: false,
          threadId: options.threadId,
          agentId: options.agentId,
          workspacePath: options.workspacePath,
          turnState,
          harnessAgentContext: { ...options.harnessContext, managedExecution: true },
          onHookResult,
          onHookSkippedFactory,
          isPreparationCurrent: () => {
            try {
              assertCurrent()
              return true
            } catch {
              return false
            }
          }
        })
        assertCurrent()
        if (!result.accepted) throw Error(`FLOW_SKILL_PREPARATION_BLOCKED: ${result.reason}`)
        prepared = true
        return result.content
      } finally {
        preparing = false
      }
    },
    async completeTurn(result) {
      assertCurrent()
      if (!prepared) throw Error("FLOW_SKILL_TURN_NOT_PREPARED")
      if (completed) throw Error("FLOW_SKILL_TURN_ALREADY_COMPLETED")
      // No implicit business retry: a completion veto fails this flow attempt.
      completed = true
      const hookResult = await runPostSkillUseHooksForActivatedSkills({
        signal: options.signal,
        threadId: options.threadId,
        agentId: options.agentId,
        turnId: options.threadId,
        workspacePath: options.workspacePath,
        pluginOutputDir: options.harnessContext?.pluginOutputDir,
        systemId: options.harnessContext?.systemId,
        ...getHarnessHookContext(options.harnessContext ?? {}),
        hookScope: turnState.hookScope,
        skillUseTracker: turnState.skillUseTracker,
        onHookResult,
        onHookSkippedFactory,
        getStopContext: () => ({
          userMessage: rawMessage,
          assistantResponse: result.text,
          usedSkills: turnState.skillUseTracker.getUsedSkillNames()
        })
      })
      assertCurrent()
      if (hookResult && shouldPreventContinuation(hookResult))
        throw Error(`FLOW_SKILL_COMPLETION_STOPPED: ${getCompletionHookStopReason(hookResult)}`)
      if (hookResult && shouldRequestRevision(hookResult))
        throw Error(`FLOW_SKILL_COMPLETION_BLOCKED: ${getCompletionHookBlockReason(hookResult)}`)
    }
  }
}

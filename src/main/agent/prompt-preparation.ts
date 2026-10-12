import type { HookResult } from "../hooks/types"
import {
  applyPromptRewritePreservingGoalMarker,
  buildInternalGoalPromptFromHookResult
} from "./goals/internal-prompt"
import { parseSkillUseBlock } from "./skill-lifecycle/marker"

export type PreparedUserPrompt =
  | {
      accepted: true
      content: string
      explicitSkillHookContext?: string
    }
  | {
      accepted: false
      blockedBy: "explicit_skill"
      reason: string
    }
  | {
      accepted: false
      blockedBy: "user_prompt_submit"
      reason: string
      hookResult: HookResult
    }
  | {
      accepted: false
      blockedBy: "run_not_ready"
      reason: string
    }

/** The transport resolves identities and permissions. This shared sequencing
 * layer does not discover desktop settings, execute a shell, or trust markers
 * found in user text. The existing desktop adapter supplies its actual Hooks. */
export interface PromptSkillActivation<Skill> {
  parsed?: { block: string }
  skill?: Skill
  hookContext?: string
  blocked: boolean
  reason?: string
}

export interface PromptPreparationOptions<Skill> {
  rawMessage: string
  initialModelInput: string
  activateExplicitSkill?: () => Promise<PromptSkillActivation<Skill> | null | undefined>
  /** Omitted only when this transport has no configured submit handlers. */
  submit?: (hookVisibleMessage: string) => Promise<HookResult | null>
  /** Rebuild transport-owned context around a rewritten task body. The default
   * preserves desktop goal markers; internal goal envelopes always stay immutable. */
  rewriteModelInput?: (message: string) => string | Promise<string>
  isPreparationCurrent?: () => boolean
  onExplicitSkillActivated?: (skill: Skill) => void
  onSystemMessage?: (message: string) => void
}

export async function prepareUserPromptCore<Skill>(
  options: PromptPreparationOptions<Skill>
): Promise<PreparedUserPrompt> {
  const { rawMessage, initialModelInput, isPreparationCurrent } = options
  const stale = (): PreparedUserPrompt => ({
    accepted: false,
    blockedBy: "run_not_ready",
    reason: "当前运行已结束或被替换"
  })
  if (isPreparationCurrent && !isPreparationCurrent()) return stale()
  const explicitSkillActivation = await options.activateExplicitSkill?.()
  if (isPreparationCurrent && !isPreparationCurrent()) return stale()
  if (explicitSkillActivation?.blocked) {
    return {
      accepted: false,
      blockedBy: "explicit_skill",
      reason: explicitSkillActivation.reason || "显式选择的技能被 Hook 拦截"
    }
  }
  const isInternalGoalModelInput =
    initialModelInput.startsWith("[Starting active goal]") ||
    initialModelInput.startsWith("[Continuing active goal]")
  const hookVisibleMessage = isInternalGoalModelInput ? initialModelInput : rawMessage
  const promptSubmitResult = await options.submit?.(hookVisibleMessage)
  if (isPreparationCurrent && !isPreparationCurrent()) return stale()
  if (promptSubmitResult?.blocked || promptSubmitResult?.continue === false) {
    return {
      accepted: false,
      blockedBy: "user_prompt_submit",
      reason:
        promptSubmitResult.stopReason ||
        promptSubmitResult.reason ||
        promptSubmitResult.stderr ||
        promptSubmitResult.stdout ||
        "消息被 Hook 策略拦截",
      hookResult: promptSubmitResult
    }
  }
  let preparedMessage = initialModelInput
  const updatedMessage =
    promptSubmitResult?.updatedInput?.message ??
    promptSubmitResult?.updatedInput?.prompt ??
    promptSubmitResult?.updatedInput?.userPrompt
  if (isInternalGoalModelInput) {
    preparedMessage = buildInternalGoalPromptFromHookResult(initialModelInput, {
      updatedInput: promptSubmitResult?.updatedInput,
      additionalContexts: [
        explicitSkillActivation?.hookContext,
        promptSubmitResult?.additionalContext
      ]
    })
  } else if (typeof updatedMessage === "string" && updatedMessage.length > 0) {
    preparedMessage = options.rewriteModelInput
      ? await options.rewriteModelInput(updatedMessage)
      : applyPromptRewritePreservingGoalMarker(initialModelInput, updatedMessage)
    if (isPreparationCurrent && !isPreparationCurrent()) return stale()
  }
  if (
    !isInternalGoalModelInput &&
    explicitSkillActivation?.parsed &&
    !parseSkillUseBlock(preparedMessage)
  ) {
    preparedMessage = [preparedMessage.trimEnd(), explicitSkillActivation.parsed.block]
      .filter(Boolean)
      .join("\n\n")
  }
  const promptContextBlocks = [
    explicitSkillActivation?.hookContext,
    promptSubmitResult?.additionalContext
  ].filter((item): item is string => Boolean(item?.trim()))
  if (!isInternalGoalModelInput && promptContextBlocks.length > 0) {
    preparedMessage = `${promptContextBlocks.join("\n\n")}\n\n${preparedMessage}`
  }
  if (promptSubmitResult?.systemMessage) options.onSystemMessage?.(promptSubmitResult.systemMessage)
  if (explicitSkillActivation?.skill)
    options.onExplicitSkillActivated?.(explicitSkillActivation.skill)
  return {
    accepted: true,
    content: preparedMessage,
    explicitSkillHookContext: explicitSkillActivation?.hookContext
  }
}

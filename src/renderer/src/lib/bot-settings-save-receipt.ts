import type { BotApprovalRuleChange, BotApprovalRules } from "../../../shared/bot-approval-rules"
import type { BotAutoReviewChange, BotAutoReviewSettings } from "../../../shared/bot-auto-review"
import { normalizeSandAutoReviewInstructions } from "../../../shared/bot-auto-review-instructions"

export function matchesApprovalRuleReceipt(
  input: BotApprovalRuleChange,
  result: BotApprovalRules
): boolean {
  if (
    !result ||
    result.botId !== input.botId ||
    result.dataEpoch !== input.dataEpoch ||
    result.revision !== input.revision + 1 ||
    !Array.isArray(result.rules)
  )
    return false
  const changed = result.rules.filter((rule) => rule.id === input.ruleId)
  return input.behavior === null
    ? changed.length === 0
    : changed.length === 1 && changed[0].behavior === input.behavior
}
export function matchesAutoReviewReceipt(
  input: BotAutoReviewChange,
  result: BotAutoReviewSettings
): boolean {
  if (
    !result ||
    result.botId !== input.botId ||
    result.dataEpoch !== input.dataEpoch ||
    result.revision !== input.revision + 1
  )
    return false
  const policy = normalizeSandAutoReviewInstructions(input)
  return (
    result.isEnabled === policy.isEnabled &&
    JSON.stringify(result.allowInstructions) === JSON.stringify(policy.allowInstructions) &&
    JSON.stringify(result.blockInstructions) === JSON.stringify(policy.blockInstructions)
  )
}

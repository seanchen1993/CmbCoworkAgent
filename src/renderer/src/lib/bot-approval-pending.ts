import { botApprovalRuleChange } from "../../../shared/bot-approval-rules"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

export const createPendingApprovalRuleStore = (storage?: () => PendingSaveStorage) =>
  createFlatSettingsPending({
    input: botApprovalRuleChange,
    key: (botId) => `cmb:bot-approval-rule:pending:${botId}`,
    maxCharacters: 4096,
    storageMessage: "无法保存操作记录，审批规则尚未修改。",
    storage
  })
export const pendingApprovalRuleStore = createPendingApprovalRuleStore()
export const inspectPendingApprovalRule = pendingApprovalRuleStore.inspect
export const readPendingApprovalRule = pendingApprovalRuleStore.read
export const rememberPendingApprovalRule = pendingApprovalRuleStore.remember
export const acknowledgePendingApprovalRule = pendingApprovalRuleStore.acknowledge
export const discardPendingApprovalRule = pendingApprovalRuleStore.discard

import { botUsageBudgetChange } from "../../../shared/bot-usage-budget"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

export const createPendingBotBudgetStore = (storage?: () => PendingSaveStorage) =>
  createFlatSettingsPending({
    input: botUsageBudgetChange,
    key: (botId) => `cmb:bot-budget:pending:${botId ?? "user"}`,
    maxCharacters: 2048,
    storageMessage: "无法保存操作记录，额度尚未修改。",
    storage
  })
export const pendingBotBudgetStore = createPendingBotBudgetStore()
export const inspectPendingBotBudget = pendingBotBudgetStore.inspect
export const readPendingBotBudget = pendingBotBudgetStore.read
export const rememberPendingBotBudget = pendingBotBudgetStore.remember
export const acknowledgePendingBotBudget = pendingBotBudgetStore.acknowledge
export const discardPendingBotBudget = pendingBotBudgetStore.discard

import { z } from "zod"
import { createProtectedSavePending } from "./bot-protected-save-pending"
import {
  botPluginPaneAction,
  botPluginSessionKey,
  type BotPluginPaneAction,
  type BotPluginPaneAddress
} from "../../../shared/bot-plugin-panes"

const record = z.object({ dataEpoch: z.string(), input: botPluginPaneAction }).strict()
const key = (input: BotPluginPaneAddress) => `bot-plugin-pane-pending:${botPluginSessionKey(input)}`

const pending = createProtectedSavePending<BotPluginPaneAction>({
  record: record as z.ZodType<{
    dataEpoch: string
    input: BotPluginPaneAction
  }>,
  input: botPluginPaneAction as z.ZodType<BotPluginPaneAction>,
  key: (input) => key(input),
  maxCharacters: 220_000,
  oversizeMessage: "插件操作记录过大，本次操作尚未提交。请缩短输入内容。",
  storageMessage: "无法保留插件操作记录，请恢复应用存储访问后重试。本次操作尚未提交。"
})

export function inspectPendingPluginPane(input: BotPluginPaneAddress, dataEpoch: string) {
  const value = pending.inspect(key(input), dataEpoch)
  if ((value.kind === "valid" || value.kind === "obsolete") && key(value.input) !== key(input))
    return { kind: "corrupt" as const, raw: value.raw }
  return value
}

export function readPendingPluginPane(
  input: BotPluginPaneAddress,
  dataEpoch: string
): BotPluginPaneAction | null {
  const value = inspectPendingPluginPane(input, dataEpoch)
  return value.kind === "valid" ? value.input : null
}

export function rememberPendingPluginPane(input: BotPluginPaneAction, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}

export function acknowledgePendingPluginPane(
  input: BotPluginPaneAction,
  dataEpoch: string
): boolean {
  return pending.acknowledge(input, dataEpoch)
}

export function discardPendingPluginPane(
  input: BotPluginPaneAddress,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(input), dataEpoch, raw)
}

import { z } from "zod"
import {
  botPrimaryChange,
  botPrimaryEnsure,
  botPrimaryCheckInChange,
  type BotPrimaryState
} from "../../../shared/bot-primary"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import { botApi } from "./bot-api"
import { useBotWorkspaceStore } from "./bot-workspace-store"

// The settings scope is the workspace, while the selected Bot is part of the request.
export const botPrimarySettingsInput = z
  .object({
    botId: z.null(),
    revision: z.number().int().nonnegative(),
    dataEpoch: z.string().min(1).max(160),
    nonce: z.string().min(1).max(160),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("change"), targetBotId: botPrimaryChange.shape.botId }).strict(),
      z
        .object({
          kind: z.literal("ensure"),
          profile: botPrimaryEnsure.shape.profile,
          introduction: botPrimaryEnsure.shape.introduction
        })
        .strict(),
      z
        .object({
          kind: z.literal("checkIn"),
          settings: botPrimaryCheckInChange.omit({
            nonce: true,
            dataEpoch: true,
            primaryRevision: true
          })
        })
        .strict()
    ])
  })
  .strict()
export type BotPrimarySettingsInput = z.infer<typeof botPrimarySettingsInput>
export interface BotPrimarySettingsView {
  botId: null
  revision: number
  dataEpoch: string
  primary: BotPrimaryState
}
export const pendingBotPrimarySettings = createFlatSettingsPending({
  input: botPrimarySettingsInput,
  key: () => "cmb:bot-primary:pending:workspace",
  maxCharacters: 48_000,
  storageMessage: "无法保存操作记录，主 Bot 设置尚未修改。"
})
export function primarySettingsView(primary: BotPrimaryState): BotPrimarySettingsView {
  return { botId: null, dataEpoch: primary.dataEpoch, revision: primary.revision, primary }
}
export async function readBotPrimarySettings(): Promise<BotPrimarySettingsView> {
  const state = await botApi.primaryBot()
  useBotWorkspaceStore.getState().applyPrimary(state)
  return primarySettingsView(state)
}
export async function changeBotPrimarySettings(input: BotPrimarySettingsInput) {
  const identity = { revision: input.revision, dataEpoch: input.dataEpoch, nonce: input.nonce }
  switch (input.action.kind) {
    case "change":
      return primarySettingsView(
        await botApi.changePrimaryBot({ ...identity, botId: input.action.targetBotId })
      )
    case "ensure": {
      if (
        input.action.profile.autoReviewEnabled !== undefined &&
        !useBotWorkspaceStore.getState().host?.capabilities?.includes("bot-create-review-v1")
      )
        throw new Error("这次创建包含操作审核设置，请连接支持此功能的后台后核对原请求。")
      const result = await botApi.ensurePrimaryBot({
        ...identity,
        profile: input.action.profile,
        ...(input.action.introduction ? { introduction: input.action.introduction } : {})
      })
      if (result.outcome === "tombstoned" || result.outcome === "botLimit") {
        const error = new Error(
          result.outcome === "tombstoned"
            ? "之前创建的主 Bot 已被删除，请选择现有 Bot。"
            : "Bot 数量已达上限，请选择现有 Bot。"
        ) as Error & { code: string }
        error.code = result.outcome === "tombstoned" ? "primary_tombstoned" : "bot_limit"
        throw error
      }
      return primarySettingsView(result.state)
    }
    case "checkIn":
      return primarySettingsView(
        await botApi.changePrimaryCheckIn({
          ...identity,
          ...input.action.settings,
          primaryRevision: input.revision
        })
      )
  }
}
export function verifiesBotPrimarySettings(
  input: BotPrimarySettingsInput,
  result: BotPrimarySettingsView
): boolean {
  const state = result.primary
  if (result.botId !== null || state.dataEpoch !== input.dataEpoch) return false
  switch (input.action.kind) {
    case "change":
      return (
        state.botId === input.action.targetBotId &&
        [input.revision, input.revision + 1].includes(state.revision)
      )
    case "ensure":
      return Boolean(state.botId) && [input.revision, input.revision + 1].includes(state.revision)
    case "checkIn": {
      const expected = input.action.settings,
        saved = state.checkIn
      return (
        state.revision === input.revision &&
        saved !== null &&
        saved.revision === expected.revision + 1 &&
        saved.botId === expected.botId &&
        saved.enabled === expected.enabled &&
        saved.prompt === expected.prompt.trim() &&
        saved.everyMs === expected.everyMs &&
        saved.timezone === expected.timezone &&
        saved.targetBotIds.length === expected.targetBotIds.length &&
        saved.targetBotIds.every((id) => expected.targetBotIds.includes(id))
      )
    }
  }
}

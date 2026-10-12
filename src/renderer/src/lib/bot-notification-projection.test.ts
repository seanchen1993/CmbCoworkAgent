import { expect, it } from "vitest"
import type { BotWorkspaceSnapshot, CoworkBot } from "../../../shared/bot-types"
import {
  applyBotNotificationSettingReceipt,
  mergeBotNotificationSettings
} from "./bot-notification-projection"

const bot: CoworkBot = {
  id: "13c4b921-51bd-4c16-8be7-957d090863a7",
  name: "Test",
  instructions: "",
  modelRef: null,
  workspacePath: null,
  revision: 1,
  hidden: false,
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null
}
const snapshot = (): BotWorkspaceSnapshot => ({
  dataEpoch: "test-epoch",
  cursor: 10,
  bots: [bot],
  conversations: [],
  runs: [],
  interactions: []
})

it("keeps an acknowledged first preference when an earlier snapshot had none", () => {
  const receipt = { botId: bot.id, revision: 1, enabled: false }
  const current = applyBotNotificationSettingReceipt(snapshot(), "test-epoch", receipt)
  expect(current?.cursor).toBe(10)
  expect(mergeBotNotificationSettings(current, snapshot())).toEqual([receipt])
})

it("does not roll back newer preferences using a stale receipt or poll", () => {
  const newest = { botId: bot.id, revision: 3, enabled: false }
  const current = { ...snapshot(), notificationSettings: [newest] }
  expect(
    applyBotNotificationSettingReceipt(current, "test-epoch", {
      ...newest,
      revision: 2,
      enabled: true
    })
  ).toBe(current)
  expect(
    mergeBotNotificationSettings(current, {
      ...snapshot(),
      notificationSettings: [{ ...newest, revision: 2, enabled: true }]
    })
  ).toEqual([newest])
})

it("retires old preference revisions after data restore and excludes deleted Bots", () => {
  const current = {
    ...snapshot(),
    notificationSettings: [{ botId: bot.id, revision: 3, enabled: false }]
  }
  const restored = {
    ...snapshot(),
    dataEpoch: "restored",
    notificationSettings: [{ botId: bot.id, revision: 1, enabled: true }]
  }
  expect(mergeBotNotificationSettings(current, restored)).toEqual(restored.notificationSettings)
  expect(
    applyBotNotificationSettingReceipt(restored, "test-epoch", current.notificationSettings[0])
  ).toBe(restored)
  expect(mergeBotNotificationSettings(current, { ...snapshot(), bots: [] })).toBeUndefined()
})

it("does not reintroduce a removed Bot using an old acknowledged mutation", () => {
  const current = { ...snapshot(), bots: [] }
  expect(
    applyBotNotificationSettingReceipt(current, "test-epoch", {
      botId: bot.id,
      revision: 1,
      enabled: false
    })
  ).toBe(current)
})

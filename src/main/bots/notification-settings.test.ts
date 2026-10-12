import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bot-notifications-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  return {
    get store() {
      return store
    },
    bot,
    conversationId,
    input: {
      botId: bot.id,
      dataEpoch: store.backupSchedule.epoch(),
      revision: 0,
      enabled: false,
      nonce: "mute"
    },
    reopen() {
      store.close()
      store = new BotStore(join(directory, "bots.sqlite"))
    }
  }
}
it("persists notification preferences and unknown-response receipts independently of active execution", () => {
  const f = fixture()
  f.store.send({ nonce: "task", conversationId: f.conversationId, text: "Work" })
  const run = f.store.claim("host")!
  const muted = f.store.notifications.change(f.input)
  expect(muted).toMatchObject({ enabled: false, revision: 1 })
  expect(f.store.getBot(f.bot.id).revision).toBe(f.bot.revision)
  f.store.assertLease(run.lease)
  const enabled = f.store.notifications.change({
    ...f.input,
    revision: 1,
    enabled: true,
    nonce: "enable"
  })
  f.reopen()
  expect(f.store.notifications.change(f.input)).toEqual(muted)
  expect(f.store.snapshot().notificationSettings).toEqual([enabled])
  expect(
    f.store.events(0).filter((item) => item.kind === "notification.settings_changed")
  ).toHaveLength(2)
})
it("rejects stale settings, reused nonces, invalid payloads and previous restore epochs", () => {
  const f = fixture()
  f.store.notifications.change(f.input)
  for (const [input, code] of [
    [{ ...f.input, enabled: true }, "nonce_conflict"],
    [{ ...f.input, nonce: "stale" }, "revision_conflict"],
    [{ ...f.input, extra: true }, "invalid_input"],
    [{ ...f.input, enabled: "yes" }, "invalid_input"]
  ] as const)
    expect(() => f.store.notifications.change(input)).toThrow(expect.objectContaining({ code }))
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','new-epoch','{}',1)"
  )
  expect(() => f.store.notifications.change(f.input)).toThrow(
    expect.objectContaining({ code: "data_epoch" })
  )
})

it("copies muted preferences without copying their revision or request identity", () => {
  const f = fixture()
  f.store.notifications.change(f.input)
  const copy = f.store.cloneBot({ id: f.bot.id, revision: f.bot.revision, nonce: "copy" })
  expect(f.store.notifications.list()).toContainEqual({
    botId: copy.bot.id,
    revision: 1,
    enabled: false
  })
  f.store.notifications.change({
    ...f.input,
    botId: copy.bot.id,
    nonce: "copy-enable",
    revision: 1,
    enabled: true
  })
  expect(f.store.notifications.list().find((item) => item.botId === f.bot.id)?.enabled).toBe(false)
})

import { afterEach, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { BotStore } from "./store"
import { BotNotificationPresenter } from "./notification-presenter"
import type { BotDesktopNotice } from "./notification-feed"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  store.send({ nonce: "task", conversationId, text: "Work" })
  const { run, lease } = store.claim("host")!
  const notice: BotDesktopNotice = {
    botId: bot.id,
    runId: run.id,
    kind: "agent-done",
    title: "Owner",
    body: "Done",
    link: { conversationId, messageId: run.messageId }
  }
  const natives: (EventEmitter & {
    show: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  })[] = []
  const ports = {
    create: vi.fn(() => {
      const n = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() })
      natives.push(n)
      return n
    }),
    navigate: vi.fn()
  }
  const presenter = new BotNotificationPresenter(ports)
  presenter.frame(store.snapshot())
  return { store, bot, lease, notice, natives, ports, presenter }
}
it("supports native close-before-click ordering and navigates to the exact message", () => {
  const f = fixture()
  f.presenter.show(f.notice)
  f.natives[0].emit("close")
  f.natives[0].emit("click")
  expect(f.ports.navigate).toHaveBeenCalledWith(f.notice)
  expect(f.natives[0].show).toHaveBeenCalledOnce()
})
it.each(["mute", "hide", "restore", "stop"])(
  "withdraws %s notices and ignores their delayed clicks",
  (mode) => {
    const f = fixture()
    f.presenter.show(f.notice)
    if (mode === "mute")
      f.store.notifications.change({
        botId: f.bot.id,
        dataEpoch: "initial",
        enabled: false,
        revision: 0,
        nonce: "mute"
      })
    if (mode === "hide") f.store.updateBot({ id: f.bot.id, revision: f.bot.revision, hidden: true })
    if (mode === "restore")
      f.store.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored','{}',1)"
      )
    if (mode === "stop") f.presenter.stop()
    else f.presenter.frame(f.store.snapshot())
    expect(f.natives[0].close).toHaveBeenCalledOnce()
    f.natives[0].emit("click")
    expect(f.ports.navigate).not.toHaveBeenCalled()
  }
)
it("withdraws resolved human questions and replaces earlier results for the same Bot", () => {
  const f = fixture()
  f.presenter.show(f.notice)
  f.presenter.show(f.notice)
  expect(f.natives[0].close).toHaveBeenCalledOnce()
  f.natives[0].emit("click")
  expect(f.ports.navigate).not.toHaveBeenCalled()
  f.store.requestInteraction(f.lease, { kind: "question", prompt: "Question" })
  f.presenter.frame(f.store.snapshot())
  f.presenter.show({ ...f.notice, kind: "agent-needs-input" })
  f.store.finish(f.lease, "cancelled", "Cancelled")
  f.presenter.frame(f.store.snapshot())
  expect(f.natives[2].close).toHaveBeenCalledOnce()
  f.natives[2].emit("click")
  expect(f.ports.navigate).not.toHaveBeenCalled()
})

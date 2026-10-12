import { existsSync } from "node:fs"
import { join } from "node:path"
import { Notification, type BrowserWindow } from "electron"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { botMessageLink } from "../../shared/bot-deep-link"
import { getDesktopBotClient } from "./desktop-client"
import { BotNotificationMonitor } from "./notification-monitor"
import { BotNotificationPresenter } from "./notification-presenter"
import { readBotWorkspaceFrame } from "../../shared/bot-workspace-frame"
import { BOT_WORK_PAGES_CAPABILITY } from "../../shared/bot-work-pages"
import { BotDomainError } from "../../shared/bot-types"

export function startDesktopBotNotifications(ports: {
  window(): BrowserWindow | null
  navigate(url: string): void
}): () => void {
  const presenter = new BotNotificationPresenter({
    create(notice) {
      if (!Notification.isSupported()) return null
      return new Notification({
        title: notice.title,
        body: notice.body,
        silent: notice.kind === "agent-done",
        urgency: notice.kind === "agent-needs-input" ? "critical" : "normal"
      })
    },
    navigate: (notice) => ports.navigate(botMessageLink(notice.link))
  })
  const database = join(getCmbCoworkAgentDataRoot(), "bot-host", "bots.sqlite")
  const monitor = new BotNotificationMonitor({
    async connect() {
      // Installing/opening Cmb alone must not create a Bot Host or database.
      if (!existsSync(database)) return null
      const client = await getDesktopBotClient()
      return {
        async snapshot() {
          for (let attempt = 0; attempt < 2; attempt++) {
            const host = await client.call("status")
            if (!host.capabilities?.includes(BOT_WORK_PAGES_CAPABILITY))
              return (
                await readBotWorkspaceFrame({
                  status: async () => host,
                  snapshot: (input) => client.call("snapshot", input)
                })
              ).snapshot
            const snapshot = await client.call("snapshot", {
              runProjection: "summary",
              workProjection: "paged",
              hostId: host.hostId,
              dataEpoch: host.dataEpoch,
              notificationTargets: presenter.targets()
            })
            if (snapshot.hostId === host.hostId && snapshot.dataEpoch === host.dataEpoch)
              return snapshot
          }
          throw new BotDomainError("workspace_changed", "Bot 后台或数据已变化，请重新读取")
        },
        events: (cursor) => client.call("events", cursor),
        notificationEvents: (input) => client.call("notificationEvents", input)
      }
    },
    focused() {
      const window = ports.window()
      return !!window && !window.isDestroyed() && window.isFocused()
    },
    now: Date.now,
    frame: (snapshot) => presenter.frame(snapshot),
    show: (notice) => presenter.show(notice),
    unavailable: () => presenter.clear()
  })
  const timer = setInterval(() => void monitor.poll(), 2000)
  timer.unref()
  void monitor.poll()
  return () => {
    clearInterval(timer)
    monitor.stop()
    presenter.stop()
  }
}

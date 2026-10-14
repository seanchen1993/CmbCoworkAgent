import type { FunctionPlugin } from "./dispatcher"

const uiOnlyCapabilities = new Set([
  "ui.open", "ui.close", "ui.panes", "ui.resolve", "ui.invalidate", "ui.log", "ui.status",
  "ui.toast", "store.get", "store.set", "store.keys", "store.delete", "session.usage",
  "session.version", "clock.time", "clock.now", "command.register", "command.list"
])

/** Only an exclusively UI development overlay can avoid opening new conversation history. */
export function developmentUiOnly(
  plugins: readonly FunctionPlugin[],
  development: ReadonlyMap<FunctionPlugin, unknown>
): boolean {
  return plugins.length > 0 && plugins.every(plugin => development.has(plugin) &&
    plugin.capabilities.every(capability => uiOnlyCapabilities.has(capability)) &&
    plugin.guest.registrations.every(registration => registration.pattern === "ui.render"))
}

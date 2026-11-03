const eventName = "cmb:release-guide-settings"
export type GuideSettingsTab = "mods" | "plugins" | "connectors"

// Repeat navigation to an already mounted settings page without resetting its drafts.
export function revealGuideSettings(tab: GuideSettingsTab) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: tab }))
}

export function subscribeGuideSettings(listener: (tab: GuideSettingsTab) => void) {
  const receive = (event: Event) => {
    const tab = (event as CustomEvent<unknown>).detail
    if (tab === "mods" || tab === "plugins" || tab === "connectors") listener(tab)
  }
  window.addEventListener(eventName, receive)
  return () => window.removeEventListener(eventName, receive)
}

import type { KeyboardEvent } from "react"

/** Keyboard activation stays inside the visible site and uses the same click/IPC authorization. */
export function pressFunctionHotkey(event: KeyboardEvent<HTMLElement>): boolean {
  const section = event.currentTarget
  const active = document.activeElement
  if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing ||
    event.ctrlKey || event.altKey || event.metaKey || !/^[a-z0-9]$/i.test(event.key) ||
    document.visibilityState !== "visible" || !document.hasFocus() ||
    !section.isConnected || !section.getClientRects().length ||
    document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') ||
    !(active instanceof HTMLElement) || !section.contains(active) ||
    active.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
    return false
  const scope = "[data-function-hotkey-scope]"
  if (active.closest(scope) !== section) return false
  const plugin = active.closest<HTMLElement>("[data-function-plugin]")?.dataset.functionPlugin
  if (!plugin) return false
  const candidates = [...section.querySelectorAll<HTMLButtonElement>("button[data-function-hotkey]")]
    .filter(button => button.dataset.functionHotkey === event.key.toLowerCase() &&
      button.dataset.functionPlugin === plugin && button.closest(scope) === section)
  const button = candidates.at(-1)
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true" ||
    !button.getClientRects().length || !button.dataset.functionHandle) return false
  event.preventDefault()
  event.stopPropagation()
  button.click()
  return true
}

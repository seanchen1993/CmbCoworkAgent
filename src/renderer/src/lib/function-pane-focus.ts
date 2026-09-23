import type { FunctionFocusTarget } from "../../../shared/mods/v2/ui"

export function canRequestPaneFocus(state: {
  visible: boolean
  active: boolean
  emptyComposer: boolean
  composerReady: boolean
  dialog: boolean
  current: "composer" | "body" | "other"
}): boolean {
  return (
    state.visible &&
    state.active &&
    state.emptyComposer &&
    state.composerReady &&
    !state.dialog &&
    (state.current === "composer" || state.current === "body")
  )
}

export function desktopAllowsPaneFocus(): boolean {
  const composer = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")
  return canRequestPaneFocus({
    visible: document.visibilityState === "visible",
    active: document.hasFocus(),
    emptyComposer: composer?.value === "",
    composerReady: Boolean(composer && !composer.disabled && composer.getClientRects().length),
    dialog: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')),
    current:
      document.activeElement === composer
        ? "composer"
        : document.activeElement === document.body
          ? "body"
          : "other"
  })
}

export function paneFocusElement(
  section: HTMLElement,
  target?: FunctionFocusTarget
): HTMLElement | undefined {
  if (!target) return section
  return [...section.querySelectorAll<HTMLElement>("[data-function-control]")].find(
    (element) =>
      element.dataset.functionControl === target.element &&
      element.dataset.functionPlugin === target.plugin &&
      element.closest<HTMLElement>("[data-function-client-instance]")?.dataset
        .functionClientInstance === target.client
  )
}

/** Imperative focus can move only inside the caller's already focused, visible site. */
export function desktopOwnsPaneFocus(section: HTMLElement, plugin: string): boolean {
  const current = document.activeElement
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    section.isConnected &&
    section.getClientRects().length > 0 &&
    !document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') &&
    current instanceof HTMLElement &&
    section.contains(current) &&
    current.dataset.functionPlugin === plugin &&
    !current.matches(":disabled")
  )
}

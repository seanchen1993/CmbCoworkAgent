export function ownsChatPaneEscape(event: KeyboardEvent, pane: HTMLElement | null, allowUnfocused: boolean): boolean {
  return Boolean(pane && (event.composedPath().includes(pane) || allowUnfocused))
}

export function getChatEscapeOverlay(event: KeyboardEvent): Element | undefined {
  return event.composedPath().find((node): node is Element =>
    node instanceof Element && node.matches('[role="dialog"], [role="alertdialog"], [role="menu"]')
  )
}

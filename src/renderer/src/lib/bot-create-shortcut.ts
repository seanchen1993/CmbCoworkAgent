/** Grok's creation shortcuts remain available while editing a chat draft. */
export function botCreateShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "repeat"
    | "isComposing"
    | "keyCode"
    | "defaultPrevented"
  >
): "bot" | "chat" | null {
  if (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "n"
  )
    return event.shiftKey ? "chat" : "bot"
  return null
}

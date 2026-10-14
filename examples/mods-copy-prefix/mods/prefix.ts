export function register(on) {
  on("ui.copy", ($, event, next) => next({ ...event, text: "[检视摘录] " + event.text }))
}

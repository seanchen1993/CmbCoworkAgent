export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "feedback-show", description: "Show feedback", immediate: true })
    await $.command.register({ name: "feedback-clear", description: "Clear feedback", immediate: true })
    return next(e)
  })
  on("command.run", { command: "feedback-show" }, ($) => {
    $.ui.status("FEEDBACK_PINNED")
    $.ui.toast("FEEDBACK_TEMPORARY", { timeoutMs: 2500 })
    return { text: "FEEDBACK_COMMAND_ORIGINAL" }
  })
  on("command.run", { command: "feedback-clear" }, ($) => {
    $.ui.status(undefined)
    return { text: "FEEDBACK_CLEARED" }
  })
}

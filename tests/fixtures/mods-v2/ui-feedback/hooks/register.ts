export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "feedback-show", description: "Show feedback", immediate: true })
    await $.command.register({ name: "feedback-flood", description: "Feedback layout bound", immediate: true })
    await $.command.register({ name: "feedback-long", description: "Full protected long feedback", immediate: true })
    await $.command.register({ name: "feedback-clear", description: "Clear feedback", immediate: true })
    return next(e)
  })
  on("command.run", { command: "feedback-show" }, ($) => {
    $.ui.status("FEEDBACK_PINNED")
    $.ui.toast("FEEDBACK_TEMPORARY", { timeoutMs: 2500 })
    return { text: "FEEDBACK_COMMAND_ORIGINAL" }
  })
  on("command.run", { command: "feedback-flood" }, ($) => {
    $.ui.status("LONG_FEEDBACK " + "x".repeat(9000))
    for (let i = 0; i < 4; i++) $.ui.toast("<script>window.shouldNotRun=true</script>" + "y".repeat(9000))
    return { text: "FEEDBACK_LAYOUT" }
  })
  on("command.run", { command: "feedback-clear" }, ($) => {
    $.ui.status(undefined)
    return { text: "FEEDBACK_CLEARED" }
  })
  on("command.run", { command: "feedback-long" }, ($) => {
    const prefix = "FEEDBACK_LONG_INPUT:", tail = ":FEEDBACK_LONG_END"
    const text = prefix + "x".repeat(30000 - prefix.length - tail.length) + tail
    $.ui.status(text)
    $.ui.toast(text, { timeoutMs: 60000 })
    return { text: "FEEDBACK_LONG_COMPLETE" }
  })
  for (const event of ["ui.status", "ui.toast"]) {
    on(event, ($, e, next) => {
      if (typeof e.text !== "string" || !e.text.startsWith("FEEDBACK_LONG_INPUT:")) return next(e)
      if (e.text.length !== 30000 || !e.text.endsWith(":FEEDBACK_LONG_END"))
        throw Error("FEEDBACK_LONG_HOOK_FULL_REQUIRED")
      return next({ ...e, text: "FEEDBACK_LONG_HOOK:sk-ui-long-fixture-token-123456789:" + e.text })
    })
  }
}

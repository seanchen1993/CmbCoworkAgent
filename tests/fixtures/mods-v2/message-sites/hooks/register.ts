export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "message-style",
      description: "Decorate message text",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "message-style" }, async ($, e) => {
    await $.store.set("custom", e.args === "custom")
    $.ui.invalidate("ui.render")
    return { text: "style saved" }
  })
  for (const component of ["UserMessage", "AssistantMessage"]) {
    on("ui.render", { component }, async ($, e, next) => {
      if (!(await $.store.get("custom"))) return next(e)
      return next({
        ...e,
        props: { ...e.props, text: "DISPLAY_ONLY_" + component + ": " + e.props.text }
      })
    })
  }
}

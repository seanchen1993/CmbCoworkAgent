export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "output-echo",
      description: "Command display check",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "output-echo" }, () => ({ text: "ORIGINAL_OUTPUT" }))
  on("ui.render", { component: "CommandOutput" }, ($, e, next) => {
    if (e.props.command !== "output-echo") return next(e)
    return next({ ...e, props: { ...e.props, text: "DISPLAY_OUTPUT " + e.props.args } })
  })
}

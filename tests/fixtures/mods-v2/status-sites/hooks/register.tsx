export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "status-sites-style",
      description: "Choose native or custom status labels",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "status-sites-style" }, async ($, e) => {
    const custom = e.args.trim() === "custom"
    await $.store.set("status-sites-custom", custom)
    $.ui.invalidate("ui.render")
    return { text: JSON.stringify({ custom }) }
  })
  on("ui.render", async ($, e, next) => {
    if (!(await $.store.get("status-sites-custom"))) return next(e)
    if (e.component === "Spinner")
      return next({
        ...e,
        props: { ...e.props, word: "STATUS_SPINNER", message: null, suffix: " ~" }
      })
    if (e.component === "TurnDuration")
      return next({ ...e, props: { ...e.props, word: "STATUS_DURATION" } })
    if (e.component === "SessionMode")
      return next({ ...e, props: { modes: ["STATUS_MODE", ...e.props.modes] } })
    return next(e)
  })
}

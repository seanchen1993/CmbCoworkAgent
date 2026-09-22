export function register(on) {
  let focusCount = 0
  let scrollCount = 0
  on("session.start", async ($, e, next) => {
    await $.tool.register({ name: "probe", description: "Verify host model fork and classify" })
    await $.command.register({ name: "lifecycle-pane", description: "Open lifecycle probe", immediate: true })
    return next(e)
  })
  on("turn.step", async function* ($, e, next) {
    for await (const frame of next(e)) {
      yield frame.kind === "text"
        ? { ...frame, text: frame.text.replaceAll("LIFECYCLE_RAW", "LIFECYCLE_TRANSFORMED") }
        : frame
    }
  })
  on("tool.call", { tool: "mcp__model-lifecycle__probe" }, async ($) => {
    const fork = await $.model.fork({ prompt: "[lifecycle-fork]", maxTokens: 64 })
    const label = await $.model.classify("[lifecycle-classify]", ["ready", "blocked"], { maxTokens: 16 })
    return { result: { fork, label } }
  })
  on("command.run", { command: "lifecycle-pane" }, async ($) => {
    await $.ui.open({ id: "lifecycle", title: "Lifecycle E2E", rows: 3, closeOnEscape: true })
    return { text: "LIFECYCLE_PANE_OPEN" }
  })
  on("ui.focus", { component: "Pane", requestId: "lifecycle" }, async ($, e, next) => {
    focusCount++
    $.ui.invalidate("ui.render")
    return next(e)
  })
  on("ui.scroll", { component: "Pane", requestId: "lifecycle" }, async ($, e, next) => {
    scrollCount++
    $.ui.invalidate("ui.render")
    return next(e)
  })
  on("ui.render", { component: "Pane", requestId: "lifecycle" }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column">
      <Text>focus:{focusCount} focused:{String(e.props.isFocused)} scroll:{scrollCount}</Text>
      <Text>{"Scrollable line\n".repeat(30)}</Text>
    </Box>
  })
}

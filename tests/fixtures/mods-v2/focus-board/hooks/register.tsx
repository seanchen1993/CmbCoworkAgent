export function register(on) {
  let focusCount = 0
  let entered = ""
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "focus-board",
      description: "Open a keyboard focus probe",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "focus-board" }, async ($) => {
    await $.ui.open({ id: "focus-board", title: "Focus E2E", focus: true, closeOnEscape: true })
    return { text: "FOCUS_BOARD_OPEN" }
  })
  on("ui.focus", { component: "Pane", requestId: "focus-board" }, async ($, e, next) => {
    if (e.focused) focusCount++
    return next(e)
  })
  on("ui.render", { component: "Pane", requestId: "focus-board" }, ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>
          focus-events:{focusCount} entered:{entered}
        </Text>
        <Input
          key="first"
          label="First focus field"
          autoFocus
          onSubmit={() => {}}
          onInput={(value) => {
            entered = value
            $.ui.invalidate("ui.render")
          }}
        />
        <Input
          key="second"
          label="Second focus field"
          autoFocus
          onSubmit={() => {}}
          onInput={(value) => {
            entered = value
            $.ui.invalidate("ui.render")
          }}
        />
        <Button
          key="redraw"
          label="Redraw focus probe"
          onPress={() => $.ui.invalidate("ui.render")}
        />
      </Box>
    )
  })
}

export function register(on) {
  let saved
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "pane-probe", description: "Pane probe" })
    await $.command.register({ name: "pane-retained", description: "Retained SDK probe" })
    return next(e)
  })
  on("command.run", { command: "pane-retained" }, async ($) => {
    saved ??= () => $.session.id()
    await Promise.resolve()
    return { text: await saved() }
  })
  on("command.run", { command: "pane-probe" }, async ($) => {
    const opened = await $.ui.open({ id: "probe", title: "Probe", rows: 8, closeOnEscape: true })
    const closed = await $.ui.close({ id: "probe" })
    return { text: JSON.stringify({ opened: typeof opened, closed: typeof closed }) }
  })
  on("ui.render", { component: "Pane", requestId: "probe" }, ($, e) => {
    const { Box, Text, Button, Input, Select, Link, Code } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Pane probe</Text>
        <Button
          label="Click"
          onPress={async () => {
            await $.session.id()
          }}
        />
        <Input
          key="note"
          label="Note"
          value="hello"
          onSubmit={async () => {
            await $.session.id()
          }}
        />
        <Select key="mode" options={[{ value: "a", label: "A" }]} value="a" onSelect={() => {}} />
        <Link href="https://example.com/" label="Example" />
        <Code source="const x = 1" language="typescript" />
      </Box>
    )
  })
}

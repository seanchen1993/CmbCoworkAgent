export function register(on) {
  let count = 0
  let submitted = ""
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>
          SITE_ABOVE count:{count} submitted:{submitted}
        </Text>
        <Button
          key="increment"
          label="Site increment"
          autoFocus
          onPress={() => {
            count++
            $.ui.invalidate("ui.render")
          }}
        />
        <Input
          key="note"
          label="Site note"
          submitLabel="Save site note"
          value={submitted}
          onSubmit={(value) => {
            submitted = value
            $.ui.invalidate("ui.render")
          }}
        />
      </Box>
    )
  })
  on("ui.render", { component: "PromptHint" }, ($, e, next) =>
    next({
      ...e,
      props: {
        ...e.props,
        hint: `SITE_HINT draft:${e.props.isDraft} working:${e.props.isWorking} ${e.props.hint}`
      }
    })
  )
  on("ui.render", { component: "InfoNotice" }, ($, e, next) =>
    next({
      ...e,
      props: { ...e.props, text: `SITE_NOTICE ${e.props.text}` }
    })
  )
  on("classic.UserPromptSubmit", ($, e, next) =>
    e.prompt === "SITE_BLOCK_PROBE" ? { block: "SITE_HOST_BLOCK" } : next(e)
  )
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "code-pane",
      description: "Show source and diff",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "code-pane" }, async ($) => {
    await $.ui.open({ id: "code-preview", title: "Code E2E", rows: 12, closeOnEscape: true })
    return { text: "CODE_PREVIEW_OPEN" }
  })
  on("ui.render", { component: "Pane", requestId: "code-preview" }, ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>Source and diff preview</Text>
        <Code
          source={'const count = 2\nconst label = "safe"'}
          path="never-read/private.ts"
          startLine={42}
          wrap="wrap"
        />
        <Code
          source={"--- a/task.ts\n+++ b/task.ts\n@@ -1 +1 @@\n-old value\n+new value"}
          format="diff"
          startLine={99}
          wrap="truncate-end"
        />
      </Box>
    )
  })
}

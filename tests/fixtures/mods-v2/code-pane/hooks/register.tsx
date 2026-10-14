export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "code-pane",
      description: "Show source and diff",
      immediate: true
    })
    await $.command.register({
      name: "code-long-pane",
      description: "Show long source",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "code-long-pane" }, async ($) => {
    await $.ui.open({ id: "code-long-preview", title: "Long Code", rows: 12, closeOnEscape: true })
    return { text: "LONG_CODE_PREVIEW_OPEN" }
  })
  on("ui.render", { component: "Pane", requestId: "code-long-preview" }, ($, e) => {
    const { Box, Code } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Code source={"x".repeat(120000) + "synthetic-secret-tail"} language="typescript" />
        <Code source={"<script>malformed diff</script>"} format="diff" startLine={17} />
      </Box>
    )
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

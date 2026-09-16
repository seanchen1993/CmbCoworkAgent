/** A desktop pane built entirely through the public function SDK. */
export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "claw-board",
      description: "打开我的 Claw 面板",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "claw-board" }, async ($) => {
    await $.ui.open({ id: "claw-board", title: "我的 Claw", closeOnEscape: true, rows: 14 })
    return { text: "已打开我的 Claw 面板。" }
  })
  on("ui.render", { component: "Pane", requestId: "claw-board" }, async ($, event) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(event)
    const count = (await $.store.get("board-count")) ?? 0
    const note = (await $.store.get("board-note")) ?? ""
    const mode = (await $.store.get("board-mode")) ?? "review"
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>用插件定制你的 Claw</Text>
        <Text>点击次数：{String(count)}</Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="count"
            label="加一"
            onPress={async () => {
              await $.store.set("board-count", ((await $.store.get("board-count")) ?? 0) + 1)
              $.ui.invalidate("ui.render")
            }}
          />
          <Button
            key="reset"
            label="重置"
            onPress={async () => {
              await $.store.set("board-count", 0)
              $.ui.invalidate("ui.render")
            }}
          />
        </Box>
        <Input
          key="note"
          label="项目备注"
          value={note}
          submitLabel="保存备注"
          onSubmit={async (value) => {
            await $.store.set("board-note", value)
            $.ui.invalidate("ui.render")
          }}
        />
        <Select
          key="mode"
          label="面板视图"
          value={mode}
          options={[
            { value: "review", label: "检视" },
            { value: "build", label: "构建" }
          ]}
          onSelect={async (value) => {
            await $.store.set("board-mode", value)
            $.ui.invalidate("ui.render")
          }}
        />
        <Text dimColor>
          备注：{note || "尚未填写"} · 视图：{mode === "review" ? "检视" : "构建"}
        </Text>
      </Box>
    )
  })
}

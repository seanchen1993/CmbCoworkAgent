export function register(on) {
  let context: { window: number; tokens?: number; percent?: number } | undefined
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "usage-board",
      description: "打开任务用量提示",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "usage-board" }, async ($) => {
    context = (await $.session.usage()).context
    await $.ui.open({ id: "usage-board", title: "任务用量", rows: 5 })
    return { text: "在右侧 Claw 工作台的“插件与结果”查看。实际任务返回用量后会自动更新。" }
  })
  on("session.measure", async ($, event, next) => {
    context = event.context
    $.ui.invalidate("ui.render")
    return next(event)
  })
  on("ui.render", { component: "Pane", requestId: "usage-board" }, ($, event) => {
    const { Box, Text } = $.ui.resolve(event)
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          {context?.tokens === undefined
            ? "等待实际任务返回输入量。"
            : `当前输入量 ${context.tokens} / ${context.window}（${context.percent ?? 0}%）`}
        </Text>
        <Text dimColor>这是最近一次响应的输入量；不是累计账单，也不包含 Claude 订阅额度。</Text>
      </Box>
    )
  })
}

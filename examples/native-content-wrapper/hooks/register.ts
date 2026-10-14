export function register(on) {
  const labels = {
    AssistantMessage: "我的 Claw · 任务回答",
    ToolGroup: "我的 Claw · 本轮工具操作",
    AskUserQuestion: "我的 Claw · 请确认后再继续"
  }

  on("ui.render", async ($, event, next) => {
    if (!Object.hasOwn(labels, event.component)) return next(event)
    const { Box, Text } = $.ui.resolve(event)
    return Box({
      flexDirection: "column",
      children: [Text({ children: labels[event.component] }), await next(event)]
    })
  })
}

export function register(on) {
  let count = 0
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "claw-board",
      description: "打开跨插件组合示例",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-board" }, async ($) => {
    await $.ui.open({ id: "composition-board", title: "我的任务看板" })
    return {}
  })
  on("ui.render", { component: "Pane", requestId: "composition-board" }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: "column",
      gap: 1,
      children: [
        Text({ children: "我的任务看板" }),
        Text({ children: "已完成 " + count + " 次操作" }),
        Button({
          key: "complete-one",
          label: "完成一次操作",
          onPress() {
            count++
            $.ui.invalidate("ui.render")
          }
        })
      ]
    })
  })
}

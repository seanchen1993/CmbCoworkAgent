export function register(on) {
  const task = "根据本对话已经确认的需求完成开发，保持当前项目权限，说明实际修改和验证结果。"
  let pending = false
  let reviewTurn

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const lower = await next(e)
    const button = Button({
      key: "finish-and-review",
      label: "完成需求并接着检视",
      onPress: () => {
        if (pending) return
        pending = true
        void $.prompt.submit({ text: task, asUser: true }).catch(() => {
          pending = false
          reviewTurn = undefined
        })
      }
    })
    return Box({ children: [button, lower] })
  })

  on("turn.start", ($, e, next) => {
    if (pending && e.text === task) reviewTurn = e.turnId
    return next(e)
  })

  on("turn.complete", ($, e, next) => {
    if (e.turnId !== reviewTurn) return next(e)
    pending = false
    reviewTurn = undefined
    if (e.reason === "answer") {
      void $.prompt
        .submit({
          text: "只检视刚才任务的代码修改，检查正确性、边界情况和已有功能兼容性。先读实际修改，再按严重程度列出发现；本轮不修改文件。"
        })
        .catch(() => {})
    }
    return next(e)
  })
}

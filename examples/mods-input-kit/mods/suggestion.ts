export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({ name: "input-next", description: "显示需自己接受的下一步建议", immediate: true })
    return next(event)
  })
  on("command.run", { command: "input-next" }, async ($) => {
    const result = await $.prompt.suggest({ text: "review the change and run tests" })
    return { text: result.isShown ? "建议已显示，按 Tab 或 → 接受，确认后发送。" :
      "建议未显示：请等任务结束、清空输入框并关闭弹窗，再执行 /input-next。" }
  })
}

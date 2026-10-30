export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-session",
      description: "查看会话模型、上下文用量、轮次、最近回复与 Git 仓库",
      immediate: true
    })
    await $.command.register({
      name: "claw-usage-summary",
      description: "查看当前上下文的快速 breakdown",
      immediate: true
    })
    await $.command.register({
      name: "claw-usage-full",
      description: "查看当前上下文的详细 breakdown",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-session" }, async ($) => {
    const repo = await $.session.repo()
    const messages = await $.session.messages()
    const usage = await $.session.usage()
    const last = messages.filter((message) => message.role === "assistant" && message.text).at(-1)
    return {
      text: [
        `会话：${await $.session.id()}`,
        `目录：${await $.session.cwd()}`,
        `模型：${await $.session.model()}`,
        `上下文：${usage.context.tokens === undefined ? "尚无实际读数" : `${usage.context.tokens} tokens / ${usage.context.percent}%`}（窗口 ${usage.context.window}）`,
        `用户轮次：${await $.session.turns()}`,
        `消息：${messages.length}`,
        ...(last ? [`最近回复：${last.text.slice(0, 200)}`] : []),
        repo ? `仓库：${repo.root}\n远端：${repo.remote ?? "未设置"}` : "仓库：无 Git 仓库"
      ].join("\n")
    }
  })
  on("command.run", { command: "claw-usage-summary" }, async ($) => ({
    text: JSON.stringify(await $.session.usage({ breakdown: "summary", columns: 60 }))
  }))
  on("command.run", { command: "claw-usage-full" }, async ($) => ({
    text: JSON.stringify(await $.session.usage({ breakdown: "full", columns: 60 }))
  }))
}

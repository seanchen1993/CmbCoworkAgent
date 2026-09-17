export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-session",
      description: "查看会话模型、轮次、最近回复与 Git 仓库",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-session" }, async ($) => {
    const repo = await $.session.repo()
    const messages = await $.session.messages()
    const last = messages.filter((message) => message.role === "assistant" && message.text).at(-1)
    return {
      text: [
        `会话：${await $.session.id()}`,
        `目录：${await $.session.cwd()}`,
        `模型：${await $.session.model()}`,
        `用户轮次：${await $.session.turns()}`,
        `消息：${messages.length}`,
        ...(last ? [`最近回复：${last.text.slice(0, 200)}`] : []),
        repo ? `仓库：${repo.root}\n远端：${repo.remote ?? "未设置"}` : "仓库：无 Git 仓库"
      ].join("\n")
    }
  })
}

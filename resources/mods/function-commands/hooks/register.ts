export function register(on) {
  let visits = 0
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "claw-info",
      description: "查看当前项目和会话信息",
      argumentHint: "[备注]",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "claw-info" }, async ($, event) => {
    const cwd = await $.session.cwd()
    const id = await $.session.id()
    const note = event.args || (await $.store.get("last-note"))
    if (event.args) await $.store.set("last-note", event.args)
    visits++
    return {
      text: `项目：${cwd}\n会话：${id}\n本次会话查询：${visits}${note ? `\n备注：${note}` : ""}`
    }
  })
}

export function register(on) {
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "hello-spark",
      description: "向输入的名字打招呼",
      argumentHint: "[名字]",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "hello-spark" }, async ($, event) => {
    const name = (event.args ?? "").trim().slice(0, 80) || "新朋友"
    return { text: `你好，${name}！第一个灵件已运行。` }
  })
}

export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-ask",
      description: "用已配置的默认模型回答一个问题",
      argumentHint: "[问题]",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-ask" }, async ($, e) => {
    if (!e.args.trim()) return { text: "请输入问题，例如 /claw-ask 如何给项目写一份自检清单？" }
    return {
      text: await $.model.complete({
        model: "default",
        prompt: e.args,
        system: "请用简洁的中文回答。",
        maxTokens: 512
      })
    }
  })
}

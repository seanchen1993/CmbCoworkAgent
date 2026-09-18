export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "model-probe", description: "Model probe" })
    return next(e)
  })
  on("command.run", { command: "model-probe" }, async ($, e) => ({
    text: await $.model.complete({ model: "fixture", prompt: e.args, maxTokens: 32 })
  }))
  on("model.complete", { prompt: "input" }, async ($, e, next) => {
    const first = await next({ ...e, prompt: "first" })
    const second = await next({ ...e, prompt: "second" })
    return { value: `${next.origin.plugin}:${first.value}:${second.value}` }
  })
  on("model.complete", { prompt: "short" }, () => ({ value: "local answer" }))
}

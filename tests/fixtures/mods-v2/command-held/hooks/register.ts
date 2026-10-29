export function register(on) {
  let calls = 0
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "held-probe", description: "Probe held commands" })
    await $.command.register({ name: "held-child", description: "Nested command" })
    return next(e)
  })
  on("session.id", async ($) => ({ value: (await $.command.run({ command: "held-child" })).text }))
  on("command.run", { command: "held-child" }, () => ({ text: String(++calls) }))
  on("command.run", { command: "held-probe" }, async ($) => {
    const direct = await $.command.run({ command: "held-child" }).then(() => false, () => true)
    const indirect = await $.session.id().then(() => false, () => true)
    return { text: JSON.stringify({ direct, indirect, calls }) }
  })
}

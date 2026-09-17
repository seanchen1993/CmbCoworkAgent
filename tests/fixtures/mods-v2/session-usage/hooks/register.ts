export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "usage-probe", description: "Context usage probe" })
    return next(e)
  })
  on("session.usage", async ($, e, next) => next({ ...e, columns: 60 }))
  on("command.run", { command: "usage-probe" }, async ($) => {
    try {
      return { text: JSON.stringify(await $.session.usage()) }
    } catch (error) {
      return { text: "caught:" + error.message }
    }
  })
}

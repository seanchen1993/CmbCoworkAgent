export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "session-state", description: "Read session state" })
    return next(e)
  })
  on("session.model", async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    return { value: "view:" + result.value }
  })
  on("command.run", { command: "session-state" }, async ($) => {
    try {
      return {
        text: JSON.stringify({
          model: await $.session.model(),
          turns: await $.session.turns(),
          messages: await $.session.messages()
        })
      }
    } catch (error) {
      return { text: "caught:" + error.message }
    }
  })
}

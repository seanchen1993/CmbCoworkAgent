export function register(on) {
  let active
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "turn-probe",
      description: "Read or cancel a turn",
      immediate: true
    })
    return next(e)
  })
  on("turn.start", async ($, e, next) => {
    active = e.turnId
    return next(e)
  })
  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    return { ...result, text: `done:${e.turnId}:${e.reason}:${result.text}` }
  })
  on("command.run", { command: "turn-probe" }, async ($, e) => {
    if (e.args !== "abort") return { text: active ?? "none" }
    try {
      return { text: "aborted:" + typeof (await $.turn.abort({ turnId: active })) }
    } catch (error) {
      return { text: "caught:" + error.message }
    }
  })
}

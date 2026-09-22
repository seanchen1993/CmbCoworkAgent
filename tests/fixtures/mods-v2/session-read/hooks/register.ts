export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "session-probe", description: "Session metadata probe" })
    return next(e)
  })
  on("session.repo", async ($, e, next) => {
    const answer = await next(e)
    if (answer.deny !== undefined) return answer
    return {
      value: answer.value === null ? null : { ...answer.value, root: "view:" + answer.value.root }
    }
  })
  on("command.run", { command: "session-probe" }, async ($) => {
    try {
      return {
        text: JSON.stringify({ repo: await $.session.repo(), auth: await $.session.authorize() })
      }
    } catch (error) {
      return { text: "caught:" + error.message }
    }
  })
}

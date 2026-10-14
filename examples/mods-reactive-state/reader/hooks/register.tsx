import { atom, derive, read } from "claude-code"

const count = atom({ plugin: "state-owner", key: "count" }, 0)
const score = derive([count], (n) => n * 10)

export function register(on) {
  on("session.start", async ($, e, next) => {
    for (const name of ["state-reader-open", "state-denied"])
      await $.command.register({ name, description: name, immediate: true })
    return next(e)
  })
  on("command.run", { command: "state-reader-open" }, async ($) => {
    await $.ui.open({ id: "state-reader", title: "Independent derived view" })
    return {}
  })
  on("command.run", { command: "state-denied" }, async ($) => {
    try {
      await $.state.set(count.ref, 999)
      return { text: "UNEXPECTED_WRITE" }
    } catch (error) {
      return { text: String(error) }
    }
  })
  on("ui.render", { component: "Pane", requestId: "state-reader" }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{"READER_SCORE_" + (await read($, score))}</Text>
  })
}

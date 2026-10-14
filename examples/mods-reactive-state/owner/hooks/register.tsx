import { atom, read, update } from "claude-code"

const count = atom({ plugin: "state-owner", key: "count" }, 0)

export function register(on) {
  on("session.start", async ($, e, next) => {
    for (const name of ["state-open", "state-inspect", "state-increment"])
      await $.command.register({ name, description: name, immediate: true })
    return next(e)
  })
  on("command.run", { command: "state-open" }, async ($) => {
    await $.ui.open({ id: "state-owner", title: "Shared state owner" })
    return {}
  })
  on("command.run", { command: "state-inspect" }, async ($) => ({
    text: JSON.stringify(await $.state.get(count.ref))
  }))
  on("command.run", { command: "state-increment" }, async ($) => {
    await update($, count, (n) => n + 1)
    return { text: String(await read($, count)) }
  })
  on("ui.render", { component: "Pane", requestId: "state-owner" }, async ($, e) => {
    const { Text, Button } = $.ui.resolve(e)
    const value = await read($, count)
    return (
      <>
        <Text>{"OWNER_COUNT_" + value}</Text>
        <Button
          key="increment"
          label="Increment shared count"
          onPress={async () => {
            await update($, count, (n) => n + 1)
          }}
        />
      </>
    )
  })
}

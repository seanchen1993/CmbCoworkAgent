import type { Register } from "claude-code"

export const register: Register<"typed-counter"> = (on) => {
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "typed-counter",
      description: "Increment this session's typed counter",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "typed-counter" }, async ($) => {
    const ref = { plugin: "typed-counter", key: "count" } as const
    const previous = await $.state.get(ref)
    const value = (previous.value ?? 0) + 1
    const changed = await $.state.set(ref, value, { ifVersion: previous.version })
    return {
      text: changed.isSet ? `Counter: ${value}` : "Counter changed concurrently; run again."
    }
  })
}

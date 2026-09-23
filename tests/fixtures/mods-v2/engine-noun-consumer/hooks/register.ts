export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "noun-identity",
      description: "Read identity through another isolated Mod",
      immediate: true
    })
    return next(e)
  })
  on("company.identify", async ($, e, next) => {
    const result = await next({ ...e, label: e.label + "!" })
    return { value: { ...result.value, label: result.value.label + "?" } }
  })
  on("command.run", { command: "noun-identity" }, async ($, e) => {
    const identity = await $.company.identify({ label: e.args })
    return { text: `ENGINE_NOUN:${identity.label}:${identity.thread}:${identity.calls}` }
  })
}

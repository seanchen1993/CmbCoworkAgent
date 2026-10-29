export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "state-probe", description: "State probe" })
    return next(e)
  })
  on("store.set", { key: "label" }, ($, e, next) => next({ ...e, value: e.value.toUpperCase() }))
  on("command.run", { command: "state-probe" }, async ($) => {
    const missing = (await $.store.get("missing")) === undefined
    await $.store.set("null", null)
    await $.store.set("label", "hello")
    await $.store.set("data", { when: new Date("2020-01-01T00:00:00Z"), omitted: undefined })
    const before = await $.store.keys()
    const label = await $.store.get("label")
    const data = await $.store.get("data")
    const nullValue = await $.store.get("null")
    await $.store.delete("label")
    const after = await $.store.keys()
    let refused = false
    try { await $.store.set("fn", () => 1) } catch { refused = true }
    const cycle = {}
    cycle.self = cycle
    const cycleRefused = await $.store.set("cycle", cycle).then(() => false, () => true)
    return { text: JSON.stringify({ missing, nullValue, label, data, before, after, refused, cycleRefused }) }
  })
}

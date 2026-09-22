export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "client-board", description: "Client board", immediate: true })
    return next(e)
  })
  on("command.run", { command: "client-board" }, async ($) => {
    await $.ui.open({ id: "client-board", title: "Client board", rows: 16, closeOnEscape: true })
    return {}
  })
  on("ui.render", { component: "Pane", requestId: "client-board" }, ($, e) => {
    const { Client } = $.ui.resolve(e)
    return <Client key="counter" module="./surface.tsx" props={{ label: "Client state" }} />
  })
  on("ui.message", { element: "counter" }, async ($, e) => {
    await $.store.set("client-message", e.data)
    return { props: { label: "Acknowledged", count: e.data.count } }
  })
}

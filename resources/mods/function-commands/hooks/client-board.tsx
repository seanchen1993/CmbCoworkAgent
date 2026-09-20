export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-client",
      description: "打开 Claw 交互工作台",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-client" }, async ($) => {
    await $.ui.open({ id: "claw-client", title: "Claw 交互工作台", rows: 16, closeOnEscape: true })
    return { text: "已打开交互工作台。组件保留自己的状态，可通过消息调用插件能力。" }
  })
  on("ui.render", { component: "Pane", requestId: "claw-client" }, ($, e) => {
    const { Client } = $.ui.resolve(e)
    return <Client key="workbench" module="./client-surface.tsx" props={{ label: "交互组件" }} />
  })
  on("ui.message", { element: "workbench" }, async ($, e) => {
    if (e.data?.kind === "redraw") {
      $.ui.invalidate("ui.render")
      return {}
    }
    if (e.data?.kind === "count" && Number.isSafeInteger(e.data.count)) {
      await $.store.set("client-last-count", e.data.count)
      return { props: { label: "宿主已收到点击" } }
    }
    return {}
  })
}

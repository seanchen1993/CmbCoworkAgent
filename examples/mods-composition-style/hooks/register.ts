export function register(on) {
  on("ui.resolve", { component: /^Pane$/ }, async ($, e, next) => {
    const lower = await next(e)
    return {
      ...lower,
      Text: (props) => lower.Text({ ...props, children: ["组合版 · ", props.children] }),
      Button: (props) => lower.Box({
        flexDirection: "column",
        children: [
          lower.Text({ children: "此按钮仍执行原看板的操作" }),
          lower.Button({ ...props, label: "执行 · " + props.label })
        ]
      })
    }
  })
}

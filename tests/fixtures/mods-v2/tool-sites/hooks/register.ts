export function register(on) {
  on("ui.render", { component: "ToolGroup" }, ($, e, next) =>
    next({ ...e, props: { ...e.props, isExpanded: true } }))
  on("ui.render", { component: "ToolUse" }, ($, e, next) =>
    next({ ...e, props: { ...e.props, input: { label: "DISPLAY_TOOL_INPUT" } } }))
  on("ui.render", { component: "ToolResult" }, ($, e, next) =>
    next({ ...e, props: { ...e.props, output: "DISPLAY_TOOL_RESULT" } }))
}

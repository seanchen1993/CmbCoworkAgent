import type { FunctionFocusTarget, FunctionPaneSnapshot, FunctionUiElement } from "./ui"

/** Draw order also covers isolated Client surfaces. Addresses always retain their owner. */
export function functionFocusTargets(
  pane: Pick<FunctionPaneSnapshot, "tree" | "clients">
): { target: FunctionFocusTarget; autoFocus: boolean }[] {
  const targets: { target: FunctionFocusTarget; autoFocus: boolean }[] = []
  const visit = (node: FunctionUiElement | string, client?: string): void => {
    if (typeof node === "string") return
    if (node.press && ["Button", "Input", "Select"].includes(node.type))
      targets.push({
        target: {
          plugin: node.press.plugin,
          element: String(node.props.key),
          ...(client ? { client } : {})
        },
        autoFocus: node.props.autoFocus === true
      })
    if (node.type === "Client" && !client) {
      const surface = pane.clients?.find(
        (row) => row.plugin === node.client?.plugin && row.element === node.props.key && !row.error
      )
      if (surface) visit(surface.tree, surface.id)
    }
    node.children?.forEach((child) => visit(child, client))
  }
  visit(pane.tree)
  return targets
}

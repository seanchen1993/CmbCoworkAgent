export interface ReactVirtuosoScrollCancelOptions {
  workspaceRoot?: string
  checkOnly?: boolean
}
export function checkReactVirtuosoScrollCancel(
  options?: Pick<ReactVirtuosoScrollCancelOptions, "workspaceRoot">
): { status: "installed"; targets: number }
export function installReactVirtuosoScrollCancel(
  options?: ReactVirtuosoScrollCancelOptions
): Promise<{ status: "installed" | "applied"; targets: number }>

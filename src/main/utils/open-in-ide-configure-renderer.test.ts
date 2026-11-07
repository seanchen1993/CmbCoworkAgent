import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

// Execute the actual component callbacks, with a delayed IPC response and React state spies.
const source = ts.createSourceFile("open-in-ide-button.tsx", readFileSync(new URL(
  "../../renderer/src/components/ui/open-in-ide-button.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler: ts.Expression | undefined, cleanup: ts.Expression | undefined,
  dialogChange: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleConfirmPreferredIde" &&
    node.initializer && ts.isCallExpression(node.initializer)) handler = node.initializer.arguments[0]
  if (ts.isCallExpression(node) && node.expression.getText(source) === "React.useLayoutEffect" &&
    node.arguments[0]?.getText(source).includes("configurationAttempt.current")) cleanup = node.arguments[0]
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onOpenChange" &&
    node.initializer && ts.isJsxExpression(node.initializer)) dialogChange = node.initializer.expression
  ts.forEachChild(node, visit)
}
visit(source)
function instantiate(expression: ts.Expression | undefined, scope: Record<string, unknown>) {
  if (!expression) throw Error("ACTUAL_CONFIGURE_CALLBACK_REQUIRED")
  const code = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText.trim().replace(/;$/, "")
  return new Function(...Object.keys(scope), `return ${code}`)(...Object.values(scope))
}

function fixture() {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void
  const configurePreferred = vi.fn(() => new Promise((yes, no) => { resolve = yes; reject = no }))
  const scope = {
    configuringRef: { current: false }, configurationAttempt: { current: 0 },
    setConfiguring: vi.fn(), selectedIde: "vscode", pathInputVisible: false,
    manualExecutablePath: "", window: { api: { ide: { configurePreferred } } },
    applyConfigureResult: vi.fn(), openWithIde: vi.fn(async () => {}),
    setDialogMessage: vi.fn(), setPathInputVisible: vi.fn(),
    opening: false, setDialogOpen: vi.fn(), resetDialogState: vi.fn()
  }
  const run = instantiate(handler, scope) as () => Promise<void>
  const initialize = instantiate(cleanup, scope) as () => () => void
  let dispose = initialize()
  scope.setConfiguring.mockClear()
  const changeDialog = instantiate(dialogChange, scope) as (open: boolean) => void
  return { scope, configurePreferred, run, dispose: () => dispose(), changeDialog,
    changeScope: () => { dispose(); dispose = initialize() },
    resolve: (value: unknown) => resolve(value), reject: (error: unknown) => reject(error) }
}

describe("asynchronous IDE configuration in the actual renderer callback", () => {
  it("coalesces immediate double confirmation while retaining the successful open", async () => {
    const f = fixture(), pending = f.run()
    await f.run()
    expect(f.configurePreferred).toHaveBeenCalledTimes(1)
    f.resolve({ status: "configured", settings: {} })
    await pending
    expect(f.scope.applyConfigureResult).toHaveBeenCalledTimes(1)
    expect(f.scope.openWithIde).toHaveBeenCalledWith("vscode")
    expect(f.scope.setConfiguring.mock.calls).toEqual([[true], [false]])
  })

  it("blocks every dialog dismissal route while configuration is pending", async () => {
    const f = fixture(), pending = f.run()
    f.changeDialog(false)
    expect(f.scope.setDialogOpen).not.toHaveBeenCalled()
    expect(f.scope.resetDialogState).not.toHaveBeenCalled()
    f.reject(Error("LOOKUP_FAILED"))
    await pending
    f.changeDialog(false)
    expect(f.scope.setDialogOpen).toHaveBeenCalledWith(false)
    expect(f.scope.resetDialogState).toHaveBeenCalledTimes(1)
  })

  it("invalidates a slow lookup when the same component changes file or workspace", async () => {
    const f = fixture(), old = f.run()
    f.changeScope()
    f.scope.setConfiguring.mockClear()
    f.resolve({ status: "configured", settings: {} })
    await old
    expect(f.scope.setConfiguring).not.toHaveBeenCalled()
    expect(f.scope.applyConfigureResult).not.toHaveBeenCalled()
    expect(f.scope.openWithIde).not.toHaveBeenCalled()
    const current = f.run()
    f.resolve({ status: "configured", settings: {} })
    await current
    expect(f.scope.openWithIde).toHaveBeenCalledTimes(1)
  })

  it("never publishes superseded settings or opens the old IDE", async () => {
    const f = fixture(), pending = f.run()
    f.resolve({ status: "superseded", settings: { preferredIde: "webstorm" } })
    await pending
    expect(f.scope.applyConfigureResult).not.toHaveBeenCalled()
    expect(f.scope.openWithIde).not.toHaveBeenCalled()
    expect(f.scope.configuringRef.current).toBe(false)
  })

  it("releases pending state after an IPC failure so a user can retry", async () => {
    const f = fixture(), first = f.run()
    f.reject(Error("IPC_UNAVAILABLE"))
    await first
    expect(f.scope.setDialogMessage).toHaveBeenCalledWith("IPC_UNAVAILABLE")
    expect(f.scope.configuringRef.current).toBe(false)
    const retry = f.run()
    f.resolve({ status: "configured", settings: {} })
    await retry
    expect(f.configurePreferred).toHaveBeenCalledTimes(2)
    expect(f.scope.openWithIde).toHaveBeenCalledTimes(1)
  })

  it.each(["resolve", "reject"] as const)("ignores a late %s after unmount", async outcome => {
    const f = fixture(), pending = f.run()
    f.dispose()
    f.scope.setConfiguring.mockClear()
    if (outcome === "resolve") f.resolve({ status: "configured", settings: {} })
    else f.reject(Error("LATE_FAILURE"))
    await pending
    expect(f.scope.setConfiguring).not.toHaveBeenCalled()
    expect(f.scope.setDialogMessage).not.toHaveBeenCalled()
    expect(f.scope.applyConfigureResult).not.toHaveBeenCalled()
    expect(f.scope.openWithIde).not.toHaveBeenCalled()
  })
})

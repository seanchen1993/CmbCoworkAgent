import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

function productionExpression(file: string, select: (node: ts.Node) => boolean, scope: object) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const matches: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && select(node)) matches.push(node.initializer)
    ts.forEachChild(node, walk)
  }
  walk(source)
  expect(matches).toHaveLength(1)
  const code = ts.transpileModule(`(${matches[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, scope)
}

it("preserves native site and Pane scopes through the actual main/preload notification bridge", () => {
  let listener: ((event: object, value: unknown) => void) | undefined
  const on = vi.fn((_channel, value) => {
    listener = value
  })
  const removeListener = vi.fn()
  const subscribe = productionExpression(
    "src/preload/index.ts",
    (node) => ts.isPropertyAssignment(node) && node.name.getText() === "onCardsChanged",
    {
      ipcRenderer: { on, removeListener }
    }
  )
  const received = vi.fn()
  const unsubscribe = subscribe(received)
  const send = vi.fn((channel: string, payload: unknown) => {
    expect(channel).toBe("mods:cards-changed")
    listener!({}, payload)
  })
  const changed = productionExpression(
    "src/main/ipc/mods.ts",
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "changed" &&
      ts.isArrowFunction(node.initializer) &&
      node.initializer.parameters.length === 2 &&
      node.initializer.getText().includes('"mods:cards-changed"'),
    {
      window: () => ({ webContents: { send } })
    }
  )
  for (const scope of ["site:actual-owner", "site:second-owner", "site-invalidated:actual-owner", "site-redraw:actual-owner", "panes", "records", "cards", "source-retiring:1", "source-replaced:2", undefined]) {
    changed("actual-thread", scope)
    expect(received).toHaveBeenLastCalledWith({
      threadId: "actual-thread",
      ...(scope === undefined ? {} : { scope })
    })
  }
  expect(on).toHaveBeenCalledWith("mods:cards-changed", expect.any(Function))
  expect(received).toHaveBeenCalledTimes(10)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith("mods:cards-changed", listener)
})


it("passes only known schema notifications through the original configuration IPC listener", () => {
  let listener: ((event: object, value?: unknown) => void) | undefined
  const received = vi.fn()
  const subscribe = productionExpression("src/preload/index.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "onConfigurationChanged", {
      ipcRenderer: { on: (_channel: string, handler: typeof listener) => { listener = handler }, removeListener: vi.fn() }
    })
  subscribe(received)
  const changed = productionExpression("src/main/ipc/mods.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "configChanged", {
      window: () => ({webContents: {send: (_channel: string, payload?: unknown) => listener!({}, payload)}})
    })
  changed("schema")
  expect(received).toHaveBeenLastCalledWith({scope: "schema"})
  changed()
  expect(received).toHaveBeenLastCalledWith(undefined)
  for (const value of [null, "schema", {scope:"unknown"}, {}]) {
    listener!({}, value)
    expect(received).toHaveBeenLastCalledWith(undefined)
  }
})

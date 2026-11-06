import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { modUiChangeAffects } from "../../shared/mods/types"

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
  const reconcileComposition = vi.fn(), reconcileCreatorReuse = vi.fn(), prune = vi.fn()
  const changed = productionExpression(
    "src/main/ipc/mods.ts",
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "changed" &&
      ts.isArrowFunction(node.initializer) &&
      node.initializer.parameters.length === 2 &&
      node.initializer.getText().includes('"mods:cards-changed"'),
    {
      modUiChangeAffects,
      approvalInbox: { prune },
      getCreatorCompositionService: () => ({ reconcile: reconcileComposition }),
      reconcileCreatorReuse,
      window: () => ({ webContents: { send } })
    }
  )
  const scopes = ["site:actual-owner", "site:second-owner", "site-invalidated:actual-owner",
    "site-redraw:actual-owner", "site-projection:row", "site-presentations:AssistantMessage",
    "panes", "placed", "feedback", "records", "cards", "source-retiring:1", "source-replaced:2", undefined]
  for (const scope of scopes) {
    changed("actual-thread", scope)
    expect(received).toHaveBeenLastCalledWith({
      threadId: "actual-thread",
      ...(scope === undefined ? {} : { scope })
    })
  }
  expect(on).toHaveBeenCalledWith("mods:cards-changed", expect.any(Function))
  expect(received).toHaveBeenCalledTimes(scopes.length)
  expect(prune).toHaveBeenCalledTimes(3)
  expect(reconcileComposition.mock.calls).toEqual(Array.from({ length: 3 }, () => ["actual-thread"]))
  expect(reconcileCreatorReuse.mock.calls).toEqual(Array.from({ length: 3 }, () => ["actual-thread"]))
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith("mods:cards-changed", listener)
})

it("notifies a child view only after native admission and removes the preload listener", async () => {
  let listener: ((event: object, payload: unknown) => void) | undefined
  const removeListener = vi.fn()
  const subscribe = productionExpression("src/preload/index.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "onAgentViewRequested", {
    ipcRenderer: {
      on: (channel: string, callback: typeof listener) => {
        expect(channel).toBe("mods:agent-view-requested")
        listener = callback
      },
      removeListener
    }
  })
  const received = vi.fn()
  const unsubscribe = subscribe(received)
  const native = vi.fn(async () => ({ requested: true }))
  const send = vi.fn((channel: string, payload: unknown) => {
    expect(channel).toBe("mods:agent-view-requested")
    listener!({}, payload)
  })
  const agentTask = productionExpression("src/main/ipc/mods.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "agentTask", {
    manager: { functionAgentTask: native },
    window: () => ({ isDestroyed: () => false, webContents: { send, isDestroyed: () => false } })
  })
  await agentTask("workspace", "thread", {}, "agent.status")
  expect(send).not.toHaveBeenCalled()
  native.mockRejectedValueOnce(Error("DENIED"))
  await expect(agentTask("workspace", "thread", {}, "ui.view")).rejects.toThrow("DENIED")
  expect(send).not.toHaveBeenCalled()
  await expect(agentTask("workspace", "thread", {}, "ui.view")).resolves.toEqual({ requested: true })
  expect(received).toHaveBeenCalledExactlyOnceWith({ threadId: "thread" })
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith("mods:agent-view-requested", listener)
})


it("passes only known schema notifications through the original configuration IPC listener", () => {
  let listener: ((event: object, value?: unknown) => void) | undefined
  const received = vi.fn()
  const reconcileComposition = vi.fn(), reconcileCreatorReuse = vi.fn()
  const invalidateEditorNavigation = vi.fn()
  const subscribe = productionExpression("src/preload/index.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "onConfigurationChanged", {
      ipcRenderer: { on: (_channel: string, handler: typeof listener) => { listener = handler }, removeListener: vi.fn() }
    })
  subscribe(received)
  const changed = productionExpression("src/main/ipc/mods.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "configChanged", {
      getCreatorCompositionService: () => ({ reconcile: reconcileComposition }),
      reconcileCreatorReuse,
      editorNavigation: { invalidate: invalidateEditorNavigation },
      window: () => ({webContents: {send: (_channel: string, payload?: unknown) => listener!({}, payload)}})
    })
  changed("schema")
  expect(received).toHaveBeenLastCalledWith({scope: "schema"})
  changed()
  expect(received).toHaveBeenLastCalledWith(undefined)
  expect(reconcileComposition.mock.calls).toEqual([[], []])
  expect(reconcileCreatorReuse.mock.calls).toEqual([[], []])
  expect(invalidateEditorNavigation).toHaveBeenCalledTimes(2)
  for (const value of [null, "schema", {scope:"unknown"}, {}]) {
    listener!({}, value)
    expect(received).toHaveBeenLastCalledWith(undefined)
  }
  expect(received).toHaveBeenCalledTimes(6)
})

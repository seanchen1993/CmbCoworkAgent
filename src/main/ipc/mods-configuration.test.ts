import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

// Execute the actual registered handler/preload subscription without starting Electron.
function expression(file: string, pick: (node: ts.Node) => ts.Node | undefined, scope: object) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  let selected: ts.Node | undefined
  const walk = (node: ts.Node): void => {
    selected = pick(node) ?? selected
    ts.forEachChild(node, walk)
  }
  walk(source)
  if (!selected) throw Error("Missing production handler")
  const code = ts.transpileModule(`(${selected.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, scope)
}

function globalHandler(scope: object, channel = "mods:configure-global") {
  return expression(
    "src/main/ipc/mods.ts",
    (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "ipcMain.handle" &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === channel
      )
        return node.arguments[1]
      return undefined
    },
    scope
  )
}

it("notifies mounted renderers after global off and reenable even with no live sessions", () => {
  let enabled = true
  const events: boolean[] = []
  const send = vi.fn((channel: string) => {
    expect(channel).toBe("mods:configuration-changed")
    events.push(enabled)
  })
  const owner = { isDestroyed: () => false, webContents: { send } }
  const handler = globalHandler({
    trusted: vi.fn(),
    settingsAccess: { assertUnlocked: vi.fn() },
    ModError: Error,
    window: () => owner,
    setModsGlobalEnabled: (value: boolean) => {
      enabled = value
      return value
    },
    manager: { invalidateAll: vi.fn() }
  })
  expect(handler({ sender: {} }, false)).toBe(false)
  expect(handler({ sender: {} }, true)).toBe(true)
  expect(events).toEqual([false, true])
})

it("protects application completion settings with writable scope and the existing settings lock", () => {
  const save = vi.fn(() => ({ source: "application", policy: { mode: "off" } }))
  const send = vi.fn()
  const scope = vi.fn(() => "workspace")
  const unlock = vi.fn<() => void>(() => {
    throw Error("locked")
  })
  const handler = globalHandler(
    {
      writableScope: scope,
      settingsAccess: { assertUnlocked: unlock },
      functions: { setCompletionPolicy: save },
      window: () => ({ isDestroyed: () => false, webContents: { send } })
    },
    "mods:function-completion-policy-set"
  )
  const event = { sender: {} }
  const input = { threadId: "thread", plugin: "plugin", policy: { mode: "off" } }
  expect(() => handler(event, input)).toThrow("locked")
  expect(save).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  unlock.mockImplementation(() => {})
  expect(handler(event, input)).toMatchObject({ source: "application" })
  expect(save).toHaveBeenCalledWith("workspace", "thread", "plugin", input.policy)
  expect(send).toHaveBeenCalledWith("mods:configuration-changed")
  scope.mockImplementation(() => {
    throw Error("read only")
  })
  expect(() => handler(event, input)).toThrow("read only")
  expect(save).toHaveBeenCalledTimes(1)
})

it("does not mutate or broadcast a denied global enable", () => {
  const set = vi.fn()
  const send = vi.fn()
  const handler = globalHandler({
    trusted: vi.fn(),
    settingsAccess: {
      assertUnlocked: () => {
        throw Error("locked")
      }
    },
    ModError: Error,
    window: () => ({ isDestroyed: () => false, webContents: { send } }),
    setModsGlobalEnabled: set,
    manager: { invalidateAll: vi.fn() }
  })
  expect(() => handler({ sender: {} }, true)).toThrow("locked")
  expect(set).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it("delivers the main-process configuration event through preload and removes the listener", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const subscribe = expression(
    "src/preload/index.ts",
    (node) =>
      ts.isPropertyAssignment(node) && node.name.getText() === "onConfigurationChanged"
        ? node.initializer
        : undefined,
    {
      ipcRenderer: {
        on: (channel: string, listener: (...args: unknown[]) => void) =>
          listeners.set(channel, listener),
        removeListener: (channel: string) => listeners.delete(channel)
      }
    }
  )
  const changed = vi.fn()
  const stop = subscribe(changed)
  listeners.get("mods:configuration-changed")?.({})
  expect(changed).toHaveBeenCalledOnce()
  stop()
  expect(listeners.size).toBe(0)
})

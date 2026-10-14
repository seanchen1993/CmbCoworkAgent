import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { ModError } from "../mods/errors"
import { expect, it, vi } from "vitest"
import { readModsChatDisplayCapability } from "./mods-display-capability"

it.each([[false, false, false], [true, false, true], [false, true, true], [true, true, true]])(
  "requires displays for functions=%s or protection=%s", (enabled, protection, expected) => {
    const manager = { isEnabled: vi.fn(() => enabled), protects: vi.fn(() => protection) }
    const access = { workspace: "canonical-worktree", assertCurrent: vi.fn() }
    expect(readModsChatDisplayCapability(manager, access)).toBe(expected)
    expect(manager.isEnabled).toHaveBeenCalledWith(access.workspace)
    expect(manager.protects).toHaveBeenCalledWith(access.workspace)
    expect(access.assertCurrent).toHaveBeenCalledTimes(2)
  }
)

it("fails closed on unknown protection and manager failure", () => {
  const access = { workspace: "workspace", assertCurrent: () => {} }
  const manager = { isEnabled: () => false, protects: () => undefined as unknown as boolean }
  expect(() => readModsChatDisplayCapability(manager, access)).toThrow("MODS_UI_SITE_PROTECTION_REQUIRED")
  manager.protects = () => { throw Error("CONTROL_RECOVERY_REQUIRED") }
  expect(() => readModsChatDisplayCapability(manager, access)).toThrow("CONTROL_RECOVERY_REQUIRED")
})

it("rejects a scope replacement during capability evaluation", () => {
  let current = true
  const access = { workspace: "original", assertCurrent: () => {
    if (!current) throw Error("MODS_SCOPE_CHANGED")
  } }
  const manager = { isEnabled: () => false, protects: () => { current = false; return false } }
  expect(() => readModsChatDisplayCapability(manager, access)).toThrow("MODS_SCOPE_CHANGED")
})

function handlers(context: Record<string, unknown>): Array<(event: object, input?: unknown) => boolean> {
  const source = ts.createSourceFile("mods.ts", readFileSync(new URL("./mods.ts", import.meta.url),
    "utf8"), ts.ScriptTarget.Latest, true)
  const callbacks: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle" &&
      node.arguments[0]?.getText(source) === '"mods:chat-display-capability"')
      callbacks.push(node.arguments[1].getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return callbacks.map(callback => runInNewContext(ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context))
}

it("binds the real IPC handler to canonical expected workspace and trusted sender", () => {
  const trusted = vi.fn((event: { trusted?: boolean }) => {
    if (!event.trusted) throw Error("MODS_IPC_SENDER")
  })
  const manager = { workspaceKey: (value: string) => value.toLowerCase(),
    isEnabled: vi.fn(() => false), protects: vi.fn(() => false) }
  const settingsScope = vi.fn((_event: object, thread: string, expected: string) => {
    if (thread !== "thread" || expected !== "workspace") throw Error("MODS_SCOPE_CHANGED")
    return { workspace: "workspace", assertCurrent: () => {} }
  })
  const registered = handlers({ trusted, manager, settingsScope, readModsChatDisplayCapability,
    ModError, code: "MODS_CONTROL_RECOVERY_REQUIRED" })
  expect(registered).toHaveLength(2)
  const read = registered[1]
  expect(read({ trusted: true }, { threadId: "thread", expectedWorkspace: "WORKSPACE" })).toBe(false)
  expect(settingsScope).toHaveBeenCalledWith({ trusted: true }, "thread", "workspace")
  expect(() => read({}, { threadId: "thread", expectedWorkspace: "workspace" })).toThrow("MODS_IPC_SENDER")
  expect(() => read({ trusted: true }, { threadId: "thread", expectedWorkspace: "other" }))
    .toThrow("MODS_SCOPE_CHANGED")
  expect(() => read({ trusted: true }, { threadId: "thread" })).toThrow("MODS_SCOPE_CHANGED")
  expect(manager.isEnabled).toHaveBeenCalledTimes(1)
  expect(manager.protects).toHaveBeenCalledTimes(1)
  expect(() => registered[0]({ trusted: true })).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
})

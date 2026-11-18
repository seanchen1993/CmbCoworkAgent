import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { ModError } from "../mods/errors"

// Execute the registered recovery handlers together with the actual admission getter.
// No Electron process or healthy manager is created in this startup-failure scenario.
function recoveryFixture(required: boolean | "unknown" = false) {
  const source = ts.createSourceFile("mods.ts", readFileSync(new URL("./mods.ts", import.meta.url),
    "utf8"), ts.ScriptTarget.Latest, true)
  const callbacks = new Map<string, string>()
  let recoveryStatus = ""
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "recoveryStatus")
      recoveryStatus = node.initializer!.getText(source)
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0])) {
      const name = node.arguments[0].text
      if (!callbacks.has(name)) callbacks.set(name, node.arguments[1].getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const managerSource = ts.createSourceFile("manager.ts",
    readFileSync(new URL("../mods/manager.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true)
  const getter = managerSource.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "getModsManager")!
  let state: boolean | undefined = true
  const code = "MODS_CONTROL_RECOVERY_REQUIRED"
  const send = vi.fn()
  const write = vi.fn((value: boolean) => { state = value; return value })
  const trusted = (event: { trusted?: boolean }) => {
    if (!event.trusted) throw new ModError("MODS_IPC_SENDER")
  }
  const getModsGlobalEnabledState = () => state
  const context = {
    code, ModError, trusted, deployment: required === "unknown" ? undefined : { required },
    getModsGlobalEnabledState, setModsGlobalEnabled: write,
    window: () => ({ isDestroyed: () => false, webContents: { send, isDestroyed: () => false } }),
    manager: undefined,
    unavailable: { code, optional: required === false, globalEnabled: getModsGlobalEnabledState }
  }
  const compile = (text: string) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const getModsManager: () => unknown = runInNewContext(
    compile(`(${getter.getText(managerSource).replace(/^export\s+/, "")})`), context)
  const handler = (name: string): ((event: object, value?: unknown) => unknown) =>
    runInNewContext(compile(`(${callbacks.get(name) === "recoveryStatus"
      ? recoveryStatus : callbacks.get(name)})`), { ...context, getModsManager })
  return { read: handler("mods:global-enabled"), status: handler("mods:status"),
    recoveryStatus: handler("mods:recovery-status"),
    configure: handler("mods:configure-global"), display: handler("mods:chat-display-capability"),
    getModsManager, send, write, state: (value: boolean | undefined) => { state = value } }
}

describe("unavailable optional Mods recovery", () => {
  const event = { trusted: true }
  it("reports the persisted on switch and restores ordinary admission after explicit opt-out", () => {
    const fixture = recoveryFixture()
    expect(fixture.read(event)).toBe(false)
    expect(fixture.status(event)).toMatchObject({ globalEnabled: true, recoveryCanDisable: true })
    expect(fixture.recoveryStatus(event)).toEqual(fixture.status(event))
    expect(() => fixture.getModsManager()).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
    expect(() => fixture.display(event)).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
    expect(fixture.configure(event, false)).toBe(false)
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith(false)
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("mods:configuration-changed")
    expect(fixture.read(event)).toBe(false)
    expect(fixture.getModsManager()).toBeUndefined()
    expect(fixture.display(event)).toBe(false)
    expect(() => fixture.configure(event, true)).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  })
  it.each([true, "unknown"] as const)("keeps required=%s policy closed", (required) => {
    assertClosedRecovery(recoveryFixture(required), event)
  })
  it("rejects untrusted callers and malformed switches before writing", () => {
    const fixture = recoveryFixture()
    for (const handler of [fixture.read, fixture.status, fixture.configure, fixture.recoveryStatus])
      expect(() => handler({}, false)).toThrow("MODS_IPC_SENDER")
    for (const value of [undefined, null, 0, "false"])
      expect(() => fixture.configure(event, value)).toThrow("MODS_SETTINGS_INVALID")
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it("keeps an unknown configured switch distinct from disabled capability and failed writes", () => {
    const fixture = recoveryFixture()
    fixture.state(undefined)
    expect(fixture.read(event)).toBe(false)
    expect(fixture.status(event)).toMatchObject({ globalEnabled: undefined })
    expect(() => fixture.getModsManager()).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
    fixture.write.mockImplementation(() => { throw Error("settings write failed") })
    expect(() => fixture.configure(event, false)).toThrow("settings write failed")
    expect(fixture.send).not.toHaveBeenCalled()
    expect(() => fixture.getModsManager()).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  })
  it("retains a committed opt-out when its window closes before notification", () => {
    const fixture = recoveryFixture()
    fixture.send.mockImplementation(() => { throw Error("webContents destroyed") })
    expect(fixture.configure(event, false)).toBe(false)
    expect(fixture.status(event)).toMatchObject({ globalEnabled: false })
    expect(fixture.getModsManager()).toBeUndefined()
  })
})

function assertClosedRecovery(fixture: ReturnType<typeof recoveryFixture>, event: object) {
  fixture.state(false)
  expect(() => fixture.configure(event, false)).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  expect(() => fixture.getModsManager()).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  expect(fixture.status(event)).toMatchObject({ recoveryCanDisable: false })
  expect(fixture.write).not.toHaveBeenCalled()
}

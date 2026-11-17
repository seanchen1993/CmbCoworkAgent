import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { ModError } from "../mods/errors"
import { expect, it, vi } from "vitest"
import { assertUnboundModsChatHistory, readModsChatDisplayCapability } from "./mods-display-capability"
import { CreatorBusinessService } from "../mods/devtools/creator-business"
import { CreatorBusinessTrials } from "../mods/devtools/creator-business-trial"
import { BusinessModAssemblyService } from "../plugins/business-mod-assembly-service"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"

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
  }).outputText, { deployment: undefined, ...context }))
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
    ModError })
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
})

it("keeps the unavailable-manager display decision aligned with ordinary chat admission", () => {
  const trusted = vi.fn((event: { trusted?: boolean }) => {
    if (!event.trusted) throw Error("MODS_IPC_SENDER")
  })
  const getModsManager = vi.fn(() => undefined)
  const getThreadCanonicalIdentity = vi.fn(() => ({ metadata: '{"workspacePath":null}' }))
  const input = { threadId: "unbound-thread", expectedWorkspace: null }
  const [read] = handlers({ trusted, getModsManager, getThreadCanonicalIdentity,
    assertUnboundModsChatHistory })

  expect(() => read({})).toThrow("MODS_IPC_SENDER")
  expect(getModsManager).not.toHaveBeenCalled()
  expect(read({ trusted: true })).toBe(false)
  expect(read({ trusted: true }, input)).toBe(false)
  expect(getThreadCanonicalIdentity).toHaveBeenCalledExactlyOnceWith(input.threadId)

  getModsManager.mockImplementation(() => {
    throw new ModError("MODS_CONTROL_RECOVERY_REQUIRED")
  })
  expect(() => read({ trusted: true })).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  expect(() => read({ trusted: true }, input)).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
  expect(getThreadCanonicalIdentity).toHaveBeenCalledTimes(1)
})

it("grants workspace-free history only for an existing unbound thread in optional-off mode", () => {
  const input = { threadId: "unbound-thread", expectedWorkspace: null }
  const trusted = ({ allowed }: { allowed?: boolean }) => {
    if (!allowed) throw new ModError("MODS_IPC_SENDER")
  }
  const deployment = { required: false }
  const globalState = vi.fn<() => boolean | undefined>(() => false)
  const getThreadCanonicalIdentity = vi.fn<(id: string) => { metadata: unknown } | null>(
    () => ({ metadata: '{"workspacePath":null}' })
  )
  const [, read] = handlers({ trusted, deployment, getThreadCanonicalIdentity, assertUnboundModsChatHistory,
    getModsGlobalEnabledState: globalState, ModError })
  const allowed = { allowed: true }
  expect(() => read({}, input)).toThrow("MODS_IPC_SENDER")
  expect(getThreadCanonicalIdentity).not.toHaveBeenCalled()
  expect(read(allowed, input)).toBe(false)
  expect(getThreadCanonicalIdentity).toHaveBeenCalledExactlyOnceWith(input.threadId)
  for (const metadata of [null, "{}"]) {
    getThreadCanonicalIdentity.mockReturnValue({ metadata })
    expect(read(allowed, input)).toBe(false)
  }
  for (const metadata of ['{"workspacePath":"C:/other"}', '{"workspacePath":""}', "[]", "null"]) {
    getThreadCanonicalIdentity.mockReturnValue({ metadata })
    expect(() => read(allowed, input)).toThrow("MODS_SCOPE_CHANGED")
  }
  getThreadCanonicalIdentity.mockReturnValue({ metadata: Buffer.from("{}") })
  expect(() => read(allowed, input)).toThrow("MODS_SCOPE_CHANGED")
  getThreadCanonicalIdentity.mockReturnValue({ metadata: "{" })
  expect(() => read(allowed, input)).toThrow()
  getThreadCanonicalIdentity.mockReturnValue(null)
  expect(() => read(allowed, input)).toThrow("MODS_THREAD_MISSING")
  expect(() => read(allowed, { ...input, threadId: "" })).toThrow("MODS_THREAD_INVALID")
  getThreadCanonicalIdentity.mockClear()
  for (const state of [true, undefined]) {
    globalState.mockReturnValue(state)
    expect(() => read(allowed, input)).toThrow("MODS_SCOPE_CHANGED")
  }
  globalState.mockReturnValue(false)
  deployment.required = true
  expect(() => read(allowed, input)).toThrow("MODS_SCOPE_CHANGED")
  expect(getThreadCanonicalIdentity).not.toHaveBeenCalled()
})

it("opens history in a missing workspace only for the saved thread and confirmed optional-off policy", () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "mods-display-offline-"))
  try {
    const offline = join(root, "repository-no-longer-mounted")
    const input = { threadId: "saved-thread", expectedWorkspace: offline }
    const trusted = ({ allowed }: { allowed?: boolean }) => {
      if (!allowed) throw new ModError("MODS_IPC_SENDER")
    }
    const manager = { workspaceKey: vi.fn((path: string) => realpathSync(path)) }
    const deployment = { required: false }
    const globalState = vi.fn<() => boolean | undefined>(() => false)
    const readThreadWorkspacePath = vi.fn((threadId: string) => {
      if (threadId !== input.threadId) throw new ModError("MODS_THREAD_MISSING")
      return offline
    })
    const [, read] = handlers({ trusted, manager, deployment, readThreadWorkspacePath,
      getModsGlobalEnabledState: globalState, ModError })
    expect(() => read({}, input)).toThrow("MODS_IPC_SENDER")
    expect(read({ allowed: true }, input)).toBe(false)
    expect(manager.workspaceKey).not.toHaveBeenCalled()
    expect(() => read({ allowed: true }, { ...input, threadId: "other-thread" }))
      .toThrow("MODS_THREAD_MISSING")
    expect(() => read({ allowed: true }, { ...input, expectedWorkspace: join(root, "other") }))
      .toThrow("ENOENT")
    globalState.mockReturnValue(true)
    expect(() => read({ allowed: true }, input)).toThrow("ENOENT")
    globalState.mockReturnValue(undefined)
    expect(() => read({ allowed: true }, input)).toThrow("ENOENT")
    globalState.mockReturnValue(false)
    deployment.required = true
    expect(() => read({ allowed: true }, input)).toThrow("ENOENT")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("leaves ordinary chat available when optional Creator receipts and snapshots are unreadable", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "mods-creator-startup-"))
  let creator: CreatorBusinessService | undefined
  let trials: CreatorBusinessTrials | undefined
  try {
    const broken = join(root, "creator-business-assemblies", "06872ad8-bd4a-4f9f-990c-3c282370d9bd")
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, "receipt.json"), "{}")
    const trialRoot = join(root, "creator-business", "trials")
    mkdirSync(trialRoot, { recursive: true })
    writeFileSync(join(trialRoot, "stage-checks.sqlite"), "invalid SQLite contents".repeat(128))
    writeFileSync(join(trialRoot, "packages"), "not a directory")

    const source = ts.createSourceFile("mods.ts", readFileSync(new URL("./mods.ts", import.meta.url),
      "utf8"), ts.ScriptTarget.Latest, true)
    const register = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "registerModsHandlers")
    const initializers = register?.body?.statements.filter((node) =>
      ts.isVariableStatement(node) && node.declarationList.declarations.some(({ name }) =>
        ts.isIdentifier(name) && [
          "creatorBusinessAssembly", "creatorBusiness", "creatorBusinessTrials"
        ].includes(name.text)))
    expect(initializers?.some((node) => node.getText(source).includes("new CreatorBusinessService")))
      .toBe(true)

    const opened = vi.fn()
    const context = {
      scope: { threadId: "creator", workspace: root, incarnation: { token: "one", legacyCreatedAt: 1 } },
      assertCurrent() {}
    }
    const manager = { store: { getSetting: (_key: string, fallback?: string) => fallback },
      workspaceKey: (workspace: string) => workspace,
      isEnabled: () => false, protects: () => false }
    const noOp = () => {}
    const sandbox = {
      manager, join, CreatorBusinessService, CreatorBusinessTrials,
      BusinessModAssemblyService: function (...args: ConstructorParameters<typeof BusinessModAssemblyService>) {
        opened()
        return new BusinessModAssemblyService(...args)
      },
      getOpenworkDir: () => root,
      readDeliveryPlugins: () => [{ id: "installed", path: root, name: "Source", version: "1", enabled: true }],
      development: { projectAuthoringContext: () => context, reuseContext: () => context },
      inspectCompletePluginDirectory: noOp, installDerivedPluginDirectory: noOp,
      onLocalThreadRunLeaseReleased: () => noOp,
      functions: { onConfigurationIdle: () => noOp },
      trusted: noOp, ModError, readModsChatDisplayCapability,
      settingsScope: () => ({ workspace: root, assertCurrent: noOp })
    }
    const pending = initializers!.map((node) => node.getText(source)).join("\n")
    const initialized = runInNewContext(
      ts.transpileModule(`(() => {\n${pending}\nreturn { creatorBusiness, creatorBusinessTrials }\n})()`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
      }).outputText,
      { ...sandbox, manager: { ...manager, functionTurns: { onSettled: () => noOp } } }
    ) as {
      creatorBusiness: CreatorBusinessService
      creatorBusinessTrials: CreatorBusinessTrials
    }
    creator = initialized.creatorBusiness
    trials = initialized.creatorBusinessTrials
    const [, read] = handlers(sandbox)
    expect(read({}, { threadId: "chat", expectedWorkspace: root })).toBe(false)
    expect(opened).not.toHaveBeenCalled()
    await expect(creator.inspect("creator", "installed")).rejects.toThrow("业务 Mods 生成记录损坏")
    expect(opened).toHaveBeenCalledOnce()
    await expect(trials.request(context.scope, "checked-plan", {
      copyId: "checked-copy", digest: "a".repeat(64), name: "Source", version: "1.0.0", sources: []
    }, "Produce a checked artifact")).rejects.toThrow(/EEXIST|ENOTDIR/)
    expect(read({}, { threadId: "chat", expectedWorkspace: root })).toBe(false)
  } finally {
    trials?.close()
    creator?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

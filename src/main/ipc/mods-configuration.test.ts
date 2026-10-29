import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { nativeChildThreadReaders } from "./native-child-mods.test-helper"

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
  const context = { ModError: Error, ...scope }
  const settingsScope = expression("src/main/ipc/mods.ts", node =>
    ts.isFunctionDeclaration(node) && node.name?.text === "settingsScope" ? node : undefined,
    context)
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
    { ...context, settingsScope }
  )
}

it.each([
  ["mods:configure", { enabled: true, outputPolicy: false }],
  ["mods:revoke", { modId: "mod" }],
  ["mods:revoke-function", { name: "function" }],
  ["mods:approve", { pluginId: "plugin", digest: "a".repeat(64) }],
  ["mods:function-completion-policy-set", { plugin: "plugin", policy: { mode: "off" } }],
  ["mods:function-completion-policy", { plugin: "plugin" }],
  ["mods:audit", {}]
])("rejects stale displayed workspace on %s before accessing its data", (channel, input) => {
  const data = vi.fn()
  const handler = globalHandler({ scope: () => "B", writableScope: () => "B",
    functions: { completionPolicy: data }, manager: { store: { audit: data } } }, channel)
  expect(() => handler({}, { threadId: "thread", expectedWorkspace: "A", ...input }))
    .toThrow("MODS_SCOPE_CHANGED")
  expect(data).not.toHaveBeenCalled()
})

it.each(["composition", "reuse"])(
  "notifies committed workspace settings even when subsequent %s reconciliation fails", (failure) => {
    let enabled = false
    const send = vi.fn((channel: string) => {
      expect(channel).toBe("mods:configuration-changed")
      expect(enabled).toBe(true)
    })
    const reconcile = (kind: string) => () => { if (kind === failure) throw Error("RECONCILE_FAILED") }
    const handler = globalHandler({
      scope: () => "workspace", writableScope: () => "workspace",
      captureThreadIncarnation, matchesThreadIncarnation,
      getThreadCore: () => ({ thread_id: "thread", created_at: 1, metadata: null }),
      manager: { configure: (_workspace: string, value: boolean) => { enabled = value } },
      creatorComposition: { reconcile: reconcile("composition") },
      creatorReuse: { reconcileAuthorizations: reconcile("reuse") },
      window: () => ({ isDestroyed: () => false, webContents: { send } })
    }, "mods:configure")
    expect(() => handler({}, { threadId: "thread", expectedWorkspace: "workspace",
      enabled: true, outputPolicy: false })).toThrow("RECONCILE_FAILED")
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it.each(["workspace", "incarnation", "frame"])(
  "rejects reconciliation after dialog wait when %s changes", async change => {
    let workspace = "A"
    let row = { created_at: 1, metadata: null }
    const event = { sender: { mainFrame: {} } }
    const dialog = Promise.withResolvers<{ response: number }>()
    const reconcile = vi.fn()
    const handler = globalHandler({ scope: () => workspace,
      getThreadCore: () => row, captureThreadIncarnation, matchesThreadIncarnation,
      window: () => ({}), dialog: { showMessageBox: () => dialog.promise },
      manager: { store: { reconcile } }
    }, "mods:reconcile")
    const pending = handler(event, { threadId: "thread", expectedWorkspace: "A",
      callId: "call", resolution: "confirmed-success" })
    if (change === "workspace") workspace = "B"
    if (change === "incarnation") row = { created_at: 2, metadata: null }
    if (change === "frame") event.sender.mainFrame = {}
    dialog.resolve({ response: 1 })
    await expect(pending).rejects.toThrow("MODS_SCOPE_CHANGED")
    expect(reconcile).not.toHaveBeenCalled()
  }
)

it("forwards each settings control's displayed workspace through the actual preload", async () => {
  const invoke = vi.fn(async () => undefined)
  const calls: [string, unknown[], string][] = [
    ["configure", ["thread", true, false], "mods:configure"],
    ["revokeFunction", ["thread", "function"], "mods:revoke-function"],
    ["approve", ["thread", "plugin", "a".repeat(64)], "mods:approve"],
    ["revoke", ["thread", "mod"], "mods:revoke"],
    ["completionPolicy", ["thread", "plugin"], "mods:function-completion-policy"],
    ["setCompletionPolicy", ["thread", "plugin", { mode: "off" }], "mods:function-completion-policy-set"],
    ["autobizEnvironment", ["thread"], "mods:function-autobiz-environment"],
    ["userConfig", ["thread", "plugin"], "mods:user-config"],
    ["audit", ["thread", undefined], "mods:audit"],
    ["reconcile", ["thread", "call", "confirmed-success"], "mods:reconcile"],
    ["checkFunctionCompatibility", ["thread", "plugin", "a".repeat(64)], "mods:check-function-compatibility"]
  ]
  for (const [name, args, channel] of calls) {
    const call = expression("src/preload/index.ts", node =>
      ts.isPropertyAssignment(node) && node.name.getText() === name &&
        node.initializer.getText().includes('"' + channel + '"') ? node.initializer : undefined,
      { ipcRenderer: { invoke } })
    await call(...args, "displayed-workspace")
    expect(invoke).toHaveBeenLastCalledWith(channel,
      expect.objectContaining({ threadId: "thread", expectedWorkspace: "displayed-workspace" }))
  }
})

/** Execute the real trust and thread helpers; only the OS/Electron boundary is supplied here. */
function composerRouteFixture() {
  const source = ts.createSourceFile("mods.ts",
    readFileSync(resolve("src/main/ipc/mods.ts"), "utf8"), ts.ScriptTarget.Latest, true)
  const names = new Set(["trusted", "readThreadWorkspacePath", "threadScope", "scope"])
  const helpers: ts.FunctionDeclaration[] = []
  let registration: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) helpers.push(node)
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "mods:composer-enabled")
      registration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (helpers.length !== 4 || !registration) throw Error("Missing actual composer route")
  const directory = "C:/native/main"
  const frame = { url: pathToFileURL(join(directory, "../renderer/index.html")).href }
  const sender = { mainFrame: frame }
  const event = { sender, senderFrame: frame }
  const owner = { webContents: sender }
  let metadata: unknown = JSON.stringify({ workspacePath: "C:/logical-project" })
  let row: { metadata: unknown } | undefined = { get metadata() { return metadata } }
  let enabled = false
  const getThreadCore = vi.fn((id: string) => id === "thread" ? row : undefined)
  const workspaceKey = vi.fn(() => "C:/actual-project")
  const isEnabled = vi.fn(() => enabled)
  const status = vi.fn(), candidates = vi.fn(), approve = vi.fn()
  const code = ts.transpileModule([
    ...helpers.map(node => node.getText(source)), registration.getText(source),
    "threadScope"
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  let handler: ((event: unknown, threadId: unknown) => unknown) | undefined
  const threadScope = runInNewContext(code, {
    ipcMain: { handle: (_channel: string, value: typeof handler) => { handler = value } },
    process: { env: {} }, URL, __dirname: directory,
    join, pathToFileURL, window: () => owner, getThreadCore,
    getThreadRuntimeScope: getThreadCore,
    ...nativeChildThreadReaders(getThreadCore),
    manager: { workspaceKey, isEnabled, status, candidates, approve }, ModError: Error
  }) as (threadId: string) => string
  if (!handler) throw Error("Actual composer route was not registered")
  return { handler, threadScope, event, sender, frame, getThreadCore, workspaceKey, isEnabled,
    status, candidates, approve, setEnabled(value: boolean) { enabled = value },
    setMetadata(value: unknown) { metadata = value }, removeThread() { row = undefined } }
}

it("returns the actual logical workspace while querying current canonical settings once", () => {
  const f = composerRouteFixture()
  expect(f.handler(f.event, "thread")).toEqual({ workspace: "C:/logical-project", enabled: false })
  f.setEnabled(true)
  f.setMetadata({ workspacePath: "C:/logical-project" })
  expect(f.handler(f.event, "thread")).toEqual({ workspace: "C:/logical-project", enabled: true })
  expect(f.getThreadCore.mock.calls).toEqual([["thread"], ["thread"]])
  expect(f.workspaceKey.mock.calls).toEqual([["C:/logical-project"], ["C:/logical-project"]])
  expect(f.isEnabled.mock.calls).toEqual([["C:/actual-project"], ["C:/actual-project"]])
  expect(f.status).not.toHaveBeenCalled()
  expect(f.candidates).not.toHaveBeenCalled()
  expect(f.approve).not.toHaveBeenCalled()
  expect(f.threadScope("thread")).toBe("C:/actual-project")
})

it("rejects a foreign window, child frame or origin before reading thread/settings", () => {
  const f = composerRouteFixture()
  expect(() => f.handler({ sender: {}, senderFrame: f.frame }, "thread"))
    .toThrow("MODS_IPC_SENDER")
  expect(() => f.handler({ sender: f.sender, senderFrame: { ...f.frame } }, "thread"))
    .toThrow("MODS_IPC_SENDER")
  f.frame.url = "https://foreign.invalid/"
  expect(() => f.handler(f.event, "thread")).toThrow("MODS_IPC_ORIGIN")
  expect(f.getThreadCore).not.toHaveBeenCalled()
  expect(f.workspaceKey).not.toHaveBeenCalled()
  expect(f.isEnabled).not.toHaveBeenCalled()
})

it("preserves original thread, metadata and settings errors instead of defaulting to OFF", () => {
  const f = composerRouteFixture()
  expect(() => f.handler(f.event, 17)).toThrow("MODS_THREAD_INVALID")
  expect(() => f.handler(f.event, "x".repeat(201))).toThrow("MODS_THREAD_INVALID")
  expect(f.getThreadCore).not.toHaveBeenCalled()
  expect(() => f.handler(f.event, "missing")).toThrow("MODS_THREAD_MISSING")
  f.setMetadata("{bad JSON")
  expect(() => f.handler(f.event, "thread")).toThrow()
  f.setMetadata({ workspacePath: 17 })
  expect(() => f.handler(f.event, "thread")).toThrow("MODS_WORKSPACE_REQUIRED")
  expect(f.isEnabled).not.toHaveBeenCalled()
  f.setMetadata({ workspacePath: "C:/logical-project" })
  f.isEnabled.mockImplementationOnce(() => { throw Error("ACTUAL_SETTINGS_FAILED") })
  expect(() => f.handler(f.event, "thread")).toThrow("ACTUAL_SETTINGS_FAILED")
})

it("uses the actual preload route channel with only the original thread id", async () => {
  const result = { workspace: "C:/logical-project", enabled: false }
  const invoke = vi.fn(async () => result)
  const read = expression("src/preload/index.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "composerEnabled"
      ? node.initializer : undefined, { ipcRenderer: { invoke } })
  expect(await read("thread")).toBe(result)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mods:composer-enabled", "thread")
})

it("refreshes mounted controls only after actual approval commits, including an empty old Session", async () => {
  const ready = Promise.withResolvers<void>()
  const send = vi.fn()
  const approve = vi.fn(() => ready.promise)
  const handler = globalHandler({
    scope: () => "workspace", ModError: Error, functions: { approve },
    window: () => ({ isDestroyed: () => false, webContents: { send } })
  }, "mods:approve-function")
  const input = { threadId: "thread", pluginId: "plugin", digest: "a".repeat(64) }
  const pending = handler({}, input)
  expect(send).not.toHaveBeenCalled()
  ready.resolve()
  await pending
  expect(approve).toHaveBeenCalledWith("workspace", "plugin", input.digest)
  expect(send).toHaveBeenCalledExactlyOnceWith("mods:configuration-changed")
  approve.mockRejectedValueOnce(Error("GRANT_FAILED"))
  await expect(handler({}, input)).rejects.toThrow("GRANT_FAILED")
  expect(send).toHaveBeenCalledTimes(1)
})

it("notifies the renderer after revoking a component, with no retired Session required", () => {
  const send = vi.fn(), revoke = vi.fn()
  const reconcileComposition = vi.fn(), reconcileReuse = vi.fn()
  const handler = globalHandler({
    scope: () => "workspace", ModError: Error, functions: { revoke },
    creatorComposition: { reconcile: reconcileComposition },
    creatorReuse: { reconcileAuthorizations: reconcileReuse },
    window: () => ({ isDestroyed: () => false, webContents: { send } })
  }, "mods:revoke-function")
  handler({}, { threadId: "thread", name: "actual" })
  expect(revoke).toHaveBeenCalledWith("workspace", "actual")
  expect(reconcileComposition).toHaveBeenCalledExactlyOnceWith()
  expect(reconcileReuse).toHaveBeenCalledExactlyOnceWith()
  expect(reconcileComposition.mock.invocationCallOrder[0])
    .toBeGreaterThan(revoke.mock.invocationCallOrder[0])
  expect(reconcileReuse.mock.invocationCallOrder[0])
    .toBeGreaterThan(revoke.mock.invocationCallOrder[0])
  expect(send.mock.invocationCallOrder[0])
    .toBeGreaterThan(reconcileReuse.mock.invocationCallOrder[0])
  expect(send).toHaveBeenCalledExactlyOnceWith("mods:configuration-changed")
})

it.each(["workspace", "incarnation", "frame"])(
  "does not commit a scoped formal approval after its %s changes", async change => {
    let workspace = "workspace"
    let row = { created_at: 1, metadata: null as string | null }
    const event = { sender: { mainFrame: {} } }
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    const committed = vi.fn(), send = vi.fn()
    const approve = vi.fn(async (_workspace: string, _plugin: string, _digest: string,
      assertCurrent: () => void) => {
      assertCurrent()
      entered.resolve()
      await resume.promise
      assertCurrent()
      committed()
    })
    const handler = globalHandler({
      scope: () => workspace, ModError: Error, functions: { approve },
      getThreadCore: () => row, captureThreadIncarnation, matchesThreadIncarnation,
      window: () => ({ isDestroyed: () => false, webContents: { send } })
    }, "mods:approve-function")
    const input = { threadId: "thread", pluginId: "plugin", digest: "a".repeat(64),
      expectedWorkspace: "other" }
    await expect(handler(event, input)).rejects.toThrow("MODS_APPROVAL_SCOPE_CHANGED")
    expect(approve).not.toHaveBeenCalled()
    input.expectedWorkspace = "workspace"
    const pending = handler(event, input)
    await entered.promise
    if (change === "workspace") workspace = "other"
    if (change === "incarnation") row = { created_at: 2, metadata: null }
    if (change === "frame") event.sender.mainFrame = {}
    resume.resolve()
    await expect(pending).rejects.toThrow("MODS_APPROVAL_SCOPE_CHANGED")
    expect(committed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  }
)

it("preserves legacy approval payload and forwards the optional formal reuse workspace", async () => {
  const invoke = vi.fn(async () => undefined)
  const approve = expression("src/preload/index.ts", node =>
    ts.isPropertyAssignment(node) && node.name.getText() === "approveFunction"
      ? node.initializer : undefined, { ipcRenderer: { invoke } })
  const digest = "a".repeat(64)
  await approve("thread", "plugin", digest)
  expect(invoke).toHaveBeenLastCalledWith("mods:approve-function", {
    threadId: "thread", pluginId: "plugin", digest
  })
  await approve("thread", "plugin", digest, "workspace")
  expect(invoke).toHaveBeenLastCalledWith("mods:approve-function", {
    threadId: "thread", pluginId: "plugin", digest, expectedWorkspace: "workspace"
  })
})

it("validates peer query payload and binds it to the trusted thread workspace", () => {
  const listFunctionPeerMessages = vi.fn(() => [])
  const scope = vi.fn(() => "/trusted")
  const handler = globalHandler(
    { scope, ModError: Error, manager: { listFunctionPeerMessages } },
    "mods:peer-messages"
  )
  for (const input of [null, "thread", {}, { threadId: 1 }, { threadId: "" }])
    expect(() => handler({}, input)).toThrow("MODS_IPC_ARGUMENTS")
  expect(listFunctionPeerMessages).not.toHaveBeenCalled()
  const event = {}
  expect(handler(event, { threadId: "thread" })).toEqual([])
  expect(scope).toHaveBeenCalledWith(event, "thread")
  expect(listFunctionPeerMessages).toHaveBeenCalledWith("/trusted", "thread")
})

it.each([
  undefined,
  null,
  {},
  { pluginId: "", digest: "a".repeat(64) },
  { pluginId: "x".repeat(257), digest: "a".repeat(64) },
  { pluginId: "plugin", digest: "not-a-digest" },
  { pluginId: "plugin", digest: "A".repeat(64) }
])("rejects malformed compatibility-check input %j before starting a VM", async (input) => {
  const check = vi.fn()
  const handler = globalHandler(
    {
      scope: () => "workspace",
      ModError: Error,
      functions: { checkCompatibility: check }
    },
    "mods:check-function-compatibility"
  )
  await expect(handler({}, input)).rejects.toThrow("MODS_GRANT_INVALID")
  expect(check).not.toHaveBeenCalled()
})

it("does not inspect plugins for an unauthorized compatibility reader", async () => {
  const check = vi.fn()
  const handler = globalHandler(
    {
      scope: () => {
        throw Error("UNAUTHORIZED")
      },
      ModError: Error,
      functions: { checkCompatibility: check }
    },
    "mods:check-function-compatibility"
  )
  await expect(
    handler({}, { threadId: "thread", pluginId: "plugin", digest: "a".repeat(64) })
  ).rejects.toThrow("UNAUTHORIZED")
  expect(check).not.toHaveBeenCalled()
})

it("withholds compatibility results if the project scope changes during inspection", async () => {
  let workspace = "project-a"
  let release!: () => void
  const check = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const handler = globalHandler(
    {
      scope: () => workspace,
      ModError: Error,
      functions: { checkCompatibility: check }
    },
    "mods:check-function-compatibility"
  )
  const input = { threadId: "thread", pluginId: "plugin", digest: "a".repeat(64) }
  const pending = handler({}, input)
  workspace = "project-b"
  release()
  await expect(pending).rejects.toThrow("MODS_SCOPE_CHANGED")
  expect(check).toHaveBeenCalledWith("project-a", input.pluginId, input.digest)
})

it("performs a read-only compatibility check without granting execution permissions", async () => {
  const result = { digest: "a".repeat(64), compatibility: { status: "partial" } }
  const check = vi.fn(async () => result)
  const grant = vi.fn()
  const handler = globalHandler(
    {
      scope: () => "workspace",
      ModError: Error,
      functions: { checkCompatibility: check, approve: grant }
    },
    "mods:check-function-compatibility"
  )
  expect(await handler({}, { threadId: "thread", pluginId: "plugin", digest: result.digest })).toBe(
    result
  )
  expect(grant).not.toHaveBeenCalled()
})

it("rechecks project scope after environment inspection", async () => {
  let workspace = "project-a"
  let release!: () => void
  const probe = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const read = vi.fn(() => ({ source: "application", policy: { mode: "off" } }))
  const handler = globalHandler(
    {
      scope: () => workspace,
      inspectAutobizEnvironment: probe,
      functions: { completionPolicy: read }
    },
    "mods:function-autobiz-environment"
  )
  const request = handler({}, "thread")
  workspace = "project-b"
  release()
  await expect(request).rejects.toThrow("MODS_SCOPE_CHANGED")
  expect(read).not.toHaveBeenCalled()
})

it("does not probe dependencies for an unauthorized policy reader", async () => {
  const probe = vi.fn()
  const handler = globalHandler(
    {
      scope: () => {
        throw Error("unauthorized")
      },
      inspectAutobizEnvironment: probe
    },
    "mods:function-autobiz-environment"
  )
  await expect(handler({}, "thread")).rejects.toThrow("unauthorized")
  expect(probe).not.toHaveBeenCalled()
})

it("reads ordinary completion rules without starting external environment processes", () => {
  const probe = vi.fn(() => new Promise(() => {}))
  const value = { source: "application", policy: { mode: "off" } }
  const read = vi.fn(() => value)
  const handler = globalHandler(
    {
      scope: () => "workspace",
      inspectAutobizEnvironment: probe,
      functions: { completionPolicy: read }
    },
    "mods:function-completion-policy"
  )
  expect(handler({}, { threadId: "thread", plugin: "plugin" })).toBe(value)
  expect(probe).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledWith("workspace", "thread", "plugin")
})

it("notifies mounted renderers after global off and reenable even with no live sessions", () => {
  let enabled = true
  const events: boolean[] = []
  const compositionStates: boolean[] = [], reuseStates: boolean[] = []
  const reconcileComposition = vi.fn(() => { compositionStates.push(enabled) })
  const reconcileReuse = vi.fn(() => { reuseStates.push(enabled) })
  const send = vi.fn((channel: string) => {
    expect(channel).toBe("mods:configuration-changed")
    events.push(enabled)
  })
  const owner = { isDestroyed: () => false, webContents: { send } }
  const handler = globalHandler({
    trusted: vi.fn(),
    ModError: Error,
    window: () => owner,
    creatorComposition: { reconcile: reconcileComposition },
    creatorReuse: { reconcileAuthorizations: reconcileReuse },
    setModsGlobalEnabled: (value: boolean) => {
      enabled = value
      return value
    },
    manager: { invalidateAll: vi.fn() }
  })
  expect(handler({ sender: {} }, false)).toBe(false)
  expect(handler({ sender: {} }, true)).toBe(true)
  expect(events).toEqual([false, true])
  expect(reconcileComposition).toHaveBeenCalledTimes(2)
  expect(reconcileReuse).toHaveBeenCalledTimes(2)
  expect(compositionStates).toEqual([false, true])
  expect(reuseStates).toEqual([false, true])
})

it("edits completion settings without a password while retaining writable scope checks", () => {
  const save = vi.fn(() => ({ source: "application", policy: { mode: "off" } }))
  const send = vi.fn()
  const scope = vi.fn(() => "workspace")
  const handler = globalHandler(
    {
      writableScope: scope,
      functions: { setCompletionPolicy: save },
      window: () => ({ isDestroyed: () => false, webContents: { send } })
    },
    "mods:function-completion-policy-set"
  )
  const event = { sender: {} }
  const input = { threadId: "thread", plugin: "plugin", policy: { mode: "off" } }
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
  const reconcileComposition = vi.fn(), reconcileReuse = vi.fn()
  const handler = globalHandler({
    trusted: () => {
      throw Error("untrusted sender")
    },
    ModError: Error,
    window: () => ({ isDestroyed: () => false, webContents: { send } }),
    setModsGlobalEnabled: set,
    creatorComposition: { reconcile: reconcileComposition },
    creatorReuse: { reconcileAuthorizations: reconcileReuse },
    manager: { invalidateAll: vi.fn() }
  })
  expect(() => handler({ sender: {} }, true)).toThrow("untrusted sender")
  expect(set).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(reconcileComposition).not.toHaveBeenCalled()
  expect(reconcileReuse).not.toHaveBeenCalled()
})

it.each(["mods:function-unlocked", "mods:unlock-function"])(
  "keeps %s as a trusted compatibility query without enabling or granting Mods",
  (channel) => {
    const trusted = vi.fn()
    const handler = globalHandler({ trusted }, channel)
    expect(handler({ sender: {} })).toBe(true)
    expect(handler({ sender: {} }, "any obsolete credential")).toBe(true)
    expect(trusted).toHaveBeenCalledTimes(2)
    trusted.mockImplementation(() => {
      throw Error("untrusted sender")
    })
    expect(() => handler({ sender: {} })).toThrow("untrusted sender")
  }
)

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

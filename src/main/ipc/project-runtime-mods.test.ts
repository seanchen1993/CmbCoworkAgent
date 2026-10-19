import { FunctionUserConfigValues } from "../mods/v2/user-config-values"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { projectPreviewRegistry } from "../mods/devtools/project-preview-registry"
import { readProjectSource } from "../mods/devtools/project-source"
import { testSecretProtector } from "../../../tests/support/mods-secret-protector"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerProjectRuntimeModsHandlers } from "./project-runtime-mods"
import { setProjectRuntimeFunctions } from "../harness-board/project-runtime-function-source"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { ModsManager } from "../mods/manager"

const state = vi.hoisted(() => ({ enabled: true }))
vi.mock("../storage", () => ({
  getPlugins: () => [{ id: "installation", enabled: state.enabled }]
}))
const nativeDialogs = vi.hoisted(() => ({
  choose: async () => ({ canceled: false, filePaths: ["C:/chosen-knowledge"] }),
  confirm: async () => ({ response: 1 })
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showOpenDialog: () => nativeDialogs.choose(),
    showMessageBox: () => nativeDialogs.confirm()
  }
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  state.enabled = true
})
async function fixture(
  config = false,
  preview = false,
  migration = false,
  workspaceControls = false
) {
  const root = mkdtempSync(join(tmpdir(), "project-native-mods-")),
    source = join(root, "source"),
    workspace = join(root, "workspace")
  mkdirSync(source)
  mkdirSync(workspace)
  const bundle = createProjectTemplate({
    packageId: "mixed-project",
    name: "Mixed",
    version: "1.0.0"
  })
  for (const file of bundle.files) {
    const path = join(source, file.path)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, file.text)
  }
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ name: "mixed-project", version: "1.0.0", mods: "mods/manifest.json" })
  )
  mkdirSync(join(source, "mods"))
  writeFileSync(
    join(source, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "real-compiled-id",
      entry: "main.ts",
      ...(migration
        ? {
            cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" },
            userConfigSchema: {
              version: 1,
              migrations: [
                {
                  fromVersion: 0,
                  toVersion: 1,
                  changes: [{ kind: "rename", from: "oldLabel", to: "label" }]
                }
              ]
            }
          }
        : {}),
      ...(config
        ? {
            userConfig: {
              label: {
                type: "string",
                title: "Label",
                description: "Required label",
                required: true
              },
              token: {
                type: "string",
                title: "Token",
                description: "Native secret",
                sensitive: true
              },
              knowledge: {
                type: "directory",
                title: "Knowledge",
                description: "Read-only directory"
              }
            }
          }
        : {})
    })
  )
  writeFileSync(
    join(source, "mods/main.ts"),
    "export function register(on){on('session.start',async($,e,next)=>next(e))}"
  )
  let previewCurrent = true
  const previewScope = {
    threadId: "creator",
    workspace,
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  const registered = preview
    ? await projectPreviewRegistry.register({
        projectId: "project",
        scope: previewScope,
        snapshot: {
          devId: randomUUID(),
          draftId: "draft",
          revision: 1,
          digest: (await readProjectSource(source)).bundle.digest,
          packagePath: source,
          workspace
        },
        guard: () => {
          if (!previewCurrent) throw Error("PREVIEW_OWNER_CHANGED")
        },
        release: vi.fn(),
        actions: []
      })
    : undefined
  const projects = new HostProjectStore(join(root, "project.sqlite")),
    snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const service = new HostProjectService(projects, snapshots, {
    resolveInstalledPlugin: async () =>
      registered
        ? {
            installedPluginId: registered.id,
            root: source,
            packageId: registered.name,
            packageVersion: registered.version,
            enabled: true
          }
        : {
            installedPluginId: "installation",
            root: source,
            packageId: "mixed-project",
            packageVersion: "1.0.0",
            enabled: true
          },
    authorize: async () => {},
    executeSkill: async () => {
      throw Error("NEVER_EXECUTE_WHILE_APPROVING")
    }
  })
  const project = await service.localCreate({
    projectId: "project",
    name: "Mixed",
    workspace,
    installedPluginId: registered?.id ?? "installation",
    goal: "Native permission test"
  })
  if (registered) {
    await projectPreviewRegistry.bind(project, snapshots.read(project.pluginDigest).root)
    cleanup.push(() => projectPreviewRegistry.finish(project, previewScope, []))
  }
  let globallyEnabled = true
  const core = workspaceControls
    ? new ModsManager(
        join(root, "mods.sqlite"),
        () => [],
        async () => false,
        () => {},
        undefined,
        undefined,
        () => globallyEnabled
      )
    : undefined
  const control = core?.store ?? new ModControlStore(join(root, "mods.sqlite"))
  let probe: Promise<void> | undefined
  let beforePublication: (() => Promise<void>) | undefined
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => [],
      secretProtector: testSecretProtector(),
      enabled: (workspace) => (core ? core.isEnabled(workspace) : true),
      publish: async (_, value) => {
        await beforePublication?.()
        return value
      },
      changed: () => {}
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          await probe
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(guests.map((guest) => guest.dispose()))
        }
      }
    }
  )
  const enabledWorkspaces: string[] = []
  setProjectRuntimeFunctions(
    manager,
    (value) => (core ? core.workspaceKey(value) : value),
    core
      ? {
          settingsStamp: (workspace) =>
            JSON.stringify(
              ["enabled", "policy", "epoch"].map((key) =>
                control.getSetting(`${key}:${workspace}`, "")
              )
            ),
          globallyEnabled: () => core.isGloballyEnabled(),
          enabled: (workspace) => core.isEnabled(workspace),
          enable: (workspace) => {
            enabledWorkspaces.push(workspace)
            core.configure(workspace, true, core.protects(workspace))
          }
        }
      : undefined
  )
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const retainedChecks = { count: 0, milliseconds: 0 }
  registerProjectRuntimeModsHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    } as IpcMain,
    (value) => {
      if (value !== event) throw Error("UNTRUSTED")
    },
    () => service,
    (value) => {
      const started = performance.now()
      retainedChecks.count++
      try {
        return snapshots.read(value.pluginDigest).root
      } finally {
        retainedChecks.milliseconds += performance.now() - started
      }
    },
    () => false
  )
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => projects.close(),
    () => (core ? core.close() : control.close()),
    () => manager.close()
  )
  return {
    root,
    workspace,
    control,
    service,
    project,
    snapshots,
    manager,
    retainedChecks,
    core,
    enabledWorkspaces,
    setGlobal(value: boolean) {
      globallyEnabled = value
    },
    beforePublication(value: (() => Promise<void>) | undefined) {
      beforePublication = value
    },
    native: async (channel: string, input: unknown) => {
      const before = { ...retainedChecks }
      const started = performance.now()
      try {
        return await handlers.get("project-runtime:user-config" + channel)!(event, input)
      } finally {
        if (process.env.CMB_PROJECT_CONFIG_DIAGNOSTIC === "1")
          console.log(
            "PROJECT_CONFIG_CONTENT_FENCE",
            JSON.stringify({
              channel,
              fullChecks: retainedChecks.count - before.count,
              fullCheckMs: retainedChecks.milliseconds - before.milliseconds,
              elapsedMs: performance.now() - started
            })
          )
      }
    },
    revokePreview: () => {
      previewCurrent = false
    },
    call: (channel: string, input: unknown, eventOverride = event) =>
      handlers.get("project-runtime:mods-" + channel)!(eventOverride, input),
    gate(value: Promise<void> | undefined) {
      probe = value
    }
  }
}
it("reads exact compiled facts and approves through the original manager only in the actual project workspace", async () => {
  const f = await fixture(),
    read = await f.call("read", "project")
  expect(read.source.name).toBe("real-compiled-id")
  expect(read.source.state).toBe("needs-approval")
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
  const ordinary = f.control.grant(f.workspace, "function:real-compiled-id", "c".repeat(64), true)
  const input = {
    projectId: read.projectId,
    projectVersion: read.projectVersion,
    packageDigest: read.packageDigest,
    compiledDigest: read.source.digest
  }
  const approved = await f.call("approve", input)
  expect(approved.source.state).toBe("ready")
  expect(
    f.control.getProjectFunctionGrant(
      f.workspace,
      "project",
      read.packageDigest,
      "real-compiled-id"
    )?.digest
  ).toBe(read.source.digest)
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toEqual(ordinary)
  expect(f.control.getGrant(f.root, "function:real-compiled-id")).toBeNull()
  expect(f.service.operations("project")).toEqual([])
})

it("enables only the actual project directory after explicit native source consent using the original workspace settings", async () => {
  const f = await fixture(false, false, false, true)
  expect(f.core!.isEnabled(f.workspace)).toBe(false)
  const read = await f.call("read", "project")
  expect(read).toMatchObject({
    workspaceEnabled: false,
    globallyEnabled: true,
    source: { state: "needs-approval" }
  })
  const input = {
    projectId: "project",
    projectVersion: f.project.version,
    packageDigest: f.project.pluginDigest,
    compiledDigest: read.source.digest
  }
  await expect(f.call("approve", { ...input, compiledDigest: "b".repeat(64) })).rejects.toThrow()
  expect(f.core!.isEnabled(f.workspace)).toBe(false)
  expect(f.enabledWorkspaces).toEqual([])
  expect((await f.call("approve", input)).source.state).toBe("ready")
  expect(f.enabledWorkspaces).toEqual([f.core!.workspaceKey(f.workspace)])
  expect(f.core!.isEnabled(f.workspace)).toBe(true)
  expect(f.core!.isEnabled(f.root)).toBe(false)
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
})

it("never opens the global master or enables a directory when required configuration or source consent is invalid", async () => {
  const f = await fixture(true, false, false, true)
  const read = await f.call("read", "project")
  const input = {
    projectId: "project",
    projectVersion: f.project.version,
    packageDigest: f.project.pluginDigest,
    compiledDigest: read.source.digest
  }
  await expect(f.call("approve", input)).rejects.toThrow()
  expect(f.enabledWorkspaces).toEqual([])
  expect(f.core!.isEnabled(f.workspace)).toBe(false)
  f.setGlobal(false)
  expect((await f.call("read", "project")).source.state).toBe("disabled")
  await expect(f.call("approve", input)).rejects.toThrow("PROJECT_MODS_GLOBALLY_DISABLED")
  expect(f.enabledWorkspaces).toEqual([])
  expect(f.core!.isGloballyEnabled()).toBe(false)
})
it("fills required preview parameters through the original editor API before enabling the new project directory", async () => {
  const f = await fixture(true, true, false, true)
  const workspace = f.core!.workspaceKey(f.workspace)
  const review = await f.call("read", "project")
  expect(review.source.configurationReady).toBe(false)
  expect(f.core!.isEnabled(workspace)).toBe(false)
  const view = await f.native("", {
    threadId: "project",
    pluginId: f.project.installedPluginId,
    expectedWorkspace: workspace
  })
  await f.native("-save", {
    threadId: "project",
    pluginId: view.pluginId,
    workspace: view.workspace,
    digest: view.digest,
    revision: view.savedRevision,
    key: "label",
    value: "native parameter before activation"
  })
  expect(f.core!.isEnabled(workspace)).toBe(false)
  expect((await f.call("read", "project")).source.configurationReady).toBe(true)
  const active = await f.call("approve", {
    projectId: "project",
    projectVersion: f.project.version,
    packageDigest: f.project.pluginDigest,
    compiledDigest: view.digest
  })
  expect(active.source.state).toBe("ready")
  expect(f.core!.isEnabled(workspace)).toBe(true)
  expect(f.core!.isEnabled(f.root)).toBe(false)
})

it("rejects stale identities and non-native callers without granting or creating an operation", async () => {
  const f = await fixture(),
    read = await f.call("read", "project")
  const input = {
    projectId: read.projectId,
    projectVersion: read.projectVersion,
    packageDigest: read.packageDigest,
    compiledDigest: read.source.digest
  }
  for (const patch of [
    { projectVersion: 99 },
    { packageDigest: "a".repeat(64) },
    { compiledDigest: "a".repeat(64) },
    { projectId: "other" }
  ])
    await expect(f.call("approve", { ...input, ...patch })).rejects.toThrow()
  await expect(f.call("read", "project", {} as IpcMainInvokeEvent)).rejects.toThrow("UNTRUSTED")
  state.enabled = false
  await expect(f.call("approve", input)).rejects.toThrow("PROJECT_PLUGIN_UNAVAILABLE")
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
})
it("serializes native confirmations and rejects revocation during the real registration probe", async () => {
  const f = await fixture(),
    read = await f.call("read", "project")
  const input = {
    projectId: read.projectId,
    projectVersion: read.projectVersion,
    packageDigest: read.packageDigest,
    compiledDigest: read.source.digest
  }
  const gate = Promise.withResolvers<void>()
  f.gate(gate.promise)
  const approval = f.call("approve", input)
  await expect(f.call("approve", input)).rejects.toThrow("PROJECT_MODS_APPROVAL_BUSY")
  state.enabled = false
  gate.resolve()
  await expect(approval).rejects.toThrow("PROJECT_PLUGIN_UNAVAILABLE")
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
})

it("configures a real uninstalled preview snapshot in its own original store before native code approval", async () => {
  const f = await fixture(true, true)
  const before = await f.call("read", "project")
  expect(before.source).toMatchObject({
    name: "real-compiled-id",
    hasConfiguration: true,
    configurationReady: false
  })
  const runtimeInput = {
    workspace: f.workspace,
    plugin: {
      id: f.project.installedPluginId,
      name: f.project.packageId,
      path: f.snapshots.read(f.project.pluginDigest).root,
      enabled: true
    }
  }
  // Admission can preload the schema before an editor exists, but execution validates real values synchronously.
  await f.manager.prepareRuntimeSourceFacts(runtimeInput)
  expect(() => f.manager.assertRuntimeSourceConfiguration(runtimeInput)).toThrow(
    "Invalid plugin configuration field: label"
  )

  const identity = {
    threadId: "project",
    pluginId: f.project.installedPluginId,
    expectedWorkspace: f.workspace
  }
  const view = await f.native("", identity)
  expect(view.plugin).toBe("real-compiled-id")
  expect(view.workspace).toBe(f.workspace)
  const saved = await f.native("-save", {
    threadId: "project",
    pluginId: view.pluginId,
    workspace: view.workspace,
    digest: view.digest,
    revision: view.savedRevision,
    key: "label",
    value: "project label"
  })
  expect(saved.savedRevision).toBe(1)
  expect(saved.fields.find((field) => field.key === "label").value).toBe("project label")
  expect((await f.call("read", "project")).source.configurationReady).toBe(true)
  expect(() => f.manager.assertRuntimeSourceConfiguration(runtimeInput)).not.toThrow()
  expect(f.manager.readUserConfigIdentity(f.root, "real-compiled-id").savedRevision).toBe(0)
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
  expect(
    f.control.getProjectFunctionGrant(
      f.workspace,
      "project",
      f.project.pluginDigest,
      "real-compiled-id"
    )
  ).toBeNull()
  const secret = await f.native("-secret-save", {
    threadId: "project",
    pluginId: view.pluginId,
    workspace: view.workspace,
    digest: view.digest,
    revision: 1,
    key: "token",
    action: { operation: "set", value: "native-only-secret" }
  })
  expect(secret.fields.find((field) => field.key === "token")).toMatchObject({
    secretState: "saved"
  })
  expect(JSON.stringify(secret)).not.toContain("native-only-secret")
  const approved = await f.call("approve", {
    projectId: "project",
    projectVersion: f.project.version,
    packageDigest: f.project.pluginDigest,
    compiledDigest: view.digest
  })
  expect(approved.source.state).toBe("ready")
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
  expect(f.service.operations("project")).toEqual([])
})
it("rejects project config injection, wrong directory, stale CAS and late path chooser after preview ownership is lost", async () => {
  const f = await fixture(true, true)
  const view = await f.native("", { threadId: "project", pluginId: f.project.installedPluginId })
  const base = {
    threadId: "project",
    pluginId: view.pluginId,
    workspace: view.workspace,
    digest: view.digest,
    revision: 0
  }
  await expect(
    f.native("-save", { ...base, key: "label", value: "bad", path: f.root })
  ).rejects.toThrow("MODS_CONFIG_ARGUMENTS")
  await expect(
    f.native("-save", { ...base, workspace: f.root, key: "label", value: "bad" })
  ).rejects.toThrow("PROJECT_INPUT_CHANGED")
  await expect(
    f.native("-save", { ...base, pluginId: "other", key: "label", value: "bad" })
  ).rejects.toThrow("PROJECT_INPUT_CHANGED")
  await f.native("-save", { ...base, key: "label", value: "retained" })
  await expect(f.native("-save", { ...base, key: "label", value: "stale" })).rejects.toThrow(
    "MODS_CONFIG_VALUE_CHANGED"
  )
  const chosen = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>()
  const old = nativeDialogs.choose
  const entered = Promise.withResolvers<void>()
  nativeDialogs.choose = () => {
    entered.resolve()
    return chosen.promise
  }
  try {
    const path = f.native("-pick-path", { ...base, revision: 1, key: "knowledge" })
    await entered.promise
    f.revokePreview()
    chosen.resolve({ canceled: false, filePaths: [f.root] })
    await expect(path).rejects.toThrow("PREVIEW_OWNER_CHANGED")
  } finally {
    nativeDialogs.choose = old
  }
  expect(f.manager.readUserConfigIdentity(f.workspace, "real-compiled-id").savedRevision).toBe(1)
})

it("uses the original native confirmation and migration service for preview parameters without restoring code consent", async () => {
  const f = await fixture(true, true, true)
  const values = new FunctionUserConfigValues(f.control)
  values.save(
    f.workspace,
    "real-compiled-id",
    { oldLabel: { type: "string", title: "Old", description: "Old label" } },
    "oldLabel",
    "retained across schema upgrade",
    0,
    () => {}
  )
  const base = { threadId: "project", pluginId: f.project.installedPluginId }
  const before = await f.native("", base)
  expect(before.migration).toMatchObject({ fromVersion: 0, toVersion: 1, canApply: true })
  const input = {
    ...base,
    workspace: before.workspace,
    digest: before.digest,
    revision: before.savedRevision,
    migrationDigest: before.migration.digest
  }
  const original = nativeDialogs.confirm
  try {
    nativeDialogs.confirm = async () => ({ response: 0 })
    expect((await f.native("-migrate", input)).migration).toBeDefined()
    expect(values.read(f.workspace, "real-compiled-id").revision).toBe(1)
    nativeDialogs.confirm = async () => ({ response: 1 })
    const next = await f.native("-migrate", input)
    expect(next.migration).toBeUndefined()
    expect(next.savedRevision).toBe(2)
    expect(next.fields.find((field) => field.key === "label").value).toBe(
      "retained across schema upgrade"
    )
    expect(values.read(f.workspace, "real-compiled-id").schemaVersion).toBe(1)
    expect(
      f.control.getProjectFunctionGrant(
        f.workspace,
        "project",
        f.project.pluginDigest,
        "real-compiled-id"
      )
    ).toBeNull()
    expect(f.service.operations("project")).toEqual([])
  } finally {
    nativeDialogs.confirm = original
  }
})
it("rejects a late migration confirmation when the original preview owner changes, preserving the legacy record", async () => {
  const f = await fixture(true, true, true)
  const values = new FunctionUserConfigValues(f.control)
  values.save(
    f.workspace,
    "real-compiled-id",
    { oldLabel: { type: "string", title: "Old", description: "Old label" } },
    "oldLabel",
    "must remain legacy",
    0,
    () => {}
  )
  const view = await f.native("", { threadId: "project", pluginId: f.project.installedPluginId })
  const entered = Promise.withResolvers<void>(),
    confirmation = Promise.withResolvers<{ response: number }>()
  const original = nativeDialogs.confirm
  nativeDialogs.confirm = () => {
    entered.resolve()
    return confirmation.promise
  }
  try {
    const migration = f.native("-migrate", {
      threadId: "project",
      pluginId: view.pluginId,
      workspace: view.workspace,
      digest: view.digest,
      revision: view.savedRevision,
      migrationDigest: view.migration.digest
    })
    await entered.promise
    f.revokePreview()
    confirmation.resolve({ response: 1 })
    await expect(migration).rejects.toThrow("PREVIEW_OWNER_CHANGED")
    expect(values.read(f.workspace, "real-compiled-id")).toMatchObject({
      revision: 1,
      values: { oldLabel: "must remain legacy" }
    })
    expect(values.read(f.workspace, "real-compiled-id").schemaVersion).toBeUndefined()
  } finally {
    nativeDialogs.confirm = original
  }
})

it("bounds complete package checks per native config operation without reusing previous results", async () => {
  const f = await fixture(true, true)
  const identity = { threadId: "project", pluginId: f.project.installedPluginId }
  let checks = f.retainedChecks.count
  const view = await f.native("", identity)
  expect(f.retainedChecks.count - checks).toBeGreaterThan(1)
  expect(f.retainedChecks.count - checks).toBeLessThanOrEqual(6)
  checks = f.retainedChecks.count
  const saved = await f.native("-save", {
    ...identity,
    workspace: view.workspace,
    digest: view.digest,
    revision: view.savedRevision,
    key: "label",
    value: "fresh value"
  })
  expect(f.retainedChecks.count - checks).toBeGreaterThan(1)
  expect(f.retainedChecks.count - checks).toBeLessThanOrEqual(12)
  checks = f.retainedChecks.count
  const next = await f.native("", identity)
  expect(next.savedRevision).toBe(saved.savedRevision)
  expect(next.fields.find((field) => field.key === "label").value).toBe("fresh value")
  expect(f.retainedChecks.count - checks).toBeGreaterThan(1)
  expect(f.retainedChecks.count - checks).toBeLessThanOrEqual(6)
  expect(f.control.getGrant(f.workspace, "function:real-compiled-id")).toBeNull()
})

it("rejects retained package changes during native configuration publication", async () => {
  const f = await fixture(true, true)
  const identity = { threadId: "project", pluginId: f.project.installedPluginId }
  await f.native("", identity)
  const path = join(f.snapshots.read(f.project.pluginDigest).root, "skills/draft/SKILL.md")
  const original = readFileSync(path, "utf8")
  f.beforePublication(async () => {
    await Promise.resolve()
    writeFileSync(path, original + "\n// changed while the native result was pending")
  })
  await expect(f.native("", identity)).rejects.toThrow("PACKAGE_CHANGED")
  expect(f.manager.readUserConfigIdentity(f.workspace, "real-compiled-id").savedRevision).toBe(0)
  expect(f.service.operations("project")).toEqual([])
})

it("rejects configuration revision changes while a native result is pending", async () => {
  const f = await fixture(true, true)
  const identity = { threadId: "project", pluginId: f.project.installedPluginId }
  const values = new FunctionUserConfigValues(f.control)
  f.beforePublication(async () => {
    await Promise.resolve()
    values.save(
      f.workspace,
      "real-compiled-id",
      {
        label: { type: "string", title: "Label", description: "Required label", required: true }
      },
      "label",
      "newer native value",
      0,
      () => {}
    )
  })
  await expect(f.native("", identity)).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  f.beforePublication(undefined)
  const view = await f.native("", identity)
  expect(view.savedRevision).toBe(1)
  expect(view.fields.find((field) => field.key === "label").value).toBe("newer native value")
})

it("rechecks complete package contents after the native path chooser resolves", async () => {
  const f = await fixture(true, true)
  const identity = { threadId: "project", pluginId: f.project.installedPluginId }
  const view = await f.native("", identity)
  const file = join(f.snapshots.read(f.project.pluginDigest).root, "skills/draft/SKILL.md")
  const original = readFileSync(file, "utf8")
  const selected = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>()
  const entered = Promise.withResolvers<void>()
  const old = nativeDialogs.choose
  nativeDialogs.choose = () => {
    entered.resolve()
    return selected.promise
  }
  try {
    const pending = f.native("-pick-path", {
      ...identity,
      workspace: view.workspace,
      digest: view.digest,
      revision: view.savedRevision,
      key: "knowledge"
    })
    await entered.promise
    writeFileSync(file, original + "\n// changed while native selection was pending")
    selected.resolve({ canceled: false, filePaths: [f.root] })
    await expect(pending).rejects.toThrow("PACKAGE_CHANGED")
    expect(f.manager.readUserConfigIdentity(f.workspace, "real-compiled-id").savedRevision).toBe(0)
  } finally {
    nativeDialogs.choose = old
  }
})

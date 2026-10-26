import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import type { CompositionCatalogSnapshot } from "../plugins/project-composition-catalog"
import type { CompositionRun } from "../../shared/project-runtime/composition-api"
import type { ProjectFunctionSourceReview } from "../../shared/project-runtime/function-source"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"

// Discovery and a native window are controlled. Original stores, snapshots, compiler,
// native configuration/consent services, guest probe, coordinator and HostService stay real.
const state = vi.hoisted(() => ({
  root: "",
  workspace: "",
  incarnation: "original",
  plugins: [] as PluginMetadata[],
  snapshot: undefined as CompositionCatalogSnapshot | undefined,
  choose: async () => ({ canceled: false, filePaths: ["C:/chosen-knowledge"] }),
  beforeProbe: undefined as (() => Promise<void>) | undefined
}))
vi.mock("electron", () => ({
  shell: { openPath: async () => "" },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: () => state.choose(), showMessageBox: async () => ({ response: 1 }) }
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root, getPlugins: () => state.plugins }))
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getThreadCore: () => ({
    metadata: {
      workspacePath: state.workspace,
      cmb_thread_incarnation: state.incarnation,
      harnessProjectSession: { projectId: "parent", kind: "chat" }
    }
  })
}))
vi.mock("../harness-board/service", () => ({
  getHarnessCapabilityWorkspaces: () => [state.workspace],
  getHarnessCapabilityFeatureWorkspace: () => undefined
}))
vi.mock("../mods/builtins/project-facts", () => ({
  readBuiltinProjectBinding: () => false,
  readBuiltinProjectFacts: () => ({ facts: { state: "unavailable" } })
}))
vi.mock("../plugins/capability-catalog-client", () => ({
  capabilityCatalogWorkers: { read: (run: (reader: undefined) => unknown) => run(undefined) }
}))
vi.mock("../plugins/project-composition-catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/project-composition-catalog")>()
  return { ...original, readProjectCompositionCatalog: async () => structuredClone(state.snapshot) }
})

import { registerProjectCompositionHandlers } from "./project-composition"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { ModsManager } from "../mods/manager"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { setProjectRuntimeFunctions } from "../harness-board/project-runtime-function-source"
import { FunctionUserConfigValues } from "../mods/v2/user-config-values"
import { compositionUnitConfigurationKey } from "../../shared/project-runtime/composition-api"
import { testSecretProtector } from "../../../tests/support/mods-secret-protector"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  state.choose = async () => ({ canceled: false, filePaths: ["C:/chosen-knowledge"] })
  state.beforeProbe = undefined
})
async function fixture() {
  const root = (state.root = mkdtempSync(join(tmpdir(), "composition-native-config-")))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  state.workspace = join(root, "parent")
  state.incarnation = "original"
  mkdirSync(state.workspace)
  const source = join(root, "installed")
  mkdirSync(source)
  for (const file of createProjectTemplate({
    packageId: "unit-docs",
    name: "Unit docs",
    version: "1.0.0"
  }).files) {
    const path = join(source, file.path)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, file.text)
  }
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ name: "unit-docs", version: "1.0.0", mods: "mods/manifest.json" })
  )
  mkdirSync(join(source, "mods"))
  writeFileSync(
    join(source, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "unit-native-id",
      entry: "main.ts",
      userConfig: {
        audience: {
          type: "string",
          title: "Audience",
          description: "Required unit input",
          required: true
        },
        knowledgeRoot: {
          type: "directory",
          title: "Knowledge",
          description: "Read-only knowledge"
        },
        token: { type: "string", title: "Token", description: "Native only", sensitive: true }
      }
    })
  )
  writeFileSync(
    join(source, "mods/main.ts"),
    "export function register(on,options){if(!options.audience)throw Error('UNIT_CONFIG_REQUIRED');on('session.start',async($,e,next)=>next(e))}"
  )
  const plugin = {
    id: "installation",
    name: "unit-docs",
    version: "1.0.0",
    path: source,
    enabled: true
  } as PluginMetadata
  state.plugins = [plugin]
  const projects = new HostProjectStore(join(root, "host.sqlite")),
    snapshots = new HostPackageSnapshots(join(root, "host-packages"))
  cleanup.push(() => projects.close())
  const retained = snapshots.capture(source)
  const execute = vi.fn(async () => {
    throw Error("CONTROLLED_ENGINE_STOP")
  })
  const host = new HostProjectService(projects, snapshots, {
    resolveInstalledPlugin: async (id) => {
      const current = state.plugins.find((plugin) => plugin.id === id)
      return (
        current && {
          installedPluginId: current.id,
          packageId: current.name,
          packageVersion: current.version,
          root: current.path,
          enabled: current.enabled
        }
      )
    },
    authorize: async () => {
      /* Original host authorization is tested at its own native boundary. */
    },
    executeSkill: execute
  })
  const core = new ModsManager(
    join(root, "mods.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  cleanup.push(() => core.close())
  core.configure(state.workspace, true, false)
  const manager = new FunctionModsManager(
    core.store,
    {
      plugins: () => [],
      enabled: (workspace) => core.isEnabled(workspace),
      secretProtector: testSecretProtector(),
      publish: async (_workspace, value) => value,
      changed: () => {}
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          await state.beforeProbe?.()
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
  cleanup.push(() => manager.close())
  setProjectRuntimeFunctions(manager, (path) => core.workspaceKey(path), {
    settingsStamp: (workspace) =>
      JSON.stringify(
        ["enabled", "policy", "epoch"].map((key) =>
          core.store.getSetting(`${key}:${workspace}`, "")
        )
      ),
    globallyEnabled: () => core.isGloballyEnabled(),
    enabled: (workspace) => core.isEnabled(workspace),
    enable: (workspace) => core.configure(workspace, true, false)
  })
  state.snapshot = {
    revision: "locked-catalog",
    diagnostics: [],
    sources: [
      {
        plugin,
        capability: {
          id: "project-flow",
          title: "Unit docs",
          kind: "flow",
          usage: "project",
          runtimeMode: "host",
          entry: "devclaw.project-runtime.json",
          dependsOn: []
        },
        entry: {
          source: {
            pluginId: plugin.id,
            capabilityId: "project-flow",
            packageDigest: retained.digest
          },
          sourceName: plugin.name,
          title: "Unit docs",
          kind: "flow",
          available: true,
          reasons: [],
          inputs: [],
          outputs: []
        }
      }
    ]
  }
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  let event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const owner = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow
  let closeComposition: (() => void) | undefined
  cleanup.push(() => closeComposition?.())
  const register = () => {
    closeComposition?.()
    handlers.clear()
    const composition = registerProjectCompositionHandlers(
      {
        handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) =>
          handlers.set(name, handler)
      } as unknown as IpcMain,
      {
        trusted: (input) => {
          if (input.sender !== event.sender || input.senderFrame !== sender.mainFrame)
            throw Error("UNTRUSTED_NATIVE_FRAME")
          return owner
        },
        host: () => host,
        assertWorkspaceIdle: () => {},
        bindOwner: () => {}
      }
    )
    closeComposition = () => composition().close()
  }
  register()
  const call = async <T>(method: string, input: unknown) =>
    handlers.get(method)!(event, input) as Promise<T>
  const scope = {
    projectId: "parent",
    threadId: "native-parent-chat",
    expectedWorkspace: state.workspace
  }
  const definition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent",
    workspace: state.workspace,
    goal: "Write a document with explicitly configured unit parameters",
    units: ["first", "second"].map((id) => ({
      id,
      kind: "flow",
      source: state.snapshot!.sources[0].entry.source,
      inputs: [],
      outputs: []
    }))
  }
  const prepare = async () => {
    await call("project-composition:catalog", scope)
    const preview = await call<{ id: string }>("project-composition:preview", {
      scope,
      catalogRevision: "locked-catalog",
      definition
    })
    return call<CompositionRun>("project-composition:prepare", {
      scope,
      previewId: preview.id,
      requestId: "native-two-phase"
    })
  }
  const key = (run: CompositionRun, unitId = "first") =>
    compositionUnitConfigurationKey({ scope, runId: run.id, unitId, expectedVersion: run.version })
  const review = (key: string) =>
    call<ProjectFunctionSourceReview>("project-composition-unit:mods-read", key)
  const config = (key: string) =>
    call<FunctionUserConfigView>("project-composition-unit:user-config", {
      threadId: key,
      pluginId: plugin.id
    })
  const save = (key: string, view: FunctionUserConfigView, field: string, value: string) =>
    call<FunctionUserConfigView>("project-composition-unit:user-config-save", {
      threadId: key,
      pluginId: plugin.id,
      digest: view.digest,
      workspace: view.workspace,
      revision: view.savedRevision,
      key: field,
      value
    })
  const approve = async (key: string) => {
    const current = await review(key)
    return call<ProjectFunctionSourceReview>("project-composition-unit:mods-approve", {
      projectId: key,
      projectVersion: current.projectVersion,
      packageDigest: current.packageDigest,
      compiledDigest: current.source!.digest
    })
  }
  return {
    root,
    source,
    plugin,
    retained,
    snapshots,
    projects,
    host,
    manager,
    core,
    execute,
    handlers,
    sender,
    scope,
    prepare,
    key,
    review,
    config,
    save,
    approve,
    call,
    register,
    currentEvent: () => event,
    replaceFrame() {
      sender.mainFrame = {}
      event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
    }
  }
}

it("keeps native business-context endpoints bound to the actual unit, version and declared adapter", async () => {
  const f = await fixture()
  const run = await f.prepare()
  const request = { scope: f.scope, runId: run.id, unitId: "first", expectedVersion: run.version }
  expect(await f.call("project-composition:readUnitContext", request)).toEqual({
    supported: false, required: false, candidates: [], selected: []
  })
  await expect(f.call("project-composition:readUnitContext", { ...request, sourceRoot: f.source }))
    .rejects.toThrow("COMPOSITION_SCOPE_INVALID")
  await expect(f.call("project-composition:readUnitContext", { ...request, unitId: "unknown" }))
    .rejects.toThrow("COMPOSITION_CONFIGURATION_CHANGED")
  await expect(f.call("project-composition:readUnitContext", { ...request, expectedVersion: run.version + 1 }))
    .rejects.toThrow("COMPOSITION_VERSION_CONFLICT")
  await expect(f.call("project-composition:saveUnitContext", {
    ...request, deployUnitIds: ["UNDECLARED"], contextFingerprint: "a".repeat(64)
  })).rejects.toThrow("COMPOSITION_UNIT_CONTEXT_UNSUPPORTED")
  expect((await f.call<CompositionRun>("project-composition:read", { scope: f.scope, runId: run.id })).version)
    .toBe(run.version)
  expect(f.execute).not.toHaveBeenCalled()
})

it("configures and explicitly approves only each real unit before original engine admission", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    first = f.key(run),
    second = f.key(run, "second")
  expect(run.configurationPending).toBe(true)
  expect(f.host.get(`composition:${run.id}:first`)).toBeUndefined()
  expect(f.execute).not.toHaveBeenCalled()
  await expect(
    f.call("project-composition:startPrepared", {
      scope: f.scope,
      runId: run.id,
      expectedVersion: run.version
    })
  ).rejects.toThrow(/configuration|APPROVAL/)
  const initial = await f.review(first)
  expect(initial.source).toMatchObject({ configurationReady: false, state: "needs-approval" })
  await expect(f.approve(first)).rejects.toThrow(/configuration/)
  let view = await f.save(first, await f.config(first), "audience", "first-only")
  const chosen = await f.call<string>("project-composition-unit:user-config-pick-path", {
    threadId: first,
    pluginId: f.plugin.id,
    digest: view.digest,
    workspace: view.workspace,
    revision: view.savedRevision,
    key: "knowledgeRoot"
  })
  view = await f.save(first, view, "knowledgeRoot", chosen)
  expect(
    (await f.config(second)).fields.find((field) => field.key === "audience")?.value
  ).toBeUndefined()
  expect((await f.config(second)).workspace).not.toBe(view.workspace)
  expect(
    new FunctionUserConfigValues(f.core.store, testSecretProtector()).read(
      f.core.workspaceKey(f.scope.expectedWorkspace),
      "unit-native-id"
    ).revision
  ).toBe(0)
  expect((await f.approve(first)).source?.state).toBe("ready")
  expect((await f.review(second)).source).toMatchObject({
    configurationReady: false,
    state: "needs-approval"
  })
  await expect(
    f.call("project-composition:startPrepared", {
      scope: f.scope,
      runId: run.id,
      expectedVersion: run.version
    })
  ).rejects.toThrow(/configuration|APPROVAL/)
  await f.save(second, await f.config(second), "audience", "second-only")
  await f.approve(second)
  expect(f.execute).not.toHaveBeenCalled()
  const started = await f.call<CompositionRun>("project-composition:startPrepared", {
    scope: f.scope,
    runId: run.id,
    expectedVersion: run.version
  })
  expect(started.configurationPending).toBe(false)
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
  await expect(f.save(first, view, "audience", "late")).rejects.toThrow(/VERSION|CONFIGURATION/)
}, 15000)

it("rejects parent/other-unit injection and late native chooser results after frame or owner revocation", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    key = f.key(run),
    view = await f.config(key)
  await expect(f.save(f.key(run, "missing"), view, "audience", "injected")).rejects.toThrow(
    /CONFIGURATION/
  )
  await expect(f.save(f.key(run, "second"), view, "audience", "injected")).rejects.toThrow(
    /INPUT_CHANGED|SCOPE_CHANGED/
  )
  await expect(
    f.call("project-composition-unit:user-config", {
      threadId: key,
      pluginId: f.plugin.id,
      expectedWorkspace: f.scope.expectedWorkspace
    })
  ).rejects.toThrow("PROJECT_INPUT_CHANGED")
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  state.choose = async () => {
    await held
    return { canceled: false, filePaths: ["C:/late"] }
  }
  const pending = f.call("project-composition-unit:user-config-pick-path", {
    threadId: key,
    pluginId: f.plugin.id,
    digest: view.digest,
    workspace: view.workspace,
    revision: view.savedRevision,
    key: "knowledgeRoot"
  })
  const rejected = expect(pending).rejects.toThrow(/FRAME|CHANGED/)
  await new Promise((resolve) => setTimeout(resolve, 20))
  f.sender.mainFrame = {}
  release()
  await rejected
  expect(f.execute).not.toHaveBeenCalled()
})

it("restores only pending configuration after restart and rejects updated or revoked source identities", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    key = f.key(run)
  await f.save(key, await f.config(key), "audience", "persisted-unit-value")
  f.register()
  const restored = await f.call<CompositionRun>("project-composition:read", {
    scope: f.scope,
    runId: run.id
  })
  expect(restored).toMatchObject({ configurationPending: true, version: run.version })
  expect((await f.config(key)).fields.find((field) => field.key === "audience")?.value).toBe(
    "persisted-unit-value"
  )
  expect((await f.review(key)).source?.state).toBe("needs-approval")
  expect(f.execute).not.toHaveBeenCalled()
  state.plugins[0].enabled = false
  await expect(f.config(key)).rejects.toThrow("COMPOSITION_SOURCE_CHANGED")
  state.plugins[0].enabled = true
  state.plugins[0].version = "2.0.0"
  await expect(f.config(key)).rejects.toThrow("COMPOSITION_SOURCE_CHANGED")
  expect(f.execute).not.toHaveBeenCalled()
})

it("re-adopts a fresh native frame while rejecting old-frame configuration results", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    key = f.key(run),
    oldEvent = f.currentEvent()
  const view = await f.save(key, await f.config(key), "audience", "before-reload")
  f.replaceFrame()
  expect((await f.config(key)).fields.find((field) => field.key === "audience")?.value).toBe(
    "before-reload"
  )
  const oldSave = f.handlers.get("project-composition-unit:user-config-save")!
  await expect(
    oldSave(oldEvent, {
      threadId: key,
      pluginId: f.plugin.id,
      digest: view.digest,
      workspace: view.workspace,
      revision: view.savedRevision,
      key: "audience",
      value: "old-frame"
    })
  ).rejects.toThrow("UNTRUSTED_NATIVE_FRAME")
  expect((await f.config(key)).fields.find((field) => field.key === "audience")?.value).toBe(
    "before-reload"
  )
  expect(f.execute).not.toHaveBeenCalled()
})

it("rejects source mutation after the real path chooser and owner changes during the original guest approval probe", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    key = f.key(run)
  const view = await f.save(key, await f.config(key), "audience", "configured")
  let release!: () => void
  let entered!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const entry = new Promise<void>((resolve) => {
    entered = resolve
  })
  state.beforeProbe = async () => {
    entered()
    await barrier
  }
  const approval = f.approve(key)
  const rejected = expect(approval).rejects.toThrow(/CONTEXT_CHANGED/)
  await entry
  state.incarnation = "replacement-parent"
  release()
  await rejected
  state.beforeProbe = undefined
  state.incarnation = "original"
  expect((await f.review(key)).source?.state).toBe("needs-approval")
  const bytes = readFileSync(join(f.retained.root, "mods/main.ts"), "utf8")
  state.choose = async () => {
    writeFileSync(
      join(f.retained.root, "mods/main.ts"),
      `${bytes}\n// changed during native choice\n`
    )
    return { canceled: false, filePaths: ["C:/changed-source"] }
  }
  await expect(
    f.call("project-composition-unit:user-config-pick-path", {
      threadId: key,
      pluginId: f.plugin.id,
      digest: view.digest,
      workspace: view.workspace,
      revision: view.savedRevision,
      key: "knowledgeRoot"
    })
  ).rejects.toThrow()
  expect(f.execute).not.toHaveBeenCalled()
}, 10000)

it("rechecks every unit's actual configuration revision before the final start CAS", async () => {
  const f = await fixture(),
    run = await f.prepare(),
    first = f.key(run),
    second = f.key(run, "second")
  for (const key of [first, second]) {
    await f.save(key, await f.config(key), "audience", "before-start")
    await f.approve(key)
  }
  const original = f.manager.runtimeSourceReview.bind(f.manager)
  let entered!: () => void
  let release!: () => void
  const entry = new Promise<void>((resolve) => {
    entered = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = vi.spyOn(f.manager, "runtimeSourceReview").mockImplementation(async (input) => {
    const value = await original(input)
    if (input.scope.projectId === `composition:${run.id}:second`) {
      entered()
      await barrier
    }
    return value
  })
  const start = f.call("project-composition:startPrepared", {
    scope: f.scope,
    runId: run.id,
    expectedVersion: run.version
  })
  const rejected = expect(start).rejects.toThrow("COMPOSITION_CONFIGURATION_CHANGED")
  await entry
  await f.save(first, await f.config(first), "audience", "changed-during-final-check")
  release()
  await rejected
  read.mockRestore()
  const pending = await f.call<CompositionRun>("project-composition:read", {
    scope: f.scope,
    runId: run.id
  })
  expect(pending).toMatchObject({ version: run.version, configurationPending: true })
  expect((await f.config(first)).fields.find((field) => field.key === "audience")?.value).toBe(
    "changed-during-final-check"
  )
  expect(f.execute).not.toHaveBeenCalled()
}, 15000)

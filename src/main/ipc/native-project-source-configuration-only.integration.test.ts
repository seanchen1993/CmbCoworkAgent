import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import type { ProjectFunctionSourceReview } from "../../shared/project-runtime/function-source"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"
import { ModControlStore } from "../mods/control-store"
import { FunctionModsManager } from "../mods/v2/manager"
import { registerNativeProjectSourceHandlers } from "./native-project-source"

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("preserves the real metadata-only source review through native IPC without guest approval or enabling Mods", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-config-review-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, "source"),
    workspace = join(root, "workspace")
  await mkdir(sourceRoot)
  await mkdir(workspace)
  await writeFile(
    join(sourceRoot, "plugin.json"),
    JSON.stringify({
      name: "native-metadata",
      version: "1.0.0",
      userConfig: {
        audience: {
          type: "string",
          title: "Audience",
          description: "Business readers",
          required: true
        }
      }
    })
  )
  const store = new ModControlStore(join(root, "settings.sqlite"))
  cleanup.push(() => store.close())
  const guests = vi.fn(() => {
    throw Error("METADATA_MUST_NOT_CREATE_GUEST")
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [],
      enabled: () => false,
      publish: async (_workspace, value) => value,
      changed: vi.fn()
    },
    guests
  )
  cleanup.push(() => manager.close())
  let globallyEnabled = false
  const enable = vi.fn(() => {
    throw Error("METADATA_MUST_NOT_ENABLE_MODS")
  })
  const controls = {
    enabled: () => false,
    globallyEnabled: () => globallyEnabled,
    settingsStamp: () => "unchanged-off",
    enable
  }
  const input = {
    workspace,
    plugin: { id: "native-installation", name: "native-metadata", path: sourceRoot, enabled: true },
    scope: { projectId: "native-project", packageDigest: "a".repeat(64) }
  }
  let current = true
  const guard = () => {
    if (!current) throw Error("NATIVE_OWNER_CHANGED")
  }
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  registerNativeProjectSourceHandlers(
    {
      handle: (channel: string, run: Parameters<IpcMain["handle"]>[1]) => {
        handlers.set(channel, run)
      }
    } as unknown as IpcMain,
    "test-native-config",
    (_event, id) => {
      if (id !== "native-project") throw Error("NATIVE_PROJECT_CHANGED")
      guard()
      return {
        manager,
        input,
        workspaceControl: controls,
        project: { projectId: id, version: 1, pluginDigest: input.scope.packageDigest },
        guard,
        authorityGuard: guard
      }
    }
  )
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const invoke = <T>(kind: string, value: unknown) =>
    Promise.resolve().then(() =>
      handlers.get(`test-native-config:${kind}`)!(event, value)
    ) as Promise<T>
  const review = await invoke<ProjectFunctionSourceReview>("mods-read", "native-project")
  expect(review).toMatchObject({
    globallyEnabled: false,
    workspaceEnabled: false,
    source: {
      state: "ready",
      configurationOnly: true,
      hasConfiguration: true,
      configurationReady: false,
      capabilities: [],
      scannedMethods: [],
      scanIncomplete: false
    }
  })
  const view = await invoke<FunctionUserConfigView>("user-config", {
    threadId: "native-project",
    pluginId: input.plugin.id,
    expectedWorkspace: workspace
  })
  await invoke("user-config-save", {
    threadId: "native-project",
    pluginId: input.plugin.id,
    digest: view.digest,
    workspace: view.workspace,
    key: "audience",
    value: "Business owners",
    revision: view.savedRevision
  })
  expect(await invoke("mods-read", "native-project")).toMatchObject({
    source: { configurationOnly: true, state: "ready", configurationReady: true }
  })
  manager.assertRuntimeSourceReady(input)
  const approval = {
    projectId: "native-project",
    projectVersion: 1,
    packageDigest: input.scope.packageDigest,
    compiledDigest: review.source!.digest
  }
  await expect(invoke("mods-approve", approval)).rejects.toThrow("GLOBALLY_DISABLED")
  globallyEnabled = true
  await expect(invoke("mods-approve", approval)).rejects.toThrow("APPROVAL_STALE")
  expect(guests).not.toHaveBeenCalled()
  expect(enable).not.toHaveBeenCalled()
  expect(store.getGrant(workspace, "function:native-metadata")).toBeNull()
  expect(
    store.getProjectFunctionGrant(
      workspace,
      "native-project",
      input.scope.packageDigest,
      "native-metadata"
    )
  ).toBeNull()
  current = false
  await expect(invoke("mods-read", "native-project")).rejects.toThrow("OWNER_CHANGED")
})

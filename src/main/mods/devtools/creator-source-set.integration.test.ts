import { mkdtemp, rm, cp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { CreatorSourceSets } from "./creator-source-set"
import { CreatorProjectDeliveries } from "./creator-project-delivery"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { observeProjectDeliveryInstallation } from "../../plugins/plugin-delivery-observation"
import { PluginStartUseService } from "../../plugins/plugin-start-use"
import { FunctionModsManager } from "../v2/manager"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { ModControlStore } from "../control-store"
import { createAuthoringTemplate } from "./authoring-templates"
import { sourceSetBrowser } from "./source-set-browser.test-helper"
import type { PluginStartUseInput } from "../../../shared/plugin-start-use"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "source-set-test", getVersion: () => "2.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {}
}))
vi.mock("../../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: vi.fn() }))
vi.mock("../../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))
vi.mock("../manager", () => ({ getModsManager: () => undefined }))

const isolation = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-set-native-"))
  const original = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = path.join(root, "data")
  return { root, original }
})
const { root, original } = isolation
let plugins: typeof import("../../ipc/plugins")
let storage: typeof import("../../storage")
const close: Array<() => Promise<void> | void> = []
beforeAll(async () => {
  plugins = await import("../../ipc/plugins")
  storage = await import("../../storage")
  const owned = relative(root, storage.getPluginsDir())
  expect(owned && !owned.startsWith("..") && !isAbsolute(owned)).toBeTruthy()
})
afterAll(async () => {
  for (const work of close.reverse()) await work()
  if (original === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = original
  if (root) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const workspace = await mkdtemp(join(root, "workspace-")),
    threadId = "source-set-native"
  const scope = { workspace, threadId, incarnation: { token: "source-set", legacyCreatedAt: 1 } }
  const context = () => ({ scope, assertCurrent: () => {} })
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, before: string | undefined, next: string) => {
      if (values.get(key) !== before) return false
      values.set(key, next)
      return true
    }
  }
  const control = new ModControlStore(join(workspace, "mods.sqlite"))
  close.push(() => control.close())
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    control,
    {
      plugins: storage.getPlugins,
      enabled: () => true,
      clawApplicable: () => true,
      publish: async (_workspace, value) => value,
      changed: () => {}
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() {
        guests.forEach((guest) => guest.dispose())
      },
      async stopAndDrain() {
        guests.forEach((guest) => guest.dispose())
      }
    })
  )
  close.push(() => functions.close())
  const actions = () => functions.actionCatalog(workspace, threadId)
  const sessions = new ProjectAuthoringSessions(actions)
  sessions.configurePersistence(settings, join(workspace, "projects"))
  const observeInstallation = (
    input: { pluginId: string; name: string; version: string; digest: string },
    guard: () => void
  ) => observeProjectDeliveryInstallation(storage.getPluginsDir(), storage.getPlugins, input, guard)
  const installed = vi.fn(plugins.installDerivedPluginDirectory)
  const deliveryDependencies: ConstructorParameters<typeof CreatorProjectDeliveries>[0] = {
    root: join(workspace, "deliveries"),
    settings,
    sessions,
    context,
    occupied: () => false,
    plugins: storage.getPlugins,
    install: installed,
    invalidate: () => {},
    changed: () => {},
    actions,
    observeInstallation
  }
  const deliveries = new CreatorProjectDeliveries(deliveryDependencies)
  const deps: ConstructorParameters<typeof CreatorSourceSets>[0] = {
    root: join(workspace, "sources"),
    settings,
    sessions,
    deliveries,
    context,
    occupied: () => false,
    plugins: storage.getPlugins,
    install: installed,
    observeInstallation,
    validatePackage: plugins.inspectCompletePluginDirectory,
    functions: (space) => functions.status(space),
    actions,
    assertAuthorized: (space, bindings) => {
      for (const binding of bindings) {
        const grant = control.getGrant(space, `function:${binding.name}`)
        if (!grant?.enabled || grant.digest !== binding.digest)
          throw Error("SOURCE_SET_AUTHORIZATION_CHANGED")
      }
    },
    invalidate: () => {},
    changed: () => {}
  }
  const sourceSets = new CreatorSourceSets(deps)
  const startUse = new PluginStartUseService({
    plugins: storage.getPlugins,
    enable: async (id, guard) => {
      guard()
      storage.setPluginEnabled(id, true)
    }
  })
  return {
    workspace,
    threadId,
    scope,
    sourceSets,
    sessions,
    deliveries,
    installed,
    functions,
    startUse,
    deps,
    deliveryDependencies
  }
}

async function vendorSource(workspace: string, dependency = false) {
  const selected = join(workspace, "vendor-source")
  await cp(resolve("tests/fixtures/native-compositions/vendor"), join(selected, "project"), {
    recursive: true
  })
  if (dependency) {
    const source = createAuthoringTemplate({
      id: "vendor-" + randomUUID().slice(0, 8),
      name: "Vendor helper",
      kind: "command",
      instruction: "Review supplied vendor material"
    })
    for (const file of source.files) {
      const path = join(selected, "dependency", file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.text)
    }
  }
  await writeFile(
    join(selected, "devclaw.source-set.json"),
    JSON.stringify({
      protocol: "devclaw.project-source-set/v1",
      title: "供应商准入",
      goal: "核对供应商",
      project: "project",
      dependencies: dependency ? ["dependency"] : []
    })
  )
  return selected
}

it("imports actual AutoBiz packages, independently installs and grants them, compiles real catalog identities and reaches original start-use", async () => {
  const f = await fixture()
  await f.sourceSets.import(f.threadId, f.workspace, resolve("resources/native-compositions"))
  const set = f.sourceSets.status(f.threadId)!
  expect(set.dependencies).toHaveLength(2)
  expect(f.installed).not.toHaveBeenCalled()
  await expect(f.sourceSets.advance(f.threadId, f.workspace, set.id)).rejects.toThrow(
    "DEPENDENCIES_PENDING"
  )
  for (const dep of set.dependencies) {
    await f.sourceSets.install(f.threadId, f.workspace, set.id, dep.id)
    const current = f.sourceSets.status(f.threadId)!.dependencies.find((row) => row.id === dep.id)!
    const identity = {
      threadId: f.threadId,
      expectedWorkspace: f.workspace,
      pluginId: current.pluginId!,
      expected: { name: dep.name, version: dep.version, digest: dep.digest }
    }
    const use = await f.startUse.prepare(identity, () => {})
    if (use.activationRequired) await f.startUse.enable(identity, () => {})
    const status = (await f.functions.status(f.workspace)).find(
      (row) => row.pluginId === current.pluginId
    )!
    expect(status.state).toBe("needs-approval")
    await expect(f.sourceSets.advance(f.threadId, f.workspace, set.id)).rejects.toThrow()
    await f.functions.approve(f.workspace, current.pluginId!, status.digest!)
  }
  const first = f.sourceSets.status(f.threadId)!.dependencies[0]
  const originalStatus = f.deps.functions
  f.deps.functions = async (space) => {
    const rows = await originalStatus(space)
    f.functions.revoke(space, first.name)
    return rows // Simulate revoke after an early ready row was already collected.
  }
  await expect(f.sourceSets.advance(f.threadId, f.workspace, set.id)).rejects.toThrow(
    "AUTHORIZATION_CHANGED"
  )
  f.deps.functions = originalStatus
  let firstStatus = (await f.functions.status(f.workspace)).find(
    (row) => row.pluginId === first.pluginId
  )!
  await f.functions.approve(f.workspace, first.pluginId!, firstStatus.digest!)
  const originalPrepare = f.deliveries.prepare.bind(f.deliveries)
  const preparing = vi.spyOn(f.deliveries, "prepare").mockImplementationOnce(async (...args) => {
    const result = await originalPrepare(...args)
    f.functions.revoke(f.workspace, first.name)
    return result
  })
  await expect(f.sourceSets.advance(f.threadId, f.workspace, set.id)).rejects.toThrow(
    "AUTHORIZATION"
  )
  expect(f.sourceSets.status(f.threadId)?.phase).not.toBe("ready")
  expect(f.installed).toHaveBeenCalledTimes(2)
  preparing.mockRestore()
  firstStatus = (await f.functions.status(f.workspace)).find(
    (row) => row.pluginId === first.pluginId
  )!
  await f.functions.approve(f.workspace, first.pluginId!, firstStatus.digest!)
  await f.sourceSets.advance(f.threadId, f.workspace, set.id)
  expect(f.sourceSets.status(f.threadId)?.phase).toBe("ready")
  const delivery = f.deliveries.status(f.threadId)!
  expect(delivery.phase).toBe("needs-confirmation")
  const authorPlugin = JSON.parse(
    f.sessions
      .list(f.scope)[0]
      .source.files.find((file) => file.path === "composition/source.json")!.text
  ).plugin
  expect(delivery.name).not.toBe(authorPlugin.id)
  expect(delivery.name).toMatch(/^[a-z][a-z0-9-]{0,47}$/)
  expect(f.installed).toHaveBeenCalledTimes(2)
  await f.deliveries.install(f.threadId, f.workspace, {
    deliveryId: delivery.id,
    digest: delivery.digest
  })
  const saved = f.deliveries.status(f.threadId)!
  const report = await f.startUse.prepare(
    {
      threadId: f.threadId,
      expectedWorkspace: f.workspace,
      pluginId: saved.pluginId!,
      expected: { name: saved.name, version: saved.version, digest: saved.digest }
    },
    () => {}
  )
  expect(report.kind).toBe("host-project")
  const compiled = f.sessions.list(f.scope)[0]
  const lock = compiled.source.files.find(
    (file) => file.path === "devclaw.project-actions.lock.json"
  )!.text
  for (const dep of f.sourceSets.status(f.threadId)!.dependencies)
    expect(lock).toContain(dep.pluginId)
  expect(f.installed).toHaveBeenCalledTimes(3)
}, 120_000)

it("drives real vendor import, compile, install and start-use services through the actual browser cards", async () => {
  const f = await fixture()
  const selected = await vendorSource(f.workspace)
  let sets = f.sourceSets,
    deliveries = f.deliveries,
    sessions = f.sessions
  const status = () => ({
    threadId: f.threadId,
    workspace: f.workspace,
    enabled: true,
    drafts: [],
    trials: [],
    sourceSet: sets.status(f.threadId),
    projectRequest: sessions.trialRequest(f.scope),
    projectDelivery: deliveries.status(f.threadId)
  })
  const h = await sourceSetBrowser(
    { threadId: f.threadId, workspace: f.workspace },
    async (method, input) => {
      expect(input.threadId).toBe(f.threadId)
      if (method !== "status") expect(input.expectedWorkspace).toBe(f.workspace)
      if (method === "importSourceSet") {
        expect(Object.keys(input).sort()).toEqual(["expectedWorkspace", "threadId"])
        // Native directory-picker result is the only fixture boundary; installation is the original service.
        await sets.import(f.threadId, f.workspace, selected)
      } else if (method === "advanceSourceSet")
        await sets.advance(f.threadId, f.workspace, input.id)
      else if (method === "installProjectDelivery")
        await deliveries.install(f.threadId, f.workspace, {
          deliveryId: input.deliveryId,
          digest: input.digest
        })
      else if (method === "reconcileProjectDelivery")
        await deliveries.reconcile(f.threadId, f.workspace, {
          deliveryId: input.deliveryId,
          digest: input.digest
        })
      else if (method === "prepareStartUse")
        return f.startUse.prepare(input as unknown as PluginStartUseInput, () => {})
      else if (method === "enableStartUse")
        return f.startUse.enable(input as unknown as PluginStartUseInput, () => {})
      else if (method !== "status") throw Error("UNEXPECTED_TEST_TRANSPORT")
      return status()
    }
  )
  try {
    await h.page.getByRole("button", { name: "选择作者源码目录", exact: true }).click()
    await h.page.getByRole("button", { name: "核对权限并准备模板", exact: true }).click()
    await h.page.getByRole("button", { name: "确认安装新插件", exact: true }).waitFor()
    expect(status().projectDelivery!.name).not.toBe(
      JSON.parse(
        sessions
          .list(f.scope)[0]
          .source.files.find((file) => file.path === "composition/source.json")!.text
      ).plugin.id
    )
    expect(status().projectDelivery!.name).toMatch(/^[a-z][a-z0-9-]{0,47}$/)
    const revision = sessions.list(f.scope)[0].revision
    sessions = new ProjectAuthoringSessions(f.deps.actions)
    sessions.configurePersistence(f.deps.settings, join(f.workspace, "projects"))
    deliveries = new CreatorProjectDeliveries({ ...f.deliveryDependencies, sessions })
    sets = new CreatorSourceSets({ ...f.deps, sessions, deliveries })
    expect(status().sourceSet?.phase).toBe("needs-review")
    expect(status().projectDelivery?.phase).toBe("unknown")
    await h.page.evaluate((value) => {
      Object.assign(window, { coldStatus: value })
    }, status())
    await h.page.evaluate("window.fixture.setStatus(window.coldStatus)")
    await h.page.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
    await h.page.getByText(/已核实：未发现本次交付的执行结果/).waitFor()
    expect(status().sourceSet?.phase).toBe("needs-review")
    expect(f.installed).not.toHaveBeenCalled()
    await h.page.getByRole("button", { name: "核对权限并准备模板", exact: true }).click()
    await expect.poll(() => status().sourceSet?.phase).toBe("ready")
    expect(sessions.list(f.scope)[0].revision).toBe(revision)
    const exported = deliveries.status(f.threadId)!
    await deliveries.export(
      f.threadId,
      f.workspace,
      { deliveryId: exported.id, digest: exported.digest },
      join(f.workspace, "owned-test-export.zip")
    )
    expect(status().projectDelivery?.canInstall).toBe(true)
    deliveries = new CreatorProjectDeliveries({ ...f.deliveryDependencies, sessions })
    sets = new CreatorSourceSets({ ...f.deps, sessions, deliveries })
    expect(status().projectDelivery?.phase).toBe("exported")
    expect(status().projectDelivery?.canInstall).toBe(false)
    expect(status().sourceSet?.phase).toBe("needs-review")
    await h.page.evaluate((value) => {
      Object.assign(window, { coldStatus: value })
    }, status())
    await h.page.evaluate("window.fixture.setStatus(window.coldStatus)")
    await h.page.getByRole("button", { name: "核对权限并准备模板", exact: true }).click()
    await expect.poll(() => status().sourceSet?.phase).toBe("ready")
    expect(f.installed).not.toHaveBeenCalled()
    expect(sessions.list(f.scope)[0].revision).toBe(revision)
    await h.page.getByRole("button", { name: "确认安装新插件", exact: true }).click()
    await expect.poll(() => deliveries.status(f.threadId)?.phase).toBe("installed")
    deliveries = new CreatorProjectDeliveries({ ...f.deliveryDependencies, sessions })
    sets = new CreatorSourceSets({ ...f.deps, sessions, deliveries })
    expect(status().sourceSet?.phase).toBe("ready")
    await h.page.evaluate((value) => {
      Object.assign(window, { coldStatus: value })
    }, status())
    await h.page.evaluate("window.fixture.setStatus(window.coldStatus)")
    await h.page.getByRole("button", { name: "开始使用", exact: true }).click()
    await h.page.getByText(/此插件通过本地项目任务使用/).waitFor()
    if (await h.page.getByRole("button", { name: "启用新插件", exact: true }).count())
      await h.page.getByRole("button", { name: "启用新插件", exact: true }).click()
    await h.page.getByRole("button", { name: "进入本地任务创建", exact: true }).click()
    await expect
      .poll(() => h.page.evaluate("window.fixture.startUseIntent()?.report.kind"))
      .toBe("host-project")
    expect(deliveries.status(f.threadId)?.phase).toBe("installed")
    expect(f.installed).toHaveBeenCalledOnce()
    expect(await h.page.getByLabel("插件名称").count()).toBe(0)
    expect(h.errors).toEqual([])
  } catch (error) {
    console.error(
      "[source-set browser diagnostic]",
      JSON.stringify({
        text: await h.page.locator("body").innerText(),
        status: status(),
        errors: h.errors
      })
    )
    throw error
  } finally {
    await h.browser.close()
  }
}, 120_000)

it("reconciles a lost original installation reply without reinstalling and preserves cold explicit review", async () => {
  const f = await fixture()
  await f.sourceSets.import(f.threadId, f.workspace, await vendorSource(f.workspace, true))
  const set = f.sourceSets.status(f.threadId)!,
    dep = set.dependencies[0]
  f.installed.mockImplementationOnce(async (...args) => {
    await plugins.installDerivedPluginDirectory(...args)
    throw Error("LOST_REPLY")
  })
  await expect(f.sourceSets.install(f.threadId, f.workspace, set.id, dep.id)).rejects.toThrow(
    "LOST_REPLY"
  )
  const cold = new CreatorSourceSets(f.deps)
  expect(cold.status(f.threadId)?.phase).toBe("needs-review")
  expect(cold.status(f.threadId)?.dependencies[0].phase).toBe("unknown")
  await expect(cold.install(f.threadId, f.workspace, set.id, dep.id)).rejects.toThrow(
    "REVIEW_REQUIRED"
  )
  await expect(cold.cancel(f.threadId, f.workspace, set.id)).rejects.toThrow("OUTCOME_UNCONFIRMED")
  await cold.reconcile(f.threadId, f.workspace, set.id, dep.id)
  expect(cold.status(f.threadId)?.dependencies[0].phase).toBe("installed")
  expect(f.installed).toHaveBeenCalledOnce()
  await cold.cancel(f.threadId, f.workspace, set.id)
  expect(cold.status(f.threadId)?.phase).toBe("cancelled")
  await cold.import(f.threadId, f.workspace, join(f.workspace, "vendor-source"))
  const next = cold.status(f.threadId)!
  await cold.install(f.threadId, f.workspace, next.id, next.dependencies[0].id)
  expect(f.installed).toHaveBeenCalledOnce() // Exact existing bytes are observed, never reinstalled.
  await expect(cold.advance(f.threadId, f.workspace, next.id)).rejects.toThrow("AUTHORIZATION")
}, 60_000)

it("rejects a same-name different-byte installation and changed frozen dependency source", async () => {
  const f = await fixture()
  const selected = await vendorSource(f.workspace, true)
  await f.sourceSets.import(f.threadId, f.workspace, selected)
  const set = f.sourceSets.status(f.threadId)!,
    dep = set.dependencies[0]
  await f.sourceSets.install(f.threadId, f.workspace, set.id, dep.id)
  await f.sourceSets.cancel(f.threadId, f.workspace, set.id)
  await writeFile(join(selected, "dependency", "README.md"), "Different author bytes\n")
  await f.sourceSets.import(f.threadId, f.workspace, selected)
  const next = f.sourceSets.status(f.threadId)!,
    nextDep = next.dependencies[0]
  await expect(f.sourceSets.install(f.threadId, f.workspace, next.id, nextDep.id)).rejects.toThrow(
    "INSTALLED_CONFLICT"
  )
  expect(f.installed).toHaveBeenCalledOnce()
  await writeFile(join(f.deps.root, next.id, nextDep.id, "README.md"), "Changed frozen copy\n")
  await expect(f.sourceSets.install(f.threadId, f.workspace, next.id, nextDep.id)).rejects.toThrow(
    "DEPENDENCY_CHANGED"
  )
  expect(f.installed).toHaveBeenCalledOnce()
}, 60_000)

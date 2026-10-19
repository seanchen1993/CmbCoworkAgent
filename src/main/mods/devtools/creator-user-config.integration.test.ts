import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "../v2/manager"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { compileFunctionPlugin } from "../v2/loader"
import { CreatorUserConfigService, setCreatorUserConfigService } from "./creator-user-config"
import { ModsManager } from "../manager"
import { createModConfigurationTool } from "../../agent/tools/mod-configuration-tool"
import { setModDevelopmentService, type ModDevelopmentService } from "./development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { CreatorRequestBudgets } from "./creator-request-budget"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import type { DevelopmentContext } from "./development-service"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(extraHook = "", nativeWorkspace = false) {
  const root = await mkdtemp(join(tmpdir(), "creator-user-config-"))
  const source = join(root, "plugin")
  await mkdir(join(source, "hooks"), { recursive: true })
  const manifest = { name: "creator-config", userConfig: {
    tone: { type: "string", title: "Tone", description: "Voice", default: "warm" },
    required: { type: "string", title: "Required", description: "Required", required: true },
    directory: { type: "directory", title: "Knowledge", description: "Knowledge directory" },
    token: { type: "string", title: "Token", description: "Token", sensitive: true }
  } }
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest))
  await writeFile(join(source, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(join(source, "hooks/register.ts"), `export function register(on, options) {
    on("session.start",async ($,e,next) => {
      await $.command.register({name:"config-probe",description:JSON.stringify(options)})
      return next(e)
    })
    ${extraHook}
  }`)
  const native = nativeWorkspace
    ? new ModsManager(join(root, "native-control.sqlite"), () => [], async () => false, () => {})
    : undefined
  const workspace = native?.workspaceKey(root) ?? root
  const settings = new ModControlStore(join(root, "control.sqlite"))
  const protector = testSecretProtector()
  const values = new FunctionUserConfigValues(settings, protector)
  const plugins = [{ id: "p", name: manifest.name, path: source, enabled: true }]
  let busy = false, current = true
  const changed = vi.fn()
  const manager = new FunctionModsManager(settings, {
    plugins: () => plugins,
    enabled: () => true,
    publish: async (_w, value) => value,
    changed: () => {},
    configurationBusy: () => busy,
    secretProtector: protector
  }, () => {
    const guests: FunctionGuestRuntime[] = []
    return { load: async (...args) => {
      const guest = await FunctionGuestRuntime.create(...args)
      guests.push(guest)
      return guest
    }, stop: () => { for (const guest of guests) guest.dispose() } }
  })
  const context: DevelopmentContext = { scope: {
    workspace, threadId: "chat", incarnation: { token: "creator-config", legacyCreatedAt: 1 }
  }, assertCurrent: () => {
    if (!current) throw Error("DEVELOPMENT_TURN_CHANGED")
  } }
  const makeService = (read?: ConstructorParameters<typeof CreatorUserConfigService>[0]["read"]) => new CreatorUserConfigService({
    settings, context: () => context, changed,
    ...(native ? { normalizeWorkspace: (value: string) => native.workspaceKey(value) } : {}),
    read: read ?? ((c, p, s, guard) => manager.userConfig(c.scope.workspace, c.scope.threadId, p, s, guard)),
    save: (c, b, k, v, s, guard) => manager.saveUserConfig(c.scope.workspace,
      c.scope.threadId, b.pluginId, b.digest, k, v, b.revision, s, guard),
    reset: (c, b, k, s, guard) => manager.resetUserConfig(c.scope.workspace,
      c.scope.threadId, b.pluginId, b.digest, k, b.revision, s, guard),
    apply: (c, b, s, guard) => manager.applyUserConfig(c.scope.workspace,
      c.scope.threadId, b.pluginId, b.digest, b.revision, s, guard)
  })
  cleanup.push(async () => {
    manager.close()
    native?.close()
    settings.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("creator-user-config-"))
      throw Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true })
  })
  const compiled = await compileFunctionPlugin(source)
  settings.grant(workspace, `function:${compiled.name}`, compiled.digest, true)
  values.save(workspace, manifest.name, compiled.userConfig!, "required", "provided", 0, () => {})
  const signal = new AbortController().signal
  return { root, workspace, native, source, manifest, manager, values, settings, compiled, context,
    service: makeService(), makeService, signal, changed,
    busy: (value: boolean) => { busy = value },
    lost: () => { current = false } }
}

it("routes a real model configuration tool workspace alias through the original canonical store and native card", async () => {
  const f = await fixture("", true)
  const alias = process.platform === "win32" ? f.root.toUpperCase() : f.root + sep
  expect(alias).not.toBe(f.workspace)
  expect(f.native!.workspaceKey(alias)).toBe(f.workspace)
  const budgets = new CreatorRequestBudgets()
  setModDevelopmentService({
    isCreatorMode: (id: string, value: string) => id === "chat" &&
      f.native!.workspaceKey(value) === f.workspace,
    captureCreatorMode: () => () => f.context.assertCurrent(),
    claimAuthoringBudget: (_id: string, run: string, kind: "operation" | "candidate") =>
      budgets.claim(f.workspace, run, kind)
  } as unknown as ModDevelopmentService)
  setCreatorUserConfigService(f.service)
  claimLocalThreadRunLease({ threadId: "chat", owner: "desktop", runId: "canonical-config" })
  try {
    const tool = createModConfigurationTool({ threadId: "chat", workspace: alias, signal: f.signal })
    let result = JSON.parse(await tool.invoke({ action: "inspect", pluginId: "p" }))
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(result.result.workspace).toBe(f.workspace)
    result = JSON.parse(await tool.invoke({ action: "set", pluginId: "p", digest: result.result.digest,
      revision: result.result.savedRevision, key: "tone", value: "canonical" }))
    expect(result.ok).toBe(true)
    expect(f.values.read(f.workspace, "creator-config").values.tone).toBe("canonical")
    expect(f.values.read(alias, "creator-config").values).toEqual({})
    result = JSON.parse(await tool.invoke({ action: "request_input", pluginId: "p", digest: result.result.digest,
      revision: result.result.savedRevision, key: "token" }))
    expect(result.ok).toBe(true)
    expect(result.result.request.workspace).toBe(f.workspace)
    expect(f.service.status("chat")?.workspace).toBe(f.workspace)
    expect(result.result.request).not.toHaveProperty("value")
  } finally {
    setModDevelopmentService(undefined)
    setCreatorUserConfigService(undefined)
    releaseLocalThreadRunLease("chat", "desktop", "canonical-config")
  }
})

it.each(["workspace", "owner", "source", "revision"] as const)(
  "rejects a canonical alias configuration continuation after %s changes across its read await",
  async (change) => {
    const f = await fixture("", true)
    const alias = process.platform === "win32" ? f.root.toUpperCase() : f.root + sep
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const service = f.makeService(async (context, plugin, signal, guard) => {
      const view = await f.manager.userConfig(context.scope.workspace, context.scope.threadId,
        plugin, signal, guard)
      entered.resolve()
      await release.promise
      return view
    })
    const original = await f.manager.userConfig(f.workspace, "chat", "p", f.signal, () => {})
    const pending = service.change("chat", alias, { pluginId: "p", digest: original.digest,
      revision: original.savedRevision }, "set", "tone", "must-not-commit", f.signal, () => {})
    void pending.catch(() => {})
    await entered.promise
    if (change === "workspace") {
      const other = join(f.root, "other-workspace")
      await mkdir(other)
      f.context.scope.workspace = f.native!.workspaceKey(other)
    } else if (change === "owner") f.lost()
    else if (change === "source") await writeFile(join(f.source, "hooks/register.ts"), "export function register() {}")
    else f.values.save(f.workspace, "creator-config", f.compiled.userConfig!,
      "tone", "newer-native-value", original.savedRevision, () => {})
    release.resolve()
    await expect(pending).rejects.toThrow(change === "workspace" ? "MODS_CONFIG_SCOPE_CHANGED"
      : change === "owner" ? "DEVELOPMENT_TURN_CHANGED"
      : change === "source" ? "MODS_CONFIG_SOURCE_CHANGED" : "MODS_CONFIG_VALUE_CHANGED")
    expect(f.values.read(f.workspace, "creator-config").values.tone)
      .toBe(change === "revision" ? "newer-native-value" : undefined)
    expect(service.status("chat")).toBeUndefined()
  }
)

it("does not grant a different real directory the creator's canonical configuration scope", async () => {
  const f = await fixture("", true)
  const foreign = join(f.root, "foreign-workspace")
  await mkdir(foreign)
  await expect(f.service.inspect("chat", foreign, "p", f.signal, () => {}))
    .rejects.toMatchObject({ code: "MODS_CONFIG_SCOPE_CHANGED" })
  expect(f.values.read(f.workspace, "creator-config").values).toEqual({ required: "provided" })
  expect(f.values.read(f.native!.workspaceKey(foreign), "creator-config").values).toEqual({})
})

it("uses the original durable revisioned store and safely applies only after the existing task", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "chat")
  let view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  const original = view.savedRevision
  f.busy(true)
  view = await f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: original }, "set", "tone", "formal", f.signal, () => {}) as typeof view
  expect(view.state).toBe("pending")
  expect(f.values.read(f.root, "creator-config").values.tone).toBe("formal")
  expect((await f.manager.commands(f.root, "chat")).find(row => row.command === "config-probe")?.name)
    .toContain('"tone":"warm"')
  f.busy(false)
  view = await f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: view.savedRevision }, "apply", undefined, undefined, f.signal, () => {}) as typeof view
  expect(view.state).toBe("applied")
  expect((await f.manager.commands(f.root, "chat")).find(row => row.command === "config-probe")?.name)
    .toContain('"tone":"formal"')
  const reopened = f.makeService()
  expect((await reopened.inspect("chat", f.root, "p", f.signal, () => {})).savedRevision)
    .toBe(view.savedRevision)
  await expect(reopened.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: original }, "set", "tone", "stale", f.signal, () => {}))
    .rejects.toMatchObject({ code: "MODS_CONFIG_VALUE_CHANGED" })
})

it("removes an ordinary override rather than persisting an old default, preserving other fields", async () => {
  const f = await fixture()
  let view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  view = await f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: view.savedRevision }, "set", "tone", "formal", f.signal, () => {}) as typeof view
  view = await f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: view.savedRevision }, "reset", "tone", undefined, f.signal, () => {}) as typeof view
  expect(view.fields.find(row => row.key === "tone")?.value).toBe("warm")
  expect(f.values.read(f.root, "creator-config").values).toEqual({ required: "provided" })
  const changed = { ...f.manifest, userConfig: { ...f.manifest.userConfig,
    tone: { ...f.manifest.userConfig.tone, default: "new-default" } } }
  await writeFile(join(f.source, "plugin.json"), JSON.stringify(changed))
  view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  expect(view.fields.find(row => row.key === "tone")?.value).toBe("new-default")
})

it("requires the original trusted form for paths/secrets, persists only references and never grants", async () => {
  const f = await fixture()
  const view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  const binding = { pluginId: "p", digest: view.digest, revision: view.savedRevision }
  for (const key of ["token", "directory"])
    await expect(f.service.change("chat", f.root, binding, "set", key,
      "do-not-save", f.signal, () => {})).rejects.toMatchObject({ code: "MODS_USER_CONFIG_DIALOG_REQUIRED" })
  await f.service.change("chat", f.root, binding, "request_input", "token", undefined, f.signal, () => {})
  const restored = f.makeService().status("chat")!
  expect(restored).toMatchObject({ key: "token", pluginId: "p", sensitive: true })
  expect(restored).not.toHaveProperty("value")
  // This is the existing native API used by FunctionUserConfig, not a model tool operation.
  await f.manager.saveSensitiveUserConfig(f.root, "chat", "p", view.digest, "token",
    { operation: "set", value: "native-secret-value" }, view.savedRevision, f.signal, () => {})
  const actual = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  expect(JSON.stringify(actual)).not.toContain("native-secret-value")
  expect(actual.fields.find(row => row.key === "token")?.secretState).toBe("saved")
  expect(f.service.status("chat")).toBeUndefined()
  // A new request after clearing the persisted reference must still CAS correctly.
  await f.service.change("chat", f.root, { ...binding, revision: actual.savedRevision },
    "request_input", "directory", undefined, f.signal, () => {})
  expect(f.service.status("chat")?.key).toBe("directory")
})

it("rejects source/owner/workspace changes without writing or trusting stale requests", async () => {
  const f = await fixture()
  const view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  const binding = { pluginId: "p", digest: view.digest, revision: view.savedRevision }
  await expect(f.service.change("chat", f.root + "-other", binding, "set", "tone", "bad",
    f.signal, () => {})).rejects.toMatchObject({ code: "MODS_CONFIG_SCOPE_CHANGED" })
  await writeFile(join(f.source, "hooks/register.ts"), "export function register() {}")
  await expect(f.service.change("chat", f.root, binding, "set", "tone", "bad", f.signal,
    () => {})).rejects.toMatchObject({ code: "MODS_CONFIG_SOURCE_CHANGED" })
  f.lost()
  await expect(f.service.inspect("chat", f.root, "p", f.signal, () => {}))
    .rejects.toThrow("DEVELOPMENT_TURN_CHANGED")
  expect(f.values.read(f.root, "creator-config").values).toEqual({ required: "provided" })
  expect(f.service.status("chat")).toBeUndefined()
})

it("keeps reset within the existing config.set policy and preserves a denied override", async () => {
  const f = await fixture(`on("config.set", async ($, e, next) => {
    if(e.key === "creator-config.tone" && e.value === "warm") return {deny:"Default disallowed"}
    return next(e)
  })`)
  await f.manager.commands(f.root, "chat")
  f.busy(true)
  let view = await f.service.inspect("chat", f.root, "p", f.signal, () => {})
  view = await f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: view.savedRevision }, "set", "tone", "formal", f.signal, () => {}) as typeof view
  await expect(f.service.change("chat", f.root, { pluginId: "p", digest: view.digest,
    revision: view.savedRevision }, "reset", "tone", undefined, f.signal, () => {}))
    .rejects.toMatchObject({ code: "MODS_CONFIG_DENIED" })
  expect(f.values.read(f.root, "creator-config").values.tone).toBe("formal")
})

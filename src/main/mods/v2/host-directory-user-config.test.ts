import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionUserConfigValues } from "./user-config-values"
import * as loader from "./loader"
import { FunctionConfigurationSourceCache } from "./configuration-source-cache"
import { RetainedPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../../plugins/runtime-source-scope"
import type { PluginMetadata } from "../../types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture(nativeSchema: boolean) {
  const root = await mkdtemp(join(tmpdir(), "host-directory-config-"))
  const source = join(root, "plugin")
  await mkdir(join(source, "mods"), { recursive: true })
  const schema = {
    knowledgeRoot: { type: "directory", title: "Knowledge", description: "Read-only source" },
    text: { type: "string", title: "Text", description: "Ordinary" },
    secret: { type: "string", title: "Secret", description: "Private", sensitive: true },
    file: { type: "file", title: "File", description: "One file" }
  }
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "package-display-name",
      version: "1.0.0",
      ...(nativeSchema ? {} : { userConfig: schema })
    })
  )
  await writeFile(
    join(source, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "actual-native-identity",
      entry: "register.ts",
      ...(nativeSchema ? { userConfig: schema } : {})
    })
  )
  await writeFile(join(source, "mods/register.ts"), "export function register() {}")
  const store = new ModControlStore(join(root, "settings.sqlite"))
  const plugins = [
    { id: "installed-uuid", name: "package-display-name", path: source, enabled: true }
  ]
  const manager = new FunctionModsManager(store, {
    plugins: () => plugins,
    enabled: () => false,
    publish: async (_workspace, value) => value,
    changed: () => {}
  })
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, source, store, manager, plugins }
}

it.each([true, false])(
  "reads native-UI saves using compiled identity with native-schema=%s",
  async (nativeSchema) => {
    const f = await fixture(nativeSchema)
    const compile = vi.spyOn(loader, "compileFunctionPlugin")
    const signal = new AbortController().signal
    const view = await f.manager.userConfig(f.root, "chat", "installed-uuid", signal, () => {})
    expect(view.plugin).toBe("actual-native-identity")
    expect(
      await f.manager.readDirectoryUserConfig(f.root, f.source, "knowledgeRoot")
    ).toBeUndefined()
    await f.manager.saveUserConfig(
      f.root,
      "chat",
      view.pluginId,
      view.digest,
      "knowledgeRoot",
      f.root,
      view.savedRevision,
      signal,
      () => {}
    )
    expect(await f.manager.readDirectoryUserConfig(f.root, f.source, "knowledgeRoot")).toBe(f.root)
    expect(f.manager.readUserConfigDirectoryIdentity(f.root, view.plugin, "knowledgeRoot")).toBe(
      f.root
    )
    expect(
      f.manager.readUserConfigDirectoryIdentity("another-workspace", view.plugin, "knowledgeRoot")
    ).toBeUndefined()
    expect(f.manager.readUserConfigIdentity(f.root, view.plugin)).toMatchObject({
      savedRevision: 1
    })
    expect(
      f.manager.readUserConfigDirectoryIdentity(f.root, "package-display-name", "knowledgeRoot")
    ).toBeUndefined()
    expect(
      await f.manager.readDirectoryUserConfig(
        join(f.root, "another-workspace"),
        f.source,
        "knowledgeRoot"
      )
    ).toBeUndefined()
    expect(
      new FunctionUserConfigValues(f.store).read(f.root, "package-display-name").values
    ).toEqual({})
    expect(compile).toHaveBeenCalledTimes(1)
  }
)

it("rejects undeclared, non-directory and secret fields and removed source identities", async () => {
  const f = await fixture(true)
  for (const key of ["missing", "text", "secret", "file"])
    await expect(f.manager.readDirectoryUserConfig(f.root, f.source, key)).rejects.toMatchObject({
      code: "MODS_USER_CONFIG_INVALID"
    })
  f.plugins.length = 0
  await expect(
    f.manager.readDirectoryUserConfig(f.root, f.source, "knowledgeRoot")
  ).rejects.toMatchObject({ code: "MODS_CONFIG_PLUGIN_MISSING" })
})

it("the host synchronous directory identity refuses ciphertext and non-text without exposing or decrypting it", async () => {
  const f = await fixture(true),
    key = "function-user-config:" + JSON.stringify([f.root, "actual-native-identity"])
  f.store.setSetting(key, JSON.stringify({ revision: 1, values: { knowledgeRoot: false } }))
  expect(() =>
    f.manager.readUserConfigDirectoryIdentity(f.root, "actual-native-identity", "knowledgeRoot")
  ).toThrow("MODS_USER_CONFIG_INVALID")
  f.store.setSetting(
    key,
    JSON.stringify({
      revision: 2,
      values: { knowledgeRoot: "must-not-read" },
      sealed: { knowledgeRoot: "c2VjcmV0" }
    })
  )
  expect(() =>
    f.manager.readUserConfigDirectoryIdentity(f.root, "actual-native-identity", "knowledgeRoot")
  ).toThrow("MODS_USER_CONFIG_INVALID")
  const identity = f.manager.readUserConfigIdentity(f.root, "actual-native-identity")
  expect(JSON.stringify(identity)).not.toMatch(/must-not-read|c2VjcmV0/)
})

async function retainedFixture() {
  const f = await fixture(true)
  const view = await f.manager.userConfig(f.root, "chat", "installed-uuid", new AbortController().signal, () => {})
  await f.manager.saveUserConfig(f.root, "chat", view.pluginId, view.digest, "knowledgeRoot", f.root,
    view.savedRevision, new AbortController().signal, () => {})
  const snapshots = new RetainedPackageSnapshots(join(f.root, "retained"))
  const pinned = snapshots.capture(f.source)
  const token = issueRuntimePluginSourceToken({
    mode: "legacy", threadId: "thread", incarnationKey: "original", projectId: "project",
    operationId: "operation", workspace: f.root, packageDigest: pinned.digest,
    stageId: "legacy", plugin: { ...f.plugins[0], path: pinned.root, version: "1.0.0" } as PluginMetadata
  }, snapshots.captureGuard(pinned.digest), () => {
    if (!f.plugins.some(item => item.id === "installed-uuid" && item.enabled))
      throw Error("ORIGINAL_SOURCE_REVOKED")
  })
  return { ...f, pinned, token }
}

it("reads the original native configuration through an exact retained source, never a live-path substitution", async () => {
  const f = await retainedFixture()
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  await withRuntimePluginSource(f.token, async () => {
    expect(await f.manager.readDirectoryUserConfig(f.root, f.pinned.root, "knowledgeRoot")).toBe(f.root)
    expect(await f.manager.readDirectoryUserConfig(f.root, f.pinned.root, "knowledgeRoot")).toBe(f.root)
    await expect(f.manager.readDirectoryUserConfig(f.root, f.source, "knowledgeRoot"))
      .rejects.toMatchObject({ code: "MODS_CONFIG_PLUGIN_MISSING" })
  })
  expect(compile).toHaveBeenCalledTimes(1)
  expect(new FunctionUserConfigValues(f.store).read(f.root, "actual-native-identity")).toMatchObject({
    revision: 1, values: { knowledgeRoot: f.root }
  })
  const other = new RetainedPackageSnapshots(join(f.root, "other-retained")).capture(f.source)
  const otherToken = issueRuntimePluginSourceToken({
    mode: "legacy", threadId: "other", incarnationKey: "other", projectId: "other",
    operationId: "other", workspace: f.root, packageDigest: other.digest, stageId: "legacy",
    plugin: { ...f.plugins[0], path: other.root, version: "1.0.0" } as PluginMetadata
  })
  await withRuntimePluginSource(otherToken, async () => {
    await expect(f.manager.readDirectoryUserConfig(f.root, f.pinned.root, "knowledgeRoot"))
      .rejects.toMatchObject({ code: "MODS_CONFIG_PLUGIN_MISSING" })
  })
})

it.each(["disable", "uninstall", "source-bytes"] as const)(
  "rejects retained directory configuration when %s changes during the actual compilation await",
  async change => {
    const f = await retainedFixture()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = FunctionConfigurationSourceCache.prototype.read
    vi.spyOn(FunctionConfigurationSourceCache.prototype, "read").mockImplementation(async function(this: FunctionConfigurationSourceCache, path: string) {
      const compiled = await original.call(this, path)
      if (path === f.pinned.root) { entered.resolve(); await release.promise }
      return compiled
    })
    const reading = withRuntimePluginSource(f.token, () =>
      f.manager.readDirectoryUserConfig(f.root, f.pinned.root, "knowledgeRoot"))
    const rejected = expect(reading).rejects.toThrow(
      change === "source-bytes" ? /PACKAGE_CHANGED|PACKAGE_SNAPSHOT_CHANGED/ : "ORIGINAL_SOURCE_REVOKED"
    )
    await entered.promise
    if (change === "disable") f.plugins[0].enabled = false
    else if (change === "uninstall") f.plugins.length = 0
    else {
      const path = join(f.pinned.root, "mods/register.ts")
      await chmod(path, 0o600)
      await writeFile(path, "export function register(){ /* genuinely changed bytes */ }")
    }
    release.resolve()
    await rejected
    expect(new FunctionUserConfigValues(f.store).read(f.root, "actual-native-identity")).toMatchObject({
      revision: 1, values: { knowledgeRoot: f.root }
    })
  }
)

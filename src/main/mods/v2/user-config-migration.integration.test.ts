import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionUserConfigValues } from "./user-config-values"
import { compileFunctionPlugin } from "./loader"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import type { FunctionConfigHandle } from "./config-row-registry"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "migration-upgrade-")),
    source = join(root, "plugin")
  await mkdir(join(source, "mods"), { recursive: true })
  const field = { type: "string", title: "Label", description: "Help" }
  const old = parseFunctionUserConfig({ oldLabel: field, oldToken: { ...field, sensitive: true } })!
  const next = { label: { ...field, default: "default" }, token: { ...field, sensitive: true } }
  const declaration = {
    version: 1,
    migrations: [
      {
        fromVersion: 0,
        toVersion: 1,
        changes: [
          { kind: "rename", from: "oldLabel", to: "label" },
          { kind: "rename", from: "oldToken", to: "token" }
        ]
      }
    ]
  }
  const write = async (upgrade: boolean) => {
    await writeFile(
      join(source, "plugin.json"),
      JSON.stringify({ name: "Display name", version: upgrade ? "2.0.0" : "1.0.0" })
    )
    await writeFile(
      join(source, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "native-config-id",
        entry: "register.ts",
        userConfig: upgrade ? next : old,
        ...(upgrade ? { userConfigSchema: declaration, cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" } } : {})
      })
    )
  }
  await write(false)
  await writeFile(
    join(source, "mods/register.ts"),
    'export function register(){throw Error("not authorized to execute")}'
  )
  const store = new ModControlStore(join(root, "settings.sqlite")),
    protector = testSecretProtector()
  const values = new FunctionUserConfigValues(store, protector)
  values.save(root, "native-config-id", old, "oldLabel", "retained-user-value", 0, () => {})
  values.saveSensitive(
    root,
    "native-config-id",
    old,
    "oldToken",
    { operation: "set", value: "native-secret-sentinel" },
    1,
    () => {}
  )
  values.save(root, "another-plugin", old, "oldLabel", "unaffected", 0, () => {})
  const plugins = [{ id: "original-uuid", name: "Display name", path: source, enabled: true }]
  let locked = false
  const nativeRow: FunctionConfigHandle = {
    key: "native-config-id.label",
    label: "Policy",
    kind: "text",
    storageKey: "native-policy",
    provider: { plugin: "core", tier: "core" },
    locked: () => true,
    validate: () => true,
    cell: { read: () => ({ revision: "policy", value: "policy-value" }), write: vi.fn() }
  }
  const make = () =>
    new FunctionModsManager(store, {
      plugins: () => plugins,
      secretProtector: protector,
      configRows: () => (locked ? [nativeRow] : []),
      enabled: () => false,
      publish: async (_workspace, value) => value,
      changed: () => {}
    })
  let manager = make()
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  return {
    root,
    source,
    store,
    values,
    next,
    write,
    plugins,
    nativeRow,
    signal,
    get manager() {
      return manager
    },
    lock: (value: boolean) => {
      locked = value
    },
    restart: () => {
      manager.close()
      manager = make()
    },
    view: () => manager.userConfig(root, "chat", "original-uuid", signal, () => {})
  }
}
it("upgrades actual immutable source/schema using original native identity, preserves encrypted data across restart and grants no code authority", async () => {
  const f = await fixture(),
    before = await f.view()
  expect(before.plugin).toBe("native-config-id")
  const rawIdentity = f.manager.readUserConfigIdentity(f.root, before.plugin)
  expect(JSON.stringify(rawIdentity)).not.toContain("native-secret-sentinel")
  await f.write(true)
  const next = await f.view()
  expect(next.digest).not.toBe(before.digest)
  expect(next.migration).toMatchObject({ fromVersion: 0, toVersion: 1, canApply: true })
  const result = await f.manager.migrateUserConfig(
    f.root,
    "chat",
    next.pluginId,
    next.digest,
    next.savedRevision,
    next.migration!.digest,
    f.signal,
    () => {}
  )
  expect(result.savedRevision).toBe(3)
  expect(result.migration).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("native-secret-sentinel")
  expect(f.values.read(f.root, "Display name").revision).toBe(0)
  expect(f.values.read(f.root, "another-plugin").values.oldLabel).toBe("unaffected")
  expect(f.store.getGrant(f.root, "function:native-config-id")).toBeNull()
  f.restart()
  expect((await f.view()).migration).toBeUndefined()
  expect(
    f.values.resolve(
      f.root,
      "native-config-id",
      (await compileFunctionPlugin(f.source)).userConfig!,
      (await compileFunctionPlugin(f.source)).userConfigSchema
    )
  ).toEqual({ label: "retained-user-value", token: "native-secret-sentinel" })
  const identity = await f.manager.readDirectoryUserConfigSnapshot(f.root, f.source)
  expect(identity).toMatchObject({ plugin: "native-config-id", schemaVersion: 1, savedRevision: 3 })
  expect(JSON.stringify(identity)).not.toMatch(/retained-user-value|native-secret-sentinel/)
  expect(identity!.storedRecordDigest).not.toBe(rawIdentity.storedRecordDigest)
})
it("keeps original bytes when source, revision or native policy authority changes before migration", async () => {
  const f = await fixture()
  await f.write(true)
  const view = await f.view(),
    saved = f.values.read(f.root, view.plugin)
  f.lock(true)
  expect((await f.view()).migration!.canApply).toBe(false)
  await expect(
    f.manager.migrateUserConfig(
      f.root,
      "chat",
      view.pluginId,
      view.digest,
      view.savedRevision,
      view.migration!.digest,
      f.signal,
      () => {}
    )
  ).rejects.toThrow("POLICY_LOCKED")
  expect(f.nativeRow.cell.read().value).toBe("policy-value")
  expect(f.nativeRow.cell.write).not.toHaveBeenCalled()
  f.lock(false)
  await writeFile(join(f.source, "mods/register.ts"), "export function register(){}")
  await expect(
    f.manager.migrateUserConfig(
      f.root,
      "chat",
      view.pluginId,
      view.digest,
      view.savedRevision,
      view.migration!.digest,
      f.signal,
      () => {}
    )
  ).rejects.toThrow("SOURCE_CHANGED")
  expect(f.values.read(f.root, view.plugin)).toEqual(saved)
  const current = await f.view()
  await expect(
    f.manager.migrateUserConfig(
      f.root,
      "chat",
      current.pluginId,
      current.digest,
      current.savedRevision,
      current.migration!.digest,
      f.signal,
      () => {
        f.plugins.length = 0
      }
    )
  ).rejects.toThrow("SOURCE_CHANGED")
  expect(f.values.read(f.root, view.plugin)).toEqual(saved)
})

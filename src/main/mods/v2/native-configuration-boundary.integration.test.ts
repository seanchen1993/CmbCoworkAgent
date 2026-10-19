import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionUserConfigValues } from "./user-config-values"
import { RetainedPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { withNativeConfigurationScope } from "./native-configuration-scope"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import type { ModJson } from "../../../shared/mods/types"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(migration = false) {
  const root = await mkdtemp(join(tmpdir(), "native-config-fence-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"), workspace = join(root, "unit")
  await mkdir(join(source, "mods"), { recursive: true })
  await mkdir(workspace)
  const field = { type: "string", title: "Label", description: "Native parameter" }
  await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "display", version: "1.0.0" }))
  await writeFile(join(source, "business-note.md"), "Original source resource")
  await writeFile(join(source, "mods/main.ts"), "export function register() { /* Configuration only. */ }")
  await writeFile(join(source, "mods/manifest.json"), JSON.stringify({
    apiVersion: "cmb.mods/v2", id: "actual-native-name", entry: "main.ts",
    userConfig: { label: field,
      directory: { type: "directory", title: "Directory", description: "Read-only" },
      token: { ...field, sensitive: true } },
    ...(migration ? { userConfigSchema: { version: 1, migrations: [{ fromVersion: 0, toVersion: 1,
      changes: [{ kind: "rename", from: "oldLabel", to: "label" }] }] },
      cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" } } : {})
  }))
  const snapshots = new RetainedPackageSnapshots(join(root, "retained")), retained = snapshots.capture(source)
  const plugin = { id: "installed-uuid", name: "display", path: retained.root, enabled: true }
  const store = new ModControlStore(join(root, "config.sqlite")), protector = testSecretProtector()
  const values = new FunctionUserConfigValues(store, protector)
  if (migration) values.save(workspace, "actual-native-name", parseFunctionUserConfig({ oldLabel: field })!,
    "oldLabel", "existing", 0, () => {})
  let active = true, contentCalls = 0, authorityCalls = 0
  let publication: ((value: ModJson) => Promise<ModJson>) | undefined
  const authority = () => { authorityCalls++; if (!active) throw Error("NATIVE_OWNER_CHANGED") }
  const content = () => { authority(); contentCalls++; snapshots.read(retained.digest); authority() }
  const manager = new FunctionModsManager(store, { plugins: () => [], enabled: () => false,
    secretProtector: protector, publish: async (_workspace, value) => publication ? publication(value) : value,
    changed: () => {} })
  cleanup.push(() => { manager.close(); store.close() })
  const signal = new AbortController()
  const run = <T>(work: () => T) => withNativeConfigurationScope({ workspace, projectId: "unit-a",
    plugin, assertCurrent: authority, assertContentCurrent: content }, work)
  const read = () => run(() => manager.userConfig(workspace, "unit-a", plugin.id, signal.signal, authority))
  return { workspace, plugin, retained, manager, values, protector, signal, authority, run, read,
    revoke: () => { active = false }, setPublication: (callback: typeof publication) => { publication = callback },
    mutateResource: () => writeFileSync(join(retained.root, "business-note.md"), "Changed source resource"),
    counts: () => ({ content: contentCalls, authority: authorityCalls }) }
}

it("checks full native content only at actual read/publication boundaries and rechecks on every request", async () => {
  const f = await fixture()
  const first = await f.read()
  expect(first.fields.find(field => field.key === "label")?.value).toBe("")
  expect(f.counts().content).toBe(3)
  expect(f.counts().authority).toBeGreaterThan(3)
  await f.read()
  expect(f.counts().content).toBe(6)
  expect(f.values.read(f.workspace, first.plugin).revision).toBe(0)
})

it.each(["source", "owner", "cancel"])("rejects %s changes across publication without returning the stale native value", async change => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.setPublication(async value => { entered.resolve(); await release.promise; return value })
  const read = f.read(), rejected = expect(read).rejects.toThrow()
  await entered.promise
  if (change === "source") f.mutateResource()
  if (change === "owner") f.revoke()
  if (change === "cancel") f.signal.abort()
  release.resolve()
  await rejected
  expect(f.values.read(f.workspace, "actual-native-name").revision).toBe(0)
})

it("keeps the chooser's complete source fence even when the selected or cancelled result arrives late", async () => {
  const f = await fixture(), view = await f.read()
  await expect(f.run(() => f.manager.pickUserConfigPath(f.workspace, "unit-a", f.plugin.id,
    view.digest, "directory", view.savedRevision, f.signal.signal, f.authority, async () => {
      f.mutateResource()
      return undefined
    }))).rejects.toThrow()
  expect(f.values.read(f.workspace, view.plugin).revision).toBe(0)
})

it("cannot reuse a native scope for another unit", async () => {
  const f = await fixture()
  await expect(f.run(() => f.manager.userConfig(f.workspace, "unit-b", f.plugin.id,
    f.signal.signal, f.authority))).rejects.toThrow("MODS_CONFIG_SCOPE_CHANGED")
  f.revoke()
  expect(() => f.run(() => undefined)).toThrow("NATIVE_OWNER_CHANGED")
})

it("checks actual secret encryption before committing, without storing or returning a secret on source change", async () => {
  const f = await fixture(), view = await f.read()
  const encrypt = f.protector.encryptString
  f.protector.encryptString = value => { const sealed = encrypt(value); f.mutateResource(); return sealed }
  await expect(f.run(() => f.manager.saveSensitiveUserConfig(f.workspace, "unit-a", f.plugin.id,
    view.digest, "token", { operation: "set", value: "native-secret-sentinel" }, view.savedRevision,
    f.signal.signal, f.authority))).rejects.toThrow()
  const record = f.values.read(f.workspace, view.plugin)
  expect(record.revision).toBe(0)
  expect(record.values).toEqual({})
  expect(record.sealed ?? {}).toEqual({})
})

it("keeps original migration state when the full source changes at the original store boundary", async () => {
  const f = await fixture(true), view = await f.read()
  expect(view.migration?.canApply).toBe(true)
  const before = f.values.read(f.workspace, view.plugin)
  const original = FunctionUserConfigValues.prototype.migrate
  vi.spyOn(FunctionUserConfigValues.prototype, "migrate").mockImplementation(function (this: FunctionUserConfigValues, ...args: Parameters<FunctionUserConfigValues["migrate"]>) {
    f.mutateResource()
    return original.apply(this, args)
  })
  await expect(f.run(() => f.manager.migrateUserConfig(f.workspace, "unit-a", f.plugin.id,
    view.digest, view.savedRevision, view.migration!.digest, f.signal.signal, f.authority))).rejects.toThrow()
  expect(f.values.read(f.workspace, view.plugin)).toEqual(before)
})


it("does not save an ordinary value when a non-compiled package resource changes at the store boundary", async () => {
  const f = await fixture(), view = await f.read()
  const original = FunctionUserConfigValues.prototype.save
  vi.spyOn(FunctionUserConfigValues.prototype, "save").mockImplementation(function (this: FunctionUserConfigValues, ...args: Parameters<FunctionUserConfigValues["save"]>) {
    f.mutateResource()
    return original.apply(this, args)
  })
  await expect(f.run(() => f.manager.saveUserConfig(f.workspace, "unit-a", f.plugin.id,
    view.digest, "label", "must-not-be-saved", view.savedRevision,
    f.signal.signal, f.authority))).rejects.toThrow()
  expect(f.values.read(f.workspace, view.plugin)).toEqual({ revision: 0, values: {} })
})

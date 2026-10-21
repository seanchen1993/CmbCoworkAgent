import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { isConfigurationOnlyPackage } from "./configuration-only-package"
import { compileFunctionConfiguration, compileFunctionPlugin } from "./loader"
import { FunctionConfigurationSourceCache } from "./configuration-source-cache"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fields = {
  knowledge: {
    type: "directory",
    title: "知识目录",
    description: "只读取已绑定目录",
    required: true
  }
}
async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), "mods-configuration-only-"))
  roots.push(root)
  await mkdir(join(root, "hooks"))
  await mkdir(join(root, "mods"))
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      name: "config-only",
      version: "1.0.0",
      ...(native ? {} : { userConfig: fields })
    })
  )
  await writeFile(
    join(root, "hooks/hooks.json"),
    JSON.stringify([
      { event: "PreToolUse", type: "command", command: "python original-check.py", mandatory: true }
    ])
  )
  // Merely retaining unreferenced code cannot execute it during schema discovery.
  await writeFile(join(root, "hooks/register.ts"), 'throw Error("METADATA_MUST_NOT_EVALUATE_CODE")')
  if (native)
    await writeFile(
      join(root, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "config-only",
        userConfig: fields
      })
    )
  return root
}

describe("native metadata configuration without a Function guest", () => {
  it("reads flat mandatory Hooks plus Host schema through a private cache and does not manufacture an empty guest", async () => {
    const root = await fixture()
    const original = await readFile(join(root, "hooks/hooks.json"))
    expect(isConfigurationOnlyPackage(root)).toBe(true)
    const cache = new FunctionConfigurationSourceCache()
    const first = await cache.read(root)
    expect(first).toMatchObject({
      configurationOnly: true,
      name: "config-only",
      code: "",
      clients: {},
      environment: { read: [], write: [] },
      userConfig: fields
    })
    expect(first.actions).toBeUndefined()
    expect(first.components).toBeUndefined()
    expect(first.sources).not.toContain("hooks/register.ts")
    expect(Object.isFrozen(first.userConfig!.knowledge)).toBe(true)
    expect(await cache.read(root)).toBe(first)
    assertFunctionSourcesCurrent(first)
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_MANIFEST_INVALID")
    expect(await readFile(join(root, "hooks/hooks.json"))).toEqual(original)
  })

  it("preserves pinned migration schema and source proofs in a metadata-only native manifest", async () => {
    const root = await fixture(true)
    const userConfigSchema = {
      version: 1,
      migrations: [{ fromVersion: 0, toVersion: 1, changes: [] }]
    }
    await writeFile(
      join(root, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "config-only",
        userConfig: fields,
        userConfigSchema,
        cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" }
      })
    )
    expect(isConfigurationOnlyPackage(root)).toBe(true)
    const compiled = await compileFunctionConfiguration(root, { captureSources: true })
    expect(compiled).toMatchObject({
      configurationOnly: true,
      userConfig: fields,
      userConfigSchema,
      modelProtocol: "result-v1",
      authoringEntries: []
    })
    expect(compiled.authoringSources!["mods/manifest.json"]).toContain("userConfigMigrations")
    assertFunctionSourcesCurrent(compiled)
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_MANIFEST_INVALID")
  })

  it.each([
    { entry: "register.ts" },
    { modules: [] },
    { register: "register.ts" },
    { claw: { actions: [] } },
    { types: "index.d.ts" },
    { customRuntime: true },
    { options: { hidden: true } },
    { dependencies: { hidden: "1.0.0" } }
  ])(
    "does not classify unknown or behavioral Mods declaration as native metadata: %j",
    async (extra) => {
      const root = await fixture(true)
      await writeFile(
        join(root, "mods/manifest.json"),
        JSON.stringify({
          apiVersion: "cmb.mods/v2",
          id: "config-only",
          userConfig: fields,
          ...extra
        })
      )
      expect(isConfigurationOnlyPackage(root)).toBe(false)
    }
  )

  it("continues normal guest compilation for an actual register module and retains the zero-module rejection", async () => {
    const root = await fixture()
    await writeFile(join(root, "hooks/hooks.json"), '{"modules":[]}')
    expect(isConfigurationOnlyPackage(root)).toBe(false)
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_MODULES_LIMIT")
    await expect(compileFunctionConfiguration(root)).rejects.toThrow("MODS_MODULES_LIMIT")
    await writeFile(join(root, "hooks/hooks.json"), '{"modules":["register.ts"]}')
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(){throw Error("DO_NOT_EVALUATE") }'
    )
    const compiled = await new FunctionConfigurationSourceCache().read(root)
    expect(compiled.configurationOnly).toBeUndefined()
    expect(compiled.code).toContain("DO_NOT_EVALUATE")
    expect(compiled.userConfig).toEqual(fields)
  })

  it("invalidates schema reuse when formerly absent behavioral declarations appear", async () => {
    const root = await fixture()
    const cache = new FunctionConfigurationSourceCache()
    const first = await cache.read(root)
    await writeFile(
      join(root, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "config-only",
        entry: "register.ts"
      })
    )
    await writeFile(join(root, "mods/register.ts"), "export function register(){}")
    expect(() => assertFunctionSourcesCurrent(first)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
    expect(() => cache.peek(root)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
    const next = await cache.read(root)
    expect(next.configurationOnly).toBeUndefined()
    expect(next.digest).not.toBe(first.digest)
  })

  it("rejects linked declarations and revalidates unchanged bytes on replacement file identities", async () => {
    const root = await fixture()
    const cache = new FunctionConfigurationSourceCache()
    const first = await cache.read(root)
    const manifest = join(root, "plugin.json")
    await writeFile(manifest + ".replacement", await readFile(manifest))
    await rename(manifest + ".replacement", manifest)
    expect(await cache.read(root)).not.toBe(first)
    const target = join(root, "linked-source")
    await mkdir(target)
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({ apiVersion: "cmb.mods/v2", id: "config-only", userConfig: fields })
    )
    await symlink(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    await writeFile(manifest, JSON.stringify({ name: "config-only", mods: "linked/manifest.json" }))
    expect(isConfigurationOnlyPackage(root)).toBe(false)
    await expect(compileFunctionConfiguration(root)).rejects.toThrow()
  })

  it("retains schema conflict, invalid metadata and migration compatibility checks", async () => {
    const root = await fixture(true)
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ name: "config-only", userConfig: fields })
    )
    expect(isConfigurationOnlyPackage(root)).toBe(false)
    await expect(compileFunctionConfiguration(root)).rejects.toThrow("DECLARATION_CONFLICT")
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "config-only" }))
    await writeFile(
      join(root, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "config-only",
        userConfig: fields,
        userConfigSchema: { version: 1, migrations: [] }
      })
    )
    expect(isConfigurationOnlyPackage(root)).toBe(false)
    await expect(compileFunctionConfiguration(root)).rejects.toThrow()
    await writeFile(join(root, "mods/manifest.json"), " ".repeat(32769))
    expect(isConfigurationOnlyPackage(root)).toBe(false)
  })
})

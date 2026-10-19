import { createAuthoringSourceBundle } from "../devtools/authoring-bundle"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { parseFunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import { readPureFunctionSource } from "../devtools/authoring-install-source"
import { createHash } from "node:crypto"
import { modCompiler } from "../loader"
import { FUNCTION_HOST_REVISION } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { checkFunctionPlugin } from "../devtools/check"
import { resolveFunctionUserConfig } from "../../../shared/mods/v2/user-config"

const roots: string[] = []
async function plugin(source: string, modules = ["./register.ts"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mods-v2-loader-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "loader-probe" })
  )
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules }))
  await writeFile(join(root, "hooks/register.ts"), source)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("function plugin snapshot loader", () => {
  it.each(["cjs", "cts"])("loads .%s entries and imports as ESM and pins their sources", async (extension) => {
    const root = await plugin("", [`./register.${extension}`])
    await writeFile(join(root, `hooks/register.${extension}`),
      `import { text } from "./helper.${extension}";
       export function register(on) { on("command.run", () => ({text})) }`)
    const helper = join(root, `hooks/helper.${extension}`)
    await writeFile(helper, extension === "cts"
      ? 'export const text: string = "first"' : 'export const text = "first"')
    const first = await compileFunctionPlugin(root, { captureSources: true })
    expect(first.sources).toEqual(expect.arrayContaining([
      `hooks/register.${extension}`, `hooks/helper.${extension}`
    ]))
    expect((await checkFunctionPlugin(root)).registrations).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "command.run" })])
    )
    await writeFile(helper, 'export const text = "second"')
    expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
  })

  it.each(["cjs", "cts"])("rejects require and dynamic import in .%s modules", async (extension) => {
    const root = await plugin("", [`./register.${extension}`])
    await writeFile(join(root, "hooks/helper.js"), 'export const text = "value"')
    for (const body of [
      'const source = require("./helper.js"); export function register(){return source.text}',
      'export function register(name){return require(name)}',
      'export function register(){return import("./helper.js")}'
    ]) {
      await writeFile(join(root, `hooks/register.${extension}`), body)
      await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_IMPORT_DENIED")
    }
  })

  it.each(["cjs", "cts"])("includes .%s client modules in the immutable bundle", async (extension) => {
    const root = await plugin(`export function register(on){on("ui.render",($,e)=>{
      const {Client}=$.ui.resolve(e);return Client({key:"board",module:"./board.${extension}"})
    })}`)
    await writeFile(join(root, `hooks/board.${extension}`),
      'export default function Board(){ return "client" }')
    expect(Object.keys((await compileFunctionPlugin(root)).clients)).toEqual([
      `hooks/board.${extension}`
    ])
    await writeFile(join(root, `hooks/board.${extension}`),
      'const value=require("./helper.js");export default function Board(){return value}')
    await writeFile(join(root, "hooks/helper.js"), 'export const text="not available"')
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_IMPORT_DENIED")
  })

  it("pins action declarations in the grant digest without running plugin code", async () => {
    const root = await plugin('export function register(){throw Error("must not run") }')
    const manifest = {
      name: "loader-probe",
      claw: {
        actions: [{ id: "run", name: "Run", command: "run", inputSchema: { type: "object" } }]
      }
    }
    await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
    const first = await compileFunctionPlugin(root)
    expect(first.actions).toEqual(manifest.claw.actions)
    manifest.claw.actions[0].command = "other"
    await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
    expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
  })

  it("rejects action schemas with external references instead of accepting unchecked inputs", async () => {
    const root = await plugin("export function register(){}")
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({
        name: "loader-probe",
        claw: {
          actions: [
            {
              id: "run",
              name: "Run",
              command: "run",
              inputSchema: { $ref: "https://invalid/schema" }
            }
          ]
        }
      })
    )
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_TOOL_SCHEMA_REF")
  })

  it("pins explicit platform action bindings without running registration or exposing every capability", async () => {
    const root = await plugin('export function register(){throw Error("must not execute") }')
    const manifest = {
      name: "loader-probe",
      claw: { actions: [{ id: "report", name: "Report", inputSchema: { type: "object" },
        platform: { id: "delivery", version: "1.0.0", action: "generate" } }] }
    }
    const save = () => writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
    await save()
    const first = await compileFunctionPlugin(root)
    expect(first.actions).toEqual(manifest.claw.actions)
    expect(first.actions![0]).not.toHaveProperty("command")
    manifest.claw.actions[0].platform.version = "1.1.0"
    await save()
    expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
  })

  it("preserves legacy digest shape and pins the full optional configuration declaration", async () => {
    const root = await plugin("export function register(){}")
    const manifest = {
      name: "loader-probe",
      cmbCompatibility: { modelProtocol: "legacy-v1" },
      claw: {
        actions: [
          {
            id: "run",
            name: "Run",
            command: "run",
            inputSchema: {}
          } as ModObject
        ]
      }
    }
    const save = () => writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
    await save()
    const legacy = await compileFunctionPlugin(root, { captureSources: true })
    // This is the pre-configSchema approval hash contract, without any new normalized keys.
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          name: legacy.name,
          profile: legacy.profile,
          hostRevision: FUNCTION_HOST_REVISION,
          version: modCompiler().version,
          code: legacy.code,
          clients: legacy.clients,
          environment: legacy.environment,
          sources: Object.entries(legacy.authoringSources!).sort(([a], [b]) => a.localeCompare(b))
        })
      )
      .digest("hex")
    expect(legacy.digest).toBe(expected)
    expect(legacy.actions![0]).not.toHaveProperty("configSchema")
    manifest.claw.actions[0].configSchema = {
      type: "object",
      title: "Configuration",
      properties: {}
    }
    await save()
    const added = await compileFunctionPlugin(root)
    expect(added.actions![0].configSchema).toEqual(manifest.claw.actions[0].configSchema)
    expect(added.digest).not.toBe(legacy.digest)
    const configSchema = manifest.claw.actions[0].configSchema as ModObject
    configSchema.title = "Changed annotation"
    await save()
    expect((await compileFunctionPlugin(root)).digest).not.toBe(added.digest)
    delete manifest.claw.actions[0].configSchema
    await save()
    expect((await compileFunctionPlugin(root)).digest).toBe(legacy.digest)
  })

  it.each([null, [], { $ref: "https://invalid/schema" }, { type: "object", unsupported: true }])(
    "rejects invalid config schemas at compilation: %j",
    async (configSchema) => {
      const root = await plugin("export function register(){}")
      await writeFile(
        join(root, ".claude-plugin/plugin.json"),
        JSON.stringify({
          name: "loader-probe",
          claw: {
            actions: [
              {
                id: "run",
                name: "Run",
                command: "run",
                inputSchema: {},
                configSchema
              }
            ]
          }
        })
      )
      await expect(compileFunctionPlugin(root)).rejects.toThrow()
    }
  )

  it("rejects an explicit null claw declaration instead of treating it as absent", async () => {
    const root = await plugin("export function register(){}")
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "loader-probe", claw: null })
    )
    await expect(compileFunctionPlugin(root)).rejects.toThrow("CLAW_ACTION_OBJECT_INVALID")
  })

  it("reports literal environment declarations in approval digest and rejects direct dynamic access", async () => {
    const root = await plugin(
      'export function register(on){on("command.run",async $=>({text:await $.env.get("HOME")}))}'
    )
    const first = await compileFunctionPlugin(root)
    expect(first.environment).toEqual({ read: ["HOME"], write: [] })
    expect((await checkFunctionPlugin(root)).environment).toEqual(first.environment)
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on){on("command.run",async $=>({text:await $.env.get("PATH")}))}'
    )
    const second = await compileFunctionPlugin(root)
    expect(second.environment.read).toEqual(["PATH"])
    expect(second.digest).not.toBe(first.digest)
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on){on("command.run",async ($,e)=>({text:await $.env.get(e.text)}))}'
    )
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_ENV_NAME_LITERAL")
  })
  it.each(["Panel", "h", "__functionJsx"])(
    "captures %s Client modules in the grant digest and rejects dynamic or escaping paths",
    async (factory) => {
      const source = `export function register(on){on("ui.render",($,e)=>{
      const {Client: Panel}=$.ui.resolve(e);return ${factory}(${factory === "Panel" ? "" : "Panel,"}{key:"board",module:"./board.tsx"})
    })}`
      const root = await plugin(source)
      await writeFile(
        join(root, "hooks/board.tsx"),
        `export default function Board(_,s){const {Text}=s.elements;return <Text>A</Text>}`
      )
      const first = await compileFunctionPlugin(root)
      expect(Object.keys(first.clients)).toEqual(["hooks/board.tsx"])
      expect(first.code).toContain("hooks/board.tsx")
      await writeFile(
        join(root, "hooks/board.tsx"),
        `export default function Board(_,s){const {Text}=s.elements;return <Text>B</Text>}`
      )
      expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
      await writeFile(
        join(root, "hooks/register.ts"),
        source.replace('module:"./board.tsx"', "module:e.path")
      )
      await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_CLIENT_MODULE_LITERAL")
      await writeFile(
        join(root, "hooks/register.ts"),
        source.replace("./board.tsx", "../../outside.tsx")
      )
      await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_PATH_INVALID")
    }
  )
  it("loads the real Claude package layout and reports registration without granting permissions", async () => {
    const report = await checkFunctionPlugin(resolve("tests/fixtures/mods-v2/conformance"))
    expect(report).toMatchObject({ valid: true, authorized: false, profile: "claude-code/2.1.278" })
    expect(report.registrations.some((r) => r.hasCatch)).toBe(true)
  })
  it("includes package metadata and source in the immutable digest", async () => {
    const root = await plugin('export function register(on){on("command.run",()=>({text:"a"}))}')
    const first = await compileFunctionPlugin(root)
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on){on("command.run",()=>({text:"b"}))}'
    )
    const second = await compileFunctionPlugin(root)
    expect(second.digest).not.toBe(first.digest)
    expect(first.code).toContain('"a"')
  })
  it("refuses escaping module paths and arbitrary runtime imports", async () => {
    const escape = await plugin("export function register(){}", ["../../outside.ts"])
    await expect(compileFunctionPlugin(escape)).rejects.toThrow("MODS_PATH_INVALID")
    const bare = await plugin(
      'import fs from "node:fs";export function register(){fs.readFileSync("x")}'
    )
    await expect(compileFunctionPlugin(bare)).rejects.toThrow("MODS_IMPORT_DENIED")
  })
  it("does not silently accept asynchronous registration through the module wrapper", async () => {
    const root = await plugin("export async function register(){}")
    await expect(checkFunctionPlugin(root)).rejects.toThrow()
  })
  it("reports unknown events and never claims that checking grants access", async () => {
    const root = await plugin('export function register(on){on("turn.typo",()=>({}))}')
    expect(await checkFunctionPlugin(root)).toMatchObject({
      valid: false,
      authorized: false,
      diagnostics: [{ code: "MODS_EVENT_PROVIDER_REQUIRED", pattern: "turn.typo" }]
    })
  })

  it("warns about schema-only registrations without breaking legacy package validation", async () => {
    const root = await plugin('export function register(on){on("classic.FileChanged",()=>({}))}')
    expect(await checkFunctionPlugin(root)).toMatchObject({
      valid: true,
      packageValid: true,
      authorized: false,
      compatibility: {
        scope: "registration-events-only",
        status: "unsupported",
        strictCompatible: false
      },
      diagnostics: [{ code: "MODS_EVENT_SCHEMA_ONLY", pattern: "classic.FileChanged" }]
    })
  })

  it("reports completion gates only for exact registrations, not wildcard observers", async () => {
    const root = await plugin(`export function register(on) {
      on("*", (_,e,next) => next(e))
      on("completion.check", () => ({decision:"pass"}))
    }`)
    const report = await checkFunctionPlugin(root)
    expect(report.valid).toBe(true)
    expect(report.registrations[0].events).not.toContain("completion.check")
    expect(report.registrations[1].events).toEqual(["completion.check"])
  })

  it("resolves a custom hooks path relative to the package, then modules relative to hooks", async () => {
    const root = await plugin(
      "export function register(on){on('session.start',(_,e,next)=>next(e))}"
    )
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "custom", hooks: "./hooks/custom.json" })
    )
    await writeFile(join(root, "hooks/custom.json"), JSON.stringify({ modules: ["./register.ts"] }))
    const compiled = await compileFunctionPlugin(root)
    expect(compiled.name).toBe("custom")
    expect(compiled.sources).toContain("hooks/custom.json")
    expect(compiled.code).toContain("session.start")
  })

  it("routes a native v2 manifest in a plugin package without requiring Claude hooks", async () => {
    const root = await plugin("export function register(){}")
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "native-package", mods: "hooks/native.json" })
    )
    await writeFile(
      join(root, "hooks/native.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "native",
        entry: "register.ts",
        options: { level: 2 }
      })
    )
    const compiled = await compileFunctionPlugin(root)
    expect(compiled).toMatchObject({ name: "native", options: { level: 2 } })
    expect(compiled.sources).toContain("hooks/native.json")
  })

  it("rejects duplicate unqualified registrations as the upstream loader does", async () => {
    const root = await plugin(
      'export function register(on){on("session.id",()=>({value:"a"}));on("session.id",()=>({value:"b"}))}'
    )
    await expect(checkFunctionPlugin(root)).rejects.toThrow()
  })
})


it.each(["legacy-v1", "result-v1"])("requires fresh approval for an unchanged explicit %s package after host contract migration", async modelProtocol => {
  const root = await plugin("export function register(){}")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({
    name: "loader-probe", cmbCompatibility: { modelProtocol }
  }))
  const current = await compileFunctionPlugin(root, { captureSources: true })
  expect(FUNCTION_HOST_REVISION).toBe("claude-295-tools-v91")
  for (const hostRevision of ["module-resources-v89", "claude-295-tools-v90"]) {
    const oldHostDigest = createHash("sha256").update(JSON.stringify({
      name: current.name, profile: current.profile,
      ...(modelProtocol === "result-v1" ? { modelProtocol } : {}),
      hostRevision, version: modCompiler().version,
      code: current.code, clients: current.clients, environment: current.environment,
      sources: Object.entries(current.authoringSources!).sort(([a], [b]) => a.localeCompare(b))
    })).digest("hex")
    expect(current.digest).not.toBe(oldHostDigest)
  }
})

it("defaults Claude packages to result objects and pins explicit legacy opt-in in the source digest", async () => {
  const root = await plugin("export function register(){}")
  const first = await compileFunctionPlugin(root, { captureSources: true })
  // Reconstruct the former implicit-legacy approval digest using the SAME package bytes.
  const oldDigest = createHash("sha256").update(JSON.stringify({
    name: first.name, profile: first.profile, hostRevision: FUNCTION_HOST_REVISION,
    version: modCompiler().version, code: first.code, clients: first.clients,
    environment: first.environment,
    sources: Object.entries(first.authoringSources!).sort(([a], [b]) => a.localeCompare(b))
  })).digest("hex")
  expect(first.digest).not.toBe(oldDigest)
  expect(first.modelProtocol).toBe("result-v1")
  expect((await checkFunctionPlugin(root)).modelProtocol).toBe("result-v1")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({name:"loader-probe",cmbCompatibility:{modelProtocol:"legacy-v1"}}))
  const legacy = await compileFunctionPlugin(root)
  expect(legacy.modelProtocol).toBe("legacy-v1")
  expect(legacy.digest).not.toBe(first.digest)
  expect((await checkFunctionPlugin(root)).modelProtocol).toBe("legacy-v1")
  await mkdir(join(root, "mods"))
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify({apiVersion:"cmb.mods/v2",id:"loader-probe",entry:"../hooks/register.ts",cmbCompatibility:{modelProtocol:"result-v1"}}))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_MODEL_PROTOCOL_CONFLICT")
})


it("does not erase a Claude package null compatibility declaration with fallback", async () => {
  const root = await plugin("export function register(){}")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe", cmbCompatibility: null }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_MODEL_PROTOCOL_MANIFEST")
})

it("captures original userConfig schema in the approved snapshot without executing register", async () => {
  const root = await plugin('export function register(){throw Error("must not run") }')
  const manifest = { name: "loader-probe", userConfig: {
    tone: { type: "string", title: "Tone", description: "Voice", default: "warm" }
  } }
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
  const first = await compileFunctionPlugin(root)
  expect(first.userConfig).toEqual(manifest.userConfig)
  expect(resolveFunctionUserConfig(first.userConfig!, {})).toEqual({ tone: "warm" })
  manifest.userConfig.tone.default = "formal"
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify(manifest))
  expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
  expect(first.userConfig!.tone.default).toBe("warm")
})

it("does not silently ignore a null or invalid userConfig declaration", async () => {
  const root = await plugin("export function register(){}")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe", userConfig: null }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("Invalid plugin configuration field")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe", userConfig: {
    bad: { type: "number", title: "Count", description: "Help", default: "not a number" }
  } }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("Invalid plugin configuration field: bad")
})

it("pins optional engineering schema migrations next to the original fields without executing code", async () => {
  const root = await plugin('export function register(){throw Error("never execute") }')
  const userConfig = { label: { type: "string", title: "Label", description: "Help", default: "new" } }
  const userConfigSchema = { version: 1, migrations: [{ fromVersion: 0, toVersion: 1,
    changes: [{ kind: "rename", from: "oldLabel", to: "label" }] }] }
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe", userConfig, userConfigSchema, cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" } }))
  const first = await compileFunctionPlugin(root)
  expect(first.userConfigSchema).toEqual(userConfigSchema)
  await mkdir(join(root, "mods"))
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify({ apiVersion: "cmb.mods/v2",
    id: "native-not-display", entry: "register.ts", userConfigSchema }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("DECLARATION_CONFLICT")
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe", userConfig }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("SCHEMA_SOURCE_CONFLICT")
  await writeFile(join(root, "mods/register.ts"), 'export function register(){}')
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify({ apiVersion: "cmb.mods/v2",
    id: "native-not-display", entry: "register.ts", userConfig, userConfigSchema, cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" } }))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loader-probe" }))
  const native = await compileFunctionPlugin(root)
  expect(native.name).toBe("native-not-display")
  expect(native.userConfigSchema).toEqual(userConfigSchema)
  expect(native.digest).not.toBe(first.digest)
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify({ apiVersion: "cmb.mods/v2",
    id: "native-not-display", entry: "register.ts", userConfig,
    userConfigSchema: { ...userConfigSchema, tier: "builtin" } }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MIGRATION_INVALID")
})

it("requires the migration marker and executes the pinned historical parser to prove older clients reject it", async () => {
  const root = await plugin("export function register(){}")
  const userConfig = { label: { type: "string", title: "Label", description: "Help" } }
  const userConfigSchema = { version: 1, migrations: [{ fromVersion: 0, toVersion: 1, changes: [] }] }
  const cmbCompatibility = { modelProtocol: "result-v1", userConfigMigrations: "v1" }
  const file = join(root, ".claude-plugin/plugin.json")
  await writeFile(file, JSON.stringify({ name: "loader-probe", userConfig, userConfigSchema }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_USER_CONFIG_SCHEMA_COMPATIBILITY_REQUIRED")
  await writeFile(file, JSON.stringify({ name: "loader-probe", userConfig, cmbCompatibility }))
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_USER_CONFIG_SCHEMA_DECLARATION_REQUIRED")
  await writeFile(file, JSON.stringify({ name: "loader-probe", userConfig, userConfigSchema, cmbCompatibility }))
  expect((await compileFunctionPlugin(root)).userConfigSchema).toEqual(userConfigSchema)
  // Exact pre-migration source, not mutable HEAD or a rewritten parser. Provenance is
  // alongside the fixture: commit d3edb4a10366a52ab6282783ab2bc22c000278e6,
  // Git blob 4f1b6b166d5e1805aa9c6302879eff0ba4e7f7b3. No Git history is needed at test time.
  const original = await readFile(
    resolve("tests/fixtures/mods-upstream/client-compatibility/model-protocol-before-user-config-migrations.ts.txt")
  )
  expect(original.byteLength).toBe(3097)
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "8c9e299e95a0780a24c097f3fedee715aba28a6193c1b8ac3ba58289e58f20cf"
  )
  const exports: { parseFunctionModelProtocol?: (value: unknown) => unknown } = {}
  const compiled = ts.transpileModule(original.toString("utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(compiled, {
    exports,
    require(id: string) {
      if (id !== "./contracts") throw Error("UNEXPECTED_OLD_PARSER_IMPORT")
      return { isModObject, ModFunctionError }
    }
  })
  expect(exports.parseFunctionModelProtocol!({ modelProtocol: "result-v1" })).toBe("result-v1")
  expect(() => exports.parseFunctionModelProtocol!(cmbCompatibility)).toThrow("MODS_MODEL_PROTOCOL_MANIFEST")
  expect(parseFunctionModelProtocol(cmbCompatibility)).toBe("result-v1")
  expect(() => parseFunctionModelProtocol({ ...cmbCompatibility, userConfigMigrations: "unknown" })).toThrow("MODS_MODEL_PROTOCOL_MANIFEST")
  expect(() => parseFunctionModelProtocol({ ...cmbCompatibility, arbitraryAuthority: true })).toThrow("MODS_MODEL_PROTOCOL_MANIFEST")
  const nativeManifest = { apiVersion: "cmb.mods/v2", id: "native-config", entry: "register.ts", userConfig, userConfigSchema, cmbCompatibility }
  expect(readPureFunctionSource(createAuthoringSourceBundle([
    { path: "plugin.json", text: JSON.stringify({ name: "native-config", version: "1.0.0", mods: "mods/manifest.json" }) },
    { path: "mods/manifest.json", text: JSON.stringify(nativeManifest) },
    { path: "mods/register.ts", text: "export function register(){}" }
  ])).files).toHaveLength(3)
})

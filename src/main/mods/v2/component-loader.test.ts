import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin, projectFunctionComponents } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ClawComponentSelection } from "../../../shared/mods/claw-components"

const roots: string[] = []
const guests: FunctionGuestRuntime[] = []
afterEach(async () => {
  guests.splice(0).forEach((guest) => guest.dispose())
  for (const root of roots.splice(0)) {
    const path = resolve(root)
    if (!relative(resolve(tmpdir()), path).startsWith("mods-components-loader-"))
      throw Error("Unexpected fixture cleanup path")
    await rm(path, { recursive: true, force: true })
  }
})

const selected = (ids: string[], config = {}): ClawComponentSelection => ({
  mode: "selected",
  ids,
  config
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-components-loader-"))
  roots.push(root)
  await mkdir(join(root, "mods"))
  const component = (id: string, dependsOn: string[] = []) => ({
    id,
    name: id,
    kind: "module",
    entry: `${id}.ts`,
    dependsOn,
    actionIds: [] as string[]
  })
  const manifest = {
    apiVersion: "cmb.mods/v2",
    id: "component-demo",
    options: { inherited: "package" },
    claw: {
      componentsVersion: 1,
      components: [component("review", ["core"]), component("core"), component("rewrite")],
      actions: [] as { id: string; name: string; command: string; inputSchema: object }[]
    }
  }
  const save = () => writeFile(join(root, "mods/manifest.json"), JSON.stringify(manifest))
  await save()
  await writeFile(
    join(root, "mods/core.ts"),
    `export function register() {
    globalThis.componentOrder = (globalThis.componentOrder || []).concat("core")
  }`
  )
  await writeFile(
    join(root, "mods/review.ts"),
    `export function register(on, config) {
    globalThis.componentOrder.push("review")
    on("command.run", () => ({order:globalThis.componentOrder, config}))
  }`
  )
  await writeFile(
    join(root, "mods/rewrite.ts"),
    `throw Error("UNSELECTED_TOP_LEVEL"); export function register() { throw Error("UNSELECTED_REGISTER") }`
  )
  return { root, manifest, save }
}
async function run(code: string, options = {}) {
  const guest = await FunctionGuestRuntime.create(code, options)
  guests.push(guest)
  return guest.invoke("0", {}, async () => ({}), {
    event: "command.run",
    origin: { plugin: "engine", tier: "core" },
    capabilities: [],
    plugin: { name: "component-demo", root: "/fixture" }
  })
}

describe("explicit component source projection", () => {
  it("rejects selected component values shadowing declared package userConfig", async () => {
    const { root, manifest, save } = await fixture()
    Object.assign(manifest, {
      userConfig: { tone: { type: "string", title: "Tone", description: "Voice", default: "warm" } }
    })
    Object.assign(manifest.claw.components[0], {
      configSchema: { type: "object", properties: { tone: { type: "string" } } }
    })
    await save()
    const compiled = await compileFunctionPlugin(root)
    expect(() => projectFunctionComponents(compiled,
      selected(["core", "review"], { review: { tone: "other" } })))
      .toThrow("MODS_USER_CONFIG_COMPONENT_CONFLICT")
    expect(() => projectFunctionComponents(compiled, selected(["core", "review"]))).not.toThrow()
    const legacy = { ...compiled, userConfig: undefined }
    expect(() => projectFunctionComponents(legacy,
      selected(["core", "review"], { review: { tone: "other" } }))).not.toThrow()
  })
  it("never evaluates the unselected entry, and registers dependencies once before dependents", async () => {
    const { root } = await fixture()
    const compiled = await compileFunctionPlugin(root)
    const projection = projectFunctionComponents(compiled, selected(["review", "core"]))
    expect(projection.effectiveIds).toEqual(["core", "review"])
    expect(projection.code).not.toContain("UNSELECTED_TOP_LEVEL")
    expect(await run(projection.code, projection.options)).toEqual({
      value: { order: ["core", "review"], config: { inherited: "package" } }
    })
    // Guest exceptions are deliberately redacted at the sandbox boundary.
    await expect(FunctionGuestRuntime.create(compiled.code)).rejects.toThrow("MODS_GUEST_ERROR")
  })

  it("binds false, zero, and empty config values only to their own entry", async () => {
    const { root, manifest, save } = await fixture()
    Object.assign(manifest.claw.components[0], {
      configSchema: {
        type: "object",
        required: ["enabled", "count", "label"],
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          count: { type: "integer" },
          label: { type: "string" }
        }
      }
    })
    await save()
    await writeFile(
      join(root, "mods/core.ts"),
      `export function register(on, config) {
      if (config.enabled !== undefined) throw Error("CONFIG_LEAK")
      globalThis.componentOrder = ["core"]
    }`
    )
    const compiled = await compileFunctionPlugin(root)
    const config = { review: { enabled: false, count: 0, label: "" } }
    const projection = projectFunctionComponents(compiled, selected(["core", "review"], config))
    config.review.count = 9
    expect(await run(projection.code, projection.options)).toEqual({
      value: {
        order: ["core", "review"],
        config: { inherited: "package", enabled: false, count: 0, label: "" }
      }
    })
    expect(() => projectFunctionComponents(compiled, selected(["core", "review"]))).toThrow(
      "CLAW_COMPONENT_CONFIG_SCHEMA"
    )
  })

  it("pins all source in the grant digest but projects from the captured snapshot", async () => {
    const { root } = await fixture()
    const first = await compileFunctionPlugin(root)
    const a = projectFunctionComponents(first, selected(["core", "review"]))
    await writeFile(
      join(root, "mods/review.ts"),
      "export function register() { throw Error('CHANGED') }"
    )
    await writeFile(join(root, "mods/rewrite.ts"), "export function register() {}")
    expect(projectFunctionComponents(first, selected(["review", "core"]))).toEqual(a)
    expect((await compileFunctionPlugin(root)).digest).not.toBe(first.digest)
    expect(await run(a.code, a.options)).toMatchObject({ value: { order: ["core", "review"] } })
  })

  it("keeps a canonical selection digest distinct from full package authorization", async () => {
    const { root, manifest, save } = await fixture()
    Object.assign(manifest.claw.components[0], { configSchema: { type: "object" } })
    await save()
    const compiled = await compileFunctionPlugin(root)
    const a = projectFunctionComponents(
      compiled,
      selected(["review", "core"], { review: { a: 1, b: 2 } })
    )
    const b = projectFunctionComponents(
      compiled,
      selected(["core", "review"], { review: { b: 2, a: 1 } })
    )
    const c = projectFunctionComponents(
      compiled,
      selected(["core", "review"], { review: { a: 2, b: 2 } })
    )
    expect(a.selectionDigest).toBe(b.selectionDigest)
    expect(a.selectionDigest).not.toBe(c.selectionDigest)
    expect(a.selectionDigest).not.toBe(compiled.digest)
    expect(projectFunctionComponents(compiled).selectionDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each(["direct", "helper", "extensionless"])(
    "rejects %s imports into a different component entry",
    async (mode) => {
      const { root } = await fixture()
      await writeFile(join(root, "mods/rewrite.ts"), "export function register() {}")
      const target =
        mode === "helper" ? "helper.ts" : mode === "extensionless" ? "rewrite" : "rewrite.ts"
      await writeFile(
        join(root, "mods/helper.ts"),
        "import './rewrite.ts'; export const shared = true"
      )
      await writeFile(
        join(root, "mods/review.ts"),
        `import './${target}'; export function register() {}`
      )
      await expect(compileFunctionPlugin(root)).rejects.toThrow("CLAW_COMPONENT_CROSS_ENTRY_IMPORT")
    }
  )

  it("filters action, client, and environment surfaces with the same selected entries", async () => {
    const { root, manifest, save } = await fixture()
    manifest.claw.components[0].actionIds = ["review"]
    manifest.claw.components[2].actionIds = ["rewrite"]
    manifest.claw.actions = ["review", "rewrite"].map((id) => ({
      id,
      name: id,
      command: id,
      inputSchema: {}
    }))
    await save()
    await writeFile(
      join(root, "mods/rewrite.ts"),
      `export function register(on) {
      on("command.run", async $ => ({text:await $.env.get("HOME")}))
      on("ui.render", ($,e) => { const {Client:Panel}=$.ui.resolve(e); return Panel({module:"./panel.tsx"}) })
    }`
    )
    await writeFile(join(root, "mods/panel.tsx"), "export default function Panel(){ return null }")
    const compiled = await compileFunctionPlugin(root)
    expect(Object.keys(compiled.clients)).toEqual(["mods/panel.tsx"])
    expect(compiled.environment.read).toEqual(["HOME"])
    const projection = projectFunctionComponents(compiled, selected(["core", "review"]))
    expect(projection.actions.map((action) => action.id)).toEqual(["review"])
    expect(Object.keys(projection.clients)).toEqual([])
    expect(projection.environment).toEqual({ read: [], write: [] })
  })

  it("rejects missing dependencies, unselected config, and undeclared config", async () => {
    const { root } = await fixture()
    const compiled = await compileFunctionPlugin(root)
    expect(() => projectFunctionComponents(compiled, selected(["review"]))).toThrow(
      "CLAW_COMPONENT_DEPENDENCY_REQUIRED"
    )
    expect(() => projectFunctionComponents(compiled, selected(["core"], { review: {} }))).toThrow(
      "CLAW_COMPONENT_CONFIG_UNSELECTED"
    )
    expect(() =>
      projectFunctionComponents(compiled, selected(["core"], { core: { unknown: true } }))
    ).toThrow("CLAW_COMPONENT_CONFIG_UNDECLARED")
  })

  it("rejects mixed bootstrap entry and components", async () => {
    const { root, manifest, save } = await fixture()
    Object.assign(manifest, { entry: "core.ts" })
    await save()
    await expect(compileFunctionPlugin(root)).rejects.toThrow("CLAW_COMPONENT_ENTRY_CONFLICT")
  })

  it("rejects duplicate canonical entries and incomplete action ownership", async () => {
    const { root, manifest, save } = await fixture()
    manifest.claw.components[2].entry = "core.ts"
    await save()
    await expect(compileFunctionPlugin(root)).rejects.toThrow("CLAW_COMPONENT_ENTRY_DUPLICATE")
    manifest.claw.components[2].entry = "rewrite.ts"
    manifest.claw.actions = [{ id: "orphan", name: "Orphan", command: "orphan", inputSchema: {} }]
    await save()
    await expect(compileFunctionPlugin(root)).rejects.toThrow("CLAW_COMPONENT_ACTION_OWNERSHIP")
  })

  it("runs the shipped review component with its configured focus and current default model", async () => {
    const compiled = await compileFunctionPlugin(resolve("examples/mods-component-kit"))
    // Import approval probes the whole package in a disposable guest before selection exists.
    const approvalProbe = await FunctionGuestRuntime.create(compiled.code, compiled.options)
    guests.push(approvalProbe)
    expect(approvalProbe.registrations).toHaveLength(6)
    const projection = projectFunctionComponents(
      compiled,
      selected(["review", "context"], {
        review: { focus: "检查空数组" }
      })
    )
    expect(projection.actions.map((item) => item.id)).toEqual(["review"])
    expect(projection.code).not.toContain('name: "component-report"')
    const guest = await FunctionGuestRuntime.create(projection.code, projection.options)
    guests.push(guest)
    const command = guest.registrations.filter((item) => item.pattern === "command.run").at(-1)!
    const calls: unknown[] = []
    const result = await guest.invoke(
      command.id,
      {
        command: "component-review",
        args: "function first(xs) { return xs[0].name }"
      },
      async (method, args) => {
        calls.push({ method, args })
        return { value: "空数组时访问 name 会抛错；尚未运行测试。" }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["model.complete"],
        plugin: { name: compiled.name, root: compiled.root }
      }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: "model.complete",
      args: [
        {
          model: "default",
          system: expect.stringContaining("检查空数组")
        }
      ]
    })
    expect(result).toMatchObject({
      value: { output: { text: "空数组时访问 name 会抛错；尚未运行测试。" } }
    })
  })
})

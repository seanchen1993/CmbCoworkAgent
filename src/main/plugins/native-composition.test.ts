import { businessInput } from "./autobiz-native-fixture.test-helper"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../mods/devtools/project-doctor"
import { testProjectSource } from "../mods/devtools/project-contract"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"

const vendorRoot = resolve("tests/fixtures/native-compositions/vendor")
const businessRoot = resolve("resources/native-compositions/autobiz")
const providerRoot = resolve("resources/native-compositions/autobiz-rules")
const sourceAt = (root: string) =>
  nativeCompositionSchema.parse(
    JSON.parse(readFileSync(resolve(root, "composition/source.json"), "utf8"))
  )
const compileVendor = (source = sourceAt(vendorRoot)) =>
  compileNativeComposition(source, {
    files: readNativeCompositionFiles(vendorRoot, sourceAt(vendorRoot)),
    actionCatalog: []
  })

describe("single-source native composition", () => {
  it("compiles independent supplier semantics and runs actual Host schema validators", async () => {
    const result = compileVendor()
    const manifest = parseProjectRuntimeManifest(result.runtime)
    expect(manifest.stateOwner).toBe("host")
    expect(manifest.stages.map((stage) => stage.id)).toEqual([
      "normalize",
      "compliance",
      "risk",
      "approval",
      "archive"
    ])
    expect(manifest.stages[3]).toMatchObject({ approval: "none", resultApproval: "human" })
    const bundle = createAuthoringSourceBundle(
      result.files.map(({ path, bytes }) => ({ path, text: bytes.toString() }))
    )
    expect(inspectProjectSource(bundle).report.valid).toBe(true)
    expect(await testProjectSource(bundle, manifest)).toMatchObject({ valid: true })
    const stale = structuredClone(bundle)
    stale.files.find((file) => file.path === manifest.stages[0].skill)!.text += "changed"
    expect(inspectProjectSource(stale).report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "NATIVE_COMPOSITION_STALE" })])
    )
  })

  it("rejects disconnected, incompatible and unchecked contracts before execution", () => {
    const forward = sourceAt(vendorRoot)
    forward.modules[0].inputs = [{ artifactId: "risk", contract: "vendor.risk/v1" }]
    expect(() => compileVendor(forward)).toThrow("INPUT_NOT_PRIOR")
    const incompatible = sourceAt(vendorRoot)
    incompatible.modules[1].inputs[0].contract = "unrelated/v2"
    expect(() => compileVendor(incompatible)).toThrow("CONTRACT_MISMATCH")
    const unchecked = sourceAt(vendorRoot)
    unchecked.modules[0].outputs.push({ id: "hidden", path: "hidden.json", contract: "hidden/v1" })
    expect(() => compileVendor(unchecked)).toThrow("OUTPUT_UNCHECKED")
  })

  it("rejects malicious paths, case collisions, unknown fields and missing providers", () => {
    const invalid = sourceAt(vendorRoot)
    invalid.modules[0].outputs[0].path = "../outside.json"
    expect(() => compileVendor(invalid)).toThrow("FILE_PATH_INVALID")
    const collision = sourceAt(vendorRoot)
    collision.modules[1].outputs[0].path = "NORMALIZE.json"
    expect(() => compileVendor(collision)).toThrow("PATH_COLLISION")
    expect(() =>
      compileVendor({ ...sourceAt(vendorRoot), checkpointWriter: "run.py" } as never)
    ).toThrow()
    const source = sourceAt(businessRoot)
    expect(() =>
      compileNativeComposition(source, {
        files: readNativeCompositionFiles(businessRoot, source),
        actionCatalog: []
      })
    ).toThrow("PROVIDER_UNRESOLVED")
  })

  it("pins actual compiled business-provider identities without fabricating grants", async () => {
    const compiled = await compileFunctionPlugin(providerRoot)
    expect(compiled).toBeDefined()
    expect(compiled!.code).toContain("validate_design_contract_lock")
    const actionCatalog = compiled!.actions!.map(({ id, ...action }) => ({
      ...action,
      actionId: id,
      pluginId: "isolated-provider-installation",
      plugin: compiled!.name,
      digest: compiled!.digest
    }))
    const knowledge = await compileFunctionPlugin(
      resolve("resources/native-compositions/autobiz-knowledge")
    )
    actionCatalog.push(
      ...knowledge!.actions!.map(({ id, ...action }) => ({
        ...action,
        actionId: id,
        pluginId: "isolated-knowledge-installation",
        plugin: knowledge!.name,
        digest: knowledge!.digest
      }))
    )
    const source = sourceAt(businessRoot)
    const result = compileNativeComposition(source, {
      files: readNativeCompositionFiles(businessRoot, source),
      actionCatalog
    })
    const plugin = JSON.parse(
      result.files.find((file) => file.path === "devclaw.project-runtime.json")!.bytes.toString()
    )
    expect(plugin.extensionContract.requires).toContain("devclaw.context-materials/v1")
    for (const key of ["missingField", "knowledgeRoot"]) {
      const invalid = structuredClone(source)
      const context = invalid.context as { provider: { materials: { configuration: string[] } } }
      context.provider.materials.configuration = [key]
      expect(() =>
        compileNativeComposition(invalid, {
          files: readNativeCompositionFiles(businessRoot, source),
          actionCatalog
        })
      ).toThrow("CONTEXT_CONFIGURATION_INVALID")
    }
    const missingMaterial = structuredClone(source)
    const context = missingMaterial.context as {
      provider: { materials: { roots: Array<{ source: string; path?: string }> } }
    }
    context.provider.materials.roots.find((root) => root.source === "package")!.path =
      "undeclared-materials"
    expect(() =>
      compileNativeComposition(missingMaterial, {
        files: readNativeCompositionFiles(businessRoot, source),
        actionCatalog
      })
    ).toThrow("CONTEXT_RESOURCE_MISSING")
    expect(result.actionLock.bindings).toHaveLength(9)
    for (const binding of result.actionLock.bindings.filter(
      (item) => item.id !== "knowledge.context"
    )) {
      expect(binding.inputFrom).toMatchObject({
        kind: "artifact",
        pointer: "",
        format: "artifact-reference-v1",
        maxBytes: binding.id === "archive.business" ? 524288 : 28000
      })
    }
    const referenceCheck = source.modules[0].checks.find((check) => check.kind === "action")!
    for (const invalidCheck of [
      { ...referenceCheck, maxBytes: undefined },
      { ...referenceCheck, maxBytes: 524289 },
      { ...referenceCheck, format: "json", maxBytes: 28000 },
      { ...referenceCheck, format: "artifact-reference-v2", maxBytes: 28000 }
    ]) {
      const invalid = structuredClone(source)
      const index = invalid.modules[0].checks.findIndex((check) => check.kind === "action")
      invalid.modules[0].checks[index] = invalidCheck as typeof referenceCheck
      expect(() =>
        compileNativeComposition(invalid, {
          files: readNativeCompositionFiles(businessRoot, source),
          actionCatalog
        })
      ).toThrow()
    }
    // Author source is portable; installation identities are re-resolved on the target machine.
    const targetIds = new Map(actionCatalog.map((action) => [action.plugin, randomUUID()]))
    const rebound = compileNativeComposition(source, {
      files: readNativeCompositionFiles(businessRoot, source),
      actionCatalog: actionCatalog.map((action) => ({
        ...action,
        pluginId: targetIds.get(action.plugin)!
      }))
    })
    expect(
      rebound.actionLock.bindings.every(
        (binding) => binding.ref.pluginId === targetIds.get(binding.ref.plugin)
      )
    ).toBe(true)
    const reboundBytes = rebound.files.map((file) => file.bytes.toString()).join("\n")
    expect(reboundBytes).not.toContain("isolated-provider-installation")
    expect(reboundBytes).not.toContain("isolated-knowledge-installation")
    const codeBinding = result.actionLock.bindings.find(
      (binding) => binding.id === "code.business"
    )!
    expect(codeBinding.config.nativeCompositionProvider).toEqual(codeBinding.ref)
    expect(
      result.actionLock.bindings
        .filter(
          (binding) => !["code.business", "cicd.business", "archive.business"].includes(binding.id)
        )
        .every((binding) => Object.keys(binding.config).length === 0)
    ).toBe(true)
    const conflict = structuredClone(source)
    const codeCheck = conflict.modules
      .find((module) => module.id === "code")!
      .checks.find((check) => check.kind === "action")!
    if (codeCheck.kind !== "action") throw Error("FIXTURE_CHECK_MISSING")
    codeCheck.config = { nativeCompositionProvider: { pluginId: "forged" } }
    expect(() =>
      compileNativeComposition(conflict, {
        files: readNativeCompositionFiles(businessRoot, source),
        actionCatalog
      })
    ).toThrow("PROVIDER_IDENTITY_CONFLICT")
    const incompatibleCatalog = actionCatalog.map((action) =>
      action.actionId === "code"
        ? {
            ...action,
            configSchema: { type: "object", additionalProperties: false, properties: {} }
          }
        : action
    )
    expect(() =>
      compileNativeComposition(source, {
        files: readNativeCompositionFiles(businessRoot, source),
        actionCatalog: incompatibleCatalog
      })
    ).toThrow()
    expect(() =>
      compileNativeComposition(source, {
        files: readNativeCompositionFiles(businessRoot, source),
        actionCatalog: [...actionCatalog, actionCatalog[0]]
      })
    ).toThrow("PROVIDER_UNRESOLVED")

    expect(
      result.actionLock.bindings
        .filter((binding) => binding.id !== "knowledge.context")
        .every((binding) => binding.ref.digest === compiled!.digest)
    ).toBe(true)
    const bundle = createAuthoringSourceBundle(
      result.files.map(({ path, bytes }) => ({ path, text: bytes.toString() }))
    )
    expect(inspectProjectSource(bundle, [], actionCatalog).report.diagnostics).toEqual([])
    const report = await testProjectSource(bundle, parseProjectRuntimeManifest(result.runtime))
    expect(report.valid).toBe(true)
    expect(report.cases.every((item) => item.expected === "failed")).toBe(true)
    expect(report.limitations.join(" ")).toContain("未执行")
    expect(result.files.some((file) => /state_store|checkpoint|board_core/.test(file.path))).toBe(
      false
    )
  })
})

function runCheck(stage: string, fixtures = businessInput()) {
  const request = {
    stage,
    ...fixtures,
    current:
      stage === "convert"
        ? fixtures.normalized
        : fixtures[stage as "prd" | "specs" | "design" | "plan"]
  }
  const result = spawnSync(
    "python",
    ["-B", "-X", "utf8", resolve(providerRoot, "checks/check.py")],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    }
  )
  if (!result.stdout) throw Error(result.stderr || String(result.error))
  return JSON.parse(result.stdout)
}

describe("extracted AutoBiz business semantics, not fake schema equivalents", () => {
  it("executes the actual registered public platform action with the pinned embedded rule code", async () => {
    const bundle = await build({
      entryPoints: [resolve(providerRoot, "mods/main.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs"
    })
    type Handler = (
      sdk: unknown,
      event: unknown,
      next: (event: unknown) => unknown
    ) => Promise<unknown>
    const callbacks = new Map<string, Handler>()
    const exported = {
      exports: {} as {
        register(on: { capability(declaration: unknown, handlers: { act: Handler }): void }): void
      }
    }
    runInNewContext(bundle.outputFiles[0].text, { module: exported, exports: exported.exports })
    exported.exports.register({
      capability(_declaration, handlers) {
        callbacks.set("act", handlers.act)
      }
    })
    const fixture = businessInput()
    const files: Record<string, string> = {
      "NORMALIZED_REQUIREMENTS.json": JSON.stringify(fixture.normalized),
      "PRD.bundle.json": JSON.stringify(fixture.prd),
      "SPECS.bundle.json": JSON.stringify(fixture.specs)
    }
    const reads: string[] = []
    let processCount = 0
    const sdk = {
      fs: {
        read: async (path: string) => {
          reads.push(path)
          if (!(path in files)) throw Error("missing")
          return files[path]
        }
      },
      process: {
        run: async (argv: string[], init: { stdin: string }) => {
          processCount++
          expect(argv).toContain("-I")
          const result = spawnSync(argv[0], argv.slice(1), { input: init.stdin, encoding: "utf8" })
          return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
        }
      }
    }
    const event = {
      action: "design",
      input: { version: 1, input: fixture.design }
    }
    expect(await callbacks.get("act")!(sdk, event, () => {})).toMatchObject({
      output: { passed: true }
    })
    expect(reads).toEqual(Object.keys(files))
    expect(processCount).toBe(1)
    fixture.design.files["design.md"] += "tampered"
    await expect(
      callbacks.get("act")!(
        sdk,
        { ...event, input: { version: 1, input: fixture.design } },
        () => {}
      )
    ).resolves.toMatchObject({ status: "failed", output: { passed: false } })
  })
  it.each(["convert", "prd", "specs", "design", "plan"])(
    "runs original read-only rules for %s",
    (stage) => {
      expect(runCheck(stage)).toMatchObject({ passed: true, errors: [] })
    }
  )
  it("blocks omitted performance requirements, unmatched capabilities and stale design locks", () => {
    const missing = businessInput()
    missing.prd.files["PRD.md"] = missing.prd.files["PRD.md"].replace(
      "订单查询必须在2秒内返回",
      "订单查询"
    )
    expect(runCheck("prd", missing)).toMatchObject({
      passed: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "AUTOBIZ_PRD_REQUIREMENTS_NOT_COVERED" })
      ])
    })
    const specs = businessInput()
    specs.specs.files["proposal.md"] += "\n## Capabilities\n- extra-capability: 缺少对应规格\n"
    specs.specs.files["proposal.md"] = specs.specs.files["proposal.md"].replace(
      "- order-query: 订单查询",
      "- extra-capability: 未交付"
    )
    expect(runCheck("specs", specs).passed).toBe(false)
    const stale = businessInput()
    stale.design.files["design.md"] += "\n实际输出已修改\n"
    expect(runCheck("design", stale)).toMatchObject({
      passed: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "design_contract_lock_outdated" })
      ])
    })
  })
  it("blocks UI mismatch, duplicate scenario IDs and escaping bundle paths", () => {
    const ui = businessInput()
    ui.specs.files["UI_CONTEXT.json"] = ui.specs.files["UI_CONTEXT.json"].replace(
      '"locked"',
      '"confirmed"'
    )
    expect(runCheck("specs", ui).passed).toBe(false)
    const duplicate = businessInput()
    duplicate.specs.files["specs/order-query/spec.md"] +=
      "#### Scenario SCN-001: 重复场景\nThen 无法区分\n"
    expect(runCheck("specs", duplicate).passed).toBe(false)
    const escape = businessInput()
    Object.assign(escape.prd.files, { "../outside.md": "unsafe" })
    expect(runCheck("prd", escape).passed).toBe(false)
  })
  it("retains Plan scenario coverage, DAG, design refs and unique validation ownership", () => {
    const mutate = (
      change: (
        root: { parallelBatchPipeline: { validationOwnership: Record<string, unknown> } },
        batch: { tasks: Array<{ specRefs: string[]; deps: string[]; apiIds: string[] }> }
      ) => void
    ) => {
      const input = businessInput()
      const root = JSON.parse(input.plan.files["plan.json"])
      const batch = JSON.parse(input.plan.files["plans/B001/plan.json"])
      change(root, batch)
      input.plan.files["plan.json"] = JSON.stringify(root)
      input.plan.files["plans/B001/plan.json"] = JSON.stringify(batch)
      return runCheck("plan", input)
    }
    expect(
      mutate((_root, batch) => {
        batch.tasks[0].specRefs = []
      }).passed
    ).toBe(false)
    expect(
      mutate((_root, batch) => {
        batch.tasks[0].deps = ["T001"]
      }).passed
    ).toBe(false)
    expect(
      mutate((_root, batch) => {
        batch.tasks[0].apiIds = ["API-999"]
      }).passed
    ).toBe(false)
    expect(
      mutate((root) => {
        delete root.parallelBatchPipeline.validationOwnership["UTEST-T001"]
      }).passed
    ).toBe(false)
  })
  it("embeds the exact checked Python sources in the provider code identity", () => {
    const text = readFileSync(resolve(providerRoot, "mods/rules-bundle.ts"), "utf8")
    const embedded = JSON.parse(text.slice(text.indexOf("export const rules = ") + 21))
    for (const [path, bytes] of Object.entries(embedded))
      expect(readFileSync(resolve(providerRoot, "checks", path), "utf8")).toBe(bytes)
  })
})

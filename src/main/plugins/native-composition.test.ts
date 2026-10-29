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
  nativeCompositionLegacyGeneratedPretty,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { AUTHORING_BUNDLE_LIMITS, createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../mods/devtools/project-doctor"
import { testProjectSource } from "../mods/devtools/project-contract"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"

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
  const metadataPaths = [
    "composition/lock.json", "plugin.json", "devclaw.project-runtime.json",
    "devclaw.project-actions.lock.json"
  ]
  const bundleOf = (files: Array<{ path: string; bytes: Buffer }>) =>
    createAuthoringSourceBundle(files.map(({ path, bytes }) => ({ path, text: bytes.toString("utf8") })))

  it("compacts only generated metadata, preserves source/resources and reaches a stable recompilation", () => {
    const source = sourceAt(vendorRoot)
    const files = readNativeCompositionFiles(vendorRoot, source)
    const current = compileNativeComposition(source, { files, actionCatalog: [] })
    const legacy = compileNativeComposition(source, { files, actionCatalog: [], legacyGeneratedPretty: true })
    for (const file of current.files) {
      const previous = legacy.files.find(item => item.path === file.path)!
      if (metadataPaths.includes(file.path)) {
        expect(file.bytes.toString()).toBe(JSON.stringify(JSON.parse(previous.bytes.toString())) + "\n")
        expect(file.bytes.length).toBeLessThan(previous.bytes.length)
      } else expect(file.bytes).toEqual(previous.bytes)
    }
    expect(nativeCompositionLegacyGeneratedPretty(current.files.find(file =>
      file.path === "devclaw.project-actions.lock.json")!.bytes)).toBe(false)
    const repeated = compileNativeComposition(source, { files: current.files, actionCatalog: [] })
    expect(repeated.files).toEqual(current.files)
    expect(bundleOf(repeated.files).digest).toBe(bundleOf(current.files).digest)
  })

  it("doctors a retained pretty package and creates a different explicit compact source digest", () => {
    const source = sourceAt(vendorRoot)
    const files = readNativeCompositionFiles(vendorRoot, source)
    const original = bundleOf(compileNativeComposition(source, {
      files, actionCatalog: [], legacyGeneratedPretty: true
    }).files)
    const actionLock = original.files.find(file => file.path === "devclaw.project-actions.lock.json")!
    expect(nativeCompositionLegacyGeneratedPretty(actionLock.text)).toBe(true)
    expect(inspectProjectSource(original).report.diagnostics).toEqual([])
    const compiled = compileNativeComposition(source, {
      files: original.files.map(file => ({ path: file.path, bytes: Buffer.from(file.text) })),
      actionCatalog: []
    })
    const compact = bundleOf(compiled.files)
    expect(compact.digest).not.toBe(original.digest)
    expect(inspectProjectSource(compact).report.diagnostics).toEqual([])
    const metadata = new Set(metadataPaths)
    for (const file of original.files.filter(file => !metadata.has(file.path)))
      expect(compact.files.find(item => item.path === file.path)?.text).toBe(file.text)
    expect(actionLock.text).toBe(JSON.stringify(JSON.parse(actionLock.text), null, 2) + "\n")
  })

  it("rejects mixed generated layouts, altered content and noncanonical whitespace during replay", () => {
    const source = sourceAt(vendorRoot)
    const files = readNativeCompositionFiles(vendorRoot, source)
    const current = compileNativeComposition(source, { files, actionCatalog: [] })
    const legacy = compileNativeComposition(source, { files, actionCatalog: [], legacyGeneratedPretty: true })
    expect(inspectProjectSource(bundleOf(current.files)).report.valid).toBe(true)
    expect(inspectProjectSource(bundleOf(legacy.files)).report.valid).toBe(true)
    for (const [base, other] of [[current, legacy], [legacy, current]]) {
      for (const path of metadataPaths) {
        const mixed = base.files.map(file => file.path === path ? other.files.find(item => item.path === path)! : file)
        expect(inspectProjectSource(bundleOf(mixed)).report.valid).toBe(false)
      }
    }
    const lock = current.files.find(file => file.path === "devclaw.project-actions.lock.json")!
    for (const text of [lock.bytes.toString() + "\n", lock.bytes.toString().replace(/\n/g, "\r\n"), " " + lock.bytes.toString()])
      expect(() => nativeCompositionLegacyGeneratedPretty(text)).toThrow()
    const changed = current.files.map(file => file.path === "plugin.json"
      ? { ...file, bytes: Buffer.from(file.bytes.toString().replace('"skills":"skills"', '"skills":"other"')) }
      : file)
    expect(inspectProjectSource(bundleOf(changed)).report.valid).toBe(false)
  })

  it("fits an append-shaped expanded bundle through lossless compaction without changing any limit", () => {
    const source = sourceAt(vendorRoot)
    const paths = Array.from({ length: 4 }, (_, index) => `knowledge/padding-${index}.md`)
    source.resources.push(...paths)
    const files = [...readNativeCompositionFiles(vendorRoot, sourceAt(vendorRoot)),
      ...paths.map(path => ({ path, bytes: Buffer.alloc(0) }))]
    const size = (items: typeof files) => items.reduce((sum, file) => sum + Buffer.byteLength(file.path) + file.bytes.length, 0)
    const initial = compileNativeComposition(source, { files, actionCatalog: [], legacyGeneratedPretty: true })
    const padding = AUTHORING_BUNDLE_LIMITS.totalBytes + 503 - size(initial.files)
    expect(padding).toBeGreaterThan(0)
    for (const [index, path] of paths.entries()) {
      const bytes = Math.floor(padding / paths.length) + (index < padding % paths.length ? 1 : 0)
      expect(bytes).toBeLessThanOrEqual(AUTHORING_BUNDLE_LIMITS.fileBytes)
      files.find(file => file.path === path)!.bytes = Buffer.alloc(bytes, "x")
    }
    const authored = bundleOf([...files, { path: "composition/source.json", bytes: Buffer.from(JSON.stringify(source, null, 2) + "\n") }])
    expect(authored.files.length).toBeLessThan(AUTHORING_BUNDLE_LIMITS.files)
    const legacy = compileNativeComposition(source, { files, actionCatalog: [], legacyGeneratedPretty: true })
    expect(size(legacy.files)).toBe(AUTHORING_BUNDLE_LIMITS.totalBytes + 503)
    expect(() => bundleOf(legacy.files)).toThrow("AUTHORING_SOURCE_LIMIT")
    const compact = compileNativeComposition(source, { files, actionCatalog: [] })
    expect(size(compact.files)).toBeLessThan(AUTHORING_BUNDLE_LIMITS.totalBytes)
    expect(() => bundleOf(compact.files)).not.toThrow()
    for (const file of files)
      expect(compact.files.find(item => item.path === file.path)?.bytes).toEqual(file.bytes)
    expect(AUTHORING_BUNDLE_LIMITS).toEqual({ files: 64, fileBytes: 65536, totalBytes: 262144, pathLength: 160 })
  })

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

  it("projects declared subset inputs and doctors old subset packages without silently changing them", () => {
    const source = sourceAt(vendorRoot)
    const files = readNativeCompositionFiles(vendorRoot, source)
    const current = compileNativeComposition(source, { files, actionCatalog: [] })
    const runtime = parseProjectRuntimeManifest(current.runtime)
    expect(runtime.stages[0]).not.toHaveProperty("inputArtifactIds")
    expect(runtime.stages[1]).not.toHaveProperty("inputArtifactIds")
    expect(runtime.stages[2].inputArtifactIds).toEqual(["compliance"])
    const legacy = compileNativeComposition(source, {
      files,
      actionCatalog: [],
      legacyInputArtifactStages: new Set(source.modules.map((module) => module.id))
    })
    const bundle = (compiled: typeof current) =>
      createAuthoringSourceBundle(
        compiled.files.map(({ path, bytes }) => ({ path, text: bytes.toString("utf8") }))
      )
    const old = bundle(legacy)
    expect(inspectProjectSource(old).report.diagnostics).toEqual([])
    expect(
      parseProjectRuntimeManifest(legacy.runtime).stages.every(
        (stage) => stage.inputArtifactIds === undefined
      )
    ).toBe(true)
    expect(inspectProjectSource(bundle(current)).report.diagnostics).toEqual([])
    // Removing a new declaration alone cannot claim the old semantics: its original lock still binds it.
    const removed = bundle(current)
    const file = removed.files.find((file) => file.path === "devclaw.project-runtime.json")!
    const envelope = JSON.parse(file.text)
    for (const stage of (envelope.runtime ?? envelope).stages) delete stage.inputArtifactIds
    file.text = JSON.stringify(envelope, null, 2) + "\n"
    expect(inspectProjectSource(removed).report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "NATIVE_COMPOSITION_STALE" })])
    )
    for (const path of [
      "composition/source.json",
      "modules/risk/SKILL.md",
      "composition/lock.json"
    ]) {
      const changed = bundle(legacy)
      const asset = changed.files.find((file) => file.path === path)!
      if (path === "composition/source.json") {
        const modified = JSON.parse(asset.text)
        modified.modules[2].inputs = [modified.modules[1].inputs[0]]
        asset.text = JSON.stringify(modified)
      } else asset.text += "changed"
      expect(inspectProjectSource(changed).report.valid).toBe(false)
    }
  })

  it("compiles a ninth-stage reference check with three inputs and rejects eight without dropping any", () => {
    const source = sourceAt(vendorRoot),
      template = source.modules[0]
    source.modules = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(template),
      id: "phase-" + index,
      title: "Phase " + index,
      inputs: [],
      outputs: [
        { id: "input-" + index, path: "input-" + index + ".json", contract: "sample/input-v1" }
      ],
      checks: [
        {
          id: "input-" + index + ".shape",
          kind: "json-schema" as const,
          artifactId: "input-" + index,
          schema: { type: "object" }
        }
      ]
    }))
    source.modules.push({
      ...structuredClone(template),
      id: "verify",
      title: "Verify",
      inputs: [2, 5, 7].map((index) => ({
        artifactId: "input-" + index,
        contract: "sample/input-v1"
      })),
      outputs: [{ id: "verification", path: "verification.json", contract: "sample/result-v1" }],
      checks: [
        {
          id: "verification.check",
          kind: "action",
          artifactId: "verification",
          provider: { plugin: "verification-provider", actionId: "check" },
          format: "artifact-reference-v1",
          maxBytes: 28000
        }
      ]
    })
    const action: ClawActionDescriptor = {
      pluginId: "installed-provider",
      plugin: "verification-provider",
      digest: "a".repeat(64),
      actionId: "check",
      name: "Reference check",
      platform: { id: "verification", version: "1.0.0", action: "check" },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    }
    const options = {
      files: readNativeCompositionFiles(vendorRoot, sourceAt(vendorRoot)),
      actionCatalog: [action]
    }
    const compiled = compileNativeComposition(source, options)
    expect(parseProjectRuntimeManifest(compiled.runtime).stages[8].inputArtifactIds).toEqual([
      "input-2",
      "input-5",
      "input-7"
    ])
    source.modules[8].inputs = Array.from({ length: 8 }, (_, index) => ({
      artifactId: "input-" + index,
      contract: "sample/input-v1"
    }))
    expect(() => compileNativeComposition(source, options)).toThrow(
      "NATIVE_COMPOSITION_REFERENCE_INPUT_LIMIT"
    )
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
    const legacyProjection = compileNativeComposition(source, {
      files: readNativeCompositionFiles(businessRoot, source),
      actionCatalog,
      legacyInputArtifactStages: new Set(source.modules.map((module) => module.id))
    })
    for (const path of [
      "devclaw.project-runtime.json",
      "composition/lock.json",
      "devclaw.project-actions.lock.json"
    ])
      expect(result.files.find((file) => file.path === path)!.bytes).toEqual(
        legacyProjection.files.find((file) => file.path === path)!.bytes
      )
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

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  verifyReviewedBusinessAssembly,
  type ReviewedBusinessKernel
} from "./autobiz-business-assembly-protocol"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { assembleBusinessMods } from "./business-mod-assembler"
import { businessModCatalog } from "./business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import type { PluginMetadata } from "../types"
import reviewed from "./autobiz-business-kernel-reviewed.json"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { portableBusinessModFiles } from "./business-mod-portable-source"
import { projectBusinessModNodes, projectBusinessModWorkflowRouting } from "./business-mod-workflow"
import { getPluginSkillSearchSources, readPluginManifest } from "./manifest"
import { projectRuntimeExtensionContract, EXTENSION_BOARD_API_VERSION } from "../../shared/project-runtime"
import { assertPackageExtensionCompatibility } from "./extension-contract"

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
        )
      : value
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
function fixture() {
  const module = {
    id: "dev.specs",
    title: "Specifications",
    node: {
      id: "dev.specs",
      skill: "autodev-specs",
      order: 20,
      checkpoints: ["specs_in_progress", "specs_done"],
      validators: ["specs_contract"],
      guards: []
    },
    skill: { entry: "skills/autodev-specs/SKILL.md", resources: [] },
    resources: [],
    dependencies: { required: [], advisory: [] },
    checks: { validators: ["specs_contract"], guards: [] }
  }
  const files = new Map<string, Buffer>([
    ["board_core/contracts.py", Buffer.from("# trusted original validator")],
    ["skills/autodev-specs/SKILL.md", Buffer.from("# Original behavior contract")],
    ["plugin.json", json({ name: "new-business-plugin", version: "1.0.0" })],
    [
      "board_core/board_config.json",
      json({
        inspectCommands: { win32: { feature_status: "trusted-only" } },
        workflow: {
          nodes: projectBusinessModNodes([module]),
          ...projectBusinessModWorkflowRouting([module]),
          skipPolicy: { lockedNodes: [] }
        }
      })
    ],
    [
      "mods/business/manifest.json",
      json({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernel: {
          id: "reviewed-kernel",
          version: "1.0.0",
          resources: ["board_core/contracts.py"],
          boardConfigPath: "board_core/board_config.json"
        },
        modules: [module]
      })
    ]
  ])
  const kernel: ReviewedBusinessKernel = {
    id: "reviewed-kernel",
    version: "1.0.0",
    inspectCommandsDigest: digest(JSON.stringify({ win32: { feature_status: "trusted-only" } })),
    files: [
      { path: "board_core/contracts.py", digest: digest(files.get("board_core/contracts.py")!) }
    ],
    modules: {
      "dev.specs": {
        definitionDigest: digest(JSON.stringify(canonical(module))),
        files: {
          "skills/autodev-specs/SKILL.md": digest(files.get("skills/autodev-specs/SKILL.md")!)
        }
      }
    }
  }
  const lock = {
    apiVersion: "devclaw.business-assembly/v1",
    name: "new-business-plugin",
    version: "1.0.0",
    kernel: { id: kernel.id, version: kernel.version, files: structuredClone(kernel.files) },
    mods: [{ id: module.id, nodeId: module.id, sourceDigest: "a".repeat(64) }],
    sources: [{ name: "original-business-source", digest: "a".repeat(64), mods: [module.id] }],
    files: [] as Array<{ path: string; digest: string }>
  }
  function snapshot(rehash = true) {
    if (rehash)
      lock.files = [...files]
        .filter(([path]) => path !== "devclaw.business-assembly.json")
        .map(([path, bytes]) => ({ path, digest: digest(bytes) }))
    files.set("devclaw.business-assembly.json", json(lock))
    return { files: [...files].map(([path, bytes]) => ({ path, bytes })) }
  }
  return { module, files, kernel, lock, snapshot }
}

it("accepts omitted and explicit AutoBiz runtime metadata without admitting adapter hijacks", () => {
  const legacy = fixture()
  expect(verifyReviewedBusinessAssembly(legacy.snapshot(), legacy.kernel)).toBe(true)
  for (const target of ["lock", "catalog", "both"] as const) {
    const f = fixture()
    const catalog = JSON.parse(f.files.get("mods/business/manifest.json")!.toString("utf8"))
    if (target !== "catalog") Object.assign(f.lock.kernel, { runtime: { adapter: "autobiz-v1" } })
    if (target !== "lock") {
      catalog.kernel.runtime = { adapter: "autobiz-v1" }
      f.files.set("mods/business/manifest.json", json(catalog))
    }
    expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel), target).toBe(true)
  }
  for (const runtime of [
    { adapter: "host-linear-v1" },
    { adapter: "author-runtime" },
    { adapter: "autobiz-v1", execute: "author.js" },
    {},
    null,
    "autobiz-v1"
  ]) {
    for (const target of ["lock", "catalog"] as const) {
      const f = fixture()
      if (target === "lock") Object.assign(f.lock.kernel, { runtime })
      else {
        const catalog = JSON.parse(f.files.get("mods/business/manifest.json")!.toString("utf8"))
        catalog.kernel.runtime = runtime
        f.files.set("mods/business/manifest.json", json(catalog))
      }
      expect(
        verifyReviewedBusinessAssembly(f.snapshot(), f.kernel),
        `${target}:${JSON.stringify(runtime)}`
      ).toBe(false)
    }
  }
})

it("accepts reviewed portable assembly, then rejects source identity, inventory and kernel replacement", () => {
  const f = fixture()
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(true)
  f.files.set("board_core/contracts.py", Buffer.from("# tampered validator"))
  // Rehashing an author-controlled lock cannot turn changed core bytes into reviewed code.
  f.lock.kernel.files[0].digest = digest(f.files.get("board_core/contracts.py")!)
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
  const missing = fixture()
  missing.files.delete("skills/autodev-specs/SKILL.md")
  expect(verifyReviewedBusinessAssembly(missing.snapshot(), missing.kernel)).toBe(false)
  const renamed = fixture()
  renamed.files.set("plugin.json", json({ name: "different-name", version: "1.0.0" }))
  expect(verifyReviewedBusinessAssembly(renamed.snapshot(), renamed.kernel)).toBe(false)
  const partial = fixture()
  partial.snapshot()
  partial.files.set("unlisted.txt", Buffer.from("not in inventory"))
  expect(verifyReviewedBusinessAssembly(partial.snapshot(false), partial.kernel)).toBe(false)
})

it("retains exact admission for old fixed-flow assemblies without admitting arbitrary custom policy", () => {
  const f = fixture()
  const board = JSON.parse(f.files.get("board_core/board_config.json")!.toString("utf8"))
  Object.assign(board.workflow, projectBusinessModWorkflowRouting([f.module], false))
  f.files.set("board_core/board_config.json", json(board))
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(true)
  board.workflow.templates.custom = { kind: "custom", requiredNodes: ["dev.specs"] }
  f.files.set("board_core/board_config.json", json(board))
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
})
it("rejects undeclared/shadow Python and a same-ID original business contract with removed checks", () => {
  for (const path of [
    "json.py",
    "hooks/replacement.py",
    "board_core/native.py",
    "unrelated/check.py",
    "native.pyd"
  ]) {
    const f = fixture()
    f.files.set(path, Buffer.from("raise RuntimeError('must not be admitted')"))
    expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel), path).toBe(false)
  }
  const f = fixture()
  const catalog = JSON.parse(f.files.get("mods/business/manifest.json")!.toString("utf8"))
  catalog.modules[0].node.validators = []
  catalog.modules[0].checks.validators = []
  f.files.set("mods/business/manifest.json", json(catalog))
  f.files.set(
    "board_core/board_config.json",
    json({ workflow: { nodes: [catalog.modules[0].node] } })
  )
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
})

it("rejects rehashed checkpoint shortcuts, template overlays and state/order routing changes", () => {
  type WorkflowProbe = {
    checkpoints: { initial: string[]; transitions: Record<string, string[]> }
    dynamicStages: unknown[]
    templates: { standard: { kind: string } }
    nodes: Array<{ order: number; states: Array<{ nextAction: { slashSkill: string } }> }>
    skipPolicy: { lockedNodes: string[] }
  }
  const changes = [
    (workflow: WorkflowProbe) => {
      workflow.checkpoints.initial = ["specs_done"]
    },
    (workflow: WorkflowProbe) => {
      workflow.checkpoints.transitions.specs_in_progress = ["specs_done", "archived"]
    },
    (workflow: WorkflowProbe) => {
      workflow.checkpoints.transitions.specs_done = ["specs_in_progress"]
    },
    (workflow: WorkflowProbe) => {
      workflow.dynamicStages = [{ id: "skip-checks" }]
    },
    (workflow: WorkflowProbe) => {
      workflow.templates.standard.kind = "custom"
    },
    (workflow: WorkflowProbe) => {
      workflow.nodes[0].order = 999
    },
    (workflow: WorkflowProbe) => {
      workflow.nodes[0].states[1].nextAction.slashSkill = "unselected-skill"
    },
    (workflow: WorkflowProbe) => {
      workflow.skipPolicy.lockedNodes = ["unselected-node"]
    }
  ]
  for (const mutate of changes) {
    const f = fixture()
    const board = JSON.parse(f.files.get("board_core/board_config.json")!.toString("utf8"))
    mutate(board.workflow)
    f.files.set("board_core/board_config.json", json(board))
    // Even a fresh self-authored inventory digest cannot change the checked selection's routes.
    expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
  }
})

it("admits a declared function extension without weakening kernel, original checks or namespace proof", () => {
  const f = fixture()
  const extension = {
    id: "worktree.progress",
    title: "Progress",
    kind: "function",
    usage: "universal",
    entry: "mods/business/worktree.progress/register.ts",
    resources: ["mods/business/worktree.progress/inspect.py"],
    dependencies: { required: [], advisory: [] }
  }
  const catalog = JSON.parse(f.files.get("mods/business/manifest.json")!.toString("utf8"))
  catalog.extensions = [extension]
  f.files.set("mods/business/manifest.json", json(catalog))
  f.files.set(
    "plugin.json",
    json({ name: "new-business-plugin", version: "1.0.0", mods: "mods/manifest.json" })
  )
  f.files.set(extension.entry, Buffer.from("export function register(on) {}"))
  f.files.set(extension.resources[0], Buffer.from("# Explicit observer helper"))
  const native = {
    apiVersion: "cmb.mods/v2",
    id: "new-business-plugin",
    claw: {
      componentsVersion: 1,
      actions: [],
      components: [
        {
          id: extension.id,
          name: extension.title,
          kind: "module",
          entry: "business/worktree.progress/register.ts",
          dependsOn: [],
          actionIds: [],
          usage: "universal"
        }
      ]
    }
  }
  f.files.set("mods/manifest.json", json(native))
  Object.assign(f.lock, { extensions: [{ id: extension.id, sourceDigest: "b".repeat(64) }] })
  f.lock.sources.push({ name: "observer-source", digest: "b".repeat(64), mods: [extension.id] })
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(true)
  f.files.set("mods/business/unselected-extension/hidden.py", Buffer.from("# Unselected helper"))
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
  f.files.delete("mods/business/unselected-extension/hidden.py")
  native.claw.components[0].entry = "business/worktree.progress/other.ts"
  f.files.set("mods/manifest.json", json(native))
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
  native.claw.components[0].entry = "business/worktree.progress/register.ts"
  f.files.set("mods/manifest.json", json(native))
  f.files.set("board_core/contracts.py", Buffer.from("# Cannot rehash away changed trusted code"))
  f.lock.kernel.files[0].digest = digest(f.files.get("board_core/contracts.py")!)
  expect(verifyReviewedBusinessAssembly(f.snapshot(), f.kernel)).toBe(false)
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it.skipIf(!process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE)(
  "publishes selected real warehouse outputs with complete reviewed admission and rejects invented IDs", async () => {
    const original = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    const warehouse = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE!)
    const sources = [
      { snapshot: original, catalog: businessModCatalog(original), modIds: ["biz.prd", "dev.specs"] },
      { snapshot: warehouse, catalog: businessModCatalog(warehouse),
        modIds: businessModCatalog(warehouse).modules.map(mod => mod.id) }
    ]
    const request = { name: "warehouse-checked-export", version: "1.0.0", sources: [],
      verifiedArtifactIds: ["warehouse_sql_results", "warehouse_quality"] }
    const assembled = assembleBusinessMods(sources, request)
    expect(verifyReviewedBusinessAssembly(assembled, reviewed)).toBe(true)
    const root = await mkdtemp(join(tmpdir(), "warehouse-checked-export-"))
    roots.push(root)
    await writeDerivationFiles(root, assembled.files)
    expect(() => assertPackageExtensionCompatibility(root)).not.toThrow()
    const native = await readNativeCapabilityCatalog({ id: "new-export-source", name: request.name,
      version: request.version, path: root, enabled: true } as PluginMetadata, "project")
    expect(native.legacyAdapter).toBe("autobiz-v1")
    expect(native.capabilities[0].runtimeMode).toBe("legacy")
    for (const verifiedArtifactIds of [["unknown"], ["warehouse_sql_results", "warehouse_sql_results"], []])
      expect(() => assembleBusinessMods(sources, { ...request, verifiedArtifactIds })).toThrow(/VERIFIED_ARTIFACTS/)
    const changed = structuredClone(assembled)
    changed.files.find(file => file.path === "board_core/contracts.py")!.bytes = Buffer.from("# changed source")
    expect(verifyReviewedBusinessAssembly(changed, reviewed)).toBe(false)
  }, 60_000
)
it.skipIf(!process.env.AUTOBIZ_BUSINESS_CONTEXT_SOURCE)(
  "preserves full AutoBiz and warehouse behavior with actual worktree, context and native knowledge Skill providers",
  async () => {
    const original = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    const warehouse = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE!)
    const observer = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_OBSERVER_SOURCE!)
    const context = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_CONTEXT_SOURCE!)
    const originalCatalog = businessModCatalog(original), warehouseCatalog = businessModCatalog(warehouse)
    const observerCatalog = businessModCatalog(observer), contextCatalog = businessModCatalog(context)
    for (const warehouseMode of [false, true]) {
      const chosen = warehouseMode ? ["biz.prd", "dev.specs"] : originalCatalog.modules.map(mod => mod.id)
      const assembled = assembleBusinessMods([
        { snapshot: original, catalog: originalCatalog, modIds: chosen },
        ...(warehouseMode ? [{ snapshot: warehouse, catalog: warehouseCatalog,
          modIds: warehouseCatalog.modules.map(mod => mod.id) }] : []),
        { snapshot: observer, catalog: observerCatalog, modIds: ["autobiz.worktree-progress"] },
        { snapshot: context, catalog: contextCatalog, modIds: ["autobiz.knowledge"] }
      ], { name: warehouseMode ? "complete-warehouse-with-context" : "complete-autobiz-with-context",
        version: "1.0.0", sources: [] })
      expect(assembled.missingProviders).toEqual([])
      expect(assembled.requiresFixedWorkflowAcknowledgement).toBe(false)
      expect(verifyReviewedBusinessAssembly(assembled, reviewed)).toBe(true)
      const board = JSON.parse(assembled.files.find(file => file.path === "board_core/board_config.json")!.bytes.toString())
      const oldBoard = JSON.parse(original.files.find(file => file.path === "board_core/board_config.json")!.bytes.toString())
      expect(board.knowledge_config).toEqual(oldBoard.knowledge_config)
      expect(board.inspectCommands).toEqual(oldBoard.inspectCommands)
      expect(board.apiVersion).toBe(EXTENSION_BOARD_API_VERSION)
      const runtime = JSON.parse(assembled.files.find(file => file.path === "devclaw.project-runtime.json")!.bytes.toString())
      expect(projectRuntimeExtensionContract(runtime)).toMatchObject({
        requires: ["devclaw.required-business-checks/v1", "devclaw.context-handoff/v1"],
        context: { knowledge: { required: true, binding: "knowledgeRoot" },
          provider: { entry: "mods/business/autobiz.knowledge/provider.py" } }
      })
      const declarations = JSON.parse(assembled.files.find(file => file.path === "devclaw.capabilities.json")!.bytes.toString())
      expect(declarations.capabilities[0].requiredHooks).toHaveLength(12)
      const root = await mkdtemp(join(tmpdir(), "complete-autobiz-context-"))
      roots.push(root)
      await writeDerivationFiles(root, assembled.files)
      const compiled = await compileFunctionPlugin(root)
      expect(compiled.components?.map(component => component.id).sort()).toEqual(["autobiz.knowledge", "autobiz.worktree-progress"])
      const nativeSkills = getPluginSkillSearchSources(root, readPluginManifest(root)?.manifest)
      expect(nativeSkills.some(source => source.relPath === "mods/business/autobiz.knowledge/skills/knowledge-sync")).toBe(true)
      const catalog = await readNativeCapabilityCatalog({ id: "fresh-installed", name: runtime.runtime.plugin.id,
        version: "1.0.0", path: root, enabled: true } as PluginMetadata, "project")
      expect(catalog.status, catalog.reasons.join(";")).toBe("declared")
      expect(catalog.legacyAdapter).toBe("autobiz-v1")
      const imported = await snapshotDerivationSource(root)
      const second = assembleBusinessMods([{ snapshot: imported, catalog: businessModCatalog(imported),
        modIds: [...assembled.steps.map(step => step.id), "autobiz.worktree-progress", "autobiz.knowledge"] }], {
        name: `${runtime.runtime.plugin.id}-second`, version: "1.0.0", sources: []
      })
      expect(second.missingProviders).toEqual([])
      expect(verifyReviewedBusinessAssembly(second, reviewed)).toBe(true)
    }
  }, 60_000
)
it.skipIf(!process.env.AUTOBIZ_BUSINESS_SOURCE)(
  "recognizes two newly materialized real source assemblies without the original plugin UUID",
  async () => {
    const source = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    const custom = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_CUSTOM_SOURCE!)
    for (const withCustom of [false, true]) {
      const name = withCustom ? "independent-docs-quality" : "independent-docs"
      const assembled = assembleBusinessMods(
        [
          {
            snapshot: source,
            catalog: businessModCatalog(source),
            modIds: ["biz.prd", "dev.specs"]
          },
          ...(withCustom
            ? [
                {
                  snapshot: custom,
                  catalog: businessModCatalog(custom),
                  modIds: ["user.docs-quality"]
                }
              ]
            : [])
        ],
        { name, version: "1.0.0", sources: [] }
      )
      expect(verifyReviewedBusinessAssembly(assembled, reviewed), `${name}: exact assembly`).toBe(
        true
      )
      expect(isReviewedAutobizProtocol(assembled), name).toBe(true)
      const root = await mkdtemp(join(tmpdir(), "reviewed-business-assembly-"))
      roots.push(root)
      await mkdir(join(root, "package"))
      await writeDerivationFiles(join(root, "package"), assembled.files)
      const catalog = await readNativeCapabilityCatalog(
        {
          id: `new-${name}`,
          name,
          version: "1.0.0",
          path: join(root, "package"),
          enabled: true
        } as PluginMetadata,
        "project"
      )
      expect(catalog.status, catalog.reasons.join(";")).toBe("declared")
      expect(catalog.legacyAdapter).toBe("autobiz-v1")
    }
  },
  30_000
)

it.skipIf(
  !process.env.AUTOBIZ_BUSINESS_OBSERVER_SOURCE || !process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE
)(
  "combines the actual full or warehouse workflow with the real observer and admits a second independent generation",
  async () => {
    const original = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    const warehouse = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE!)
    const observer = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_OBSERVER_SOURCE!)
    for (const withWarehouse of [false, true]) {
      const originalCatalog = businessModCatalog(original)
      const warehouseCatalog = businessModCatalog(warehouse)
      const expected = withWarehouse
        ? ["biz.prd", "dev.specs", ...warehouseCatalog.modules.map((mod) => mod.id)]
        : originalCatalog.modules.map((mod) => mod.id)
      const selected = [
        {
          snapshot: original,
          catalog: originalCatalog,
          modIds: withWarehouse ? ["biz.prd", "dev.specs"] : expected
        },
        ...(withWarehouse
          ? [
              {
                snapshot: warehouse,
                catalog: warehouseCatalog,
                modIds: warehouseCatalog.modules.map((mod) => mod.id)
              }
            ]
          : []),
        {
          snapshot: observer,
          catalog: businessModCatalog(observer),
          modIds: ["autobiz.worktree-progress"]
        }
      ]
      const name = withWarehouse ? "actual-warehouse-observer" : "actual-full-observer"
      const assembled = assembleBusinessMods(selected, {
        name,
        version: "1.0.0",
        sources: [],
        order: expected
      })
      expect(verifyReviewedBusinessAssembly(assembled, reviewed), name).toBe(true)
      const board = JSON.parse(
        assembled.files
          .find((file) => file.path === "board_core/board_config.json")!
          .bytes.toString("utf8")
      )
      expect(board.workflow.nodes.map((node: { id: string }) => node.id)).toEqual(
        expected.filter(id => id !== "dev.detail_design")
      )
      expect(assembled.extensions?.map((extension) => extension.id)).toEqual([
        "autobiz.worktree-progress"
      ])
      if (!withWarehouse) {
        for (const mod of originalCatalog.modules) {
          const allNodes = [...board.workflow.nodes,
            ...board.workflow.dynamicStages.flatMap((stage: { nodes: unknown[] }) => stage.nodes)]
          const node = allNodes.find((node: { id: string }) => node.id === mod.id)
          expect(node.validators).toEqual(mod.node.validators)
          expect(node.guards ?? []).toEqual(mod.node.guards ?? [])
          expect(node.artifacts).toEqual(mod.node.artifacts)
        }
        expect(
          assembled.files.some(
            (file) => file.path === "workflows/code-batched-execution.workflow.js"
          )
        ).toBe(true)
        expect(
          assembled.files.some((file) => file.path === "skills/autodev/autodev-reviewer/SKILL.md")
        ).toBe(true)
      }
      const root = await mkdtemp(join(tmpdir(), "actual-business-observer-"))
      roots.push(root)
      await writeDerivationFiles(root, assembled.files)
      const compiled = await compileFunctionPlugin(root)
      expect(compiled.name).toBe(name)
      expect(compiled.components?.map((component) => [component.id, component.usage])).toEqual([
        ["autobiz.worktree-progress", "universal"]
      ])
      const snapshot = await snapshotDerivationSource(root)
      const catalog = await readNativeCapabilityCatalog(
        { id: `new-${name}`, name, version: "1.0.0", path: root, enabled: true } as PluginMetadata,
        "project"
      )
      expect(catalog.status, catalog.reasons.join(";")).toBe("declared")
      expect(catalog.legacyAdapter).toBe("autobiz-v1")
      // Importing the generated package must retain its function alongside the exact selected nodes.
      const second = assembleBusinessMods(
        [
          {
            snapshot,
            catalog: businessModCatalog(snapshot),
            modIds: [...expected, "autobiz.worktree-progress"]
          }
        ],
        { name: `${name}-second`, version: "1.0.0", sources: [] }
      )
      expect(verifyReviewedBusinessAssembly(second, reviewed)).toBe(true)
      expect(second.extensions).toHaveLength(1)
      expect(second.steps.map((step) => step.id)).toEqual(expected)
      // Portable delivery sources contain only declared implementations and tutorial entry points.
      for (const source of [original, observer, warehouse])
        expect(
          portableBusinessModFiles(source).some((file) =>
            /^(?:output|tests|node_modules|\.git)\//.test(file.path)
          )
        ).toBe(false)
    }
  },
  30_000
)

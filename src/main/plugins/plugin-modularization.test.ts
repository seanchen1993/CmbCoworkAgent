import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { wrapProjectRuntimeManifest } from "../../shared/project-runtime"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { testProjectSource } from "../mods/devtools/project-contract"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { parseSkillFrontmatter } from "../skills/frontmatter"
import { assembleBusinessMods } from "./business-mod-assembler"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import { BusinessModCatalogValidationError } from "./business-mod-catalog-schema"
import {
  createPluginModularizationCandidate,
  inspectPluginModularization
} from "./plugin-modularization"
import {
  derivationDigest,
  writeDerivationFiles,
  type DerivationSnapshot
} from "./derivation-source"

function fixture(options: { runtime?: boolean; hooks?: boolean } = {}): DerivationSnapshot {
  const records: Record<string, unknown> = {
    "plugin.json": {
      name: "original-project",
      version: "1.0.0",
      skills: "skills",
      ...(options.hooks ? { hooks: "hooks/hooks.json" } : {})
    },
    "skills/prepare/SKILL.md":
      "---\nname: prepare\ndescription: Prepare a reviewed draft\n---\nRead knowledge/policy.md and write draft.json.\n",
    "skills/approve/SKILL.md":
      "---\nname: approve\ndescription: Review the draft\n---\nRead draft.json and write decision.json.\n",
    "knowledge/policy.md":
      "Original knowledge content and environment placeholders: ${POLICY_ROOT}\n",
    "scripts/check.py": "print('original validator')\n",
    "skills/prepare/references/input.md": "Original reference\n"
  }
  if (options.hooks) records["hooks/hooks.json"] = { hooks: { PreToolUse: [] } }
  if (options.runtime !== false)
    records["devclaw.project-runtime.json"] = {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "original-project", version: "1.0.0" },
      mode: "host",
      stateOwner: "host",
      stages: [
        {
          id: "prepare",
          title: "Prepare",
          skill: "skills/prepare/SKILL.md",
          actionIds: [],
          artifactIds: ["draft"],
          checkIds: ["draft-schema"],
          approval: "none"
        },
        {
          id: "approve",
          title: "Approve",
          skill: "skills/approve/SKILL.md",
          actionIds: [],
          artifactIds: ["decision"],
          checkIds: ["decision-exists"],
          approval: "human"
        }
      ],
      actions: [],
      artifacts: [
        { id: "draft", path: "draft.json", required: true },
        { id: "decision", path: "decision.json", required: true }
      ],
      checks: [
        {
          id: "draft-schema",
          kind: "json-schema",
          artifactId: "draft",
          sideEffect: "read",
          schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
        },
        { id: "decision-exists", kind: "file-exists", artifactId: "decision", sideEffect: "read" }
      ],
      environment: [{ id: "POLICY_ROOT", description: "Local policy", required: true }],
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    }
  const files = Object.entries(records)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([path, value]) => {
      const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
      return { path, bytes, mode: 0o644, digest: createHash("sha256").update(bytes).digest("hex") }
    })
  return {
    root: "native-owned-source",
    files,
    excluded: [".env"],
    digest: derivationDigest(files, [".env"]),
    name: "original-project",
    manifests: ["plugin.json"],
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0)
  }
}
function edit(
  snapshot: DerivationSnapshot,
  path: string,
  update: (value: Record<string, unknown>) => unknown
) {
  const file = snapshot.files.find((item) => item.path === path)!
  file.bytes = Buffer.from(JSON.stringify(update(JSON.parse(file.bytes.toString("utf8")))))
  file.digest = createHash("sha256").update(file.bytes).digest("hex")
  snapshot.digest = derivationDigest(snapshot.files, snapshot.excluded)
}

function sharedSkillTemplate(): DerivationSnapshot {
  const template = createProjectTemplate({
    packageId: "shared-project",
    name: "Original shared Skill project"
  })
  const files = template.files.map(({ path, text }) => {
    const bytes = Buffer.from(text)
    return { path, bytes, mode: 0o644, digest: createHash("sha256").update(bytes).digest("hex") }
  })
  return {
    root: "native-owned-template",
    name: "shared-project",
    files,
    excluded: [],
    manifests: ["plugin.json"],
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    digest: derivationDigest(files, [])
  }
}
function addFile(source: DerivationSnapshot, path: string, text: string) {
  const bytes = Buffer.from(text)
  source.files.push({
    path,
    bytes,
    mode: 0o644,
    digest: createHash("sha256").update(bytes).digest("hex")
  })
  source.digest = derivationDigest(source.files, source.excluded)
}

function legacyFixture() {
  const source = fixture({ runtime: false, hooks: true })
  const modules = ["prepare", "approve"].map((id, index) => ({
    id,
    title: id,
    node: {
      id,
      label: id,
      group: "Business",
      skill: id,
      order: (index + 1) * 10,
      checkpoints: [id + "_in_progress", id + "_done"],
      validators: [],
      guards: [],
      artifacts: { inputs: [], outputs: [] }
    },
    skill: { entry: `skills/${id}/SKILL.md`, resources: [`skills/${id}`] },
    resources: [],
    dependencies: { required: index ? ["prepare"] : [], advisory: [] },
    checks: { validators: [], guards: [] }
  }))
  addFile(
    source,
    "board/config.json",
    JSON.stringify({
      apiVersion: 1,
      environment: { source: "${WORKSPACE_ROOT}" },
      knowledge: { reference: "knowledge/policy.md" },
      workflow: { nodes: modules.map((mod) => mod.node) }
    })
  )
  const catalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "original.board-kernel",
      version: "1.0.0",
      runtime: { adapter: "autobiz-v1" },
      boardConfigPath: "board/config.json",
      pluginFields: { hooks: "hooks/hooks.json", skills: "skills" },
      resources: ["hooks", "knowledge", "scripts"]
    },
    modules
  })
  return { source, catalog }
}

describe("original plugin first modularization", () => {
  it("accepts the reviewed adapter's derived config while retaining original source bytes and rules", () => {
    const { source, catalog } = legacyFixture()
    const original = source.files.find((file) => file.path === "board/config.json")!
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: source.digest,
      catalog
    })
    expect(candidate.files.find((file) => file.path === original.path)!.bytes).toEqual(
      original.bytes
    )
    const projection = assembleBusinessMods(
      [{ snapshot: source, catalog: candidate.catalog, modIds: ["prepare", "approve"] }],
      { sources: [], name: "independent-board", version: "1.0.0" }
    )
    const projected = JSON.parse(
      projection.files.find((file) => file.path === original.path)!.bytes.toString()
    )
    expect(projected.apiVersion).toBe(2)
    expect(projected.environment).toEqual({ source: "${WORKSPACE_ROOT}" })
    expect(projected.knowledge).toEqual({ reference: "knowledge/policy.md" })
    expect(projected.workflow.nodes.map((node: { id: string }) => node.id)).toEqual([
      "prepare",
      "approve"
    ])
    expect(projection.files.find((file) => file.path === "hooks/hooks.json")!.digest).toBe(
      source.files.find((file) => file.path === "hooks/hooks.json")!.digest
    )
  })

  it("rejects dropped legacy node rules and flattened routing before exempting derived config", () => {
    const { source, catalog } = legacyFixture()
    edit(source, "board/config.json", (board) => {
      const workflow = board.workflow as { nodes: Array<Record<string, unknown>> }
      workflow.nodes[0].runtimePolicy = { originalConstraint: true }
      return board
    })
    expect(() =>
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog
      })
    ).toThrow("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    const second = legacyFixture()
    edit(second.source, "board/config.json", (board) => {
      const workflow = board.workflow as Record<string, unknown>
      workflow.transitions = [
        {
          from: { nodeId: "approve", state: "done" },
          to: { nodeId: "prepare", state: "in_progress" }
        }
      ]
      return board
    })
    expect(() =>
      createPluginModularizationCandidate(second.source, {
        confirmed: true,
        sourceDigest: second.source.digest,
        catalog: second.catalog
      })
    ).toThrow("PLUGIN_MODULARIZATION_WORKFLOW_MAPPING_REQUIRED")
  })

  it.each(["catalog", "dependencies", "insertAfter"] as const)(
    "rejects first-migration main-chain reversal through %s",
    (cause) => {
      const { source, catalog } = legacyFixture()
      for (const mod of catalog.modules) mod.dependencies.required = []
      if (cause === "catalog") catalog.modules.reverse()
      if (cause === "dependencies") catalog.modules[0].dependencies.required = ["approve"]
      if (cause === "insertAfter") catalog.modules[0].insertAfter = "approve"
      expect(() =>
        createPluginModularizationCandidate(source, {
          confirmed: true,
          sourceDigest: source.digest,
          catalog
        })
      ).toThrow(
        cause === "catalog"
          ? "PLUGIN_MODULARIZATION_RUNTIME_CHANGED"
          : BusinessModCatalogValidationError
      )
      // Explicit later assembly keeps the original assembler's ability to choose another route.
      const composed = assembleBusinessMods(
        [{ snapshot: source, catalog, modIds: ["approve", "prepare"] }],
        {
          sources: [],
          name: "explicit-reordering",
          version: "1.0.0",
          order: ["approve", "prepare"]
        }
      )
      expect(composed.steps.map((step) => step.id)).toEqual(["approve", "prepare"])
    }
  )

  it.each(["hookDefinitions", "runtimePolicy", "routing", "rollback"])(
    "rejects newly injected node behavior in first migration: %s",
    (field) => {
      const { source, catalog } = legacyFixture()
      catalog.modules[0].node[field] = { newlyInjectedBehavior: true }
      expect(() =>
        createPluginModularizationCandidate(source, {
          confirmed: true,
          sourceDigest: source.digest,
          catalog
        })
      ).toThrow("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    }
  )

  it("retains dynamic branch order and rejects catalog or dependency reversal", () => {
    const { source, catalog } = legacyFixture()
    const branch = ["detail-first", "detail-second"].map((id) => ({
      id,
      phase: "Dev",
      label: id,
      skill: id,
      checkpointPrefix: id,
      artifacts: { inputs: [], outputs: [] },
      validators: []
    }))
    edit(source, "board/config.json", (board) => ({
      ...board,
      workflow: {
        ...(board.workflow as Record<string, unknown>),
        dynamicStages: [
          {
            id: "optional-detail",
            phase: "Dev",
            insertBefore: "approve",
            choiceCheckpoint: "prepare_done",
            skipTargetCheckpoint: "approve_in_progress",
            enableTargetCheckpoint: "detail-first_in_progress",
            nodes: branch
          }
        ]
      }
    }))
    for (const node of branch) {
      const entry = `skills/${node.skill}/SKILL.md`
      addFile(
        source,
        entry,
        `---\nname: ${node.skill}\ndescription: Original detail step\n---\nRead original policy.\n`
      )
      catalog.modules.push({
        id: node.id,
        title: node.label,
        node: {
          ...node,
          group: node.phase,
          checkpoints: [node.id + "_in_progress", node.id + "_done"]
        },
        skill: { entry, resources: [`skills/${node.skill}`] },
        resources: [],
        dependencies: { required: [], advisory: [] },
        checks: { validators: [], guards: [] }
      })
    }
    expect(
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog
      }).status
    ).toBe("needs-native-validation")
    const reversed = structuredClone(catalog)
    reversed.modules.splice(2, 2, ...reversed.modules.slice(2).reverse())
    const dependencyReversal = structuredClone(catalog)
    dependencyReversal.modules[2].dependencies.required = ["detail-second"]
    for (const invalid of [reversed, dependencyReversal])
      expect(() =>
        createPluginModularizationCandidate(source, {
          confirmed: true,
          sourceDigest: source.digest,
          catalog: invalid
        })
      ).toThrow(BusinessModCatalogValidationError)
    const injected = structuredClone(catalog)
    injected.modules[2].node.runtimePolicy = { newlyInjectedBehavior: true }
    expect(() =>
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog: injected
      })
    ).toThrow("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
  })

  it("reports configuration credential blockers without echoing values or discarding configuration", () => {
    const { source, catalog } = legacyFixture()
    edit(source, "board/config.json", (board) => ({ ...board, apiToken: "PRIVATE_CONFIG_CANARY" }))
    const original = source.files.find((file) => file.path === "board/config.json")!.bytes
    try {
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog
      })
      throw Error("Expected configuration rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessModCatalogValidationError)
      const diagnostics = (error as BusinessModCatalogValidationError).diagnostics
      expect(diagnostics[0].code).toBe("PLUGIN_MODULARIZATION_CREDENTIAL_CONFIGURATION_REQUIRED")
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_CONFIG_CANARY")
    }
    expect(source.files.find((file) => file.path === "board/config.json")!.bytes).toEqual(original)
  })

  it("requires the original knowledge provider and accepts an explicit additive implementation", () => {
    const { source, catalog } = legacyFixture()
    edit(source, "board/config.json", (board) => ({
      ...board,
      knowledge_config: { nextAction: { slashSkill: "policy-context" } }
    }))
    const digest = source.digest
    expect(() =>
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: digest,
        catalog
      })
    ).toThrow("PLUGIN_MODULARIZATION_PROVIDER_MISSING")
    catalog.kernel!.resources.push("skills/policy-context")
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: digest,
      catalog,
      modularizationFiles: [
        {
          path: "skills/policy-context/SKILL.md",
          text: "---\nname: policy-context\ndescription: Read the original local policy\n---\nRead knowledge/policy.md and present its original policy content.\n"
        }
      ]
    })
    expect(candidate.addedFiles.map((file) => file.path)).toEqual([
      "skills/policy-context/SKILL.md"
    ])
    expect(source.digest).toBe(digest)
    for (const file of source.files)
      expect(candidate.files.find((item) => item.path === file.path)?.digest).toBe(file.digest)
  })

  it("retains native keyword and scenario metadata through candidate and assembly", () => {
    const source = fixture({ hooks: true })
    edit(source, "plugin.json", (manifest) => ({
      ...manifest,
      keywords: ["workflow", "business"],
      useScenario: "Original workflow context"
    }))
    const original = source.files.find((file) => file.path === "plugin.json")!.bytes
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: source.digest
    })
    expect(candidate.catalog.kernel?.pluginFields).toMatchObject({
      keywords: ["workflow", "business"],
      useScenario: "Original workflow context"
    })
    expect(candidate.files.find((file) => file.path === "plugin.json")!.bytes).toEqual(original)
    const projection = assembleBusinessMods(
      [{ snapshot: source, catalog: candidate.catalog, modIds: ["prepare", "approve"] }],
      { sources: [], name: "metadata-copy", version: "1.0.0" }
    )
    expect(
      JSON.parse(projection.files.find((file) => file.path === "plugin.json")!.bytes.toString())
    ).toMatchObject({
      keywords: ["workflow", "business"],
      useScenario: "Original workflow context"
    })
  })

  it("returns schema field locations without echoing unknown field names or source values", () => {
    const source = fixture()
    const catalog = structuredClone(inspectPluginModularization(source).catalog!)
    const malformed = catalog as unknown as { modules: Array<Record<string, unknown>> }
    delete malformed.modules[0].dependencies
    malformed.modules[0].PRIVATE_FIELD_CANARY = "PRIVATE_VALUE_CANARY"
    let failure: unknown
    try {
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BusinessModCatalogValidationError)
    const diagnostics = (failure as BusinessModCatalogValidationError).diagnostics
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ path: "catalog.modules.0.dependencies" })
    )
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ path: "catalog.modules.0", code: "unrecognized_keys" })
    )
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_FIELD_CANARY")
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_VALUE_CANARY")
    expect(source.files.some((file) => file.path === BUSINESS_MOD_MANIFEST)).toBe(false)
  })

  it("explains semantic skill mapping errors after structural validation", () => {
    const source = fixture()
    const catalog = structuredClone(inspectPluginModularization(source).catalog!)
    catalog.modules[0].skill.entry = "skills/unmatched/SKILL.md"
    try {
      createPluginModularizationCandidate(source, {
        confirmed: true,
        sourceDigest: source.digest,
        catalog
      })
      throw Error("Expected a rejected migration")
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessModCatalogValidationError)
      expect((error as BusinessModCatalogValidationError).diagnostics[0]).toMatchObject({
        path: "catalog.modules",
        message: expect.stringContaining("node.skill")
      })
    }
  })

  it("splits explicit Host stages without losing original files, schema, approval, knowledge or environment", () => {
    const source = fixture({ hooks: true })
    const original = source.files.map((file) => [file.path, file.bytes.toString("hex")])
    const inspection = inspectPluginModularization(source)
    expect(inspection.status).toBe("candidate")
    expect(inspection.nextAction).toBe("confirm-candidate")
    expect(inspection.excluded).toEqual([".env"])
    expect(inspection.catalog?.modules[1].dependencies.required).toEqual(["prepare"])
    expect(inspection.catalog?.modules[1].host?.stage.approval).toBe("human")
    expect(inspection.catalog?.modules[0].host?.checks[0].schema?.required).toEqual(["title"])
    expect(inspection.catalog?.kernel?.pluginFields?.hooks).toBe("hooks/hooks.json")
    const result = createPluginModularizationCandidate(source, {
      sourceDigest: source.digest,
      confirmed: true
    })
    expect(result.status).toBe("needs-native-validation")
    expect(result.files).toHaveLength(source.files.length + 1)
    for (const file of source.files) {
      const retained = result.files.find((item) => item.path === file.path)!
      expect(retained.digest).toBe(file.digest)
      expect(retained.bytes).toEqual(file.bytes)
      expect(retained.bytes).not.toBe(file.bytes)
    }
    expect(source.files.map((file) => [file.path, file.bytes.toString("hex")])).toEqual(original)
    expect(source.files.some((file) => file.path === BUSINESS_MOD_MANIFEST)).toBe(false)
  })

  it("requires explicit confirmation and the current exact source digest", () => {
    const source = fixture()
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: false as true
      })
    ).toThrow("CONFIRMATION_REQUIRED")
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: "stale",
        confirmed: true
      })
    ).toThrow("SOURCE_CHANGED")
  })

  it("returns authoring materials for unknown original workflows and never reports them migrated", () => {
    const source = fixture({ runtime: false, hooks: true })
    const inspection = inspectPluginModularization(source)
    expect(inspection).toMatchObject({
      status: "needs-authoring",
      runtime: "unknown",
      nextAction: "author-migration-plan"
    })
    expect(inspection.blockers[0].paths).toContain("hooks/hooks.json")
    expect(inspection.catalog).toBeUndefined()
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true
      })
    ).toThrow("PLAN_REQUIRED")
  })

  it("accepts an explicit authored plan for an unknown source through original parsers and closure checks", () => {
    const source = fixture({ runtime: false, hooks: true })
    const known = fixture({ hooks: true })
    const catalog = inspectPluginModularization(known).catalog!
    const candidate = createPluginModularizationCandidate(source, {
      sourceDigest: source.digest,
      confirmed: true,
      catalog
    })
    expect(candidate.status).toBe("needs-native-validation")
    expect(candidate.inspection.status).toBe("needs-authoring")
    expect(candidate.files.find((file) => file.path === "hooks/hooks.json")?.digest).toBe(
      source.files.find((file) => file.path === "hooks/hooks.json")?.digest
    )
  })

  it("rejects authored plans that drop retained source resources or hook bindings", () => {
    const source = fixture({ hooks: true })
    const catalog = inspectPluginModularization(source).catalog!
    catalog.kernel!.resources = catalog.kernel!.resources.filter(
      (path) => path !== "knowledge/policy.md"
    )
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog
      })
    ).toThrow("RESOURCE_LOSS")
    const changed = inspectPluginModularization(source).catalog!
    delete changed.kernel!.pluginFields!.hooks
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog: changed
      })
    ).toThrow("METADATA_CHANGED")
  })

  it("rejects removal of an original schema or human approval even in an authored plan", () => {
    const source = fixture()
    const catalog = inspectPluginModularization(source).catalog!
    catalog.modules[1].host!.stage.approval = "none"
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog
      })
    ).toThrow("RUNTIME_CHANGED")
    const weakened = inspectPluginModularization(source).catalog!
    weakened.modules[0].host!.checks[0].schema!.required = []
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog: weakened
      })
    ).toThrow("RUNTIME_CHANGED")
  })

  it("blocks missing original mandatory checks and unsupported native Function mapping", () => {
    const source = fixture()
    edit(source, "devclaw.project-runtime.json", (value) => {
      const stages = value.stages as Array<Record<string, unknown>>
      stages[0].checkIds = []
      return value
    })
    expect(inspectPluginModularization(source).status).toBe("needs-authoring")
    const functions = fixture()
    edit(functions, "plugin.json", (value) => ({ ...value, mods: "mods/manifest.json" }))
    expect(inspectPluginModularization(functions).status).toBe("needs-authoring")
  })

  it("does not discard an existing knowledge/context contract or return parser credential fragments", () => {
    const source = fixture()
    edit(source, "devclaw.project-runtime.json", (runtime) =>
      wrapProjectRuntimeManifest(runtime as never, {
        apiVersion: "devclaw.extension-contract/v1",
        requires: ["devclaw.required-business-checks/v1", "devclaw.context-handoff/v1"],
        context: {
          sourceAccess: "read-only",
          mutableData: "host",
          configuration: "host-resolved",
          knowledge: { required: true },
          provider: { entry: "scripts/provider.py", operations: ["session-context"] }
        }
      })
    )
    expect(inspectPluginModularization(source).status).toBe("needs-authoring")
    const credential = fixture()
    edit(credential, "plugin.json", (value) => ({ ...value, apiKey: "private-secret-value" }))
    const view = inspectPluginModularization(credential)
    expect(view.catalog).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain("private-secret-value")
    expect(view.status).toBe("needs-authoring")
  })

  it("routes an already modular source back to ordinary inspection instead of remigrating", () => {
    const source = fixture()
    const result = createPluginModularizationCandidate(source, {
      sourceDigest: source.digest,
      confirmed: true
    })
    const migrated = { ...source, files: result.files, digest: result.digest }
    expect(inspectPluginModularization(migrated)).toMatchObject({
      status: "already-modular",
      nextAction: "inspect-existing-mods"
    })
    expect(() =>
      createPluginModularizationCandidate(migrated, {
        sourceDigest: migrated.digest,
        confirmed: true
      })
    ).toThrow("ALREADY_MODULAR")
  })

  it("does not drop required Hook capability bindings or select one conflicting plugin manifest", () => {
    const source = fixture({ hooks: true })
    const bytes = Buffer.from(
      JSON.stringify({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: "project-flow",
            title: "Original flow",
            kind: "flow",
            usage: "project",
            entry: "devclaw.project-runtime.json",
            dependsOn: [],
            requiredHooks: ["PreToolUse:0:0"]
          }
        ]
      })
    )
    source.files.push({
      path: "devclaw.capabilities.json",
      bytes,
      mode: 0o644,
      digest: createHash("sha256").update(bytes).digest("hex")
    })
    source.digest = derivationDigest(source.files, source.excluded)
    expect(inspectPluginModularization(source).status).toBe("needs-authoring")
    const other = fixture()
    const manifest = Buffer.from(
      JSON.stringify({ name: "original-project", version: "1.0.0", hooks: "other-hooks.json" })
    )
    other.files.push({
      path: ".claude-plugin/plugin.json",
      bytes: manifest,
      mode: 0o644,
      digest: createHash("sha256").update(manifest).digest("hex")
    })
    other.manifests.push(".claude-plugin/plugin.json")
    other.digest = derivationDigest(other.files, other.excluded)
    expect(inspectPluginModularization(other).status).toBe("needs-authoring")
  })

  it("modularizes the real project-lite shared Skill with exact original checks, approval and declarations", async () => {
    const source = sharedSkillTemplate()
    const inspection = inspectPluginModularization(source)
    expect(inspection.status).toBe("candidate")
    expect(inspection.aliases).toHaveLength(2)
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: source.digest
    })
    const original = source.files.find((file) => file.path === "skills/draft/SKILL.md")!
    expect(candidate.files.find((file) => file.path === original.path)?.bytes).toEqual(
      original.bytes
    )
    for (const alias of inspection.aliases!) {
      const file = candidate.files.find((file) => file.path === alias.skill)!
      const before = parseSkillFrontmatter(original.bytes.toString("utf8"))
      const after = parseSkillFrontmatter(file.bytes.toString("utf8"))
      expect(after.body).toBe(before.body)
      expect(after.frontmatter).toEqual({ ...before.frontmatter, name: alias.name })
    }
    const projected = assembleBusinessMods(
      [
        {
          snapshot: { ...source, files: candidate.files, digest: candidate.digest },
          catalog: candidate.catalog,
          modIds: candidate.catalog.modules.map((mod) => mod.id)
        }
      ],
      {
        name: "shared-derived",
        version: "1.0.0",
        sources: []
      }
    )
    const runtime = parseProjectRuntimeManifest(
      JSON.parse(
        projected.files
          .find((file) => file.path === "devclaw.project-runtime.json")!
          .bytes.toString("utf8")
      )
    )
    const originalRuntime = parseProjectRuntimeManifest(
      JSON.parse(
        source.files
          .find((file) => file.path === "devclaw.project-runtime.json")!
          .bytes.toString("utf8")
      )
    )
    expect(runtime.stages.map((stage) => stage.id)).toEqual(["draft", "review"])
    expect(new Set(runtime.stages.map((stage) => stage.skill)).size).toBe(2)
    expect(runtime.stages[1].approval).toBe("human")
    expect(runtime.checks).toEqual(originalRuntime.checks)
    expect(runtime.artifacts).toEqual(originalRuntime.artifacts)
    expect(runtime.capabilities).toEqual(originalRuntime.capabilities)
    const bundle = createAuthoringSourceBundle(
      projected.files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
    )
    const report = await testProjectSource(bundle, runtime)
    expect(report.valid).toBe(true)
    expect(report.cases).toHaveLength(4)
    expect(report.cases.map((item) => item.actual)).toEqual([
      "failed",
      "passed",
      "failed",
      "passed"
    ])
    expect(
      JSON.parse(
        projected.files.find((file) => file.path === BUSINESS_MOD_ASSEMBLY)!.bytes.toString("utf8")
      ).kernel.runtime.capabilities
    ).toEqual(originalRuntime.capabilities)
    const reread = parseBusinessModCatalog(
      JSON.parse(
        projected.files.find((file) => file.path === BUSINESS_MOD_MANIFEST)!.bytes.toString("utf8")
      )
    )
    const repeated = assembleBusinessMods(
      [
        {
          snapshot: {
            ...source,
            name: "shared-derived",
            files: projected.files,
            digest: projected.digest
          },
          catalog: reread,
          modIds: reread.modules.map((mod) => mod.id)
        }
      ],
      { name: "shared-remixed", version: "1.0.0", sources: [] }
    )
    const repeatedRuntime = parseProjectRuntimeManifest(
      JSON.parse(
        repeated.files
          .find((file) => file.path === "devclaw.project-runtime.json")!
          .bytes.toString("utf8")
      )
    )
    expect(repeatedRuntime.capabilities).toEqual(originalRuntime.capabilities)
    expect(repeatedRuntime.stages).toEqual(runtime.stages)
    expect(repeatedRuntime.checks).toEqual(originalRuntime.checks)
  })

  it("rejects alias path/name collisions without overwriting any original file", () => {
    const source = sharedSkillTemplate()
    const alias = inspectPluginModularization(source).aliases![0]
    const bytes = Buffer.from("Original conflicting resource\n")
    source.files.push({
      path: alias.skill.replace("SKILL.md", "reference.md"),
      bytes,
      mode: 0o644,
      digest: createHash("sha256").update(bytes).digest("hex")
    })
    source.digest = derivationDigest(source.files, [])
    expect(inspectPluginModularization(source).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_ALIAS_COLLISION"
    )
    expect(() =>
      createPluginModularizationCandidate(source, { confirmed: true, sourceDigest: source.digest })
    ).toThrow("PLAN_REQUIRED")
    expect(source.files.find((file) => file.path.endsWith("reference.md"))?.bytes).toEqual(bytes)
    const named = sharedSkillTemplate()
    const namedBytes = Buffer.from(
      `---\nname: ${alias.name}\ndescription: Existing real Skill\n---\nOriginal body\n`
    )
    named.files.push({
      path: "skills/other/SKILL.md",
      bytes: namedBytes,
      mode: 0o644,
      digest: createHash("sha256").update(namedBytes).digest("hex")
    })
    named.digest = derivationDigest(named.files, [])
    expect(inspectPluginModularization(named).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_ALIAS_COLLISION"
    )
  })

  it("does not pretend invalid YAML frontmatter can be safely aliased", () => {
    const source = sharedSkillTemplate()
    const skill = source.files.find((file) => file.path === "skills/draft/SKILL.md")!
    skill.bytes = Buffer.from("---\nname: [unterminated\n---\nOriginal body\n")
    skill.digest = createHash("sha256").update(skill.bytes).digest("hex")
    source.digest = derivationDigest(source.files, [])
    expect(inspectPluginModularization(source).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_MAPPING_REQUIRED"
    )
    const anchored = sharedSkillTemplate()
    const anchor = anchored.files.find((file) => file.path === "skills/draft/SKILL.md")!
    anchor.bytes = Buffer.from(
      "---\nname: &shared original-skill\ndescription: *shared\n---\nOriginal body\n"
    )
    anchor.digest = createHash("sha256").update(anchor.bytes).digest("hex")
    anchored.digest = derivationDigest(anchored.files, [])
    expect(inspectPluginModularization(anchored).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED"
    )
  })

  it("places aliases beside the original Skill so real ../shared and ../../scripts references resolve identically", async () => {
    const source = sharedSkillTemplate()
    addFile(source, "skills/shared/policy.md", "Exact shared knowledge bytes\r\n")
    addFile(source, "scripts/check.py", "# Original helper script; do not execute\n")
    addFile(source, "skills/draft/references/detail.md", "Exact local reference\n")
    const originalSkill = source.files.find((file) => file.path === "skills/draft/SKILL.md")!
    originalSkill.bytes = Buffer.concat([
      originalSkill.bytes,
      Buffer.from("\nRead ../shared/policy.md, ../../scripts/check.py and references/detail.md.\n")
    ])
    originalSkill.digest = createHash("sha256").update(originalSkill.bytes).digest("hex")
    source.digest = derivationDigest(source.files, source.excluded)
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: source.digest
    })
    const root = await mkdtemp(join(tmpdir(), "plugin-alias-relative-"))
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("plugin-alias-relative-")
    )
      throw Error("Unsafe test cleanup")
    try {
      await writeDerivationFiles(root, candidate.files)
      const originalRoot = dirname(join(root, originalSkill.path))
      for (const alias of candidate.inspection.aliases!) {
        const aliasRoot = dirname(join(root, alias.skill))
        expect(dirname(aliasRoot)).toBe(dirname(originalRoot))
        for (const path of [
          "../shared/policy.md",
          "../../scripts/check.py",
          "references/detail.md"
        ])
          expect(await readFile(resolve(aliasRoot, path))).toEqual(
            await readFile(resolve(originalRoot, path))
          )
      }
      expect(await readFile(join(root, originalSkill.path))).toEqual(originalSkill.bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["PreSkillUse", "PostSkillUse"])(
    "blocks %s lifecycle Hooks for both exact and wildcard matchers before aliasing",
    (event) => {
      for (const matcher of ["draft", "*"]) {
        const source = sharedSkillTemplate()
        const text = JSON.stringify({
          hooks: {
            [event]: [{ matcher, hooks: [{ type: "command", command: "python hooks/check.py" }] }]
          }
        })
        addFile(source, "hooks/hooks.json", text)
        const inspection = inspectPluginModularization(source)
        expect(inspection.status).toBe("needs-authoring")
        expect(inspection.blockers[0].code).toBe(
          "PLUGIN_MODULARIZATION_SKILL_HOOK_MAPPING_REQUIRED"
        )
        expect(inspection.blockers[0].message).toContain("作者先完成")
        expect(
          source.files.find((file) => file.path === "hooks/hooks.json")?.bytes.toString("utf8")
        ).toBe(text)
        expect(() =>
          createPluginModularizationCandidate(source, {
            confirmed: true,
            sourceDigest: source.digest
          })
        ).toThrow("PLAN_REQUIRED")
      }
    }
  )

  it("blocks skill-local lifecycle Hooks and unknown Hook declarations without dropping them", () => {
    for (const text of [
      JSON.stringify([{ event: "PreSkillUse", matcher: "*", command: "python guard.py" }]),
      JSON.stringify({ UnreviewedEvent: [] }),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ command: "python guard.py", unknownMapping: true }] }]
      }),
      "{ invalid Hook declaration"
    ]) {
      const source = sharedSkillTemplate()
      addFile(source, "skills/draft/hooks.json", text)
      expect(inspectPluginModularization(source).status).toBe("needs-authoring")
      expect(inspectPluginModularization(source).blockers[0].code).toMatch(
        /^PLUGIN_MODULARIZATION_SKILL_HOOK_/
      )
      expect(
        source.files.find((file) => file.path === "skills/draft/hooks.json")?.bytes.toString("utf8")
      ).toBe(text)
    }
    const inline = sharedSkillTemplate()
    const skill = inline.files.find((file) => file.path === "skills/draft/SKILL.md")!
    skill.bytes = Buffer.from(
      skill.bytes
        .toString("utf8")
        .replace(
          "\n---\n",
          "\nhooks:\n  PreSkillUse:\n    - matcher: '*'\n      hooks:\n        - type: command\n          command: python guard.py\n---\n"
        )
    )
    skill.digest = createHash("sha256").update(skill.bytes).digest("hex")
    inline.digest = derivationDigest(inline.files, [])
    expect(inspectPluginModularization(inline).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_HOOK_MAPPING_REQUIRED"
    )
  })

  it("keeps recognized non-lifecycle plugin Hooks byte-for-byte while adding safe aliases", () => {
    const source = sharedSkillTemplate()
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "python ${CLAUDE_PLUGIN_ROOT}/scripts/check.py" }]
          }
        ]
      }
    })
    addFile(source, "hooks/hooks.json", text)
    const candidate = createPluginModularizationCandidate(source, {
      confirmed: true,
      sourceDigest: source.digest
    })
    expect(candidate.inspection.status).toBe("candidate")
    expect(
      candidate.files.find((file) => file.path === "hooks/hooks.json")?.bytes.toString("utf8")
    ).toBe(text)
  })

  it("does not duplicate nested Skill registration when copying an alias resource closure", () => {
    const source = sharedSkillTemplate()
    addFile(
      source,
      "skills/draft/nested/SKILL.md",
      "---\nname: nested\ndescription: Existing nested Skill\n---\nOriginal nested body\n"
    )
    expect(inspectPluginModularization(source).blockers[0].code).toBe(
      "PLUGIN_MODULARIZATION_SKILL_ALIAS_NESTED_MAPPING_REQUIRED"
    )
    expect(source.files.filter((file) => file.path.endsWith("nested/SKILL.md"))).toHaveLength(1)
  })

  it("adds explicit migration resources without changing any original byte and requires the full catalog closure", () => {
    const source = fixture()
    const catalog = inspectPluginModularization(source).catalog!
    const additions = [
      {
        path: "tests/project-contract.json",
        text: '{"apiVersion":"devclaw.project-contract/v1","cases":[]}'
      },
      { path: "knowledge/new-policy.md", text: "New authored context\n" }
    ]
    catalog.kernel!.resources.push(...additions.map((file) => file.path))
    const candidate = createPluginModularizationCandidate(source, {
      sourceDigest: source.digest,
      confirmed: true,
      catalog,
      modularizationFiles: additions
    })
    expect(candidate.addedFiles.map((file) => file.path)).toEqual(
      additions.map((file) => file.path)
    )
    expect(candidate.modularizationFiles).toEqual(additions)
    for (const file of source.files)
      expect(candidate.files.find((value) => value.path === file.path)?.bytes).toEqual(file.bytes)
    expect(source.files.some((file) => file.path === additions[0].path)).toBe(false)
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog: inspectPluginModularization(source).catalog!,
        modularizationFiles: additions
      })
    ).toThrow("RESOURCE_LOSS")
  })

  it("rejects additive overwrite, directory/case collision, identities, credentials and unrelated host paths", () => {
    const source = fixture()
    for (const path of [
      "skills/prepare/SKILL.md",
      "skills/Prepare/new.md",
      "skills/prepare/SKILL.md/child.json",
      "plugin.json",
      "devclaw.project-runtime.json",
      "mods/business/manifest.json",
      "tests/plugin.json",
      "knowledge/.env",
      "knowledge/credentials.json",
      "knowledge/secrets.json",
      "knowledge/auth.json",
      "knowledge/settings.local.json",
      "../outside.md",
      "C:/outside.md",
      "unrelated/file.md"
    ]) {
      expect(() =>
        createPluginModularizationCandidate(source, {
          sourceDigest: source.digest,
          confirmed: true,
          modularizationFiles: [{ path, text: "Never overwrite\n" }]
        })
      ).toThrow()
    }
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        modularizationFiles: [
          { path: "tests/new.md", text: "one" },
          { path: "tests/new.md", text: "two" }
        ]
      })
    ).toThrow("FILE_COLLISION")
  })

  it("retains the original 32-file, 64KiB single-file and 256KiB total authoring bounds", () => {
    const source = fixture()
    const catalog = inspectPluginModularization(source).catalog!
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `tests/new-${index}.md`,
      text: "bounded text\n"
    }))
    catalog.kernel!.resources.push(...files.map((file) => file.path))
    expect(
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog,
        modularizationFiles: files
      }).addedFiles
    ).toHaveLength(32)
    for (const additions of [
      [...files, { path: "tests/one-too-many.md", text: "33" }],
      [{ path: "tests/too-big.md", text: "a".repeat(65537) }],
      Array.from({ length: 5 }, (_, index) => ({
        path: `tests/total-${index}.md`,
        text: "a".repeat(60 * 1024)
      }))
    ])
      expect(() =>
        createPluginModularizationCandidate(source, {
          sourceDigest: source.digest,
          confirmed: true,
          catalog,
          modularizationFiles: additions
        })
      ).toThrow()
  })

  it("does not replace an original legacy runtime or infer Host ownership from an old board file", () => {
    const source = fixture()
    const catalog = inspectPluginModularization(source).catalog!
    edit(source, "devclaw.project-runtime.json", (value) => ({
      ...value,
      mode: "legacy",
      stateOwner: "plugin"
    }))
    expect(() =>
      createPluginModularizationCandidate(source, {
        sourceDigest: source.digest,
        confirmed: true,
        catalog,
        modularizationFiles: [{ path: "tests/new.md", text: "Explicitly authored test material" }]
      })
    ).toThrow()
    const board = fixture({ runtime: false })
    addFile(board, "board_core/board_config.json", '{"workflow":{"nodes":[]}}')
    expect(() =>
      createPluginModularizationCandidate(board, {
        sourceDigest: board.digest,
        confirmed: true,
        catalog
      })
    ).toThrow("ADAPTER_MAPPING_REQUIRED")
  })

  it.each(["Board_Core/board_config.json", "board_core/BOARD_CONFIG.JSON"])(
    "rejects an unowned legacy marker with Windows case variation: %s",
    (path) => {
      const source = fixture({ runtime: false })
      const catalog = inspectPluginModularization(fixture()).catalog!
      addFile(source, path, '{"workflow":{"nodes":[]},"inspectCommands":{"dynamic":"original"}}')
      const before = source.files.map((file) => ({
        path: file.path,
        digest: file.digest,
        bytes: Buffer.from(file.bytes)
      }))
      expect(() =>
        createPluginModularizationCandidate(source, {
          sourceDigest: source.digest,
          confirmed: true,
          catalog
        })
      ).toThrow("ADAPTER_MAPPING_REQUIRED")
      expect(
        source.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes }))
      ).toEqual(before)
      expect(source.files.some((file) => file.path === BUSINESS_MOD_MANIFEST)).toBe(false)
    }
  )
})

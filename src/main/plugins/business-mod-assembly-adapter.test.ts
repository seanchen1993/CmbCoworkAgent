import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { assembleBusinessMods } from "./business-mod-assembler"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import { derivationDigest, type DerivationFile, type DerivationSnapshot } from "./derivation-source"
import reviewedKernel from "./autobiz-business-kernel-reviewed.json"

function hostModule(id: string, order: number) {
  return {
    id,
    title: id,
    node: { id, skill: id, order },
    skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
    resources: [],
    dependencies: { required: [] as string[], advisory: [] },
    checks: { validators: [] as string[], guards: [] as string[] },
    host: {
      stage: {
        actionIds: [],
        artifactIds: [`${id}.output`],
        checkIds: [`${id}.schema`],
        approval: "none"
      },
      actions: [],
      artifacts: [{ id: `${id}.output`, path: `${id}.json`, required: true }],
      checks: [
        {
          id: `${id}.schema`,
          kind: "json-schema",
          artifactId: `${id}.output`,
          sideEffect: "read",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
        }
      ],
      environment: []
    }
  }
}

function catalog() {
  const first = hostModule("intake", 10)
  const second = hostModule("decision", 20)
  second.dependencies.required = [first.id]
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "independent.kernel",
      version: "1.0.0",
      runtime: { adapter: "host-linear-v1" },
      resources: ["knowledge/policy.md"]
    },
    modules: [first, second]
  }
}

function snapshot(
  raw: ReturnType<typeof catalog>,
  additional: Record<string, string> = {}
): DerivationSnapshot {
  const content: Record<string, string> = {
    "plugin.json": JSON.stringify({ name: "independent-source", version: "1.0.0" }),
    [BUSINESS_MOD_MANIFEST]: JSON.stringify(raw),
    "knowledge/policy.md": "Independent authored policy, no AutoBiz protocol",
    ...Object.fromEntries(
      raw.modules.map((mod) => [
        mod.skill.entry,
        `---\nname: ${mod.node.skill}\ndescription: Authored business Skill\n---\nRead policy and create a real artifact.`
      ])
    ),
    ...additional
  }
  const files: DerivationFile[] = Object.entries(content).map(([path, text]) => {
    const bytes = Buffer.from(text)
    return { path, bytes, mode: 0o644, digest: createHash("sha256").update(bytes).digest("hex") }
  })
  return {
    root: "controlled-in-memory-source",
    files,
    name: "independent-source",
    excluded: [],
    digest: derivationDigest(files, []),
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    manifests: ["plugin.json"]
  }
}

function assemble(
  raw = catalog(),
  additional: Record<string, string> = {},
  options: { verifiedArtifactIds?: string[] } = {}
) {
  const source = snapshot(raw, additional)
  return assembleBusinessMods(
    [{ snapshot: source, catalog: parseBusinessModCatalog(raw), modIds: ["decision"] }],
    { name: "independent-output", version: "1.0.0", sources: [], ...options }
  )
}
function value(files: DerivationFile[], path: string): unknown {
  const file = files.find((item) => item.path === path)
  expect(file, path).toBeDefined()
  return JSON.parse(file!.bytes.toString("utf8"))
}

describe("business assembly reviewed runtime adapters", () => {
  it.each([
    { hooks: true, rename: true, blocked: true },
    { hooks: false, rename: true, blocked: false },
    { hooks: true, rename: false, blocked: false }
  ])(
    "preserves original Skill identity when executable Hooks are declared: %j",
    ({ hooks, rename, blocked }) => {
      const raw = catalog()
      if (hooks) {
        Object.assign(raw.kernel, { pluginFields: { hooks: "hooks/hooks.json" } })
        raw.kernel.resources.push("hooks/hooks.json")
      }
      const base = snapshot(raw, hooks ? { "hooks/hooks.json": "{}" } : {})
      const changed = structuredClone(raw.modules[0])
      if (rename) {
        changed.node.skill = "intake-improved"
        changed.skill.entry = "skills/intake-improved/SKILL.md"
      }
      const next = snapshot(
        { ...raw, modules: [changed] },
        {
          [changed.skill.entry]:
            `---\nname: ${changed.node.skill}\ndescription: Revised prompt\n---\nUse the original validators and produce the original artifact.`
        }
      )
      const draft = parseBusinessModCatalog({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernelRef: { id: raw.kernel.id, version: raw.kernel.version },
        modules: [changed]
      })
      const run = () =>
        assembleBusinessMods(
          [
            { snapshot: base, catalog: parseBusinessModCatalog(raw), modIds: ["intake"] },
            { snapshot: next, catalog: draft, modIds: ["intake"] }
          ],
          {
            name: "updated-independent-source",
            version: "1.0.0",
            sources: [],
            replacements: [
              { id: "intake", sourceDigest: base.digest, replacementSourceDigest: next.digest }
            ]
          }
        )
      if (blocked) expect(run).toThrow("BUSINESS_WORKFLOW_SKILL_RENAME_REQUIRES_HOOK_MAPPING")
      else expect(run().steps.map((step) => step.id)).toEqual(["intake"])
    }
  )
  it("assembles Host stages and required checks through native contracts without board checkpoints", () => {
    const result = assemble()
    const runtime = parseProjectRuntimeManifest(value(result.files, "devclaw.project-runtime.json"))
    expect(result.runtime).toEqual({ adapter: "host-linear-v1", mode: "host", stateOwner: "host" })
    expect(runtime.mode).toBe("host")
    expect(runtime.stages.map((stage) => [stage.id, stage.skill])).toEqual([
      ["intake", "skills/intake/SKILL.md"],
      ["decision", "skills/decision/SKILL.md"]
    ])
    expect(runtime.checks.map((check) => check.id)).toEqual(["intake.schema", "decision.schema"])
    expect(result.files.some((file) => file.path === "devclaw.stage-checks.json")).toBe(false)
    expect(result.files.some((file) => file.path.includes("board_config"))).toBe(false)
    expect(value(result.files, BUSINESS_MOD_ASSEMBLY)).toMatchObject({
      kernel: { runtime: { adapter: "host-linear-v1" } }
    })
    expect(value(result.files, "devclaw.portability.json")).not.toHaveProperty("boardApiVersion")
    expect(value(result.files, BUSINESS_MOD_MANIFEST)).toMatchObject({
      kernel: { runtime: { adapter: "host-linear-v1" } }
    })
  })

  it("rejects unknown adapter identifiers and a Host kernel carrying board config", () => {
    const unknown = catalog()
    Object.assign(unknown.kernel.runtime, { adapter: "author-code.js" })
    expect(() => parseBusinessModCatalog(unknown)).toThrow(
      "BUSINESS_MOD_ASSEMBLY_ADAPTER_UNSUPPORTED"
    )
    const conflict = catalog()
    Object.assign(conflict.kernel, { boardConfigPath: "board/config.json" })
    expect(() => parseBusinessModCatalog(conflict)).toThrow("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  })

  it("cannot relabel a reviewed AutoBiz identity as a Host kernel", () => {
    const raw = catalog()
    Object.assign(raw.kernel, { id: reviewedKernel.id, version: reviewedKernel.version })
    expect(() => assemble(raw)).toThrow("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  })

  it.each(["checkpoints", "validatorBindings", "artifacts", "guards"])(
    "rejects inherited legacy %s instead of silently dropping its guarantee",
    (key) => {
      const raw = catalog()
      Object.assign(raw.modules[0].node, { [key]: key === "validatorBindings" ? {} : [] })
      expect(() => assemble(raw)).toThrow("BUSINESS_MOD_LEGACY_CHECKS_REQUIRE_ADAPTER")
    }
  )

  it("rejects a matching legacy validator declared both on a Host node and its checks", () => {
    const raw = catalog()
    raw.modules[0].checks.validators = ["must-check"]
    Object.assign(raw.modules[0].node, { validators: ["must-check"] })
    expect(() => assemble(raw)).toThrow("BUSINESS_MOD_LEGACY_CHECKS_REQUIRE_ADAPTER")
  })

  it("rejects required artifacts without a declared stage check", () => {
    const raw = catalog()
    raw.modules[0].host.stage.checkIds = []
    raw.modules[0].host.checks = []
    expect(() => assemble(raw)).toThrow("BUSINESS_MOD_HOST_REQUIRED_ARTIFACT_UNCHECKED")
  })

  it("rejects dangling references and unsupported native JSON schemas at inspection", () => {
    const dangling = catalog()
    dangling.modules[0].host.stage.checkIds = ["nonexistent"]
    expect(() => parseBusinessModCatalog(dangling)).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
    const schema = catalog()
    Object.assign(schema.modules[0].host.checks[0].schema, { $ref: "https://invalid/schema" })
    expect(() => parseBusinessModCatalog(schema)).toThrow()
  })

  it("rejects a stage with no native completion check before producing an unusable package", () => {
    const raw = catalog()
    raw.modules[0].host.stage.artifactIds = []
    raw.modules[0].host.stage.checkIds = []
    raw.modules[0].host.artifacts = []
    raw.modules[0].host.checks = []
    expect(() => assemble(raw)).toThrow("BUSINESS_MOD_HOST_STAGE_CHECK_REQUIRED")
  })

  it("rejects legacy board-dependent context providers instead of inventing Host board config", () => {
    const raw = catalog()
    Object.assign(raw, {
      extensions: [
        {
          id: "context",
          title: "Context",
          kind: "function",
          usage: "universal",
          entry: "mods/business/context/register.ts",
          resources: ["mods/business/context/provider.py"],
          dependencies: { required: [], advisory: [] },
          contextProvider: {
            entry: "mods/business/context/provider.py",
            operations: ["session-context"],
            required: true
          }
        }
      ]
    })
    const source = snapshot(raw, {
      "mods/business/context/register.ts": "export {}",
      "mods/business/context/provider.py": "# original provider"
    })
    expect(() =>
      assembleBusinessMods(
        [
          {
            snapshot: source,
            catalog: parseBusinessModCatalog(raw),
            modIds: ["decision", "context"]
          }
        ],
        { name: "independent-output", version: "1.0.0", sources: [] }
      )
    ).toThrow("BUSINESS_MOD_HOST_CONTEXT_PROVIDER_UNSUPPORTED")
  })

  it("rejects duplicate global IDs after composing individually valid Host modules", () => {
    const raw = catalog()
    raw.modules[1].host.artifacts[0].id = "intake.output"
    raw.modules[1].host.stage.artifactIds = ["intake.output"]
    raw.modules[1].host.checks[0].artifactId = "intake.output"
    expect(() => assemble(raw)).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
  })

  it("rejects unbound checks, missing declarations and legacy adapter resources", () => {
    const unbound = catalog()
    unbound.modules[0].host.stage.checkIds = []
    expect(() => assemble(unbound)).toThrow("BUSINESS_MOD_HOST_UNBOUND_DECLARATION")
    const absent = catalog()
    Reflect.deleteProperty(absent.modules[0], "host")
    expect(() => assemble(absent)).toThrow("BUSINESS_MOD_HOST_DECLARATION_REQUIRED")
    const resource = catalog()
    resource.kernel.resources.push("devclaw.stage-checks.json")
    expect(() => assemble(resource, { "devclaw.stage-checks.json": "{}" })).toThrow(
      "BUSINESS_MOD_LEGACY_CHECKS_REQUIRE_ADAPTER"
    )
  })

  it("preserves dependency ordering and refuses missing implementation/unsupported verified export", () => {
    const raw = catalog()
    raw.modules[1].dependencies.required = ["missing"]
    expect(() => assemble(raw)).toThrow()
    expect(() =>
      assemble(catalog(), { "skills/intake/SKILL.md": "---\nname: other\n---" })
    ).toThrow("BUSINESS_MOD_HOST_SKILL_INVALID")
    expect(() => assemble(catalog(), {}, { verifiedArtifactIds: ["intake.output"] })).toThrow(
      "VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED"
    )
  })

  it("keeps omitted runtime on the explicit legacy compatibility projection", () => {
    const raw = catalog()
    Reflect.deleteProperty(raw.kernel, "runtime")
    Object.assign(raw.kernel, { boardConfigPath: "board/config.json" })
    for (const mod of raw.modules) {
      Reflect.deleteProperty(mod, "host")
      Object.assign(mod.node, { checkpoints: [`${mod.id}_in_progress`, `${mod.id}_done`] })
    }
    const board = {
      apiVersion: 1,
      workflow: {
        nodes: raw.modules.map((mod) => mod.node),
        templates: { custom: { kind: "custom", requiredNodes: [] } }
      }
    }
    const result = assemble(raw, { "board/config.json": JSON.stringify(board) })
    expect(result.runtime).toEqual({ adapter: "autobiz-v1", mode: "legacy", stateOwner: "plugin" })
    expect(result.files.some((file) => file.path === "devclaw.stage-checks.json")).toBe(true)
    expect(value(result.files, "devclaw.portability.json")).toHaveProperty("boardApiVersion", 2)
    expect(
      parseProjectRuntimeManifest(value(result.files, "devclaw.project-runtime.json")).mode
    ).toBe("legacy")
  })
})

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { assembleBusinessMods } from "./business-mod-assembler"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import { derivationDigest, type DerivationSnapshot } from "./derivation-source"

function catalog() {
  const shared = {
    stage: {
      actionIds: ["shared.action"],
      artifactIds: ["shared.output"],
      checkIds: ["shared.check"],
      approval: "human"
    },
    actions: [
      {
        id: "shared.action",
        ref: {
          pluginId: "installed-source",
          plugin: "source-action",
          digest: "a".repeat(64),
          actionId: "check"
        }
      }
    ],
    artifacts: [{ id: "shared.output", path: "output.json", required: true }],
    checks: [
      {
        id: "shared.check",
        artifactId: "shared.output",
        kind: "json-schema",
        sideEffect: "read",
        schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
      }
    ],
    environment: [{ id: "POLICY_ROOT", description: "Original policy", required: true }]
  }
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "independent.shared",
      version: "1.0.0",
      runtime: { adapter: "host-linear-v1" },
      resources: []
    },
    modules: ["draft", "review"].map((id, index) => ({
      id,
      title: id,
      node: { id, skill: id, order: index * 10 },
      skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
      resources: [],
      dependencies: { required: index ? ["draft"] : [], advisory: [] },
      checks: { validators: [], guards: [] },
      host: structuredClone(shared)
    }))
  }
}
function assemble(raw = catalog()) {
  const files = [
    { path: "plugin.json", text: JSON.stringify({ name: "original-source", version: "1.0.0" }) },
    ...raw.modules.map((mod) => ({
      path: mod.skill.entry,
      text: `---\nname: ${mod.id}\ndescription: Real source\n---\nRetain original source.\n`
    }))
  ].map(({ path, text }) => {
    const bytes = Buffer.from(text)
    return { path, bytes, mode: 0o644, digest: createHash("sha256").update(bytes).digest("hex") }
  })
  const snapshot: DerivationSnapshot = {
    root: "native-owned",
    name: "original-source",
    files,
    excluded: [],
    manifests: ["plugin.json"],
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    digest: derivationDigest(files, [])
  }
  const projection = assembleBusinessMods(
    [{ snapshot, catalog: parseBusinessModCatalog(raw), modIds: ["review"] }],
    {
      name: "shared-output",
      version: "1.0.0",
      sources: []
    }
  )
  return parseProjectRuntimeManifest(
    JSON.parse(
      projection.files
        .find((file) => file.path === "devclaw.project-runtime.json")!
        .bytes.toString("utf8")
    )
  )
}

describe("Host shared stage contracts and preserved declarations", () => {
  it("merges structurally equivalent shared actions, artifacts, checks and environment while retaining all stage references", () => {
    const raw = catalog()
    raw.modules[1].host.checks[0].schema = {
      required: ["title"],
      properties: { title: { type: "string" } },
      type: "object"
    }
    const result = assemble(raw)
    expect(result.stages).toHaveLength(2)
    for (const key of ["actions", "artifacts", "checks", "environment"] as const)
      expect(result[key]).toHaveLength(1)
    expect(
      result.stages.every(
        (stage) => stage.checkIds[0] === "shared.check" && stage.approval === "human"
      )
    ).toBe(true)
  })

  it.each(["actions", "artifacts", "checks", "environment"] as const)(
    "rejects a conflicting shared %s declaration",
    (key) => {
      const raw = catalog()
      const declaration = raw.modules[1].host
      if (key === "actions") declaration.actions[0].ref.digest = "b".repeat(64)
      if (key === "artifacts") declaration.artifacts[0].path = "other.json"
      if (key === "checks") declaration.checks[0].schema.properties.title.type = "number"
      if (key === "environment") declaration.environment[0].required = false
      expect(() => assemble(raw)).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
    }
  )

  it("preserves the original five boolean declarations without treating them as authority", () => {
    const raw = catalog()
    const capabilities = {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: true,
      cancellation: false
    }
    Object.assign(raw.kernel.runtime, { capabilities })
    expect(assemble(raw).capabilities).toEqual(capabilities)
    expect(assemble().capabilities).toEqual({
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    })
  })

  it("rejects incomplete, nonboolean or extra capability fields and never extends the AutoBiz protocol", () => {
    for (const capabilities of [
      { execution: true },
      {
        execution: true,
        conditionalTransition: false,
        idempotency: "true",
        reconciliation: false,
        cancellation: true
      },
      {
        execution: true,
        conditionalTransition: false,
        idempotency: true,
        reconciliation: false,
        cancellation: true,
        grant: true
      }
    ]) {
      const raw = catalog()
      Object.assign(raw.kernel.runtime, { capabilities })
      expect(() => parseBusinessModCatalog(raw)).toThrow()
    }
    const legacy = catalog()
    Object.assign(legacy.kernel, { boardConfigPath: "board/config.json" })
    Object.assign(legacy.kernel.runtime, {
      adapter: "autobiz-v1",
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    })
    expect(() => parseBusinessModCatalog(legacy)).toThrow("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  })
})

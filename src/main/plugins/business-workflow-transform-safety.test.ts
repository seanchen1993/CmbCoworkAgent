import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import { assembleBusinessMods } from "./business-mod-assembler"
import { snapshotDerivationSource } from "./derivation-source"
import { inspectBusinessWorkflow, transformBusinessWorkflow } from "./business-workflow-transform"

function checkedNativeStage() {
  return parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "independent.delivery", version: "1.0.0" },
    modules: [
      {
        id: "delivery.review",
        title: "业务复核",
        node: { id: "delivery.review", skill: "review" },
        skill: { entry: "skills/review/SKILL.md", resources: [] },
        resources: [],
        dependencies: { required: [], advisory: [] },
        checks: { validators: [], guards: [] },
        host: {
          stage: {
            actionIds: ["quality-check"],
            artifactIds: ["review"],
            checkIds: ["quality-receipt"],
            approval: "human"
          },
          actions: [
            {
              id: "quality-check",
              ref: {
                pluginId: "installed-validator",
                plugin: "quality-policy",
                actionId: "validate",
                digest: "a".repeat(64)
              }
            }
          ],
          artifacts: [{ id: "review", path: "review.json", required: true }],
          checks: [
            {
              id: "quality-receipt",
              artifactId: "review",
              kind: "action",
              actionId: "quality-check",
              sideEffect: "read"
            }
          ],
          environment: []
        }
      }
    ]
  }).modules[0]
}

it.each(["pluginId", "plugin", "actionId", "digest"] as const)(
  "cannot relabel an original native check's %s while keeping its action/check IDs",
  (field) => {
    const source = checkedNativeStage()
    const candidate = structuredClone(source)
    candidate.host!.actions[0].ref[field] =
      field === "digest" ? "b".repeat(64) : "different-validator"
    // Both declarations are structurally valid and keep the same output, check and stage
    // bindings. The source replacement guard must preserve the actual validation identity.
    const next = parseBusinessModCatalog({
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernelRef: { id: "independent.delivery", version: "1.0.0" },
      modules: [candidate]
    }).modules[0]
    expect(() =>
      transformBusinessWorkflow({
        modules: [source],
        sourceDigest: "c".repeat(64),
        expectedWorkflowDigest: inspectBusinessWorkflow([source]).digest,
        changes: [{ kind: "replace_step", id: source.id, module: next }]
      })
    ).toThrow("BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED")
  }
)

it.each(["knowledge", "executable"])(
  "cannot silently rewrite an original %s resource inside its own namespace",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-protected-resource-"))
    try {
      const source = checkedNativeStage()
      source.resources = ["mods/business/delivery.review/policy.md"]
      source.skill.resources = ["skills/review/check.py"]
      const catalog = parseBusinessModCatalog({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernel: {
          id: "independent.delivery",
          version: "1.0.0",
          runtime: { adapter: "host-linear-v1" },
          resources: []
        },
        modules: [source]
      })
      const files = {
        [source.skill.entry]:
          "---\nname: review\ndescription: Original review skill\n---\nKeep the required original checks.\n",
        [source.resources[0]]: "Required knowledge and policy",
        [source.skill.resources[0]]: "raise ValueError('original-validator')\n"
      }
      async function materialize(name: string, value: unknown, resources: Record<string, string>) {
        const root = join(directory, name)
        for (const [path, text] of Object.entries({
          "plugin.json": JSON.stringify({ name, version: "1.0.0" }),
          "mods/business/manifest.json": JSON.stringify(value),
          ...resources
        })) {
          await mkdir(dirname(join(root, path)), { recursive: true })
          await writeFile(join(root, path), text)
        }
        return snapshotDerivationSource(root)
      }
      const original = await materialize("protected-original", catalog, files)
      const replacementCatalog = parseBusinessModCatalog({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernelRef: { id: "independent.delivery", version: "1.0.0" },
        modules: [source]
      })
      const replacement = await materialize("protected-replacement", replacementCatalog, {
        ...files,
        [kind === "knowledge" ? source.resources[0] : source.skill.resources[0]]:
          "silently weakened"
      })
      expect(() =>
        assembleBusinessMods(
          [
            { snapshot: original, catalog, modIds: [] },
            { snapshot: replacement, catalog: replacementCatalog, modIds: [source.id] }
          ],
          {
            name: "protected-candidate",
            version: "1.0.0",
            sources: [],
            replacements: [
              {
                id: source.id,
                sourceDigest: original.digest,
                replacementSourceDigest: replacement.digest
              }
            ]
          }
        )
      ).toThrow("BUSINESS_WORKFLOW_RETAINED_RESOURCE_CHANGED")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.each(["artifact-type", "extract-policy", "missing-extract-policy"])(
  "keeps the original required output semantics when replacing a stage (%s)",
  (mutation) => {
    const source = checkedNativeStage()
    delete source.host
    source.node.checkpoints = ["review_in_progress", "review_done"]
    source.node.artifacts = {
      outputs: [
        {
          id: "review",
          path: "review.json",
          artifactType: "json",
          required: true,
          extract: { degrade: "Stop and ask for the required structured input." }
        }
      ]
    }
    const candidate = structuredClone(source)
    const output = (candidate.node.artifacts as { outputs: Array<Record<string, unknown>> })
      .outputs[0]
    if (mutation === "artifact-type") output.artifactType = "file"
    else if (mutation === "extract-policy") output.extract = { degrade: "Skip the missing output." }
    else delete output.extract
    expect(() =>
      transformBusinessWorkflow({
        modules: [source],
        sourceDigest: "c".repeat(64),
        expectedWorkflowDigest: inspectBusinessWorkflow([source]).digest,
        changes: [{ kind: "replace_step", id: source.id, module: candidate }]
      })
    ).toThrow(/BUSINESS_WORKFLOW_REQUIRED_/)
  }
)

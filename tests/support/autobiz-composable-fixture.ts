import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { assembleBusinessMods } from "../../src/main/plugins/business-mod-assembler"
import { businessModCatalog } from "../../src/main/plugins/business-mod-manifest"
import {
  inspectBusinessWorkflow,
  transformBusinessWorkflow
} from "../../src/main/plugins/business-workflow-transform"
import { prepareAutobizFunctionStatePlugin } from "../../scripts/prepare-autobiz-function-state-plugin"
import { readNativeCapabilityCatalog } from "../../src/main/plugins/capability-catalog"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"
import { projectNodeAgentResources } from "../../src/main/plugins/project-agent-resources"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  type DerivationFile
} from "../../src/main/plugins/derivation-source"

const file = (path: string, text: string): DerivationFile => {
  const bytes = Buffer.from(text)
  return { path, bytes, digest: createHash("sha256").update(bytes).digest("hex"), mode: 0o666 }
}

/** Builds an independent actual Python-kernel candidate; never modifies the retained source. */
export async function createAutobizComposableFixture(
  source: string,
  parent: string,
  options: { minimumRevision?: number } = {}
) {
  const baseline = await prepareAutobizFunctionStatePlugin({
    source,
    output: join(parent, "baseline"),
    name: "autobiz-composable-baseline",
    version: "1.1.0"
  })
  const original = await snapshotDerivationSource(baseline.assembled)
  const catalog = structuredClone(businessModCatalog(original))
  const changes = new Map<string, DerivationFile>()
  const input = {
    id: "normalized_requirements",
    path: "NORMALIZED_REQUIREMENTS.json",
    required: true
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["feature", "requirements", "revision"],
    properties: {
      feature: { type: "string", minLength: 1 },
      revision: { type: "integer", minimum: options.minimumRevision ?? 1 },
      requirements: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
    }
  }
  const skill = options.minimumRevision === 2 ? "requirements-convert-v2" : "requirements-convert"
  const validator = "business:biz.convert"
  const validatorPath = "mods/business/biz.convert/check.py"
  const converter = {
    id: "biz.convert",
    title: "需求转换",
    node: {
      id: "biz.convert",
      label: "需求转换",
      group: "Biz",
      skill: "requirements-convert",
      order: 0,
      checkpoints: ["convert_in_progress", "convert_done"],
      artifacts: {
        inputs: [],
        outputs: [{ ...input, artifactType: "json", schemaVersion: "1.0.0", schema }]
      },
      validators: [validator],
      validatorBindings: { [validator]: { path: validatorPath, function: "validate" } }
    },
    skill: { entry: "skills/requirements-convert/SKILL.md", resources: [] },
    resources: [validatorPath],
    dependencies: { required: [], advisory: [] },
    checks: { validators: [validator], guards: [] }
  }
  const prd = structuredClone(catalog.modules.find((item) => item.id === "biz.prd")!)
  const artifacts = prd.node.artifacts as { inputs: unknown[] }
  artifacts.inputs.push({ ...input, schemaVersion: "1.0.0" })
  prd.dependencies.required.push("biz.convert")
  const lineageValidator = "business:biz.prd"
  const lineagePath = "mods/business/biz.prd/requirements_lineage.py"
  prd.checks.validators.push(lineageValidator)
  prd.node.validators = [...prd.checks.validators]
  prd.node.validatorBindings = {
    ...(prd.node.validatorBindings as Record<string, unknown> | undefined),
    [lineageValidator]: { path: lineagePath, function: "validate" }
  }
  prd.resources.push(lineagePath)
  const extensionIds = catalog.extensions!.map((item) => item.id)
  let transformed = transformBusinessWorkflow({
    modules: catalog.modules,
    sourceDigest: original.digest,
    expectedWorkflowDigest: inspectBusinessWorkflow(catalog.modules, extensionIds).digest,
    extensionIds,
    changes: [
      { kind: "insert", before: "biz.prd", module: converter },
      { kind: "replace_step", id: "biz.prd", module: prd }
    ]
  })
  if (options.minimumRevision === 2) {
    const specs = structuredClone(transformed.modules.find((item) => item.id === "dev.specs")!)
    specs.node.description =
      String(specs.node.description ?? "") + "\n读取上游结构化需求并保留验收来源。"
    const modified = transformBusinessWorkflow({
      modules: transformed.modules,
      sourceDigest: original.digest,
      expectedWorkflowDigest: transformed.workflow.digest,
      extensionIds,
      changes: [
        {
          kind: "replace_skill",
          id: "biz.convert",
          skillName: skill,
          skill: { entry: `skills/${skill}/SKILL.md`, resources: [] }
        },
        { kind: "replace_step", id: "dev.specs", module: specs }
      ]
    })
    transformed = {
      ...modified,
      changedIds: [...new Set([...transformed.changedIds, ...modified.changedIds])],
      replacements: [
        ...new Set([
          ...transformed.replacements,
          ...modified.replacements.filter((id) => catalog.modules.some((item) => item.id === id))
        ])
      ]
    }
  }
  changes.set(
    `skills/${skill}/SKILL.md`,
    file(
      `skills/${skill}/SKILL.md`,
      `---\nname: ${skill}\ndescription: 将原始需求转换为可验证的结构化需求\n---\n先调用当前插件state_read，找到workflow.stages中本技能对应outputs的schemaVersion和schema，按实际声明生成NORMALIZED_REQUIREMENTS.json。包含feature、revision和非空requirements，revision最低值等约束必须读取有效schema，不能硬编码旧版值。调用state_preflight、state_advance推进，成功后由后继技能读取同一产物。\n`
    )
  )
  changes.set(
    validatorPath,
    file(
      validatorPath,
      `import json\n\ndef validate(context):\n    value = json.loads(context.file("NORMALIZED_REQUIREMENTS.json").read_text(encoding="utf-8"))\n    return 0 if value.get("feature") == context.slug else 1\n`
    )
  )
  changes.set(
    lineagePath,
    file(
      lineagePath,
      `import json\n\ndef validate(context):\n    upstream = json.loads(context.file("NORMALIZED_REQUIREMENTS.json").read_text(encoding="utf-8"))\n    prd = context.file("PRD.md").read_text(encoding="utf-8")\n    requirements = upstream.get("requirements")\n    if (upstream.get("feature") != context.slug or not isinstance(requirements, list) or not requirements\n            or any(not isinstance(item, str) or not item.strip() or item not in prd for item in requirements)\n            or "来源：NORMALIZED_REQUIREMENTS.json" not in prd):\n        raise ValueError("AUTOBIZ_PRD_REQUIREMENTS_NOT_COVERED")\n    return 0\n`
    )
  )
  changes.set(
    "mods/business/manifest.json",
    file(
      "mods/business/manifest.json",
      JSON.stringify({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernelRef: { id: catalog.kernel!.id, version: catalog.kernel!.version },
        modules: transformed.modules.filter((item) => transformed.changedIds.includes(item.id))
      })
    )
  )
  changes.set(
    "plugin.json",
    file("plugin.json", JSON.stringify({ name: "creator-requirements-draft", version: "0.1.0" }))
  )
  for (const mod of transformed.modules.filter((item) =>
    transformed.replacements.includes(item.id)
  ))
    for (const path of [
      mod.skill.entry,
      ...mod.skill.resources,
      ...mod.resources,
      ...projectNodeAgentResources(mod.node)
    ])
      for (const retained of original.files.filter(
        (item) => item.path === path || item.path.startsWith(path + "/")
      ))
        changes.set(retained.path, retained)
  const draft = join(parent, "source")
  await mkdir(draft)
  await writeDerivationFiles(draft, [...changes.values()])
  const snapshot = await snapshotDerivationSource(draft)
  const selected = businessModCatalog(snapshot)
  const ids = [...catalog.modules, ...(catalog.extensions ?? [])].map((item) => item.id)
  const changedIds = selected.modules.map((item) => item.id)
  const assembled = assembleBusinessMods(
    [
      { snapshot: original, catalog, modIds: ids },
      { snapshot, catalog: selected, modIds: changedIds }
    ],
    {
      name: "autobiz-converted-requirements",
      version: "1.1.0",
      sources: [
        { inspectionId: "controlled-original-baseline", modIds: ids },
        { inspectionId: "controlled-creator-transform", modIds: changedIds }
      ],
      replacements: transformed.replacements.map((id) => ({
        id,
        sourceDigest: original.digest,
        replacementSourceDigest: snapshot.digest
      })),
      order: transformed.order,
      acceptFixedWorkflow: true
    }
  )
  const output = join(parent, "complete-plugin")
  await mkdir(output)
  await writeDerivationFiles(output, assembled.files)
  const native = await readNativeCapabilityCatalog(
    {
      id: "actual-converted-autobiz",
      path: output,
      name: "autobiz-converted-requirements",
      version: "1.1.0",
      enabled: true
    },
    "project"
  )
  if (native.status !== "declared" || native.legacyAdapter !== "autobiz-v1")
    throw Error("AUTOBIZ_COMPOSITION_ADMISSION_FAILED:" + JSON.stringify(native))
  const compiled = await compileFunctionPlugin(output)
  if (!compiled.code) throw Error("AUTOBIZ_COMPOSITION_COMPILE_FAILED")
  return { output, original, assembled, catalog: selected, native, transformed }
}

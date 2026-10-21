import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { createPluginModularizationCandidate } from "../src/main/plugins/plugin-modularization"
import { readBundledBusinessModExample } from "../src/main/plugins/business-mod-examples"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import {
  businessModCatalog,
  parseBusinessModCatalog
} from "../src/main/plugins/business-mod-manifest"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  type DerivationFile
} from "../src/main/plugins/derivation-source"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"
import { readPluginStageRecoveryAdapter } from "../src/main/mods/devtools/plugin-stage-recovery-adapter"
import type { BusinessModCatalog } from "../src/shared/business-mods"
import {
  repairOriginalAutobizCompletionContext,
  repairOriginalAutobizPreparationBase,
  repairOriginalAutobizPlanProjection
} from "./autobiz-original-preparation-compatibility"

export const ORIGINAL_AUTOBIZ_ZIP_SHA256 =
  "df77bc7f59c77732586cbbf05582cad7447de3027818ad59734715108e89f184"
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const file = (path: string, bytes: Buffer): DerivationFile => ({
  path,
  bytes,
  mode: process.platform === "win32" ? 0o666 : 0o644,
  digest: hash(bytes)
})

/** Author-side conversion of the explicitly supplied original. No installed package is modified. */
export async function prepareOriginalAutobizModsDelivery(input: {
  archive: string
  output: string
  name: string
  version: string
  repairPreparationBase?: boolean
}) {
  const bytes = await readFile(input.archive)
  assert.equal(hash(bytes), ORIGINAL_AUTOBIZ_ZIP_SHA256, "Exact supplied original ZIP required")
  const zip = new AdmZip(bytes)
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  const manifests = entries.filter((entry) => /(?:^|\/)plugin\.json$/.test(entry.entryName))
  assert.equal(manifests.length, 1)
  const prefix = manifests[0].entryName.slice(0, -"plugin.json".length)
  const files = entries.map((entry) => {
    assert(entry.entryName.startsWith(prefix))
    const path = entry.entryName.slice(prefix.length)
    assert(
      path &&
        !path.includes("\\") &&
        !path.split("/").some((part) => ["", ".", ".."].includes(part))
    )
    return file(path, entry.getData())
  })
  assert.equal(files.length, 234, "Complete original inventory required")
  const output = resolve(input.output)
  await mkdir(output) // Exclusive creation, including previous incomplete deliveries.
  const originalRoot = join(output, "original-read-only")
  await writeDerivationFiles(originalRoot, files)
  const original = await snapshotDerivationSource(originalRoot)
  const repairs =
    input.repairPreparationBase === false
      ? []
      : [
          "hooks/parallel_batch_stage.py",
          "hooks/parallel_evidence_aggregate.py",
          "hooks/plan_writer.py",
          "hooks/evidence_integrity_gate.py"
        ]
  let authored = original
  if (repairs.length) {
    const compatible = join(output, "compatible-source")
    const projection = await readFile(
      resolve("resources/mods/autobiz-plan-merge/verified-merge-projection.py.inc"),
      "utf8"
    )
    await writeDerivationFiles(
      compatible,
      original.files.map((row) =>
        repairs.includes(row.path)
          ? file(
              row.path,
              row.path === "hooks/plan_writer.py"
                ? repairOriginalAutobizPlanProjection(row.bytes, projection)
                : row.path === "hooks/evidence_integrity_gate.py"
                  ? repairOriginalAutobizCompletionContext(row.bytes)
                  : repairOriginalAutobizPreparationBase(row.path, row.bytes)
            )
          : row
      )
    )
    authored = await snapshotDerivationSource(compatible)
  }
  const json = (path: string) =>
    JSON.parse(original.files.find((row) => row.path === path)!.bytes.toString("utf8"))
  const manifest = json(original.manifests[0])
  const board = json("board_core/board_config.json")
  const dynamic = board.workflow.dynamicStages.flatMap((stage: { nodes: unknown[] }) => stage.nodes)
  const nodes = [...board.workflow.nodes, ...dynamic]
  const modules = nodes.map((node) => {
    const skill = original.files.find((row) => row.path.endsWith(`/${node.skill}/SKILL.md`))
    assert(skill, `Original skill missing: ${node.id}`)
    const skillRoot = skill.path.slice(0, -"SKILL.md".length)
    const selected = structuredClone(node)
    if (dynamic.includes(node)) {
      selected.group ??= selected.phase
      selected.checkpoints ??= [
        selected.checkpointPrefix + "_in_progress",
        selected.checkpointPrefix + "_done"
      ]
    }
    return {
      id: node.id,
      title: node.label ?? node.id,
      node: selected,
      skill: {
        entry: skill.path,
        resources: original.files
          .filter((row) => row.path.startsWith(skillRoot) && row.path !== skill.path)
          .map((row) => row.path)
      },
      resources: [],
      dependencies: { required: [], advisory: [] },
      checks: { validators: node.validators ?? [], guards: node.guards ?? [] }
    }
  })
  const owned = new Set(modules.flatMap((mod) => [mod.skill.entry, ...mod.skill.resources]))
  const example = await readBundledBusinessModExample("autobiz-knowledge", resolve("tests"))
  const recoveryEntry = "mods/business/autobiz.knowledge/stage-recovery/adapter.py"
  const declaration = {
    apiVersion: "devclaw.plugin-stage-recovery/v1" as const,
    entry: recoveryEntry,
    runtime: "python" as const,
    isolation: "private-output-copy" as const,
    codeSource: "keep" as const,
    externalEffects: "network-requires-confirmation" as const
  }
  const pluginFields = Object.fromEntries(
    [
      "description",
      "author",
      "license",
      "keywords",
      "useScenario",
      "hooks",
      "skills",
      "mcpServers",
      "userConfig"
    ]
      .filter((key) => manifest[key] !== undefined)
      .map((key) => [key, manifest[key]])
  )
  const catalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "autobiz.original-234-kernel",
      version: input.version,
      runtime: { adapter: "autobiz-v1" },
      boardConfigPath: "board_core/board_config.json",
      pluginFields,
      resources: original.files
        .filter((row) => !original.manifests.includes(row.path) && !owned.has(row.path))
        .map((row) => row.path)
    },
    modules,
    extensions: example.draft.extensions!.map((extension) => ({
      ...extension,
      resources: [...extension.resources, recoveryEntry],
      stageRecoveryAdapter: declaration
    }))
  } satisfies BusinessModCatalog)
  const recovery = await readFile(resolve("resources/mods/autobiz-stage-recovery/adapter.py"))
  const modularizationFiles = [
    ...example.draft.files,
    { path: recoveryEntry, text: recovery.toString("utf8") }
  ]
  const candidate = createPluginModularizationCandidate(authored, {
    sourceDigest: authored.digest,
    confirmed: true,
    catalog,
    modularizationFiles
  })
  const source = join(output, "Mods-source")
  await writeDerivationFiles(source, candidate.files)
  const snapshot = await snapshotDerivationSource(source)
  const selected = businessModCatalog(snapshot)
  const modIds = [...selected.modules, ...(selected.extensions ?? [])].map((mod) => mod.id)
  const assembly = assembleBusinessMods([{ snapshot, catalog: selected, modIds }], {
    name: input.name,
    version: input.version,
    sources: [{ inspectionId: "explicit-original-zip-author-conversion", modIds }],
    acceptFixedWorkflow: true
  })
  const assembled = join(output, "complete-plugin")
  await writeDerivationFiles(assembled, assembly.files)
  const adapter = readPluginStageRecoveryAdapter(assembled)
  adapter.assertCurrent()
  const native = await readNativeCapabilityCatalog(
    {
      id: "exact-original-user-delivery",
      path: assembled,
      name: input.name,
      version: input.version,
      enabled: true
    },
    "project"
  )
  assert.equal(native.status, "declared", native.reasons.join("; "))
  const outputZip = join(output, input.name + ".zip")
  const packed = new AdmZip()
  for (const row of assembly.files) packed.addFile(row.path, row.bytes)
  await writeFile(outputZip, packed.toBuffer(), { flag: "wx" })
  const changes = original.files.flatMap((row) => {
    const current = assembly.files.find((item) => item.path === row.path)
    return current?.digest === row.digest
      ? []
      : [{ path: row.path, before: row.digest, after: current?.digest }]
  })
  assert.deepEqual(
    changes.map((row) => row.path).sort(),
    ["board_core/board_config.json", "plugin.json", ...repairs].sort()
  )
  const report = {
    sourceZip: resolve(input.archive),
    sourceZipSha256: hash(bytes),
    originalDigest: original.digest,
    originalFiles: original.files.length,
    source,
    assembled,
    outputZip,
    outputZipSha256: hash(await readFile(outputZip)),
    packageDigest: (await snapshotDerivationSource(assembled)).digest,
    plugin: { name: input.name, version: input.version },
    modules: modules.map((mod) => mod.id),
    allOriginalHooksAndScriptsPreserved: changes.every(
      (row) => !/^(?:hooks|skills|board_core)\/.+\.(?:py|js|md)$/.test(row.path)
    ),
    allOriginalHookDeclarationsPreserved:
      assembly.files.find((row) => row.path === "hooks/hooks.json")!.digest ===
      original.files.find((row) => row.path === "hooks/hooks.json")!.digest,
    compatibilityRepair: {
      changedFiles: repairs,
      reasons: [
        "Bind isolated preparation evidence to the native Batch startSha and retain stale-input rejection",
        "Project Plan completion only from current native Task/Stage/Train/Git merge proof",
        "Project successful non-deferred staged aggregate for the unchanged legacy Code evidence reader",
        "Pass the native feature directory into original completion checks instead of referencing an undefined variable"
      ],
      originalSourceUnchanged: true
    },
    changedOriginalMetadata: changes.filter((row) => !repairs.includes(row.path)),
    changedOriginalScripts: changes.filter((row) => repairs.includes(row.path)),
    recoveryAdapter: adapter.declaration,
    nativeCapabilityStatus: native.status,
    reviewedLegacyAdapter: native.legacyAdapter ?? null,
    diagnostics: assembly.diagnostics,
    businessStagesExecuted: false
  }
  await writeFile(
    join(output, "conversion-verification.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" }
  )
  assert.equal(hash(await readFile(input.archive)), ORIGINAL_AUTOBIZ_ZIP_SHA256)
  return report
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-original-mods-delivery.ts")
) {
  assert(
    process.argv[2] && process.argv[3],
    "Usage: <original.zip> <new-output-directory> [new-name version]"
  )
  void prepareOriginalAutobizModsDelivery({
    archive: process.argv[2],
    output: process.argv[3],
    name: process.argv[4] ?? "autobiz-original-mods-recovery-20261021",
    version: process.argv[5] ?? "1.0.3"
  })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

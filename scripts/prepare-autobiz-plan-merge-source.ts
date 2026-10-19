import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"

const repository = resolve(__dirname, "..")
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
export const AUTOBIZ_PLAN_MERGE_SOURCE_SHA256 =
  "aba93b9226786fc65eb02d6f652792bfc812abbc7be625974c5a70eeab5e5aee"
// Updated only alongside the reviewed transform resource; unknown inputs fail closed.
export const AUTOBIZ_PLAN_MERGE_TARGET_SHA256 =
  "be568b7e790a21539c7906f4657bf563337a9c8937ae7b09cfbf0198404971e6"
export const AUTOBIZ_AGGREGATE_SOURCE_SHA256 =
  "02f3097b584b90463ad45007a7cc5b95378ed751861bc90fc3db4eacdb7a0257"
export const AUTOBIZ_AGGREGATE_TARGET_SHA256 =
  "f3e3cba9675fd04f4991f3b841cd03e2296fe5ce0e9c6dedaf8e938b24ed242d"
export function transformAutobizEvidenceAggregate(bytes: Buffer): Buffer {
  assert.equal(
    digest(bytes),
    AUTOBIZ_AGGREGATE_SOURCE_SHA256,
    "AutoBiz evidence aggregate source differs from the exact reviewed revision"
  )
  const anchor = '        manifest["finalEvidenceAggregate"] = report'
  const original = bytes.toString("utf8")
  assert.equal(
    original.split(anchor).length,
    2,
    "Expected exactly one aggregate compatibility anchor"
  )
  const output = Buffer.from(
    original.replace(
      anchor,
      `${anchor}
        # One strict aggregate fact, projected for the original legacy code_done gate.
        # Never retain an earlier success after current evidence fails or defers.
        if report["passed"] and not report["hasDeferredIssues"]:
            manifest["finalVerification"] = report
        else:
            manifest.pop("finalVerification", None)`
    )
  )
  assert.equal(
    digest(output),
    AUTOBIZ_AGGREGATE_TARGET_SHA256,
    "AutoBiz aggregate transform differs from the reviewed output"
  )
  return output
}
export async function transformAutobizPlanWriter(bytes: Buffer): Promise<Buffer> {
  assert.equal(
    digest(bytes),
    AUTOBIZ_PLAN_MERGE_SOURCE_SHA256,
    "AutoBiz Plan Writer source differs from the exact reviewed revision"
  )
  let text = bytes.toString("utf8")
  const helper = await readFile(
    join(repository, "resources/mods/autobiz-plan-merge/verified-merge-projection.py.inc"),
    "utf8"
  )
  const replacements = [
    [
      "def _project_batches(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:",
      helper +
        "def _project_batches(data: dict[str, Any], *, workspace: Path | None = None, " +
        "feature: str | None = None) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:"
    ],
    [
      "        status = _batch_status(batch_tasks)",
      '        status = ("done" if _verified_parallel_batch_merge(workspace, feature, ' +
        "batch_id, previous, batch_tasks) else _batch_status(batch_tasks))"
    ],
    [
      '"completedAt": previous.get("completedAt") if status == "done" else None,',
      '"completedAt": previous.get("mergedAt") if status == "done" else None,'
    ],
    [
      "    root, batch_plans = _project_batches(data)",
      "    root, batch_plans = _project_batches(data, workspace=workspace, feature=feature)"
    ]
  ]
  for (const [from, to] of replacements) {
    assert.equal(text.split(from).length, 2, "Expected exactly one reviewed patch anchor")
    text = text.replace(from, to)
  }
  const output = Buffer.from(text)
  assert.equal(
    digest(output),
    AUTOBIZ_PLAN_MERGE_TARGET_SHA256,
    "AutoBiz Plan Writer transform differs from the reviewed output"
  )
  return output
}

/** New source only. Never changes upstream or an installed plugin. */
export async function prepareAutobizPlanMergeSource(output: string, upstream: string) {
  const targetWithinSource = relative(resolve(upstream), resolve(output))
  assert(
    targetWithinSource &&
      (targetWithinSource.split(/[\\/]/)[0] === ".." || isAbsolute(targetWithinSource)),
    "Compatibility output must be outside the read-only upstream source"
  )
  const original = await snapshotDerivationSource(upstream)
  const plan = original.files.find((file) => file.path === "hooks/plan_writer.py")
  assert(plan, "Original Plan Writer is required")
  const patched = await transformAutobizPlanWriter(plan.bytes)
  const aggregate = original.files.find(
    (file) => file.path === "hooks/parallel_evidence_aggregate.py"
  )!
  assert(aggregate, "Original evidence aggregate is required")
  const patchedAggregate = transformAutobizEvidenceAggregate(aggregate.bytes)
  const manifestFile = original.files.find((file) => file.path === "mods/business/manifest.json")!
  assert(manifestFile, "Original business manifest is required")
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"))
  assert.deepEqual(
    { id: manifest.kernel?.id, version: manifest.kernel?.version },
    { id: "autobiz.python-kernel", version: "1.0.0" }
  )
  assert(manifest.kernel.resources.includes("hooks/plan_writer.py"))
  manifest.kernel.version = "1.0.1"
  const pluginFile = original.files.find((file) => file.path === "plugin.json")!
  const plugin = JSON.parse(pluginFile.bytes.toString("utf8"))
  plugin.name = "autobiz-plan-merge-compatible"
  plugin.version = "1.0.1"
  plugin.description += "；Plan 合并凭据投影兼容修订 1.0.1"
  const runtimeFile = original.files.find((file) => file.path === "devclaw.project-runtime.json")!
  const runtime = JSON.parse(runtimeFile.bytes.toString("utf8"))
  const runtimeDeclaration =
    runtime.apiVersion === "devclaw.project-runtime/v2" ? runtime.runtime : runtime
  runtimeDeclaration.plugin = { id: plugin.name, version: plugin.version }
  const modified = new Map([
    ["hooks/plan_writer.py", patched],
    ["hooks/parallel_evidence_aggregate.py", patchedAggregate],
    ["mods/business/manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
    ["plugin.json", Buffer.from(JSON.stringify(plugin, null, 2) + "\n")],
    ["devclaw.project-runtime.json", Buffer.from(JSON.stringify(runtime, null, 2) + "\n")]
  ])
  await mkdir(output) // No overwrite, including a previous failed/prepared output.
  await writeDerivationFiles(
    output,
    original.files.map((file) =>
      modified.has(file.path)
        ? { ...file, bytes: modified.get(file.path)!, digest: digest(modified.get(file.path)!) }
        : file
    )
  )
  const created = await snapshotDerivationSource(output)
  for (const file of original.files)
    assert.equal(
      created.files.find((item) => item.path === file.path)?.digest,
      modified.has(file.path) ? digest(modified.get(file.path)!) : file.digest
    )
  assert.equal(
    (await snapshotDerivationSource(upstream)).digest,
    original.digest,
    "Upstream source changed while preparing the compatibility source"
  )
  const receipt = {
    apiVersion: "devclaw.autobiz-plan-merge-compatibility/v1",
    source: resolve(upstream),
    output: resolve(output),
    originalDigest: original.digest,
    outputDigest: created.digest,
    fromSha256: plan.digest,
    toSha256: digest(patched),
    aggregateFromSha256: aggregate.digest,
    aggregateToSha256: digest(patchedAggregate),
    kernelVersion: "1.0.1",
    plugin: { name: plugin.name, version: plugin.version },
    changedFiles: [...modified.keys()],
    originalSourceUnchanged: true,
    noOverwrite: true
  }
  await writeFile(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-plan-merge-source.ts")
) {
  assert(process.argv[2], "Explicit new source output directory is required")
  void prepareAutobizPlanMergeSource(
    resolve(process.argv[2]),
    resolve(process.argv[3] ?? "C:/ai/autobiz_kanban")
  )
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

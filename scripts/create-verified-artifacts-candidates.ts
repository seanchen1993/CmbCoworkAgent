/** New opt-in candidates only. Does not update a frozen delivery, install or grant anything. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { snapshotDerivationSource, writeDerivationFiles } from "../src/main/plugins/derivation-source"
import { businessModCatalog } from "../src/main/plugins/business-mod-manifest"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { assertPackageExtensionCompatibility } from "../src/main/plugins/extension-contract"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { assertHostPackageSupported } from "../src/main/harness-board/project-runtime/package-preflight"
import { parseProjectRuntimeManifest } from "../src/shared/project-runtime"
import { BUSINESS_MOD_MANIFEST } from "../src/shared/business-mods"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"
import type { PluginMetadata } from "../src/main/types"

async function main() {
  const input = process.argv[2]
  if (!input) throw Error("Specify the frozen source ZIP explicitly")
  const output = resolve(process.argv[3] ?? "output/deliveries/mods-verified-artifacts-20261017")
  await mkdir(output, { recursive: true })
  const staging = await mkdtemp(join(output, "candidate-"))
  const sourceRoot = join(staging, "frozen-source")
  const sourceZip = new AdmZip(await readFile(resolve(input)))
  sourceZip.extractAllTo(sourceRoot, false)
  const snapshot = await snapshotDerivationSource(sourceRoot)
  const catalog = businessModCatalog(snapshot)
  const kernelSource = process.env.VERIFIED_ARTIFACTS_KERNEL_SOURCE
  if (kernelSource && process.argv[4]) throw Error("A new kernel source cannot reuse old producer bytes")
  const sources = [{ snapshot, catalog,
    modIds: [...catalog.modules.map(mod => mod.id), ...(catalog.extensions ?? []).map(mod => mod.id)] }]
  const adaptation: unknown[] = []
  if (kernelSource) {
    const kernel = await snapshotDerivationSource(resolve(kernelSource))
    const kernelCatalog = businessModCatalog(kernel)
    if (!kernelCatalog.kernel) throw Error("Explicit kernel catalog required")
    const original = snapshot.files.find(file => file.path === BUSINESS_MOD_MANIFEST)!
    const manifest = JSON.parse(original.bytes.toString("utf8"))
    delete manifest.kernel
    manifest.kernelRef = { id: kernelCatalog.kernel.id, version: kernelCatalog.kernel.version }
    manifest.modules = manifest.modules.filter((mod: { id: string }) => mod.id.startsWith("warehouse."))
    if (manifest.modules.length !== 3) throw Error("Expected the explicit original three warehouse modules")
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
    const files = snapshot.files.map(file => file.path === BUSINESS_MOD_MANIFEST
      ? { ...file, bytes, digest: createHash("sha256").update(bytes).digest("hex") } : file)
    const adaptedRoot = join(staging, "explicit-warehouse-adaptation")
    await writeDerivationFiles(adaptedRoot, files)
    const adapted = await snapshotDerivationSource(adaptedRoot)
    if (adapted.files.length !== snapshot.files.length || adapted.files.some(file =>
      file.path !== BUSINESS_MOD_MANIFEST && !snapshot.files.find(prior => prior.path === file.path)?.bytes.equals(file.bytes)))
      throw Error("Adaptation changed implementation bytes")
    const adaptedCatalog = businessModCatalog(adapted)
    sources.splice(0, sources.length,
      { snapshot: kernel, catalog: kernelCatalog, modIds: ["biz.prd", "dev.specs"] },
      { snapshot: adapted, catalog: adaptedCatalog,
        modIds: [...adaptedCatalog.modules.map(mod => mod.id), ...(adaptedCatalog.extensions ?? []).map(mod => mod.id)] })
    adaptation.push({ source: resolve(kernelSource), sourceDigest: kernel.digest,
      kernel: manifest.kernelRef, adaptedDigest: adapted.digest,
      changedFile: BUSINESS_MOD_MANIFEST, implementationsUnchanged: true })
  }
  const version = kernelSource ? "1.0.1" : "1.0.0"
  const assembled = assembleBusinessMods(sources, {
    name: "autobiz-warehouse-verified-export", version, sources: [],
    verifiedArtifactIds: ["warehouse_sql_results", "warehouse_quality"]
  })
  if (assembled.missingProviders.length || assembled.requiresFixedWorkflowAcknowledgement)
    throw Error("Candidate has unresolved original dependency/routing diagnostics")
  const producerRoot = join(staging, "producer")
  await writeDerivationFiles(producerRoot, assembled.files)
  assertPackageExtensionCompatibility(producerRoot)
  const native = await readNativeCapabilityCatalog({ id: "new-verified-export-candidate",
    name: "autobiz-warehouse-verified-export", version, path: producerRoot, enabled: true } as PluginMetadata, "project")
  if (native.status !== "declared" || native.legacyAdapter !== "autobiz-v1" ||
    !native.capabilities.some(capability => capability.id === "project-flow" && capability.runtimeMode === "legacy"))
    throw Error("Candidate failed original native capability admission: " + JSON.stringify(native))
  const consumer = await snapshotDerivationSource(resolve("examples/verified-artifact-consumer"))
  assertPackageExtensionCompatibility(consumer.root)
  assertHostPackageSupported(consumer.root, parseProjectRuntimeManifest(JSON.parse(
    (await readFile(join(consumer.root, "devclaw.project-runtime.json"))).toString("utf8")
  )))
  await compileFunctionPlugin(consumer.root)
  const reports: unknown[] = []
  for (const [name, files] of [
    ["12-数仓可验证产物导出版.zip", assembled.files],
    ["13-通用JSON产物消费Mod.zip", consumer.files]
  ] as const) {
    const zip = new AdmZip()
    for (const file of files) zip.addFile(file.path, file.bytes)
    let bytes = zip.toBuffer()
    if (name.startsWith("12-") && process.argv[4]) {
      const preserved = await readFile(resolve(process.argv[4]))
      const prior = new AdmZip(preserved)
      if (prior.getEntries().filter(entry => !entry.isDirectory).length !== files.length ||
        files.some(file => !prior.readFile(file.path)?.equals(file.bytes)))
        throw Error("Preserved producer does not match the exact newly checked source files")
      bytes = preserved
    }
    if (name.startsWith("13-") && process.env.VERIFIED_ARTIFACTS_CONSUMER_ARCHIVE) {
      const preserved = await readFile(resolve(process.env.VERIFIED_ARTIFACTS_CONSUMER_ARCHIVE))
      const prior = new AdmZip(preserved)
      if (prior.getEntries().filter(entry => !entry.isDirectory).length !== files.length ||
        files.some(file => !prior.readFile(file.path)?.equals(file.bytes)))
        throw Error("Preserved consumer does not match the exact current checked example")
      bytes = preserved
    }
    const path = join(output, name)
    await writeFile(path, bytes, { flag: "wx" })
    reports.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") })
  }
  await writeFile(join(staging, "evidence.json"), JSON.stringify({
    source: resolve(input), sourceDigest: snapshot.digest, reports, adaptation, native,
    selection: ["warehouse_sql_results", "warehouse_quality"],
    scope: "New opt-in producer and independent consumer; static admission/compilation only, no execution or grants."
  }, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ staging, reports }, null, 2))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

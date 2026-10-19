import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import { prepareAutobizKnowledgeMod } from "./prepare-autobiz-knowledge-mod"
import {
  AUTOBIZ_UTEST_LITERAL_PATH,
  AUTOBIZ_UTEST_LITERAL_TO_SHA256,
  AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
} from "./prepare-autobiz-utest-literal-source"
import {
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"
import { businessModCatalog } from "../src/main/plugins/business-mod-manifest"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { isReviewedAutobizProtocol } from "../src/main/plugins/autobiz-composition-protocol"
import { assertPackageExtensionCompatibility } from "../src/main/plugins/extension-contract"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { assertHostPackageSupported } from "../src/main/harness-board/project-runtime/package-preflight"
import { parseProjectRuntimeManifest } from "../src/shared/project-runtime"

export const AUTOBIZ_UTEST_LIBRARY_SOURCE_DIGEST =
  "0ea5df9b0829c854834e85ec886fa0c7d52e19b3fd5f2e086aa2fcb1e33d9f54"
export const AUTOBIZ_UTEST_LIBRARY_OBSERVER_DIGEST =
  "5810c3eaec45761cd63f8eb727789b088eb7eb7450e28c7fd42f6d0acbcd00d8"
export const AUTOBIZ_UTEST_LIBRARY_PRODUCER_SHA256 =
  "1bbaec667cb7fd853bc44fbc6290971d95b47ae25d6445ecedfdafede2532d4b"
export const AUTOBIZ_UTEST_LIBRARY_CONSUMER_SHA256 =
  "237216083bfccb76df6fda1d20848747653ce26890ae31f7739383945b947610"
export const AUTOBIZ_UTEST_LIBRARY_DEFAULTS = {
  source: resolve("output/deliveries/mods-creator-utest-literal-20261018-v104/Mods来源/AutoBiz"),
  observer: resolve(
    "output/deliveries/mods-creator-spec-role-20261017-v103/Mods来源/Worktree进度Mod"
  ),
  warehouseArchive: resolve(
    "output/deliveries/mods-verified-artifacts-20261017-v5/12-数仓可验证产物导出版.zip"
  ),
  consumerArchive: resolve(
    "output/deliveries/mods-verified-artifacts-20261017-v4-cc/13-通用JSON产物消费Mod.zip"
  )
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")

/** Material only: original assembler, exact admission, no installation or running business. */
export async function packageAutobizUtestLiteralLibrary(
  output: string,
  input: typeof AUTOBIZ_UTEST_LIBRARY_DEFAULTS = AUTOBIZ_UTEST_LIBRARY_DEFAULTS
) {
  for (const source of [
    input.source,
    input.observer,
    dirname(input.warehouseArchive),
    dirname(input.consumerArchive)
  ]) {
    const inside = relative(resolve(source), resolve(output))
    assert(
      inside && (inside.split(/[\\/]/)[0] === ".." || isAbsolute(inside)),
      "Fresh library must be outside immutable inputs"
    )
  }
  try {
    await lstat(output)
    throw Error("AUTOBIZ_LIBRARY_OUTPUT_EXISTS")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const kernel = await snapshotDerivationSource(input.source)
  assert.equal(
    kernel.digest,
    AUTOBIZ_UTEST_LIBRARY_SOURCE_DIGEST,
    "Exact reviewed 1.0.4 source required"
  )
  assert.equal(
    kernel.files.find((file) => file.path === AUTOBIZ_UTEST_LITERAL_PATH)?.digest,
    AUTOBIZ_UTEST_LITERAL_TO_SHA256
  )
  assert.equal(
    kernel.files.find((file) => file.path === "workflows/code-batched-execution.workflow.js")
      ?.digest,
    AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
  )
  const warehouseBytes = await readFile(input.warehouseArchive),
    consumerBytes = await readFile(input.consumerArchive)
  assert.equal(
    sha(warehouseBytes),
    AUTOBIZ_UTEST_LIBRARY_PRODUCER_SHA256,
    "Exact original verified producer required"
  )
  assert.equal(
    sha(consumerBytes),
    AUTOBIZ_UTEST_LIBRARY_CONSUMER_SHA256,
    "Exact original generic consumer required"
  )
  const warehouseZip = new AdmZip(warehouseBytes),
    consumerZip = new AdmZip(consumerBytes)
  const oldObserver = await snapshotDerivationSource(input.observer)
  assert.equal(
    oldObserver.digest,
    AUTOBIZ_UTEST_LIBRARY_OBSERVER_DIGEST,
    "Exact original observer source required"
  )
  const observerManifest = JSON.parse(
    oldObserver.files
      .find((file) => file.path === "mods/business/manifest.json")!
      .bytes.toString("utf8")
  )
  const observerIdentity = JSON.parse(
    oldObserver.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
  )
  assert.deepEqual(observerManifest.kernelRef, { id: "autobiz.python-kernel", version: "1.0.3" })
  assert.equal(observerIdentity.version, "1.0.3")
  assert.deepEqual(
    observerManifest.extensions.map((item: { id: string }) => item.id),
    ["autobiz.worktree-progress"]
  )
  const implementationPaths = [
    observerManifest.extensions[0].entry,
    ...observerManifest.extensions[0].resources
  ]
  for (const file of oldObserver.files.filter((file) => implementationPaths.includes(file.path)))
    assert(
      warehouseZip.readFile(file.path)?.equals(file.bytes),
      "Unknown observer implementation: " + file.path
    )
  observerManifest.kernelRef.version = "1.0.4"
  observerIdentity.version = "1.0.4"
  await mkdir(output)
  const sourcesRoot = join(output, "Mods来源")
  await mkdir(sourcesRoot)
  const sourceDirectory = join(sourcesRoot, "AutoBiz")
  await mkdir(sourceDirectory)
  await writeDerivationFiles(sourceDirectory, kernel.files)
  const observerDirectory = join(sourcesRoot, "Worktree进度Mod")
  await mkdir(observerDirectory)
  const observerChanges = new Map([
    ["plugin.json", json(observerIdentity)],
    ["mods/business/manifest.json", json(observerManifest)]
  ])
  await writeDerivationFiles(
    observerDirectory,
    oldObserver.files.map((file) =>
      observerChanges.has(file.path)
        ? {
            ...file,
            bytes: observerChanges.get(file.path)!,
            digest: sha(observerChanges.get(file.path)!)
          }
        : file
    )
  )
  const knowledgeDirectory = join(sourcesRoot, "知识与上下文Mod")
  await prepareAutobizKnowledgeMod(knowledgeDirectory, "1.0.4")
  const selection = async (directory: string) => {
    const snapshot = await snapshotDerivationSource(directory),
      catalog = businessModCatalog(snapshot)
    return {
      snapshot,
      catalog,
      modIds: [
        ...catalog.modules.map((mod) => mod.id),
        ...(catalog.extensions ?? []).map((mod) => mod.id)
      ]
    }
  }
  const base = await selection(sourceDirectory),
    observer = await selection(observerDirectory),
    knowledge = await selection(knowledgeDirectory)
  const full = assembleBusinessMods([base, observer, knowledge], {
    name: "autobiz-complete-utest-literal",
    version: "1.0.4",
    sources: []
  })
  // Original three warehouse definitions/resources are retained; only their kernel lock changes.
  const warehouseRoot = join(output, "warehouse-original")
  warehouseZip.extractAllTo(warehouseRoot, false)
  const originalWarehouse = await snapshotDerivationSource(warehouseRoot)
  const manifest = JSON.parse(
    originalWarehouse.files
      .find((file) => file.path === "mods/business/manifest.json")!
      .bytes.toString("utf8")
  )
  delete manifest.kernel
  manifest.kernelRef = { id: "autobiz.python-kernel", version: "1.0.4" }
  manifest.modules = manifest.modules.filter((mod: { id: string }) =>
    mod.id.startsWith("warehouse.")
  )
  assert.equal(manifest.modules.length, 3)
  delete manifest.extensions
  const adaptedRoot = join(sourcesRoot, "数仓Mods")
  await mkdir(adaptedRoot)
  const adaptedManifest = json(manifest)
  await writeDerivationFiles(
    adaptedRoot,
    originalWarehouse.files.map((file) =>
      file.path === "mods/business/manifest.json"
        ? { ...file, bytes: adaptedManifest, digest: sha(adaptedManifest) }
        : file
    )
  )
  const adapted = await selection(adaptedRoot)
  const producer = assembleBusinessMods(
    [{ ...base, modIds: ["biz.prd", "dev.specs"] }, adapted, observer, knowledge],
    {
      name: "autobiz-warehouse-verified-export-utest-literal",
      version: "1.0.4",
      sources: [],
      verifiedArtifactIds: ["warehouse_sql_results", "warehouse_quality"]
    }
  )
  const packages: Array<{
    file: string
    name: string
    sha256: string
    files: number
    directory: string
  }> = []
  for (const [file, assembled] of [
    ["10-完整AutoBiz+并行进度+知识版-1.0.4.zip", full],
    ["12-数仓可验证产物导出版-1.0.4.zip", producer]
  ] as const) {
    assert.deepEqual(assembled.missingProviders, [])
    assert.equal(assembled.requiresFixedWorkflowAcknowledgement, false)
    assert(isReviewedAutobizProtocol(assembled), "Exact reviewed assembly admission required")
    const identity = JSON.parse(
      assembled.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
    )
    const directory = join(output, identity.name)
    await mkdir(directory)
    await writeDerivationFiles(directory, assembled.files)
    assertPackageExtensionCompatibility(directory)
    await compileFunctionPlugin(directory)
    const native = await readNativeCapabilityCatalog(
      {
        id: "library:" + identity.name,
        name: identity.name,
        version: identity.version,
        path: directory,
        enabled: true
      },
      "project"
    )
    assert(
      native.status === "declared" && native.legacyAdapter === "autobiz-v1",
      JSON.stringify(native)
    )
    const zip = new AdmZip()
    for (const row of assembled.files) zip.addFile(row.path, row.bytes)
    const bytes = zip.toBuffer(),
      checked = new AdmZip(bytes)
    assert.equal(
      checked.getEntries().filter((entry) => !entry.isDirectory).length,
      assembled.files.length
    )
    for (const row of assembled.files) assert.deepEqual(checked.readFile(row.path), row.bytes)
    await writeFile(join(output, file), bytes, { flag: "wx" })
    packages.push({
      file,
      name: identity.name,
      sha256: sha(bytes),
      files: assembled.files.length,
      directory
    })
  }
  const consumerRoot = join(output, "verified-artifact-consumer")
  consumerZip.extractAllTo(consumerRoot, false)
  const consumer = await snapshotDerivationSource(consumerRoot)
  assertPackageExtensionCompatibility(consumerRoot)
  assertHostPackageSupported(
    consumerRoot,
    parseProjectRuntimeManifest(
      JSON.parse(
        consumer.files
          .find((file) => file.path === "devclaw.project-runtime.json")!
          .bytes.toString("utf8")
      )
    )
  )
  await compileFunctionPlugin(consumerRoot)
  for (const file of consumer.files) assert.deepEqual(consumerZip.readFile(file.path), file.bytes)
  const consumerFile = "13-通用JSON产物消费Mod.zip"
  await writeFile(join(output, consumerFile), consumerBytes, { flag: "wx" })
  packages.push({
    file: consumerFile,
    name: "verified-artifact-consumer",
    sha256: sha(consumerBytes),
    files: consumer.files.length,
    directory: consumerRoot
  })
  assert.equal((await snapshotDerivationSource(input.source)).digest, kernel.digest)
  assert.equal((await snapshotDerivationSource(input.observer)).digest, oldObserver.digest)
  assert.equal(sha(await readFile(input.warehouseArchive)), sha(warehouseBytes))
  assert.equal(sha(await readFile(input.consumerArchive)), sha(consumerBytes))
  const receipt = {
    apiVersion: "devclaw.autobiz-utest-library/v1",
    kernelVersion: "1.0.4",
    output: resolve(output),
    inputs: {
      ...input,
      sourceDigest: kernel.digest,
      observerDigest: oldObserver.digest,
      warehouseSha256: sha(warehouseBytes),
      consumerSha256: sha(consumerBytes)
    },
    packages,
    workflowUnchangedSha256: AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256,
    hookSha256: AUTOBIZ_UTEST_LITERAL_TO_SHA256,
    consumerByteIdentical: true,
    immutableInputsUnchanged: true,
    verification:
      "Original assembler/exact native admission/Function compilation/ZIP byte roundtrip only; actual App execution remains pending"
  }
  await writeFile(join(output, "package-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx"
  })
  return receipt
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "package-autobiz-utest-literal-library.ts")
) {
  assert(process.argv[2], "Explicit fresh output required")
  void packageAutobizUtestLiteralLibrary(resolve(process.argv[2]))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

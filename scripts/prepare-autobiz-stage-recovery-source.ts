import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  derivationDigest,
  type DerivationFile,
  type DerivationSnapshot
} from "../src/main/plugins/derivation-source"
import { readPluginStageRecoveryAdapter } from "../src/main/mods/devtools/plugin-stage-recovery-adapter"
import { BUSINESS_MOD_MANIFEST } from "../src/shared/business-mods"
import {
  businessModCatalog,
  parseBusinessModCatalog
} from "../src/main/plugins/business-mod-manifest"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"

type CatalogRecoveryOptions = { extensionId: string; name: string; version?: string }
const file = (path: string, bytes: Buffer): DerivationFile => ({
  path,
  bytes,
  mode: process.platform === "win32" ? 0o666 : 0o644,
  digest: createHash("sha256").update(bytes).digest("hex")
})

async function prepareCatalogRecoverySource(
  original: DerivationSnapshot,
  destination: string,
  options: CatalogRecoveryOptions | undefined
) {
  assert(
    options?.extensionId && options.name,
    "Catalog sources require an explicit existing extensionId and independent output name"
  )
  const catalog = businessModCatalog(original)
  assert(catalog.kernel, "A complete kernel source is required for an explicit rebuild")
  const carrier = catalog.extensions?.find((extension) => extension.id === options.extensionId)
  assert(
    carrier,
    "Choose an existing real extension; recovery tooling does not invent an empty guest"
  )
  assert(
    !catalog.extensions?.some((extension) => extension.stageRecoveryAdapter),
    "Review the existing recovery adapter instead"
  )
  const entry = `mods/business/${carrier.id}/stage-recovery/adapter.py`
  assert(!original.files.some((item) => item.path === entry), "Recovery resource already exists")
  const declaration = {
    apiVersion: "devclaw.plugin-stage-recovery/v1" as const,
    entry,
    runtime: "python" as const,
    isolation: "private-output-copy" as const,
    codeSource: "keep" as const,
    externalEffects: "network-requires-confirmation" as const
  }
  const updated = parseBusinessModCatalog({
    ...catalog,
    extensions: catalog.extensions!.map((extension) =>
      extension.id === carrier.id
        ? {
            ...extension,
            resources: [...extension.resources, entry],
            stageRecoveryAdapter: declaration
          }
        : extension
    )
  })
  const files = original.files.filter((item) => item.path !== BUSINESS_MOD_MANIFEST)
  files.push(
    file(BUSINESS_MOD_MANIFEST, Buffer.from(JSON.stringify(updated, null, 2) + "\n")),
    file(entry, await readFile(resolve("resources/mods/autobiz-stage-recovery/adapter.py")))
  )
  files.sort((left, right) => left.path.localeCompare(right.path, "en"))
  const snapshot = {
    ...original,
    files,
    digest: derivationDigest(files, original.excluded),
    totalBytes: files.reduce((sum, item) => sum + item.bytes.length, 0)
  }
  const modIds = [...updated.modules, ...(updated.extensions ?? [])].map((mod) => mod.id)
  const result = assembleBusinessMods([{ snapshot, catalog: updated, modIds }], {
    name: options.name,
    version: options.version ?? "1.0.0",
    sources: [{ inspectionId: "explicit-author-rebuild", modIds }],
    order: updated.modules.map((mod) => mod.id),
    acceptFixedWorkflow: true
  })
  for (const item of original.files.filter((item) => /^(?:hooks|board_core)\//.test(item.path)))
    assert.equal(
      result.files.find((next) => next.path === item.path)?.digest,
      item.digest,
      `Original Hook/board bytes must survive exactly: ${item.path}`
    )
  await mkdir(destination)
  await writeDerivationFiles(destination, result.files)
  readPluginStageRecoveryAdapter(destination).assertCurrent()
  const native = await readNativeCapabilityCatalog(
    {
      id: "explicit-author-rebuild",
      path: destination,
      name: options.name,
      version: options.version ?? "1.0.0",
      enabled: true
    },
    "project"
  )
  assert.equal(native.status, "declared", native.reasons.join("; "))
  assert.equal(
    native.legacyAdapter,
    "autobiz-v1",
    "Rebuilt original runtime must pass its native reviewed adapter"
  )
  assert.equal(
    (await snapshotDerivationSource(original.root)).digest,
    original.digest,
    "Original must stay unchanged"
  )
  const receipt = {
    sourceDigest: original.digest,
    preparedDigest: result.digest,
    adapterEntry: entry,
    extensionId: carrier.id,
    assemblyLockRebuilt: true,
    nativeCapabilityStatus: native.status,
    nativeRuntimeAdapter: native.legacyAdapter,
    codeSource: "keep",
    gitRestore: false,
    installed: false,
    originalUnchanged: true
  }
  await writeFile(
    destination + ".recovery-adapter-receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" }
  )
  return receipt
}

/** Plugin-author tooling only. Creates a new explicit source; never patches an installed package,
 * upstream checkout, reviewed assembly lock, Hook, board configuration or business script.
 */
export async function prepareAutobizStageRecoverySource(
  source: string,
  destination: string,
  options?: CatalogRecoveryOptions
) {
  source = resolve(source)
  destination = resolve(destination)
  const inside = relative(source, destination)
  assert(
    inside && (isAbsolute(inside) || inside.split(/[\\/]/)[0] === ".."),
    "Fresh external destination required"
  )
  const original = await snapshotDerivationSource(source)
  if (
    original.files.some((file) => file.path === BUSINESS_MOD_MANIFEST) &&
    (options?.extensionId ||
      original.files.some((file) => file.path === "devclaw.business-assembly.json"))
  )
    return prepareCatalogRecoverySource(original, destination, options)
  assert(
    !original.files.some((file) => file.path === "devclaw.business-assembly.json"),
    "An assembled plugin requires its author to rebuild the complete assembly lock; do not append files"
  )
  assert(
    original.files.some((file) => file.path === "hooks/rollback_stage.py") &&
      original.files.some((file) => file.path === "board_core/board_config.json"),
    "Original AutoBiz rollback resources required"
  )
  assert(
    !original.files.some(
      (file) =>
        file.path === "devclaw.stage-recovery-adapter.json" ||
        file.path.startsWith("mods/stage-recovery/")
    ),
    "Source already declares recovery; review existing adapter instead"
  )
  await mkdir(destination) // Exclusive create: never overwrite a user's source or delivery.
  await writeDerivationFiles(destination, original.files)
  const assets = [
    ["adapter.py", "mods/stage-recovery/adapter.py"],
    ["devclaw.stage-recovery-adapter.json", "devclaw.stage-recovery-adapter.json"]
  ]
  for (const [asset, path] of assets) {
    const target = join(destination, path)
    await mkdir(resolve(target, ".."), { recursive: true })
    await writeFile(
      target,
      await readFile(resolve("resources/mods/autobiz-stage-recovery", asset)),
      { flag: "wx" }
    )
  }
  readPluginStageRecoveryAdapter(destination).assertCurrent()
  const prepared = await snapshotDerivationSource(destination)
  for (const file of original.files)
    assert.equal(
      prepared.files.find((row) => row.path === file.path)?.digest,
      file.digest,
      file.path
    )
  assert.equal(
    (await snapshotDerivationSource(source)).digest,
    original.digest,
    "Original must stay unchanged"
  )
  const receipt = {
    sourceDigest: original.digest,
    preparedDigest: prepared.digest,
    originalFiles: original.files.length,
    addedFiles: assets.map(([, path]) => path),
    adapterDigest: createHash("sha256")
      .update(await readFile(join(destination, assets[0][1])))
      .digest("hex"),
    codeSource: "keep",
    gitRestore: false,
    installed: false,
    originalUnchanged: true
  }
  await writeFile(
    destination + ".recovery-adapter-receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" }
  )
  return receipt
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve("scripts/prepare-autobiz-stage-recovery-source.ts")
) {
  assert(
    process.argv[2] && process.argv[3],
    "Usage: <read-only-source> <fresh-output-source> [existing-extension-id new-plugin-name version]"
  )
  void prepareAutobizStageRecoverySource(
    process.argv[2],
    process.argv[3],
    process.argv[4]
      ? {
          extensionId: process.argv[4],
          name: process.argv[5],
          version: process.argv[6]
        }
      : undefined
  )
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

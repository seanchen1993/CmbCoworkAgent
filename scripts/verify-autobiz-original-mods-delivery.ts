/** Record exact-package runtime verification separately from conversion and installation. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"
import { ORIGINAL_AUTOBIZ_ZIP_SHA256 } from "./prepare-autobiz-original-mods-delivery"
import type { PluginMetadata } from "../src/main/types"

async function main() {
  const [directoryInput, evidenceInput] = process.argv.slice(2)
  assert(
    directoryInput && evidenceInput,
    "Usage: <delivery-directory> <passed-journey-evidence.json>"
  )
  const directory = resolve(directoryInput),
    evidencePath = resolve(evidenceInput)
  const conversionPath = join(directory, "conversion-verification.json")
  const conversion = JSON.parse(await readFile(conversionPath, "utf8"))
  const evidenceBytes = await readFile(evidencePath)
  const evidence = JSON.parse(evidenceBytes.toString("utf8"))
  assert.equal(conversion.sourceZipSha256, ORIGINAL_AUTOBIZ_ZIP_SHA256)
  assert.equal(evidence.sourceZipSha256, ORIGINAL_AUTOBIZ_ZIP_SHA256)
  assert.equal(evidence.passed, true, "A partial or failed run is not runtime verification")
  assert.equal(evidence.stage, "archived")
  assert.equal(evidence.packageDigest, conversion.packageDigest)
  const source = join(directory, "complete-plugin")
  assert.equal((await snapshotDerivationSource(source)).digest, evidence.packageDigest)
  const zipSha = createHash("sha256")
    .update(await readFile(conversion.outputZip))
    .digest("hex")
  assert.equal(zipSha, conversion.outputZipSha256)
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
  const catalog = await readNativeCapabilityCatalog(
    {
      id: "exact-original-runtime-verification",
      path: source,
      name: manifest.name,
      version: manifest.version,
      enabled: true
    } as PluginMetadata,
    "project"
  )
  assert.equal(catalog.status, "declared")
  assert.equal(catalog.legacyAdapter, "autobiz-v1")
  const report = {
    passed: true,
    packageDigest: evidence.packageDigest,
    zipSha256: zipSha,
    sourceZipSha256: ORIGINAL_AUTOBIZ_ZIP_SHA256,
    evidencePath,
    evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    nativeCapabilityStatus: catalog.status,
    reviewedLegacyAdapter: catalog.legacyAdapter,
    stage: evidence.stage,
    originalHookIdsObserved: [
      ...new Set(evidence.hookResults.map((row: { id: string }) => row.id))
    ],
    actualKnowledgeSha256: evidence.knowledgeSha256,
    workflow: evidence.codeResult.workflow,
    explicitPromotion: evidence.codeResult.promotion,
    limits: evidence.limits,
    scope:
      "Seven main stages; optional detail-design route preserved and explicitly skipped by its original decision protocol. Controlled authoring/model responses; actual original Workflow engine, Python gates, Git and Maven. No remote-model quality or enterprise knowledge claim."
  }
  const reportPath = join(directory, "runtime-verification.json")
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  await writeFile(
    conversionPath,
    JSON.stringify(
      {
        ...conversion,
        businessStagesExecuted: true,
        reviewedLegacyAdapter: catalog.legacyAdapter,
        runtimeVerificationReport: reportPath
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    JSON.stringify({
      passed: true,
      reportPath,
      packageDigest: evidence.packageDigest,
      zipSha256: zipSha
    })
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

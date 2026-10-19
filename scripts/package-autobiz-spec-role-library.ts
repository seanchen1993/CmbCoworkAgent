import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { prepareAutobizSpecRoleSource } from "./prepare-autobiz-spec-role-source"
import { prepareAutobizKnowledgeMod } from "./prepare-autobiz-knowledge-mod"
import { snapshotDerivationSource, writeDerivationFiles } from "../src/main/plugins/derivation-source"
import { businessModCatalog } from "../src/main/plugins/business-mod-manifest"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { isReviewedAutobizProtocol } from "../src/main/plugins/autobiz-composition-protocol"

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** One separately named 1.0.3 library; old sources, nine-library and 10/11/12 ZIPs stay immutable. */
export async function packageAutobizSpecRoleLibrary(output: string, source: string,
  observer = resolve("output/deliveries/mods-creator-workflow-wakeup-20261017-v102-v2/Mods来源/Worktree进度Mod")) {
  await mkdir(output)
  const sourcesRoot = join(output, "Mods来源")
  await mkdir(sourcesRoot)
  const sourceDirectory = join(sourcesRoot, "AutoBiz")
  const sourceReceipt = await prepareAutobizSpecRoleSource(sourceDirectory, source)
  const knowledgeDirectory = join(sourcesRoot, "知识与上下文Mod")
  await prepareAutobizKnowledgeMod(knowledgeDirectory, "1.0.3")
  const oldObserver = await snapshotDerivationSource(observer)
  const observerDirectory = join(sourcesRoot, "Worktree进度Mod")
  const observerManifest = JSON.parse(oldObserver.files.find(file =>
    file.path === "mods/business/manifest.json")!.bytes.toString("utf8"))
  assert.deepEqual(observerManifest.kernelRef, { id: "autobiz.python-kernel", version: "1.0.2" })
  observerManifest.kernelRef.version = "1.0.3"
  const observerIdentity = JSON.parse(oldObserver.files.find(file => file.path === "plugin.json")!.bytes.toString("utf8"))
  observerIdentity.version = "1.0.3"
  const observerChanges = new Map([
    ["mods/business/manifest.json", Buffer.from(JSON.stringify(observerManifest, null, 2) + "\n")],
    ["plugin.json", Buffer.from(JSON.stringify(observerIdentity, null, 2) + "\n")]
  ])
  await mkdir(observerDirectory)
  await writeDerivationFiles(observerDirectory, oldObserver.files.map(file => observerChanges.has(file.path)
    ? { ...file, bytes: observerChanges.get(file.path)!, digest: digest(observerChanges.get(file.path)!) } : file))
  const sources = await Promise.all([sourceDirectory, observerDirectory, knowledgeDirectory]
    .map(async directory => {
      const snapshot = await snapshotDerivationSource(directory)
      const catalog = businessModCatalog(snapshot)
      return { snapshot, catalog, modIds: [...catalog.modules.map(mod => mod.id),
        ...(catalog.extensions ?? []).map(mod => mod.id)] }
    }))
  const assembled = assembleBusinessMods(sources, {
    name: "autobiz-complete-spec-role", version: "1.0.3", sources: []
  })
  assert.deepEqual(assembled.missingProviders, [])
  assert.equal(assembled.requiresFixedWorkflowAcknowledgement, false)
  assert(isReviewedAutobizProtocol(assembled), "New package must pass exact native reviewed admission")
  const directory = join(output, "autobiz-complete-spec-role")
  await mkdir(directory)
  await writeDerivationFiles(directory, assembled.files)
  const zip = new AdmZip()
  for (const file of assembled.files) zip.addFile(file.path, file.bytes)
  const bytes = zip.toBuffer()
  for (const file of assembled.files) assert.deepEqual(new AdmZip(bytes).readFile(file.path), file.bytes)
  const archive = join(output, "10-完整AutoBiz+并行进度+知识版-1.0.3.zip")
  await writeFile(archive, bytes, { flag: "wx" })
  const receipt = { sourceReceipt, directory, archive, sha256: digest(bytes),
    kernelVersion: "1.0.3", files: assembled.files.length, digest: assembled.digest,
    reviewedAdmission: true, originalLibrariesUnchanged: true,
    verification: "Packaging/admission only. Actual App completion requires the new full journey evidence." }
  await writeFile(join(output, "package-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === join(__dirname, "package-autobiz-spec-role-library.ts")) {
  assert(process.argv[2] && process.argv[3], "Explicit fresh output and reviewed 1.0.2 source required")
  void packageAutobizSpecRoleLibrary(resolve(process.argv[2]), resolve(process.argv[3]))
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}

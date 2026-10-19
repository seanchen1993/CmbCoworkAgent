/** Rebuild an explicitly selected installed catalog without modifying its source or projects. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { BusinessModAssemblyService } from "../src/main/plugins/business-mod-assembly-service"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import { isReviewedAutobizBusinessAssembly } from "../src/main/plugins/autobiz-business-assembly-protocol"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"

async function main() {
  const [sourceInput, outputInput, name, version] = process.argv.slice(2)
  assert(
    sourceInput && outputInput && name && version,
    "Usage: <source-catalog-directory> <new-output-directory> <new-name> <version>"
  )
  const source = resolve(sourceInput),
    output = resolve(outputInput)
  assert(relative(source, output).startsWith(".."), "Output must be outside the source package")
  await mkdir(output)
  const before = await snapshotDerivationSource(source)
  const service = new BusinessModAssemblyService(join(output, ".assembly-work"), {
    plugins: () => [],
    validatePackage: async (directory) => {
      const snapshot = await snapshotDerivationSource(directory)
      assert(isReviewedAutobizBusinessAssembly(snapshot), "Reviewed kernel admission must pass")
      if (snapshot.files.some((file) => file.path === "mods/manifest.json"))
        await compileFunctionPlugin(directory)
    },
    install: async () => {
      throw Error("Reassembly exports only; it never changes installed plugins")
    },
    invalidate: () => {}
  })
  const owner = "explicit-reassembly",
    guard = () => {}
  const inspection = await service.inspect(source, owner, guard)
  const preview = await service.preview(
    owner,
    {
      name,
      version,
      sources: [{ inspectionId: inspection.id, modIds: inspection.mods.map((mod) => mod.id) }],
      order: inspection.mods.filter((mod) => mod.kind !== "function").map((mod) => mod.id)
    },
    guard
  )
  assert(preview.valid)
  const copy = await service.create(owner, preview.previewId, randomUUID(), guard)
  await service.check(owner, copy.copyId, copy.digest, guard)
  const result = await service.export(
    owner,
    copy.copyId,
    copy.digest,
    join(output, `${name}.zip`),
    guard
  )
  assert.equal(
    (await snapshotDerivationSource(source)).digest,
    before.digest,
    "Source must stay unchanged"
  )
  await writeFile(
    join(output, "reassembly.json"),
    JSON.stringify(
      {
        sourceDigest: before.digest,
        result,
        steps: preview.steps,
        extensions: preview.extensions,
        installed: false,
        sourceUnchanged: true
      },
      null,
      2
    ),
    { flag: "wx" }
  )
  console.log(JSON.stringify(result))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

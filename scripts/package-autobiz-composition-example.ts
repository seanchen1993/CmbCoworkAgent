import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import { AUTOBIZ_KANBAN_COMMIT, withPinnedAutobiz } from "../src/main/mods/v2/autobiz-source"
import {
  renameDerivation,
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"
import { prepareFlowCompositionFiles } from "../src/main/plugins/derivation-flow-composition"
import { isReviewedAutobizProtocol } from "../src/main/plugins/autobiz-composition-protocol"

const root = resolve(__dirname, "..")
const deliveryRoot = join(root, "output/deliveries")
const destination = resolve(
  root,
  process.argv[2] || "output/deliveries/autobiz-project-composition-context-20261016"
)
const child = relative(deliveryRoot, destination)
assert(child && !isAbsolute(child) && !child.startsWith(".."), "Use a new output/deliveries folder")
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

async function archive(directory: string) {
  const snapshot = await snapshotDerivationSource(directory)
  assert.equal(snapshot.excluded.length, 0, "Delivery folder contains excluded files")
  const zip = new AdmZip()
  for (const file of snapshot.files) zip.addFile(file.path, file.bytes)
  const bytes = zip.toBuffer()
  const check = new AdmZip(bytes)
  assert.equal(
    check.getEntries().filter((entry) => !entry.isDirectory).length,
    snapshot.files.length
  )
  for (const file of snapshot.files) assert.deepEqual(check.readFile(file.path), file.bytes)
  const path = join(destination, `${snapshot.name}.zip`)
  await writeFile(path, bytes, { flag: "wx" })
  return {
    plugin: snapshot.name,
    zip: relative(destination, path),
    sha256: sha256(bytes),
    files: snapshot.files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))
  }
}

async function main() {
  await mkdir(dirname(destination), { recursive: true })
  // Never overwrite a previously delivered package or an existing user directory.
  await mkdir(destination)
  const packages: Awaited<ReturnType<typeof archive>>[] = []
  let changes: Array<{ path: string; change: string; originalSha256?: string }> = []
  await withPinnedAutobiz(undefined, async (source) => {
    const original = await snapshotDerivationSource(source)
    assert(isReviewedAutobizProtocol(original), "The pinned AutoBiz protocol must remain reviewed")
    const target = join(destination, "autobiz-project-composition-demo")
    const files = renameDerivation(original, "autobiz-project-composition-demo").map((file) => {
      // Explicitly local example: do not auto-configure the original enterprise MCP endpoints.
      if (file.path !== ".mcp.json") return file
      const bytes = Buffer.from(json({ mcpServers: {} }))
      return { ...file, bytes, digest: sha256(bytes) }
    })
    await writeDerivationFiles(target, files)
    const proposal = prepareFlowCompositionFiles(await snapshotDerivationSource(target))
    for (const file of proposal.files) {
      let after = file.after
      if (file.path === "devclaw.capabilities.json") {
        const declaration = JSON.parse(after)
        declaration.capabilities[0].title = "AutoBiz 示例完整流程"
        after = json(declaration)
      }
      await writeFile(join(target, file.path), after, { flag: "wx" })
    }
    const packaged = await snapshotDerivationSource(target)
    assert(isReviewedAutobizProtocol(packaged))
    const allowed = new Set([...original.manifests, ".mcp.json"])
    changes = original.files.flatMap((file) => {
      const actual = packaged.files.find((item) => item.path === file.path)
      assert(actual, `Original file missing: ${file.path}`)
      if (file.bytes.equals(actual.bytes)) return []
      assert(allowed.has(file.path), `Original behavior changed: ${file.path}`)
      return [
        {
          path: file.path,
          change:
            file.path === ".mcp.json"
              ? "disable enterprise MCP for this local example"
              : "independent plugin name",
          originalSha256: sha256(file.bytes)
        }
      ]
    })
    for (const file of proposal.files)
      changes.push({ path: file.path, change: "add composition declaration" })
    assert.equal(packaged.files.length, original.files.length + 4)
    packages.push(await archive(target))
  })
  const docsSource = await snapshotDerivationSource(join(root, "examples/project-docs-lite"))
  const docsTarget = join(destination, "project-docs-composition-demo")
  await writeDerivationFiles(
    docsTarget,
    renameDerivation(docsSource, "project-docs-composition-demo")
  )
  packages.push(await archive(docsTarget))
  await writeFile(
    join(destination, "使用说明.md"),
    await readFile(join(root, "docs/sparks/autobiz-composition-example.md")),
    { flag: "wx" }
  )
  await writeFile(
    join(destination, "package-manifest.json"),
    json({
      schemaVersion: 1,
      handoffProtocol: "devclaw.autobiz-context/v1",
      handoffScope: "Original checked documents/reports plus host-observed declared src baseline-to-final bytes; excludes per-file/source-code acceptance",
      sourceCommit: AUTOBIZ_KANBAN_COMMIT,
      applicationRequirement: "Use the application build verified in acceptance.json",
      packageSources: {
        "autobiz-project-composition-demo": { commit: AUTOBIZ_KANBAN_COMMIT },
        "project-docs-composition-demo": {
          directory: "examples/project-docs-lite",
          renamedFiles: ["plugin.json", "devclaw.project-runtime.json"]
        }
      },
      changes,
      packages,
      verification: "See acceptance.json after the unchanged delivered ZIPs pass installed-app E2E"
    }),
    { flag: "wx" }
  )
  console.log(
    json({
      destination,
      sourceCommit: AUTOBIZ_KANBAN_COMMIT,
      packages: packages.map(({ files, ...item }) => ({ ...item, fileCount: files.length }))
    })
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { businessModCatalog } from "../src/main/plugins/business-mod-manifest"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  type DerivationFile
} from "../src/main/plugins/derivation-source"
import { readNativeCapabilityCatalog } from "../src/main/plugins/capability-catalog"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const row = (path: string, bytes: Buffer): DerivationFile => ({
  path,
  bytes,
  digest: sha(bytes),
  mode: process.platform === "win32" ? 0o666 : 0o644
})

/** Add an executable business extension without changing the reviewed kernel or old delivery. */
export async function prepareAutobizFunctionStatePlugin(input: {
  source: string
  output: string
  name: string
  version: string
}) {
  const original = await snapshotDerivationSource(resolve(input.source))
  const catalog = structuredClone(businessModCatalog(original))
  assert.equal(catalog.kernel?.id, "autobiz.original-234-kernel")
  assert.equal(catalog.kernel?.version, "1.0.3")
  const output = resolve(input.output)
  await mkdir(output)
  const namespace = "mods/business/autobiz.state-machine/"
  const additions = await Promise.all(
    [
      "register.ts",
      "graph.ts",
      "adapter.py",
      "commit.py",
      "journal.py",
      "hook_checks.py",
      "stage_checks.py",
      "SKILL.md"
    ].map(async (name) => {
      const bytes = await readFile(resolve("resources/mods/autobiz-state-machine", name))
      return row(namespace + (name === "SKILL.md" ? "skills/state-control/SKILL.md" : name), bytes)
    })
  )
  catalog.extensions ??= []
  catalog.extensions.push({
    id: "autobiz.state-machine",
    title: "AutoBiz 可执行状态规则与显式推进",
    kind: "function",
    usage: "project",
    entry: namespace + "register.ts",
    resources: additions
      .filter((file) => !file.path.endsWith("register.ts") && !file.path.endsWith("SKILL.md"))
      .map((file) => file.path),
    skills: [namespace + "skills/state-control/SKILL.md"],
    dependencies: { required: [], advisory: [] }
  })
  const catalogFile = original.files.find((file) => file.path === "mods/business/manifest.json")
  assert(catalogFile, "Native business source catalog required")
  const sourceFiles = original.files.map((file) =>
    file.path === catalogFile.path
      ? row(file.path, Buffer.from(JSON.stringify(catalog, null, 2) + "\n"))
      : file
  )
  const source = join(output, "Mods-source")
  await writeDerivationFiles(source, [...sourceFiles, ...additions])
  const snapshot = await snapshotDerivationSource(source)
  const selected = businessModCatalog(snapshot)
  const ids = [...selected.modules, ...(selected.extensions ?? [])].map((mod) => mod.id)
  const assembly = assembleBusinessMods([{ snapshot, catalog: selected, modIds: ids }], {
    name: input.name,
    version: input.version,
    sources: [{ inspectionId: "explicit-function-state-extension", modIds: ids }],
    acceptFixedWorkflow: true
  })
  const assembled = join(output, "complete-plugin")
  await writeDerivationFiles(assembled, assembly.files)
  const native = await readNativeCapabilityCatalog(
    {
      id: "function-state-author-verification",
      path: assembled,
      name: input.name,
      version: input.version,
      enabled: true
    },
    "project"
  )
  assert.equal(native.status, "declared", native.reasons.join("; "))
  const compiled = await compileFunctionPlugin(assembled)
  assert(compiled.code)
  const changedKernelFiles = original.files.filter(
    (file) =>
      selected.kernel?.resources.includes(file.path) &&
      file.path !== "board_core/board_config.json" &&
      assembly.files.find((current) => current.path === file.path)?.digest !== file.digest
  )
  assert.deepEqual(changedKernelFiles, [])
  const previousAssembly = await snapshotDerivationSource(
    resolve(input.source, "../complete-plugin")
  )
  for (const file of previousAssembly.files.filter((file) =>
    /^(hooks|skills|board_core)\//.test(file.path)
  ))
    assert.equal(
      assembly.files.find((current) => current.path === file.path)?.digest,
      file.digest,
      file.path
    )
  const zip = new AdmZip()
  for (const file of assembly.files) zip.addFile(file.path, file.bytes)
  const outputZip = join(output, input.name + ".zip")
  await writeFile(outputZip, zip.toBuffer(), { flag: "wx" })
  const report = {
    plugin: { name: input.name, version: input.version },
    source,
    assembled,
    outputZip,
    sourceDigest: original.digest,
    packageDigest: (await snapshotDerivationSource(assembled)).digest,
    outputZipSha256: sha(await readFile(outputZip)),
    kernel: selected.kernel && { id: selected.kernel.id, version: selected.kernel.version },
    nativeCapabilityStatus: native.status,
    originalHooksSkillsBoardBytesPreserved: true,
    extensions: selected.extensions?.map((mod) => mod.id),
    executionVerified: false,
    boundary:
      "Explicit Function Mod actions; legacy Skills and CLI remain compatible. No host authority or arbitrary graph insertion."
  }
  await writeFile(
    join(output, "function-state-conversion.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" }
  )
  assert.equal((await snapshotDerivationSource(resolve(input.source))).digest, original.digest)
  return report
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-function-state-plugin.ts")
) {
  void prepareAutobizFunctionStatePlugin({
    source: process.argv[2],
    output: process.argv[3],
    name: process.argv[4] ?? "autobiz-function-state-mods-20261021",
    version: process.argv[5] ?? "1.0.4"
  })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

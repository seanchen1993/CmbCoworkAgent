import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import { checkFunctionPlugin } from "../src/main/mods/devtools/check"

const root = resolve(__dirname, "..")
const base = join(root, "output/deliveries")
const destination = resolve(
  root,
  process.argv[2] || "output/deliveries/platform-leadership-demo-20261016"
)
const below = relative(base, destination)
assert(below && !isAbsolute(below) && !below.startsWith(".."), "Use a new delivery directory")
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function files(directory: string, prefix = ""): Promise<string[]> {
  const stat = await lstat(directory)
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Source must be a real directory")
  const names: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Do not package symbolic links")
    if (entry.isDirectory())
      names.push(...(await files(join(directory, entry.name), prefix + entry.name + "/")))
    else {
      assert(entry.isFile(), "Do not package special files")
      names.push(prefix + entry.name)
    }
  }
  return names.sort()
}

async function main() {
  await mkdir(base, { recursive: true })
  await mkdir(destination) // A rerun must choose a new directory; never reset a user's workspace.
  for (const name of ["plugins", "sources", "workspace", "evidence"])
    await mkdir(join(destination, name))
  const packages: unknown[] = []
  for (const [name, source] of [
    ["task-provider", "examples/sparks-task-workbench/provider"],
    ["task-workbench", "examples/sparks-task-workbench/consumer"],
    ["behavior-prefix", "examples/sparks-task-workbench/behavior-prefix"],
    ["behavior-compact", "examples/sparks-task-workbench/behavior-compact"],
    ["edit-reminder", "examples/sparks-edit-reminder"]
  ]) {
    const directory = join(root, source)
    const snapshot = join(destination, "sources", name)
    const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
    for (const path of await files(directory)) {
      const bytes = await readFile(join(directory, path))
      const copy = join(snapshot, path)
      await mkdir(resolve(copy, ".."), { recursive: true })
      await writeFile(copy, bytes)
      inventory.push({ path, bytes: bytes.length, sha256: hash(bytes) })
    }
    // Inspect the exact frozen copy that will be archived, never the editable live source.
    const report = await checkFunctionPlugin(snapshot)
    assert(report.valid, JSON.stringify(report.diagnostics))
    assert(report.compatibility.strictCompatible, JSON.stringify(report.compatibility))
    assert(
      !report.sdkCompatibility.diagnostics.some(
        (entry) => entry.code === "MODS_SDK_UNSUPPORTED" || entry.code === "MODS_SDK_PROTOCOL"
      ),
      JSON.stringify(report.sdkCompatibility.diagnostics)
    )
    const zip = new AdmZip()
    for (const entry of inventory) {
      const bytes = await readFile(join(snapshot, entry.path))
      assert.equal(hash(bytes), entry.sha256)
      zip.addFile(entry.path, bytes)
    }
    const zipPath = join(destination, "plugins", `${name}.zip`)
    const bytes = zip.toBuffer()
    await writeFile(zipPath, bytes)
    const reopened = new AdmZip(await readFile(zipPath))
    assert.deepEqual(
      reopened
        .getEntries()
        .map((entry) => entry.entryName)
        .sort(),
      inventory.map((entry) => entry.path)
    )
    for (const entry of inventory) {
      assert.equal(hash(reopened.readFile(entry.path)!), entry.sha256)
      assert.equal(hash(await readFile(join(snapshot, entry.path))), entry.sha256)
    }
    packages.push({
      name,
      source,
      zip: `plugins/${name}.zip`,
      sha256: hash(bytes),
      pluginName: report.name,
      compiledDigest: report.digest,
      registrationCheck: "passed-no-business-action-executed",
      sdkInspection: report.sdkCompatibility,
      files: inventory
    })
  }
  // Inputs only. The example's node process reads these actual files when the user starts it.
  for (let index = 0; index < 16; index++)
    await writeFile(
      join(destination, "workspace", `input-${String(index).padStart(2, "0")}.txt`),
      `订单日报演示输入 ${index + 1}。此文件是输入，不是任务执行结果。\n`
    )
  assert.equal((await readdir(join(destination, "workspace"))).length, 16)
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceBranch: "codex/mods-v2",
        packages,
        workspace: { inputFiles: 16, generatedBusinessResults: false },
        validation: "Package registration and SDK checks; real execution requires app approval"
      },
      null,
      2
    ) + "\n"
  )
  await writeFile(
    join(destination, "现场操作.md"),
    await readFile(join(root, "docs/demo-kit/platform-workbench-20261016.md"))
  )
  console.log(JSON.stringify({ destination, packages: packages.length, inputFiles: 16 }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

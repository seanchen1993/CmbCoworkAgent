/** Build the two independent trial archives; never include the completed test fixture. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"

const root = resolve(__dirname, "../..")
const output = resolve(root, "output/frontend-api-workbench-1.1.0")
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
mkdirSync(output, { recursive: true })

function archive(source: string, entries: string[], filename: string) {
  const zip = new AdmZip()
  const hashes: Record<string, string> = {}
  const add = (relative: string) => {
    const absolute = join(source, relative)
    const stat = lstatSync(absolute)
    assert(!stat.isSymbolicLink(), "Do not publish symlinks: " + relative)
    if (stat.isDirectory()) {
      for (const file of readdirSync(absolute).sort()) add(relative + "/" + file)
      return
    }
    assert(stat.isFile(), "Expected regular file: " + relative)
    assert(!relative.split("/").some((part) => ["node_modules", "dist", ".git"].includes(part)))
    const bytes = readFileSync(absolute)
    zip.addFile(relative, bytes)
    hashes[relative] = sha256(bytes)
  }
  for (const entry of entries) add(entry)
  const bytes = zip.toBuffer()
  writeFileSync(join(output, filename), bytes)
  const check = new AdmZip(bytes)
  assert.equal(check.getEntries().length, Object.keys(hashes).length)
  for (const entry of check.getEntries())
    assert.equal(sha256(entry.getData()), hashes[entry.entryName])
  return { filename, sha256: sha256(bytes), files: hashes }
}

const pluginRoot = join(root, "examples/frontend-api-workbench")
const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"))
assert.equal(manifest.name, "frontend-api-workbench")
assert.equal(manifest.version, "1.1.0")
const plugin = archive(
  pluginRoot,
  ["plugin.json", "hooks", "README.md"],
  "frontend-api-workbench.zip"
)
const sourceRoot = join(root, "examples/frontend-api-starter")
const starter = archive(
  sourceRoot,
  [
    "AGENTS.md",
    "TASK.md",
    "README.md",
    "package.json",
    "server.cjs",
    "start-demo.cmd",
    "src",
    "public",
    "docs",
    "tests",
    "scripts"
  ],
  "frontend-api-starter.zip"
)
assert(readFileSync(join(sourceRoot, "src/api.js"), "utf8").includes("接口尚未接入"))
assert.equal(
  starter.files["public/vendor/vue.global.prod.js"],
  "9847847474877fae5997b30db1674c99d3f8ae36b475af3224a1f79c274530a9"
)

// Do not overwrite a trial copy someone may already have started to edit.
const unpacked = join(output, "vue-starter")
const unpackedCreated = !existsSync(unpacked)
if (unpackedCreated) {
  for (const entry of new AdmZip(join(output, starter.filename)).getEntries()) {
    const target = join(unpacked, entry.entryName)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}
writeFileSync(
  join(output, "archive-verification.json"),
  JSON.stringify(
    {
      plugin,
      starter,
      unpackedCreated,
      note: "ZIP bytes match source; existing unpacked trial directory is never overwritten."
    },
    null,
    2
  ) + "\n"
)
console.log(JSON.stringify({ plugin: plugin.filename, starter: starter.filename, unpackedCreated }))

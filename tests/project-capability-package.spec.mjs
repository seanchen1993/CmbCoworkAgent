import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = "C:/ai/autobiz_kanban"
const commit = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"
const output = join(root, "output/project-capability-20261011", `package-${Date.now()}`)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const options = { cwd: root, windowsHide: true, encoding: "utf8", timeout: 120000 }
const git = (...args) => execFileSync("git", args, { ...options, timeout: 10000 }).trim()
assert.equal(git("branch", "--show-current"), "codex/mods-v2")
mkdirSync(output, { recursive: true })

// An unreviewed source is rejected before the exporter creates any artifact directory.
const other = join(output, "unreviewed-source")
mkdirSync(other)
git("init", other)
writeFileSync(join(other, "plugin.json"), '{"version":"1.0.87"}\n')
git("-C", other, "add", "plugin.json")
git(
  "-C",
  other,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "fixture"
)
git("-C", other, "update-ref", "refs/remotes/origin/dev_autobiz_fullstack_0920", "HEAD")
const denied = join(output, "denied")
const rejected = spawnSync(
  process.execPath,
  ["scripts/package-autobiz-fullstack-mods.mjs", other, denied],
  options
)
assert.notEqual(rejected.status, 0)
assert.match(rejected.stderr, /上游提交与已审核版本不同/)
assert.equal(existsSync(denied), false)

const exported = join(output, "accepted")
const built = spawnSync(
  process.execPath,
  ["scripts/package-autobiz-fullstack-mods.mjs", source, exported],
  options
)
writeFileSync(join(output, "export.log"), built.stdout + built.stderr)
assert.equal(built.status, 0, built.stderr)
const receipt = JSON.parse(readFileSync(join(exported, "SOURCE.json"), "utf8"))
assert.equal(receipt.source.commit, commit)
assert.equal(receipt.source.upstreamVersion, "1.0.87")
assert.equal(receipt.plugin.version, "1.0.87-mods.3")
const original = new AdmZip(
  execFileSync("git", ["--no-replace-objects", "-C", source, "archive", "--format=zip", commit], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024
  })
)
let preserved = 0
let hooks = 0
for (const entry of original.getEntries()) {
  if (entry.isDirectory || entry.entryName === "plugin.json") continue
  assert.equal(
    hash(readFileSync(join(receipt.plugin.path, entry.entryName))),
    hash(entry.getData()),
    entry.entryName
  )
  preserved++
  if (entry.entryName.startsWith("hooks/") || /\/hooks\//.test(entry.entryName)) hooks++
}
const manifest = JSON.parse(readFileSync(join(receipt.plugin.path, "plugin.json"), "utf8"))
const upstream = JSON.parse(original.getEntry("plugin.json").getData().toString("utf8"))
assert.equal(manifest.hooks, upstream.hooks)
assert.deepEqual(manifest.skills, upstream.skills)
assert.equal(
  hash(readFileSync(join(receipt.plugin.path, "devclaw.project.json"))),
  hash(readFileSync(join(root, "examples/autobiz-fullstack-mods/devclaw.project.json")))
)
const board = JSON.parse(
  original.getEntry("board_core/board_config.json").getData().toString("utf8")
)
const nodeIds = new Set(
  [...board.workflow.nodes, ...board.workflow.dynamicStages.flatMap((x) => x.nodes)].map(
    (x) => x.id
  )
)
const capability = JSON.parse(
  readFileSync(join(receipt.plugin.path, "devclaw.project.json"), "utf8")
)
for (const stage of capability.stages) assert(nodeIds.has(stage.nodeId), stage.nodeId)
assert.equal(hash(readFileSync(receipt.plugin.zip)), receipt.plugin.sha256)
const packaged = new AdmZip(receipt.plugin.zip)
const runtime = JSON.parse(packaged.getEntry("devclaw.project-runtime.json").getData().toString("utf8"))
assert.equal(runtime.apiVersion, "devclaw.project-runtime/v1")
assert.deepEqual(runtime.plugin, { id: manifest.name, version: manifest.version })
assert.equal(runtime.stateOwner, "plugin")
assert.equal(runtime.mode, "legacy")
assert(Object.values(runtime.capabilities).every(value => value === false), "unverified direct writes stay unavailable")
assert.equal(
  hash(packaged.getEntry("devclaw.project.json").getData()),
  hash(readFileSync(join(receipt.plugin.path, "devclaw.project.json")))
)
assert.equal(
  hash(packaged.getEntry(manifest.hooks).getData()),
  hash(original.getEntry(upstream.hooks).getData())
)
const result = {
  commit,
  preserved,
  hooks,
  declaration: true,
  driftRejected: true,
  artifactRoot: exported,
  zip: receipt.plugin.zip
}
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))

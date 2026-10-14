import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

// Artifact acceptance only. This does not launch DevClaw or execute the business workflow.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRepository = "C:/ai/autobiz_kanban"
const branch = "dev_autobiz_fullstack_0920"
const commit = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"
const upstreamVersion = "1.0.87"
const pluginName = "AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods"
const pluginVersion = "1.0.87-mods.1"
const kitSha256 = "5b4966131122a65bd3edc0a76cccf36e1a1bba932931b48cdffdf6a0f2099f1f"
const artifactRoot = resolve(
  process.env.CMB_AUTOBIZ_FULLSTACK_EXPORT || join(root, "output/autobiz-fullstack-0920-20261009")
)
const checks = []
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const fileHash = (path) => hash(readFileSync(path))
const json = (path) => JSON.parse(readFileSync(path, "utf8"))
const pass = (label) => {
  checks.push(label)
  console.log("PASS " + label)
}

function inside(parent, child) {
  const path = relative(parent, child)
  return (
    path !== "" &&
    !isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith("../") &&
    !path.startsWith("..\\")
  )
}

function localPath(parent, value) {
  assert.equal(typeof value, "string", "Artifact path must be a string")
  const path = resolve(parent, value)
  assert(inside(parent, path), "Artifact path escaped its owned directory")
  assert(
    inside(realpathSync(parent), realpathSync(path)),
    "Artifact path resolved outside its owner"
  )
  return path
}

function validRelativePath(value) {
  assert.equal(typeof value, "string")
  assert(
    value &&
      !isAbsolute(value) &&
      !/[\\:]/u.test(value) &&
      [...value].every((character) => character.charCodeAt(0) >= 32)
  )
  assert(value.split("/").every((part) => part && part !== "." && part !== ".."))
  return value
}

function directoryFiles(directory) {
  assert(lstatSync(directory).isDirectory(), "Expected a real artifact directory")
  assert(!lstatSync(directory).isSymbolicLink(), "Artifact directory cannot be a link")
  const files = new Map()
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      const entry = lstatSync(path)
      assert(!entry.isSymbolicLink(), "Artifact tree contains a link")
      if (entry.isDirectory()) walk(path)
      else {
        assert(entry.isFile(), "Artifact tree contains a special file")
        const key = relative(directory, path).replaceAll("\\", "/")
        validRelativePath(key)
        assert(files.size < 12_000, "Artifact file count exceeded the acceptance boundary")
        files.set(key, fileHash(path))
      }
    }
  }
  walk(directory)
  return files
}

function zipFiles(buffer, optionalRoot = "") {
  const files = new Map()
  const archive = new AdmZip(buffer)
  let total = 0
  for (const entry of archive.getEntries()) {
    const key = validRelativePath(entry.entryName.replace(/\/$/u, ""))
    if (entry.isDirectory) continue
    assert(!files.has(key), "ZIP contains duplicate file names")
    total += entry.header.size
    assert(total <= 64 * 1024 * 1024, "ZIP exceeded the accepted source size")
    files.set(key, hash(entry.getData()))
  }
  if (optionalRoot && !files.has("plugin.json")) {
    const stripped = new Map()
    for (const [key, digest] of files) {
      assert(key.startsWith(optionalRoot + "/"), "ZIP has an unexpected root directory")
      const child = validRelativePath(key.slice(optionalRoot.length + 1))
      assert(!stripped.has(child))
      stripped.set(child, digest)
    }
    return stripped
  }
  return files
}

const sortedEntries = (map) =>
  [...map.entries()].sort(([left], [right]) => left.localeCompare(right))
const equalFiles = (actual, expected, label) =>
  assert.deepEqual(sortedEntries(actual), sortedEntries(expected), label)

function git(args, buffer = false) {
  return execFileSync("git", ["--no-replace-objects", "-C", sourceRepository, ...args], {
    ...(buffer ? {} : { encoding: "utf8" }),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  })
}

function repositoryState() {
  return {
    branch: git(["branch", "--show-current"]).trim(),
    head: git(["rev-parse", "HEAD"]).trim(),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"])
  }
}

function main() {
  const outputRoot = realpathSync(join(root, "output"))
  assert(inside(outputRoot, realpathSync(artifactRoot)), "Export must be an owned output leaf")
  assert(lstatSync(artifactRoot).isDirectory() && !lstatSync(artifactRoot).isSymbolicLink())
  const sourceBefore = repositoryState()
  assert.equal(sourceBefore.branch, branch, "The source checkout is on a different branch")
  assert.equal(sourceBefore.head, commit, "The source checkout moved from the accepted commit")
  assert.equal(
    git(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]).trim(),
    commit,
    "The origin branch moved; refresh the plan and receipt before accepting another build"
  )

  const archiveBytes = git(["archive", "--format=zip", commit], true)
  const archive = new AdmZip(archiveBytes)
  const originalFiles = zipFiles(archiveBytes)
  const trackedPaths = git(["ls-tree", "-r", "-z", "--name-only", commit])
    .split("\0")
    .filter(Boolean)
    .sort()
  assert.deepEqual(
    [...originalFiles.keys()].sort(),
    trackedPaths,
    "The archive omitted tracked assets, for example through export-ignore"
  )
  const upstreamManifest = JSON.parse(archive.getEntry("plugin.json").getData().toString("utf8"))
  assert.equal(upstreamManifest.version, upstreamVersion)
  assert.equal(upstreamManifest.hooks, "hooks/hooks.json")

  const receipt = json(join(artifactRoot, "SOURCE.json"))
  const expectedSource = {
    repository: "https://github.com/seikou00/autobiz_kanban.git",
    branch,
    commit,
    upstreamVersion
  }
  assert.equal(receipt.schemaVersion, 1)
  assert.deepEqual(receipt.source, expectedSource)
  assert(Array.isArray(receipt.originalFiles))
  const declaredFiles = new Map()
  for (const entry of receipt.originalFiles) {
    const path = validRelativePath(entry.path)
    assert(!declaredFiles.has(path), "Source receipt contains duplicate original files")
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    declaredFiles.set(path, entry.sha256)
  }
  equalFiles(declaredFiles, originalFiles, "Receipt did not describe the complete immutable source")
  pass("fixed target branch, original version and all tracked source proofs")

  assert.equal(receipt.plugin.name, pluginName)
  assert.equal(receipt.plugin.version, pluginVersion)
  const plugin = localPath(artifactRoot, receipt.plugin.path)
  const pluginZip = localPath(artifactRoot, receipt.plugin.zip)
  assert.equal(plugin, join(artifactRoot, pluginName))
  assert.equal(pluginZip, join(artifactRoot, pluginName + ".zip"))
  const packagedFiles = directoryFiles(plugin)
  const wrappedManifest = json(join(plugin, "plugin.json"))
  const allowedChanges = new Set(["name", "version", "description", "mods"])
  const stableFields = (value) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !allowedChanges.has(key)))
  assert.deepEqual(
    stableFields(wrappedManifest),
    stableFields(upstreamManifest),
    "The wrapper changed an existing plugin field"
  )
  assert.equal(wrappedManifest.name, pluginName)
  assert.equal(wrappedManifest.version, pluginVersion)
  assert.equal(typeof wrappedManifest.description, "string")
  assert(wrappedManifest.description.trim())
  assert.equal(wrappedManifest.mods, "mods/manifest.json")
  assert.equal(wrappedManifest.hooks, upstreamManifest.hooks)
  for (const [path, digest] of originalFiles) {
    if (path !== "plugin.json")
      assert.equal(packagedFiles.get(path), digest, "Original plugin asset changed: " + path)
  }
  assert.equal(packagedFiles.get("hooks/hooks.json"), originalFiles.get("hooks/hooks.json"))
  assert.equal(packagedFiles.get(".mcp.json"), originalFiles.get(".mcp.json"))
  assert(packagedFiles.has("workflows/code-batched-execution.workflow.js"))
  assert([...packagedFiles.keys()].some((path) => path.startsWith("agents/")))
  const embeddedProof = json(join(plugin, "MODS_SOURCE.json"))
  assert.equal(embeddedProof.schemaVersion, 1)
  assert.deepEqual(embeddedProof.source, expectedSource)
  assert.deepEqual(embeddedProof.originalFiles, receipt.originalFiles)
  assert.deepEqual(embeddedProof.changedOriginalFiles, ["plugin.json"])
  for (const path of packagedFiles.keys()) {
    if (originalFiles.has(path)) continue
    assert(
      path.startsWith("mods/") || path === "MODS_SOURCE.json" || path === "DEVCLAW_MODS_README.md",
      "Unexpected plugin addition: " + path
    )
    assert(!path.endsWith("workflow.generated.ts"), "Old seven-variant workflow was copied in")
  }
  equalFiles(
    zipFiles(readFileSync(pluginZip), pluginName),
    packagedFiles,
    "The plugin ZIP and installed-directory candidate differed"
  )
  assert.equal(fileHash(pluginZip), receipt.plugin.sha256)
  pass("original hooks, MCP, roles, workflows and every other asset retained in directory and ZIP")

  const native = json(join(plugin, "mods/manifest.json"))
  assert.equal(native.apiVersion, "cmb.mods/v2")
  assert.equal(native.id, pluginName)
  assert.equal(
    Object.hasOwn(native, "entry"),
    false,
    "Components cannot retain a hidden root entry"
  )
  assert.equal(native.claw.componentsVersion, 1)
  assert.deepEqual(native.claw.components.map((entry) => entry.id).sort(), [
    "board",
    "review",
    "review-input",
    "status"
  ])
  const components = new Map(native.claw.components.map((entry) => [entry.id, entry]))
  assert(
    components.get("board").dependsOn.includes("status"),
    "The board lost its status dependency"
  )
  const actionOwners = []
  for (const component of components.values()) {
    assert.equal(component.kind, "module")
    const entry = localPath(join(plugin, "mods"), validRelativePath(component.entry))
    assert(lstatSync(entry).isFile())
    for (const dependency of component.dependsOn ?? []) assert(components.has(dependency))
    assert(Array.isArray(component.actionIds))
    actionOwners.push(...component.actionIds)
  }
  assert.equal(new Set(actionOwners).size, actionOwners.length, "An action has multiple owners")
  const actions = native.claw.actions
  assert(Array.isArray(actions) && actions.length > 0)
  assert.deepEqual([...actionOwners].sort(), actions.map((action) => action.id).sort())
  assert(
    components.get("review-input").actionIds.length > 0,
    "Cross-plugin preparation did not expose an action"
  )
  for (const action of actions) {
    assert.equal(typeof action.command, "string")
    assert(action.command.trim())
    assert.equal(action.inputSchema.type, "object")
    assert.equal(action.outputSchema.type, "object")
  }
  pass("native component boundaries, explicit board dependency and callable action ownership")

  assert(Array.isArray(receipt.packages))
  assert.deepEqual(
    receipt.packages.map((entry) => entry.name).sort(),
    [pluginName, "component-review-kit", "review-agent"].sort()
  )
  const sums = readFileSync(join(artifactRoot, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/u)
  const declaredSums = []
  for (const entry of receipt.packages) {
    assert.equal(entry.file, entry.name + ".zip")
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(fileHash(localPath(artifactRoot, entry.file)), entry.sha256)
    declaredSums.push(entry.sha256 + "  " + entry.file)
  }
  assert.deepEqual([...sums].sort(), declaredSums.sort())
  const review = join(artifactRoot, "review-agent")
  const reviewFiles = directoryFiles(review)
  equalFiles(
    reviewFiles,
    directoryFiles(join(root, "examples/mods-review-agent")),
    "The independent Review source package changed"
  )
  equalFiles(
    zipFiles(readFileSync(join(artifactRoot, "review-agent.zip")), "review-agent"),
    reviewFiles,
    "The Review ZIP did not contain its complete directory"
  )
  const frozenKit = join(
    root,
    "output/stage43-main-release-win-native-20261008/DIY示例/component-review-kit.zip"
  )
  assert.equal(fileHash(frozenKit), kitSha256, "The frozen 1.5.9 component kit changed")
  assert.equal(fileHash(join(artifactRoot, "component-review-kit.zip")), kitSha256)
  pass("independent Review package and exact frozen 1.5.9 component kit with matching receipts")

  const workspace = localPath(artifactRoot, receipt.workspace.path)
  assert.equal(workspace, join(artifactRoot, "autobiz-source-project"))
  const workspaceFiles = directoryFiles(workspace)
  for (const [path, digest] of originalFiles)
    assert.equal(workspaceFiles.get(path), digest, "Original source-copy asset changed: " + path)
  assert.equal(receipt.workspace.sourceFile, "tests/test_project_status_invalid_checkpoint.py")
  assert(originalFiles.has(receipt.workspace.sourceFile))
  assert.equal(
    workspaceFiles.get(receipt.workspace.sourceFile),
    originalFiles.get(receipt.workspace.sourceFile)
  )
  for (const path of workspaceFiles.keys()) {
    if (originalFiles.has(path)) continue
    assert(
      path === ".cmb/project-checks.json" || path.startsWith(".autobizdevops/"),
      "Unexpected source-copy addition: " + path
    )
    assert(
      !/(?:^|\/)(?:\.task-runs|\.parallel-runs)(?:\/|$)/u.test(path),
      "The demo contains an active task or batch ledger"
    )
  }
  assert.deepEqual(json(join(workspace, ".cmb/project-checks.json")), {
    schemaVersion: 1,
    unitTest: { runner: "python-unittest", startDirectory: "tests", pattern: "test_*.py" }
  })
  const state = json(join(workspace, ".autobizdevops/state.json"))
  assert.equal(state.schemaVersion, "autobizdevops.state.v3")
  assert.deepEqual(Object.keys(state.features), ["mods-demo"])
  const record = state.features["mods-demo"]
  const lean = json(join(workspace, "board_core/board_config.json")).workflow.templates.lean
  assert.equal(lean.kind, "nodeSubset")
  assert.deepEqual(lean.nodes, ["dev.specs", "dev.code", "ops.archive"])
  assert.equal(record.workflowTemplate, "lean")
  assert.equal(
    Object.hasOwn(record, "workflowNodes"),
    false,
    "The fixed lean template must use its original registry, not custom per-record nodes"
  )
  assert.equal(record.checkpoint, "specs_in_progress", "The demo skipped its true initial stage")
  assert.equal(receipt.workspace.feature, "mods-demo")
  assert.equal(receipt.workspace.checkpoint, record.checkpoint)
  assert.equal(Object.hasOwn(receipt.workspace.record, "workflowNodes"), false)
  assert.deepEqual(
    receipt.workspace.record,
    record,
    "The source receipt must match the original normalized initial Feature record"
  )
  pass("immutable source copy, original initial lean Feature and honest unittest discovery scope")

  const artifactsBefore = directoryFiles(artifactRoot)
  const refusal = spawnSync(
    process.execPath,
    [join(root, "scripts/package-autobiz-fullstack-mods.mjs"), sourceRepository, artifactRoot],
    { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
  )
  assert.equal(refusal.error, undefined, "The overwrite control did not finish normally")
  assert(
    Number.isInteger(refusal.status) && refusal.status !== 0,
    "The generator accepted an already-existing output directory"
  )
  assert.match(
    refusal.stderr + refusal.stdout,
    /输出目录已存在/u,
    "The refusal did not come from the existing-output boundary"
  )
  equalFiles(
    directoryFiles(artifactRoot),
    artifactsBefore,
    "The refusal modified existing artifacts"
  )
  assert.deepEqual(repositoryState(), sourceBefore, "Acceptance changed the source checkout")
  pass("existing-output refusal preserves every artifact and the original source checkout")
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks,
        artifactRoot,
        source: expectedSource,
        originalFileCount: originalFiles.size,
        scope:
          "artifact identity, preservation and overwrite refusal; no application or business execution"
      },
      null,
      2
    )
  )
}

try {
  main()
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "AUTOBIZ_FULLSTACK_PACKAGE_ACCEPTANCE_FAILED"
  )
  process.exitCode = 1
}

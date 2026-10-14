import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyNativeTextPatch } from "./langchain-native-patch-text.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const baseName = "langchain-1.2.37-native-stream-origin"
const overlayName = "langchain-1.2.37-native-tool-invoke-origin"
const basePaths = ["dist/agents/ReactAgent.js", "dist/agents/ReactAgent.cjs", "package.json",
  "dist/native-stream-origin.js", "dist/native-stream-origin.cjs",
  "dist/native-stream-origin.d.ts", "dist/native-stream-origin.d.cts"]
const overlayPaths = ["dist/agents/ReactAgent.js", "dist/agents/ReactAgent.cjs",
  "dist/agents/nodes/ToolNode.js", "dist/agents/nodes/ToolNode.cjs", "package.json",
  "dist/native-tool-invoke-origin.js", "dist/native-tool-invoke-origin.cjs",
  "dist/native-tool-invoke-origin.d.ts", "dist/native-tool-invoke-origin.d.cts"]
const baseTemplates = ["langchain-native-stream-origin-runtime.js.inc", "langchain-native-stream-origin.d.ts"]
const overlayTemplates = ["langchain-native-tool-invoke-agent.js.inc", "langchain-native-tool-invoke-node.js.inc",
  "langchain-native-tool-invoke-origin.d.ts"]
function targetPath(root, path) {
  const target = resolve(root, path), within = relative(root, target)
  if (!within || isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\"))
    throw Error("LANGCHAIN_PATCH_PATH_INVALID")
  return target
}
async function optional(path) {
  try { return await readFile(path) }
  catch (reason) { if (reason?.code === "ENOENT") return undefined; throw reason }
}
function exactFileSet(files, paths) {
  if (!Array.isArray(files) || files.length !== paths.length ||
    files.some((file, index) => file.path !== paths[index])) throw Error("LANGCHAIN_PATCH_FILE_SET_INVALID")
}
async function validateArtifacts(name, paths, templates) {
  const bytes = await readFile(resolve(repository, "patches", `${name}.manifest.json`))
  const manifest = JSON.parse(bytes), patch = await readFile(resolve(repository, "patches", `${name}.patch`))
  if (manifest.name !== "langchain" || manifest.version !== "1.2.37" || hash(patch) !== manifest.patchSha256)
    throw Error("LANGCHAIN_PATCH_MANIFEST_INVALID")
  exactFileSet(manifest.files, paths)
  exactFileSet(manifest.templates, templates)
  for (const entry of manifest.templates)
    if (hash(await readFile(targetPath(resolve(repository, "patches"), entry.path))) !== entry.sha256)
      throw Error("LANGCHAIN_PATCH_TEMPLATE_CHANGED")
  return { manifest, bytes, patch }
}
async function artifactBundle() {
  const base = await validateArtifacts(baseName, basePaths, baseTemplates)
  const overlay = await validateArtifacts(overlayName, overlayPaths, overlayTemplates)
  if (overlay.manifest.baseManifestSha256 !== hash(base.bytes) ||
    overlay.manifest.basePatchSha256 !== base.manifest.patchSha256 ||
    overlay.manifest.licenseSha256 !== base.manifest.licenseSha256 ||
    overlay.manifest.upstreamIntegrity !== base.manifest.upstreamIntegrity ||
    overlay.manifest.upstreamSha1 !== base.manifest.upstreamSha1)
    throw Error("LANGCHAIN_TOOL_PATCH_BASE_CHANGED")
  for (const file of overlay.manifest.files) {
    const previous = base.manifest.files.find(candidate => candidate.path === file.path)
    if (previous && file.beforeSha256 !== previous.afterSha256)
      throw Error("LANGCHAIN_TOOL_PATCH_BASE_CHANGED")
  }
  return { base, overlay }
}
async function assertPackage(root, bundle) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  if (pkg.name !== "langchain" || pkg.version !== "1.2.37") throw Error("LANGCHAIN_PATCH_VERSION_CHANGED")
  if (hash(await readFile(resolve(root, "LICENSE"))) !== bundle.base.manifest.licenseSha256)
    throw Error("LANGCHAIN_PATCH_LICENSE_CHANGED")
}
async function readFiles(root, paths) {
  const files = new Map()
  for (const path of paths) files.set(path, await optional(targetPath(root, path)))
  return files
}
function matches(files, expected, side) {
  return expected.every(file => {
    const bytes = files.get(file.path)
    return (bytes === undefined ? null : hash(bytes)) === file[side]
  })
}
function unionFiles(bundle) {
  const entries = new Map()
  for (const file of bundle.base.manifest.files) entries.set(file.path, file)
  for (const file of bundle.overlay.manifest.files) entries.set(file.path, file)
  if (entries.size !== 13) throw Error("LANGCHAIN_TOOL_PATCH_UNION_INVALID")
  return [...entries.values()]
}

/** Read-only thirteen-file plan. No SDK module is loaded and no file is staged or installed. */
export async function prepareLangchainNativeFoundationPlan({ workspaceRoot = repository } = {}) {
  const bundle = await artifactBundle(), root = resolve(workspaceRoot, "node_modules/langchain")
  const upstreamTarball = "https://registry.npmjs.org/langchain/-/langchain-1.2.37.tgz"
  const upstreamIntegrity = "sha512-zjd0TpMfX8V440XJVavRmzLSvojVv5WZ7M9LWNtgYo0MDFTiWlCdnFNdHo1sZlNoI+8aSdLsVl/WXKtucyhwEA=="
  const upstreamSha1 = "58a7c4ad408cd478b606f0d7f6ef802c00bf6fa9"
  for (const artifact of [bundle.base, bundle.overlay]) {
    if (artifact.manifest.license !== "MIT" ||
      artifact.manifest.upstreamTarball !== upstreamTarball ||
      artifact.manifest.upstreamIntegrity !== upstreamIntegrity ||
      artifact.manifest.upstreamSha1 !== upstreamSha1)
      throw Error("LANGCHAIN_FOUNDATION_PLAN_UPSTREAM_CHANGED")
  }
  await assertPackage(root, bundle)
  const rootPackagePath = resolve(workspaceRoot, "package.json")
  const rootLockPath = resolve(workspaceRoot, "package-lock.json")
  const rootPackageBytes = await readFile(rootPackagePath), rootLockBytes = await readFile(rootLockPath)
  const rootPackage = JSON.parse(rootPackageBytes), rootLock = JSON.parse(rootLockBytes)
  const locked = rootLock.packages?.["node_modules/langchain"]
  if (rootPackage.dependencies?.langchain !== "1.2.37" ||
    rootLock.packages?.[""]?.dependencies?.langchain !== "1.2.37" ||
    locked?.version !== "1.2.37" || locked?.resolved !== upstreamTarball ||
    locked?.integrity !== upstreamIntegrity)
    throw Error("LANGCHAIN_FOUNDATION_PLAN_DEPENDENCY_LOCK_INVALID")
  const expected = unionFiles(bundle), observed = await readFiles(root, expected.map(file => file.path))
  const nonoverlapping = bundle.overlay.manifest.files.filter(file => !basePaths.includes(file.path))
  let state
  if (matches(observed, expected, "afterSha256")) state = "after"
  else if (matches(observed, bundle.base.manifest.files, "afterSha256") &&
    matches(observed, bundle.overlay.manifest.files, "beforeSha256")) state = "base"
  else if (matches(observed, bundle.base.manifest.files, "beforeSha256") &&
    matches(observed, nonoverlapping, "beforeSha256")) state = "before"
  else throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  const installedPackage = JSON.parse(observed.get("package.json"))
  if (installedPackage.name !== "langchain" || installedPackage.version !== "1.2.37" ||
    installedPackage.license !== "MIT") throw Error("LANGCHAIN_PATCH_VERSION_CHANGED")
  const outputs = new Map(observed)
  if (state === "before") {
    const inputs = new Map(bundle.base.manifest.files.map(file => [file.path, outputs.get(file.path)]))
    const baseOutputs = applyNativeTextPatch(bundle.base.patch.toString("utf8"), inputs)
    if (!matches(baseOutputs, bundle.base.manifest.files, "afterSha256"))
      throw Error("LANGCHAIN_PATCH_POSTIMAGE_INVALID")
    for (const file of bundle.base.manifest.files) outputs.set(file.path, baseOutputs.get(file.path))
  }
  if (state !== "after") {
    const inputs = new Map(bundle.overlay.manifest.files.map(file => [file.path, outputs.get(file.path)]))
    if (!matches(inputs, bundle.overlay.manifest.files, "beforeSha256"))
      throw Error("LANGCHAIN_TOOL_PATCH_BASE_CHANGED")
    const overlayOutputs = applyNativeTextPatch(bundle.overlay.patch.toString("utf8"), inputs)
    if (!matches(overlayOutputs, bundle.overlay.manifest.files, "afterSha256"))
      throw Error("LANGCHAIN_PATCH_POSTIMAGE_INVALID")
    for (const file of bundle.overlay.manifest.files) outputs.set(file.path, overlayOutputs.get(file.path))
  }
  if (!matches(outputs, expected, "afterSha256")) throw Error("LANGCHAIN_TOOL_PATCH_UNION_INVALID")
  const evidence = []
  const remember = (absolutePath, bytes) => {
    evidence.push(Object.freeze({ absolutePath, bytes, sha256: hash(bytes) }))
  }
  remember(rootPackagePath, rootPackageBytes)
  remember(rootLockPath, rootLockBytes)
  for (const [name, artifact] of [[baseName, bundle.base], [overlayName, bundle.overlay]]) {
    remember(resolve(repository, "patches", `${name}.manifest.json`), artifact.bytes)
    remember(resolve(repository, "patches", `${name}.patch`), artifact.patch)
    for (const template of artifact.manifest.templates) {
      const path = targetPath(resolve(repository, "patches"), template.path)
      const bytes = await readFile(path)
      if (hash(bytes) !== template.sha256) throw Error("LANGCHAIN_PATCH_TEMPLATE_CHANGED")
      remember(path, bytes)
    }
  }
  const licensePath = resolve(root, "LICENSE"), licenseBytes = await readFile(licensePath)
  if (hash(licenseBytes) !== bundle.base.manifest.licenseSha256)
    throw Error("LANGCHAIN_PATCH_LICENSE_CHANGED")
  remember(licensePath, licenseBytes)
  const targets = expected.map(file => Object.freeze({
    absolutePath: targetPath(root, file.path), relativePath: file.path,
    beforeBytes: observed.get(file.path) ?? null,
    beforeSha256: observed.get(file.path) === undefined ? null : hash(observed.get(file.path)),
    afterBytes: outputs.get(file.path), afterSha256: file.afterSha256
  }))
  return Object.freeze({ name: "langchain", version: "1.2.37", root, state,
    targets: Object.freeze(targets), evidence: Object.freeze(evidence) })
}

/** Complete known states only; both older fast paths and installation use this classification. */
export async function classifyLangchainNativeFoundations({ workspaceRoot = repository } = {}) {
  if (await optional(resolve(repository, "patches", `${overlayName}.manifest.json`)) === undefined)
    return undefined
  const bundle = await artifactBundle(), root = resolve(workspaceRoot, "node_modules/langchain")
  await assertPackage(root, bundle)
  const expected = unionFiles(bundle), files = await readFiles(root, expected.map(file => file.path))
  if (matches(files, expected, "afterSha256")) return "overlay"
  if (matches(files, bundle.base.manifest.files, "afterSha256") &&
    matches(files, bundle.overlay.manifest.files, "beforeSha256")) return "base"
  const nonoverlapping = bundle.overlay.manifest.files.filter(file => !basePaths.includes(file.path))
  if (matches(files, bundle.base.manifest.files, "beforeSha256") &&
    matches(files, nonoverlapping, "beforeSha256")) return "pristine"
  return "mixed"
}

/** Recognition requires every artifact and all thirteen postimages, never one shared-file hash. */
export async function verifyLangchainNativeToolInvokeOverlay({ workspaceRoot = repository } = {}) {
  if (await optional(resolve(repository, "patches", `${overlayName}.manifest.json`)) === undefined) return false
  const bundle = await artifactBundle(), root = resolve(workspaceRoot, "node_modules/langchain")
  await assertPackage(root, bundle)
  const expected = unionFiles(bundle), files = await readFiles(root, expected.map(file => file.path))
  return matches(files, expected, "afterSha256")
}

/** Recover exact old-base bytes from our full-file overlay; no runtime code is evaluated. */
function recoverBeforeFiles(patch, after, entries) {
  const lines = patch.split("\n"), originals = new Map()
  let index = 0
  for (const entry of entries) {
    const oldHeader = lines[index++], newHeader = lines[index++]
    if (oldHeader !== (entry.beforeSha256 === null ? "--- /dev/null" : `--- a/${entry.path}`) ||
      newHeader !== `+++ b/${entry.path}`) throw Error("LANGCHAIN_TOOL_REVERSE_HEADER_INVALID")
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index++])
    if (!header || Number(header[1]) !== (Number(header[2]) ? 1 : 0) ||
      Number(header[3]) !== (Number(header[4]) ? 1 : 0)) throw Error("LANGCHAIN_TOOL_REVERSE_HUNK_INVALID")
    const oldRows = [], newRows = []
    let oldLF = true, newLF = true
    while (index < lines.length && lines[index] !== "" && !lines[index].startsWith("--- ")) {
      const row = lines[index++], kind = row[0]
      if (kind !== "-" && kind !== "+") throw Error("LANGCHAIN_TOOL_REVERSE_LINE_INVALID")
      const noLF = lines[index] === "\\ No newline at end of file"
      if (noLF) index++
      if (kind === "-") { oldRows.push(row.slice(1)); oldLF = !noLF }
      else { newRows.push(row.slice(1)); newLF = !noLF }
    }
    if (oldRows.length !== Number(header[2]) || newRows.length !== Number(header[4]))
      throw Error("LANGCHAIN_TOOL_REVERSE_COUNT_INVALID")
    const observed = after.get(entry.path)
    const rebuilt = Buffer.from(newRows.join("\n") + (newRows.length && newLF ? "\n" : ""))
    if (!observed?.equals(rebuilt) || hash(rebuilt) !== entry.afterSha256)
      throw Error("LANGCHAIN_TOOL_REVERSE_POSTIMAGE_INVALID")
    const original = entry.beforeSha256 === null ? undefined :
      Buffer.from(oldRows.join("\n") + (oldRows.length && oldLF ? "\n" : ""))
    if ((original === undefined ? null : hash(original)) !== entry.beforeSha256)
      throw Error("LANGCHAIN_TOOL_REVERSE_PREIMAGE_INVALID")
    originals.set(entry.path, original)
  }
  const roundtrip = applyNativeTextPatch(patch, originals)
  for (const entry of entries)
    if (!roundtrip.get(entry.path).equals(after.get(entry.path))) throw Error("LANGCHAIN_TOOL_REVERSE_ROUNDTRIP_INVALID")
  return originals
}

/** Old installation fixtures receive checked base bytes even after the overlay is installed. */
export async function readLangchainNativeStreamBaseFiles({ workspaceRoot = repository } = {}) {
  const root = resolve(workspaceRoot, "node_modules/langchain")
  const base = await validateArtifacts(baseName, basePaths, baseTemplates)
  const state = await classifyLangchainNativeFoundations({ workspaceRoot })
  if (state !== undefined && state !== "base" && state !== "overlay")
    throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  let files = await readFiles(root, basePaths)
  if (matches(files, base.manifest.files, "afterSha256")) return files
  const bundle = await artifactBundle()
  await assertPackage(root, bundle)
  const expected = unionFiles(bundle), observed = await readFiles(root, expected.map(file => file.path))
  if (!matches(observed, expected, "afterSha256")) throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  const originals = recoverBeforeFiles(bundle.overlay.patch.toString("utf8"), observed, bundle.overlay.manifest.files)
  files = new Map()
  for (const file of base.manifest.files) files.set(file.path,
    originals.has(file.path) ? originals.get(file.path) : observed.get(file.path))
  if (!matches(files, base.manifest.files, "afterSha256")) throw Error("LANGCHAIN_TOOL_REVERSE_BASE_INVALID")
  return files
}

/** Checked nine-file beforeimages for real isolated overlay installation fixtures. */
export async function readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot = repository } = {}) {
  const bundle = await artifactBundle(), root = resolve(workspaceRoot, "node_modules/langchain")
  await assertPackage(root, bundle)
  const expected = unionFiles(bundle), files = await readFiles(root, expected.map(file => file.path))
  if (matches(files, bundle.base.manifest.files, "afterSha256") &&
    matches(files, bundle.overlay.manifest.files, "beforeSha256"))
    return new Map(bundle.overlay.manifest.files.map(file => [file.path, files.get(file.path)]))
  if (!matches(files, expected, "afterSha256")) throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  return recoverBeforeFiles(bundle.overlay.patch.toString("utf8"), files, bundle.overlay.manifest.files)
}

export async function installLangchainNativeToolInvokeOrigin({ workspaceRoot = repository, checkOnly = false } = {}) {
  const bundle = await artifactBundle(), root = resolve(workspaceRoot, "node_modules/langchain")
  await assertPackage(root, bundle)
  const expected = unionFiles(bundle), observed = await readFiles(root, expected.map(file => file.path))
  if (matches(observed, expected, "afterSha256")) return { status: "installed", version: "1.2.37" }
  if (!matches(observed, bundle.base.manifest.files, "afterSha256") ||
    !matches(observed, bundle.overlay.manifest.files, "beforeSha256"))
    throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  if (checkOnly) throw Error("LANGCHAIN_TOOL_PATCH_NOT_INSTALLED")
  const originals = new Map(bundle.overlay.manifest.files.map(file => [file.path, observed.get(file.path)]))
  const outputs = applyNativeTextPatch(bundle.overlay.patch.toString("utf8"), originals)
  for (const file of bundle.overlay.manifest.files)
    if (hash(outputs.get(file.path)) !== file.afterSha256) throw Error("LANGCHAIN_PATCH_POSTIMAGE_INVALID")
  const staged = [], committed = [], failures = []
  try {
    for (const file of bundle.overlay.manifest.files) {
      const target = targetPath(root, file.path), temporary = `${target}.cmb-${randomUUID()}.tmp`
      staged.push({ path: file.path, target, temporary })
      await writeFile(temporary, outputs.get(file.path), { flag: "wx" })
    }
    const current = await readFiles(root, expected.map(file => file.path))
    if (!matches(current, bundle.base.manifest.files, "afterSha256") ||
      !matches(current, bundle.overlay.manifest.files, "beforeSha256"))
      throw Error("LANGCHAIN_PATCH_CHANGED_DURING_INSTALL")
    for (const file of staged) { await rename(file.temporary, file.target); committed.push(file) }
    const final = await readFiles(root, expected.map(file => file.path))
    if (!matches(final, expected, "afterSha256")) throw Error("LANGCHAIN_TOOL_PATCH_UNION_CHANGED")
  } catch (reason) {
    failures.push(reason)
    for (let index = committed.length - 1; index >= 0; index--) {
      const file = committed[index], before = originals.get(file.path)
      try {
        const now = await optional(file.target)
        if (now === undefined || hash(now) !== hash(outputs.get(file.path)))
          throw Error("LANGCHAIN_PATCH_ROLLBACK_TARGET_CHANGED")
        if (before === undefined) await unlink(file.target)
        else await writeFile(file.target, before)
      } catch (rollbackReason) { failures.push(rollbackReason) }
    }
  } finally {
    for (const file of staged)
      try { await unlink(file.temporary) }
      catch (reason) { if (reason?.code !== "ENOENT") failures.push(reason) }
  }
  if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_PATCH_ROLLBACK_FAILED")
  if (failures.length) throw failures[0]
  return { status: "patched", version: "1.2.37" }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLangchainNativeToolInvokeOrigin({ checkOnly: process.argv.includes("--check") })
  process.stdout.write(`langchain native tool invoke origin: ${result.status} ${result.version}\n`)
}

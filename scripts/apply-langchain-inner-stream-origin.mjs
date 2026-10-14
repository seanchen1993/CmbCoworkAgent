import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyNativeTextPatch } from "./langchain-native-patch-text.mjs"
import { innerStreamPackages, innerStreamPackageFiles } from "./generate-langchain-inner-stream-origin.mjs"
import { installLangchainNativeStreamOrigin } from "./apply-langchain-native-stream-origin.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
function evidence(absolutePath, bytes) {
  return Object.freeze({ absolutePath, bytes: Buffer.from(bytes), sha256: hash(bytes) })
}
function targetPath(root, path) {
  const target = resolve(root, path), within = relative(root, target)
  if (!within || isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\"))
    throw Error("LANGCHAIN_INNER_PATCH_PATH_INVALID")
  return target
}
async function optional(path) {
  try { return await readFile(path) }
  catch (reason) { if (reason?.code === "ENOENT") return undefined; throw reason }
}
function exactSet(entries, paths) {
  if (!Array.isArray(entries) || entries.length !== paths.length ||
    entries.some((entry, index) => entry.path !== paths[index]))
    throw Error("LANGCHAIN_INNER_PATCH_FILE_SET_INVALID")
}
function matches(files, entries, side) {
  return entries.every(entry => {
    const bytes = files.get(entry.path)
    return (bytes === undefined ? null : hash(bytes)) === entry[side]
  })
}
async function assertLock(workspaceRoot) {
  const pkgPath = resolve(workspaceRoot, "package.json"), lockPath = resolve(workspaceRoot, "package-lock.json")
  const pkgBytes = await readFile(pkgPath), lockBytes = await readFile(lockPath)
  const pkg = JSON.parse(pkgBytes), lock = JSON.parse(lockBytes)
  for (const description of innerStreamPackages) {
    const locked = lock.packages?.[`node_modules/${description.name}`]
    if (pkg.dependencies?.[description.name] !== description.version ||
      lock.packages?.[""]?.dependencies?.[description.name] !== description.version ||
      locked?.version !== description.version || locked?.resolved !== description.upstreamTarball ||
      locked?.integrity !== description.upstreamIntegrity)
      throw Error("LANGCHAIN_INNER_PATCH_DEPENDENCY_LOCK_INVALID")
  }
  return [evidence(pkgPath, pkgBytes), evidence(lockPath, lockBytes)]
}
async function preparePackage(workspaceRoot, description) {
  const manifestPath = resolve(repository, "patches", `${description.artifact}.manifest.json`)
  const patchPath = resolve(repository, "patches", `${description.artifact}.patch`)
  const manifestBytes = await readFile(manifestPath), patch = await readFile(patchPath)
  const manifest = JSON.parse(manifestBytes), sources = [evidence(manifestPath, manifestBytes), evidence(patchPath, patch)]
  const paths = innerStreamPackageFiles(description)
  if (manifest.name !== description.name || manifest.version !== description.version ||
    manifest.license !== "MIT" || manifest.upstreamTarball !== description.upstreamTarball ||
    manifest.upstreamIntegrity !== description.upstreamIntegrity || manifest.upstreamSha1 !== description.upstreamSha1 ||
    hash(patch) !== manifest.patchSha256)
    throw Error("LANGCHAIN_INNER_PATCH_MANIFEST_INVALID")
  exactSet(manifest.files, paths)
  exactSet(manifest.templates, description.templates)
  for (let index = 0; index < manifest.files.length; index++)
    if (manifest.files[index].beforeSha256 !== (description.before[index] ?? null))
      throw Error("LANGCHAIN_INNER_PATCH_PREIMAGE_CHANGED")
  for (const entry of manifest.templates) {
    const path = targetPath(resolve(repository, "patches"), entry.path), bytes = await readFile(path)
    if (hash(bytes) !== entry.sha256)
      throw Error("LANGCHAIN_INNER_PATCH_TEMPLATE_CHANGED")
    sources.push(evidence(path, bytes))
  }
  const root = resolve(workspaceRoot, "node_modules", description.name)
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  const licensePath = resolve(root, "LICENSE"), licenseBytes = await readFile(licensePath)
  if (pkg.name !== description.name || pkg.version !== description.version || pkg.license !== "MIT" ||
    hash(licenseBytes) !== manifest.licenseSha256)
    throw Error("LANGCHAIN_INNER_PATCH_PACKAGE_CHANGED")
  sources.push(evidence(licensePath, licenseBytes))
  const originals = await readFiles(root, paths)
  return { description, root, paths, manifest, patch, originals, evidence: sources,
    pristine: matches(originals, manifest.files, "beforeSha256"),
    installed: matches(originals, manifest.files, "afterSha256") }
}

/** Read-only eighteen-target plan; it does not require or write the other package's state. */
export async function prepareLangchainInnerStreamPlan({ workspaceRoot = repository } = {}) {
  workspaceRoot = resolve(workspaceRoot)
  const rootEvidence = await assertLock(workspaceRoot), packages = []
  for (const description of innerStreamPackages)
    packages.push(await preparePackage(workspaceRoot, description))
  const installed = packages.every(pkg => pkg.installed)
  if (!installed && !packages.every(pkg => pkg.pristine))
    throw Error("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  const prepared = packages.map(pkg => {
    const outputs = installed ? pkg.originals : applyNativeTextPatch(pkg.patch.toString("utf8"), pkg.originals)
    if (!matches(outputs, pkg.manifest.files, "afterSha256"))
      throw Error("LANGCHAIN_INNER_PATCH_POSTIMAGE_INVALID")
    return Object.freeze({ name: pkg.description.name, version: pkg.description.version, root: pkg.root,
      state: installed ? "after" : "before",
      targets: Object.freeze(pkg.paths.map((path, index) => {
        const beforeBytes = pkg.originals.get(path) ?? null, afterBytes = outputs.get(path)
        return Object.freeze({ absolutePath: targetPath(pkg.root, path), relativePath: path,
          beforeBytes: beforeBytes === null ? null : Buffer.from(beforeBytes),
          beforeSha256: beforeBytes === null ? null : hash(beforeBytes),
          afterBytes: Buffer.from(afterBytes), afterSha256: pkg.manifest.files[index].afterSha256 })
      })), evidence: Object.freeze([...rootEvidence, ...pkg.evidence]) })
  })
  return Object.freeze({ packages: Object.freeze(prepared),
    evidence: Object.freeze([...rootEvidence, ...packages.flatMap(pkg => pkg.evidence)]) })
}
async function readFiles(root, paths) {
  const files = new Map()
  for (const path of paths) files.set(path, await optional(targetPath(root, path)))
  return files
}

/** Both packages are checked as one batch. No runtime module is loaded or permission minted. */
export async function installLangchainInnerStreamOrigin({ workspaceRoot = repository, checkOnly = false } = {}) {
  await assertLock(workspaceRoot)
  // This checker recognizes either the exact old seven, or the separately reviewed whole tool union.
  await installLangchainNativeStreamOrigin({ workspaceRoot, checkOnly: true })
  const packages = []
  for (const description of innerStreamPackages) packages.push(await preparePackage(workspaceRoot, description))
  if (packages.every(pkg => pkg.installed)) return { status: "installed", targets: 18 }
  if (!packages.every(pkg => pkg.pristine)) throw Error("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  if (checkOnly) throw Error("LANGCHAIN_INNER_PATCH_NOT_INSTALLED")
  for (const pkg of packages) {
    pkg.outputs = applyNativeTextPatch(pkg.patch.toString("utf8"), pkg.originals)
    if (!matches(pkg.outputs, pkg.manifest.files, "afterSha256"))
      throw Error("LANGCHAIN_INNER_PATCH_POSTIMAGE_INVALID")
  }
  const staged = [], committed = [], failures = []
  try {
    for (const pkg of packages) for (const path of pkg.paths) {
      const target = targetPath(pkg.root, path), temporary = `${target}.cmb-${randomUUID()}.tmp`
      const entry = { pkg, path, target, temporary }
      staged.push(entry)
      await writeFile(temporary, pkg.outputs.get(path), { flag: "wx" })
    }
    await assertLock(workspaceRoot)
    await installLangchainNativeStreamOrigin({ workspaceRoot, checkOnly: true })
    for (const pkg of packages)
      if (!matches(await readFiles(pkg.root, pkg.paths), pkg.manifest.files, "beforeSha256"))
        throw Error("LANGCHAIN_INNER_PATCH_CHANGED_DURING_INSTALL")
    for (const entry of staged) { await rename(entry.temporary, entry.target); committed.push(entry) }
    for (const pkg of packages)
      if (!matches(await readFiles(pkg.root, pkg.paths), pkg.manifest.files, "afterSha256"))
        throw Error("LANGCHAIN_INNER_PATCH_FINAL_CHANGED")
  } catch (reason) {
    failures.push(reason)
    for (let index = committed.length - 1; index >= 0; index--) {
      const entry = committed[index], before = entry.pkg.originals.get(entry.path)
      try {
        const now = await optional(entry.target)
        if (now === undefined || hash(now) !== hash(entry.pkg.outputs.get(entry.path)))
          throw Error("LANGCHAIN_INNER_PATCH_ROLLBACK_TARGET_CHANGED")
        if (before === undefined) await unlink(entry.target)
        else await writeFile(entry.target, before)
      } catch (rollbackReason) { failures.push(rollbackReason) }
    }
  } finally {
    for (const entry of staged) {
      try { await unlink(entry.temporary) }
      catch (reason) { if (reason?.code !== "ENOENT") failures.push(reason) }
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_INNER_PATCH_ROLLBACK_FAILED")
  if (failures.length) throw failures[0]
  return { status: "patched", targets: 18 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLangchainInnerStreamOrigin({ checkOnly: process.argv.includes("--check") })
  process.stdout.write(`langchain inner stream origin: ${result.status} ${result.targets}\n`)
}

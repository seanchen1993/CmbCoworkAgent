import { createHash, randomUUID } from "node:crypto"
import { open, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { prepareLangchainNativeFoundationPlan } from "./apply-langchain-native-tool-invoke-origin.mjs"
import { prepareLangchainInnerStreamPlan } from "./apply-langchain-inner-stream-origin.mjs"
import { innerStreamPackages, innerStreamPackageFiles } from "./generate-langchain-inner-stream-origin.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const langchainPaths = ["dist/agents/ReactAgent.js", "dist/agents/ReactAgent.cjs", "package.json",
  "dist/native-stream-origin.js", "dist/native-stream-origin.cjs",
  "dist/native-stream-origin.d.ts", "dist/native-stream-origin.d.cts",
  "dist/agents/nodes/ToolNode.js", "dist/agents/nodes/ToolNode.cjs",
  "dist/native-tool-invoke-origin.js", "dist/native-tool-invoke-origin.cjs",
  "dist/native-tool-invoke-origin.d.ts", "dist/native-tool-invoke-origin.d.cts"]
const descriptions = [{ name: "langchain", version: "1.2.37", paths: langchainPaths,
  upstreamTarball: "https://registry.npmjs.org/langchain/-/langchain-1.2.37.tgz",
  upstreamIntegrity: "sha512-zjd0TpMfX8V440XJVavRmzLSvojVv5WZ7M9LWNtgYo0MDFTiWlCdnFNdHo1sZlNoI+8aSdLsVl/WXKtucyhwEA==" },
  ...innerStreamPackages.map(description => ({ ...description, paths: innerStreamPackageFiles(description) }))]
const artifacts = ["langchain-1.2.37-native-stream-origin", "langchain-1.2.37-native-tool-invoke-origin",
  ...innerStreamPackages.map(description => description.artifact)]
const templates = ["langchain-native-stream-origin-runtime.js.inc", "langchain-native-stream-origin.d.ts",
  "langchain-native-tool-invoke-agent.js.inc", "langchain-native-tool-invoke-node.js.inc",
  "langchain-native-tool-invoke-origin.d.ts", ...innerStreamPackages.flatMap(description => description.templates)]

function within(root, path) {
  const target = resolve(root, path), segment = relative(root, target)
  if (!segment || isAbsolute(segment) || segment === ".." || segment.startsWith("../") || segment.startsWith("..\\"))
    throw Error("LANGCHAIN_FOUNDATIONS_PATH_INVALID")
  return target
}
async function optional(path) {
  try { return await readFile(path) }
  catch (reason) { if (reason?.code === "ENOENT") return null; throw reason }
}
function equal(left, right) {
  return left === null ? right === null : right !== null && left.equals(right)
}
function assertRootEvidence(workspaceRoot, evidence) {
  const pkg = JSON.parse(evidence.get(resolve(workspaceRoot, "package.json")).bytes)
  const lock = JSON.parse(evidence.get(resolve(workspaceRoot, "package-lock.json")).bytes)
  for (const description of descriptions) {
    const actual = lock.packages?.[`node_modules/${description.name}`]
    if (pkg.dependencies?.[description.name] !== description.version ||
      lock.packages?.[""]?.dependencies?.[description.name] !== description.version ||
      actual?.version !== description.version || actual?.resolved !== description.upstreamTarball ||
      actual?.integrity !== description.upstreamIntegrity)
      throw Error("LANGCHAIN_FOUNDATIONS_DEPENDENCY_LOCK_INVALID")
  }
}
async function prepare(workspaceRoot) {
  const [langchain, inner] = await Promise.all([
    prepareLangchainNativeFoundationPlan({ workspaceRoot }), prepareLangchainInnerStreamPlan({ workspaceRoot })
  ])
  const packages = [langchain, ...inner.packages], targets = [], evidence = new Map()
  if (packages.length !== 3 || inner.packages.length !== 2 ||
    inner.packages[0].state !== inner.packages[1].state)
    throw Error("LANGCHAIN_FOUNDATIONS_MIXED_OR_UNKNOWN_FILES")
  for (let index = 0; index < descriptions.length; index++) {
    const description = descriptions[index], pkg = packages[index]
    const root = resolve(workspaceRoot, "node_modules", description.name)
    if (pkg.name !== description.name || pkg.version !== description.version || pkg.root !== root ||
      !["before", "after", ...(index === 0 ? ["base"] : [])].includes(pkg.state) ||
      pkg.targets.length !== description.paths.length)
      throw Error("LANGCHAIN_FOUNDATIONS_PLAN_INVALID")
    for (let position = 0; position < description.paths.length; position++) {
      const target = pkg.targets[position], path = description.paths[position]
      if (target.relativePath !== path || target.absolutePath !== within(root, path) ||
        (target.beforeBytes !== null && !Buffer.isBuffer(target.beforeBytes)) ||
        !Buffer.isBuffer(target.afterBytes) ||
        (target.beforeBytes === null ? null : hash(target.beforeBytes)) !== target.beforeSha256 ||
        hash(target.afterBytes) !== target.afterSha256)
        throw Error("LANGCHAIN_FOUNDATIONS_PLAN_INVALID")
      targets.push(target)
    }
  }
  for (const entry of [...packages.flatMap(pkg => pkg.evidence), ...inner.evidence]) {
    if (!Buffer.isBuffer(entry.bytes) || hash(entry.bytes) !== entry.sha256)
      throw Error("LANGCHAIN_FOUNDATIONS_EVIDENCE_INVALID")
    const previous = evidence.get(entry.absolutePath)
    if (previous && (previous.sha256 !== entry.sha256 || !previous.bytes.equals(entry.bytes)))
      throw Error("LANGCHAIN_FOUNDATIONS_EVIDENCE_CHANGED")
    evidence.set(entry.absolutePath, entry)
  }
  const paths = [resolve(workspaceRoot, "package.json"), resolve(workspaceRoot, "package-lock.json"),
    ...descriptions.map(description => resolve(workspaceRoot, "node_modules", description.name, "LICENSE")),
    ...artifacts.flatMap(name => [resolve(repository, "patches", `${name}.manifest.json`), resolve(repository, "patches", `${name}.patch`)]),
    ...templates.map(path => within(resolve(repository, "patches"), path))]
  if (targets.length !== 31 || new Set(targets.map(target => target.absolutePath)).size !== 31 ||
    evidence.size !== paths.length || paths.some(path => !evidence.has(path)))
    throw Error("LANGCHAIN_FOUNDATIONS_PLAN_INVALID")
  assertRootEvidence(workspaceRoot, evidence)
  return { packages, targets, evidence: [...evidence.values()],
    installed: packages.every(pkg => pkg.state === "after") }
}
async function assertEvidence(plan) {
  for (const entry of plan.evidence)
    if (!(await readFile(entry.absolutePath)).equals(entry.bytes))
      throw Error("LANGCHAIN_FOUNDATIONS_EVIDENCE_CHANGED")
}
async function assertTargets(plan, side) {
  for (const target of plan.targets)
    if (!equal(await optional(target.absolutePath), target[`${side}Bytes`]))
      throw Error("LANGCHAIN_FOUNDATIONS_TARGET_CHANGED")
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}
async function ownedFile(path, bytes, owned) {
  const handle = await open(path, "wx")
  const record = { path, bytes, identity: undefined, partialBytes: undefined, complete: false, consumed: false }
  owned.push(record)
  const failures = []
  let writeStarted = false
  try {
    record.identity = await handle.stat()
    writeStarted = true
    await handle.writeFile(bytes)
    record.complete = true
  } catch (reason) {
    failures.push(reason)
    if (writeStarted) try {
      if (!sameIdentity(await stat(path), record.identity))
        throw Error("LANGCHAIN_FOUNDATIONS_PARTIAL_OWNER_CHANGED")
      const partial = await readFile(path)
      if (partial.length > bytes.length || !partial.equals(bytes.subarray(0, partial.length)) ||
        !sameIdentity(await stat(path), record.identity))
        throw Error("LANGCHAIN_FOUNDATIONS_PARTIAL_BYTES_CHANGED")
      record.partialBytes = partial
    } catch (partialReason) { failures.push(partialReason) }
  }
  try { await handle.close() } catch (reason) { failures.push(reason) }
  if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_FOUNDATIONS_STAGE_FAILED")
  if (failures.length) throw failures[0]
  return record
}
async function assertOwned(record) {
  if (!record.identity || !sameIdentity(await stat(record.path), record.identity) ||
    !(await readFile(record.path)).equals(record.bytes))
    throw Error("LANGCHAIN_FOUNDATIONS_OWN_FILE_CHANGED")
}
async function cleanupOwned(record) {
  if (record.consumed) return
  let current
  try { current = await stat(record.path) }
  catch (reason) { if (reason?.code === "ENOENT") return; throw reason }
  if (!record.identity || !sameIdentity(current, record.identity))
    throw Error("LANGCHAIN_FOUNDATIONS_CLEANUP_OWNER_CHANGED")
  const bytes = record.complete ? record.bytes : record.partialBytes
  if (bytes === undefined || !(await readFile(record.path)).equals(bytes) ||
    !sameIdentity(await stat(record.path), record.identity))
    throw Error("LANGCHAIN_FOUNDATIONS_CLEANUP_BYTES_CHANGED")
  await unlink(record.path)
}

/** All twenty-seven fixed targets are prepared before a lock or temporary file can be created. */
export async function installLangchainNativeFoundationBatch({ workspaceRoot = repository, checkOnly = false } = {}) {
  workspaceRoot = resolve(workspaceRoot)
  const initial = await prepare(workspaceRoot)
  await assertEvidence(initial)
  await assertTargets(initial, "before")
  if (initial.installed) return { status: "installed", targets: 31 }
  if (checkOnly) throw Error("LANGCHAIN_FOUNDATIONS_NOT_INSTALLED")
  const owned = [], staged = [], committed = [], failures = []
  const lockPath = within(workspaceRoot, "node_modules/.cmb-native-foundations.lock")
  const nonce = randomUUID(), lockBytes = Buffer.from(JSON.stringify({ nonce, pid: process.pid }))
  let lock
  try {
    try { lock = await ownedFile(lockPath, lockBytes, owned) }
    catch (reason) {
      if (reason?.code === "EEXIST") throw Error("LANGCHAIN_FOUNDATIONS_INSTALL_BUSY")
      throw reason
    }
    const plan = await prepare(workspaceRoot)
    // The first read authorizes no writes: lock acquisition must preserve that entire snapshot.
    await assertEvidence(initial)
    await assertTargets(initial, "before")
    await assertEvidence(plan)
    await assertTargets(plan, "before")
    if (!plan.installed) {
      for (const target of plan.targets) {
        if (equal(target.beforeBytes, target.afterBytes)) continue
        const temporary = await ownedFile(`${target.absolutePath}.cmb-${nonce}.tmp`, target.afterBytes, owned)
        const rollback = target.beforeBytes === null ? undefined :
          await ownedFile(`${target.absolutePath}.cmb-${nonce}.rollback`, target.beforeBytes, owned)
        staged.push({ target, temporary, rollback })
      }
      await assertOwned(lock)
      await assertEvidence(plan)
      await assertTargets(plan, "before")
      for (const entry of staged) {
        await assertOwned(lock)
        await assertOwned(entry.temporary)
        if (!equal(await optional(entry.target.absolutePath), entry.target.beforeBytes))
          throw Error("LANGCHAIN_FOUNDATIONS_TARGET_CHANGED")
        await rename(entry.temporary.path, entry.target.absolutePath)
        entry.temporary.consumed = true
        committed.push(entry)
      }
      await assertOwned(lock)
      await assertEvidence(plan)
      await assertTargets(plan, "after")
    }
  } catch (reason) {
    failures.push(reason)
    for (let index = committed.length - 1; index >= 0; index--) {
      const entry = committed[index]
      try {
        if (!sameIdentity(await stat(entry.target.absolutePath), entry.temporary.identity) ||
          !equal(await optional(entry.target.absolutePath), entry.target.afterBytes))
          throw Error("LANGCHAIN_FOUNDATIONS_ROLLBACK_TARGET_CHANGED")
        if (entry.rollback) {
          await assertOwned(entry.rollback)
          await rename(entry.rollback.path, entry.target.absolutePath)
          entry.rollback.consumed = true
        } else await unlink(entry.target.absolutePath)
      } catch (rollbackReason) { failures.push(rollbackReason) }
    }
  } finally {
    for (let index = owned.length - 1; index >= 0; index--)
      try { await cleanupOwned(owned[index]) } catch (reason) { failures.push(reason) }
  }
  if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_FOUNDATIONS_ROLLBACK_FAILED")
  if (failures.length) throw failures[0]
  return { status: "patched", targets: 31 }
}

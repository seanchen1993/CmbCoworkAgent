import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyNativeTextPatch } from "./langchain-native-patch-text.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const artifactRoot = resolve(repository, "patches/react-virtuoso-scroll-cancel")
const paths = ["dist/index.mjs", "dist/index.cjs", "dist/index.d.ts"]
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const fail = (code) => {
  throw Error(`REACT_VIRTUOSO_SCROLL_CANCEL_${code}`)
}

function prepare(workspaceRoot) {
  const evidence = new Map()
  const readEvidence = (path) => {
    const bytes = readFileSync(path)
    evidence.set(path, bytes)
    return bytes
  }
  const manifest = JSON.parse(readEvidence(resolve(artifactRoot, "manifest.json")))
  const patch = readEvidence(resolve(artifactRoot, "react-virtuoso-4.18.12.patch"))
  if (
    manifest.name !== "react-virtuoso" ||
    manifest.version !== "4.18.12" ||
    manifest.license !== "MIT" ||
    manifest.files?.length !== paths.length ||
    manifest.files.some(
      (file, index) =>
        file.path !== paths[index] ||
        !/^[a-f0-9]{64}$/.test(file.beforeSha256) ||
        !/^[a-f0-9]{64}$/.test(file.afterSha256)
    ) ||
    hash(patch) !== manifest.patchSha256
  )
    fail("MANIFEST_INVALID")
  const previousFiles = manifest.previousInstallation?.files
  if (
    !Array.isArray(previousFiles) || previousFiles.length !== paths.length ||
    previousFiles.some((file, index) => !file || typeof file !== "object" ||
      file.path !== paths[index] ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || !Array.isArray(file.replacements) ||
      file.replacements.length > 3 || file.replacements.some(edit =>
        !edit || typeof edit !== "object" || typeof edit.before !== "string" || !edit.before ||
        typeof edit.after !== "string" || !edit.after))
  ) fail("MANIFEST_INVALID")
  const pkg = JSON.parse(readEvidence(resolve(workspaceRoot, "package.json")))
  const lock = JSON.parse(readEvidence(resolve(workspaceRoot, "package-lock.json")))
  const locked = lock.packages?.["node_modules/react-virtuoso"]
  if (
    pkg.dependencies?.[manifest.name] !== manifest.version ||
    lock.packages?.[""]?.dependencies?.[manifest.name] !== manifest.version ||
    locked?.version !== manifest.version ||
    locked?.resolved !== manifest.lockedTarball ||
    locked?.integrity !== manifest.upstreamIntegrity
  )
    fail("DEPENDENCY_LOCK_INVALID")
  const packageRoot = resolve(workspaceRoot, "node_modules/react-virtuoso")
  if (
    hash(readEvidence(resolve(packageRoot, "package.json"))) !== manifest.packageSha256 ||
    hash(readEvidence(resolve(packageRoot, "LICENSE"))) !== manifest.licenseSha256
  )
    fail("PACKAGE_EVIDENCE_INVALID")
  const targets = manifest.files.map((file) => {
    const absolutePath = resolve(packageRoot, file.path)
    const bytes = readFileSync(absolutePath)
    const digest = hash(bytes)
    return {
      ...file,
      absolutePath,
      bytes,
      state:
        digest === file.beforeSha256 ? "before" : digest === file.afterSha256 ? "after" : "unknown"
    }
  })
  const installed = targets.every((target) => target.state === "after")
  // The unchanged declaration file belongs to both tuples. Compare the whole
  // previous tuple, rather than accepting a per-file mixture of old and new.
  const previousInstalled = targets.every((target, index) =>
    hash(target.bytes) === previousFiles[index].sha256)
  if (!installed && !previousInstalled && !targets.every((target) => target.state === "before"))
    fail("MIXED_OR_UNKNOWN_FILES")
  if (!installed) {
    const outputs = previousInstalled ? new Map(targets.map((target, index) => {
      let text = target.bytes.toString("utf8")
      for (const edit of previousFiles[index].replacements) {
        const offset = text.indexOf(edit.before)
        if (offset < 0 || text.indexOf(edit.before, offset + 1) >= 0)
          fail("PATCH_TARGET_INVALID")
        // Literal slices deliberately avoid String.replace's $ replacement syntax.
        text = text.slice(0, offset) + edit.after + text.slice(offset + edit.before.length)
      }
      return [target.path, Buffer.from(text, "utf8")]
    })) : applyNativeTextPatch(
      patch.toString("utf8"),
      new Map(targets.map((target) => [target.path, target.bytes]))
    )
    for (const target of targets) {
      target.afterBytes = outputs.get(target.path)
      if (!target.afterBytes || hash(target.afterBytes) !== target.afterSha256)
        fail("PATCH_TARGET_INVALID")
    }
  }
  return { targets, evidence, installed }
}

function assertEvidence(plan) {
  for (const [path, bytes] of plan.evidence)
    if (!readFileSync(path).equals(bytes)) fail("EVIDENCE_CHANGED")
}
function assertUnchanged(plan) {
  assertEvidence(plan)
  for (const target of plan.targets)
    if (!readFileSync(target.absolutePath).equals(target.bytes)) fail("TARGET_CHANGED")
}

/** Synchronous and read-only, including when the package is missing or still unpatched. */
export function checkReactVirtuosoScrollCancel({ workspaceRoot = repository } = {}) {
  const plan = prepare(resolve(workspaceRoot))
  assertUnchanged(plan)
  if (!plan.installed) fail("NOT_INSTALLED")
  return { status: "installed", targets: paths.length }
}

function ownedFile(path, bytes, owned) {
  const descriptor = openSync(path, "wx")
  const record = { path, bytes, identity: fstatSync(descriptor), consumed: false, complete: false }
  owned.push(record)
  try {
    writeFileSync(descriptor, bytes)
    record.complete = true
  } finally {
    closeSync(descriptor)
  }
  return record
}
function assertOwned(record) {
  const actual = statSync(record.path)
  const bytes = readFileSync(record.path)
  if (
    actual.dev !== record.identity.dev ||
    actual.ino !== record.identity.ino ||
    !(record.complete
      ? bytes.equals(record.bytes)
      : bytes.length <= record.bytes.length && bytes.equals(record.bytes.subarray(0, bytes.length)))
  )
    fail("OWN_FILE_CHANGED")
}

/** The independent three-file patch never extends the LangChain foundation target set. */
export async function installReactVirtuosoScrollCancel({
  workspaceRoot = repository,
  checkOnly = false
} = {}) {
  workspaceRoot = resolve(workspaceRoot)
  if (checkOnly) return checkReactVirtuosoScrollCancel({ workspaceRoot })
  const initial = prepare(workspaceRoot)
  assertUnchanged(initial)
  if (initial.installed) return { status: "installed", targets: paths.length }
  const owned = [],
    staged = [],
    committed = [],
    failures = []
  const nonce = randomUUID()
  try {
    let lock
    try {
      lock = ownedFile(
        resolve(workspaceRoot, "node_modules/.cmb-react-virtuoso-scroll-cancel.lock"),
        Buffer.from(JSON.stringify({ nonce, pid: process.pid })),
        owned
      )
    } catch (reason) {
      if (reason?.code === "EEXIST") fail("INSTALL_BUSY")
      throw reason
    }
    assertUnchanged(initial)
    for (const target of initial.targets) {
      const temporary = ownedFile(
        `${target.absolutePath}.cmb-${nonce}.tmp`,
        target.afterBytes,
        owned
      )
      const rollback = ownedFile(
        `${target.absolutePath}.cmb-${nonce}.rollback`,
        target.bytes,
        owned
      )
      staged.push({ target, temporary, rollback })
    }
    assertOwned(lock)
    assertUnchanged(initial)
    for (const entry of staged) {
      assertOwned(lock)
      assertOwned(entry.temporary)
      if (!readFileSync(entry.target.absolutePath).equals(entry.target.bytes))
        fail("TARGET_CHANGED")
      renameSync(entry.temporary.path, entry.target.absolutePath)
      entry.temporary.consumed = true
      committed.push(entry)
    }
    assertOwned(lock)
    assertEvidence(initial)
    checkReactVirtuosoScrollCancel({ workspaceRoot })
  } catch (reason) {
    failures.push(reason)
    for (const entry of committed.reverse()) {
      try {
        const current = statSync(entry.target.absolutePath)
        if (
          current.dev !== entry.temporary.identity.dev ||
          current.ino !== entry.temporary.identity.ino ||
          !readFileSync(entry.target.absolutePath).equals(entry.target.afterBytes)
        )
          fail("ROLLBACK_TARGET_CHANGED")
        assertOwned(entry.rollback)
        renameSync(entry.rollback.path, entry.target.absolutePath)
        entry.rollback.consumed = true
      } catch (rollbackReason) {
        failures.push(rollbackReason)
      }
    }
  } finally {
    for (const record of owned.reverse()) {
      if (record.consumed) continue
      try {
        assertOwned(record)
        unlinkSync(record.path)
      } catch (reason) {
        failures.push(reason)
      }
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "REACT_VIRTUOSO_SCROLL_CANCEL_INSTALL_FAILED")
  if (failures.length) throw failures[0]
  return { status: "applied", targets: paths.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installReactVirtuosoScrollCancel({
    checkOnly: process.argv.includes("--check")
  })
    .then((result) => {
      process.stdout.write(`react-virtuoso scroll cancellation: ${result.status} ${result.targets}\n`)
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

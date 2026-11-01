import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { ModsSourceManifest } from "./mods-source-candidate"

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const inside = (root: string, path: string) => {
  const tail = relative(root, realpathSync(path))
  assert(
    tail &&
      !isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith("..\\") &&
      !tail.startsWith("../"),
    "HISTORICAL_SOURCE_OUTSIDE_CANDIDATE"
  )
}
const safeRelative = (path: string) =>
  path &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes(":") &&
  path.split("/").every((part) => part && part !== "." && part !== "..")

/**
 * Immutable prior build evidence only. Intentionally returns no runnable entry or renderer URL.
 * New execution must still use readModsSourceCandidate and its current-checkout source fence.
 */
export function readModsHistoricalSourceReference(
  path: string,
  expected: {
    repository: string
    manifestSha256: string
  }
) {
  assert(sha(expected.manifestSha256), "HISTORICAL_SOURCE_MANIFEST_SHA_REQUIRED")
  const repository = realpathSync(expected.repository)
  const manifestPath = realpathSync(path)
  assert(
    /^output\/phase3-source-[a-z-]+-[a-f0-9]{8}\/candidate\/source-candidate\.json$/.test(
      relative(repository, manifestPath).replaceAll("\\", "/")
    ),
    "HISTORICAL_SOURCE_REQUIRES_OWNED_CANDIDATE"
  )
  assert(
    lstatSync(manifestPath).isFile() && lstatSync(manifestPath).size <= 8 * 1024 * 1024,
    "HISTORICAL_SOURCE_MANIFEST_LIMIT"
  )
  assert.equal(hash(manifestPath), expected.manifestSha256, "HISTORICAL_SOURCE_MANIFEST_CHANGED")
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as ModsSourceManifest
  assert.equal(value.execution, "source-isolated", "HISTORICAL_SOURCE_KIND_REQUIRED")
  assert.equal(realpathSync(value.repository), repository, "HISTORICAL_SOURCE_REPOSITORY_CHANGED")
  const root = realpathSync(dirname(manifestPath))
  assert.equal(realpathSync(value.root), root, "HISTORICAL_SOURCE_ROOT_CHANGED")
  assert.equal(resolve(value.entry), join(root, "out/main/index.js"))
  assert(/^[a-f0-9]{40}$/.test(value.head), "HISTORICAL_SOURCE_HEAD_REQUIRED")
  assert(
    value.files &&
      typeof value.files === "object" &&
      !Array.isArray(value.files) &&
      Object.keys(value.files).length > 0 &&
      Object.keys(value.files).length <= 20000
  )
  for (const [file, digest] of Object.entries(value.files)) {
    assert(safeRelative(file) && sha(digest), "HISTORICAL_SOURCE_FILE_INVALID")
    const actual = resolve(root, file)
    inside(root, actual)
    assert(
      lstatSync(actual).isFile() && !lstatSync(actual).isSymbolicLink(),
      "HISTORICAL_SOURCE_FILE_UNSAFE"
    )
    assert.equal(hash(actual), digest, `HISTORICAL_SOURCE_ARTIFACT_CHANGED:${file}`)
  }
  assert(
    sha(value.files["out/main/index.js"]) && sha(value.files["out/preload/index.js"]),
    "HISTORICAL_SOURCE_NATIVE_ENTRIES_REQUIRED"
  )
  assert(
    sha(value.dependencies) && hash(join(repository, "package-lock.json")) === value.dependencies,
    "HISTORICAL_SOURCE_DEPENDENCIES_CHANGED"
  )
  assert(
    Array.isArray(value.sourceRoots) &&
      value.sourceRoots.length &&
      value.sourceRoots.every((root) => typeof root === "string" && safeRelative(root)),
    "HISTORICAL_SOURCE_ROOTS_REQUIRED"
  )
  assert(
    value.sources &&
      typeof value.sources === "object" &&
      !Array.isArray(value.sources) &&
      Object.keys(value.sources).length > 0 &&
      Object.entries(value.sources).every(([file, digest]) => safeRelative(file) && sha(digest)),
    "HISTORICAL_SOURCE_INPUT_SIGNATURES_REQUIRED"
  )
  assert.equal(hash(manifestPath), expected.manifestSha256, "HISTORICAL_SOURCE_MANIFEST_CHANGED")
  return {
    execution: "historical-source-reference" as const,
    headBasis: "recorded-git-head-only-not-a-clean-checkout-claim" as const,
    sourceBasis: "immutable-manifest-signatures-and-compiled-artifacts" as const,
    repository,
    head: value.head,
    manifestPath,
    manifestSha256: expected.manifestSha256,
    mainSha256: value.files["out/main/index.js"],
    sourceSignatures: value.sources,
    dependencies: value.dependencies
  }
}

/** Cross-link a native JSON observation to its already completed source-wrapper proof. */
export function readHistoricalSourceWrapper(path: string, repository: string) {
  const record = JSON.parse(readFileSync(join(dirname(dirname(path)), "run.json"), "utf8"))
  assert.equal(
    realpathSync(record.candidate),
    realpathSync(path),
    "HISTORICAL_SOURCE_WRAPPER_CANDIDATE_CHANGED"
  )
  assert.equal(record.realModel, true, "HISTORICAL_SOURCE_REAL_MODEL_REQUIRED")
  assert.equal(record.driverIntegrityVerified, true, "HISTORICAL_SOURCE_WRAPPER_INTEGRITY_REQUIRED")
  assert(
    record.driverHashes &&
      Object.keys(record.driverHashes).length > 0 &&
      Object.values(record.driverHashes).every(sha),
    "HISTORICAL_SOURCE_DRIVER_SIGNATURES_REQUIRED"
  )
  const reference = readModsHistoricalSourceReference(path, {
    repository,
    manifestSha256: record.manifestSha256
  })
  assert.equal(record.head, reference.head, "HISTORICAL_SOURCE_WRAPPER_HEAD_CHANGED")
  return reference
}

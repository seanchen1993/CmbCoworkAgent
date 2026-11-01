import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { join, relative } from "node:path"
import type { AuthoringFile } from "../../src/shared/mods/authoring"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"

interface SourceProof {
  realAuthoring: boolean
  build: { execution: string }
  observations: Array<{
    drafts: Array<{ id: string; name: string; revision: number; digest: string }>
    nativeReadCount: number
    nativeReadReceipt: { messageId: string }
    sourceFiles: Array<{ path: string; sha256: string }>
    trials: Array<{
      draftId: string
      revision: number
      bundleDigest: string
      compiledDigest: string
    }>
  }>
  requests: Array<{ status: number; tools: Array<{ action: string; sdkQuery?: string }> }>
}

/** Copies only verified author files into a fresh scope. No profile, trial authority or grant. */
export function readGenericLiveSourceContinuation(repository: string, run: string) {
  const profile = realpathSync(run)
  const tail = relative(realpathSync(join(repository, "output")), profile).replaceAll("\\", "/")
  assert(
    /^phase3-source-generic-mod-[a-f0-9]{8}\/journey\/run-[A-Za-z0-9]+$/.test(tail),
    "CONTINUATION_REQUIRES_OWNED_REAL_MODEL_RUN"
  )
  const evidencePath = join(profile, "evidence.json")
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as SourceProof
  assert(evidence.realAuthoring === true && evidence.build.execution === "source-isolated")
  const observed = evidence.observations?.[0]
  const draft = observed?.drafts?.[0]
  assert(
    draft && observed.nativeReadCount === 1 && observed.nativeReadReceipt?.messageId,
    "CONTINUATION_REQUIRES_OBSERVED_NATIVE_SOURCE"
  )
  assert(
    evidence.requests.some(
      (request) =>
        request.status === 200 &&
        request.tools.some((tool) => tool.action === "catalog" && tool.sdkQuery === "prompt.paint")
    ),
    "CONTINUATION_REQUIRES_REAL_SDK_QUERY"
  )
  const expected = new Map<string, string>(
    observed.sourceFiles.map((file) => [file.path, file.sha256])
  )
  const compiled = new Set(
    observed.trials
      .filter(
        (row) =>
          row.draftId === draft.id &&
          row.revision === draft.revision &&
          row.bundleDigest === draft.digest
      )
      .map((row) => row.compiledDigest)
  )
  assert(compiled.size > 0, "CONTINUATION_ORIGINAL_COMPILE_RECEIPT_REQUIRED")
  const base = join(profile, "data/mod-development")
  const records = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((scope) =>
      readdirSync(join(base, scope.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(base, scope.name, entry.name, "record.json"))
    )
    .map((path) => JSON.parse(readFileSync(path, "utf8")))
    .filter(
      (record) =>
        record.schemaVersion === 1 &&
        record.coverage === "prepared-source-only-v1" &&
        record.draftId === draft.id &&
        record.revision === draft.revision &&
        record.sourceDigest === draft.digest &&
        compiled.has(record.compiledDigest)
    )
  assert.equal(records.length, 1, "CONTINUATION_EXACT_NATIVE_RECORD_REQUIRED")
  const source = records[0].source
  assert(
    source.schemaVersion === 1 && source.digest === draft.digest && Array.isArray(source.files)
  )
  assert.equal(
    createAuthoringSourceBundle(source.files).digest,
    draft.digest,
    "CONTINUATION_NATIVE_BUNDLE_CHANGED"
  )
  assert(
    source.files.length > 0 && source.files.length <= 128 && source.files.length === expected.size
  )
  const files = source.files as AuthoringFile[]
  assert(
    files.reduce((sum, file) => sum + Buffer.byteLength(file.text, "utf8"), 0) <= 2 * 1024 * 1024
  )
  for (const file of files)
    assert.equal(
      createHash("sha256").update(file.text).digest("hex"),
      expected.get(file.path),
      `CONTINUATION_SOURCE_CHANGED:${file.path}`
    )
  return {
    profile,
    evidencePath,
    originalBuild: evidence.build,
    id: draft.id as string,
    name: draft.name as string,
    revision: draft.revision,
    sourceDigest: draft.digest as string,
    files
  }
}

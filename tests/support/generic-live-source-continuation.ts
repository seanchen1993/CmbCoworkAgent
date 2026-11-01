import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { AuthoringFile } from "../../src/shared/mods/authoring"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { readHistoricalSourceWrapper } from "./mods-historical-source-reference"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"

interface SourceProof {
  threadId?: string
  realAuthoring: boolean
  build: { execution: string; sourceManifest?: string; path?: string; sha256?: string }
  sourceContinuation?: { evidence: string; sourceDigest: string }
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
    paint?: {
      jobId: string
      textUnchanged: boolean
      cursorUnchanged: boolean
      virtualTextVisible: boolean
    }
  }>
  requests: Array<{ status: number; tools: Array<{ action: string; sdkQuery?: string }> }>
}

/** Copies only verified author files into a fresh scope. No profile, trial authority or grant. */
export function readGenericLiveSourceContinuation(
  repository: string,
  run: string,
  receiptEvidence?: string
) {
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
  let compileObservation = observed
  let receiptProof:
    | { path: string; manifestPath: string; hashes: Record<string, string> }
    | undefined
  if (receiptEvidence) {
    const path = realpathSync(receiptEvidence)
    assert(
      /^(?:source-continuation-\d+\.json|continuation-[a-f0-9-]{36}\/evidence\.json)$/.test(
        relative(profile, path).replaceAll("\\", "/")
      ),
      "CONTINUATION_RECEIPT_SCOPE"
    )
    const receipt = JSON.parse(readFileSync(path, "utf8")) as SourceProof
    assert.equal(receipt.realAuthoring, true, "CONTINUATION_NATIVE_REAL_AUTHORING_REQUIRED")
    assert.equal(receipt.build.execution, "source-isolated")
    assert(receipt.build.sourceManifest, "CONTINUATION_NATIVE_MANIFEST_REQUIRED")
    const candidate = readHistoricalSourceWrapper(receipt.build.sourceManifest, repository)
    assert.equal(realpathSync(candidate.repository), realpathSync(repository))
    assert.equal(receipt.build.sha256, candidate.mainSha256, "CONTINUATION_RECEIPT_MAIN_CHANGED")
    assert(
      receipt.build.path &&
        realpathSync(receipt.build.path) ===
          realpathSync(join(dirname(candidate.manifestPath), "out/main/index.js")),
      "CONTINUATION_RECEIPT_ENTRY_CHANGED"
    )
    assert(
      evidence.threadId && receipt.threadId === evidence.threadId,
      "CONTINUATION_RECEIPT_THREAD_CHANGED"
    )
    assert.equal(realpathSync(receipt.sourceContinuation!.evidence), realpathSync(evidencePath))
    assert.equal(receipt.sourceContinuation!.sourceDigest, draft.digest)
    const matches = receipt.observations.filter(
      (row) =>
        row.drafts[0]?.id === draft.id &&
        row.drafts[0].revision === draft.revision &&
        row.drafts[0].digest === draft.digest &&
        row.nativeReadCount === 1 &&
        row.nativeReadReceipt?.messageId &&
        row.paint?.jobId &&
        row.paint.textUnchanged &&
        row.paint.cursorUnchanged &&
        row.paint.virtualTextVisible
    )
    assert.equal(matches.length, 1, "CONTINUATION_EXACT_SUCCESSFUL_NATIVE_WITNESS_REQUIRED")
    compileObservation = matches[0]
    assert.deepEqual(
      new Map(compileObservation.sourceFiles.map((file) => [file.path, file.sha256])),
      expected,
      "CONTINUATION_RECEIPT_SOURCE_CHANGED"
    )
    const protectedPaths = [
      path,
      candidate.manifestPath,
      join(dirname(dirname(candidate.manifestPath)), "run.json")
    ]
    receiptProof = {
      path,
      manifestPath: candidate.manifestPath,
      hashes: Object.fromEntries(
        protectedPaths.map((file) => [
          file,
          createHash("sha256").update(readFileSync(file)).digest("hex")
        ])
      )
    }
  }
  const compiled = new Set(
    compileObservation.trials
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
        (!receiptProof ||
          normalizeWorkspacePathKey(record.workspace) ===
            normalizeWorkspacePathKey(join(profile, "workspace"))) &&
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
    files,
    ...(receiptProof ? { receiptProof } : {})
  }
}

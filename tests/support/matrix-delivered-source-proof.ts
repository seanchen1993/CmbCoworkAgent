/** Historical evidence is an immutable source reference, never new execution or authority. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { readModsSourceCandidate } from "./mods-source-candidate"
import { verifyLiveProjectZipIdentity } from "./live-project-zip-identity"
import { assertMatrixAssembly } from "./creator-project-matrix"

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const sha = (value: unknown) => assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
function inside(root: string, path: string) {
  const actual = realpathSync(path)
  const tail = relative(root, actual)
  assert(
    tail &&
      !isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith("..\\") &&
      !tail.startsWith("../"),
    "DELIVERED_SOURCE_OUTSIDE_OWNED_RUN"
  )
  return actual
}

/** Structural producer checks are also exposed for isolated negative tests without a candidate. */
export function validateDeliveredMatrixEvidence(input: {
  caseRun: ReturnType<typeof read>
  evidence: ReturnType<typeof read>
  runtime: ReturnType<typeof read>
  first: ReturnType<typeof read>
  assembly: ReturnType<typeof read>
}) {
  const { caseRun, evidence, runtime, first, assembly } = input
  assert.equal(caseRun.scenario, "report-derived")
  assert.equal(caseRun.realModel, true)
  assert.equal(caseRun.driverIntegrityVerified, true)
  assert.equal(evidence.model?.realProvider, true)
  assert.equal(evidence.observations?.length, 1)
  const observation = evidence.observations[0]
  assert(Array.isArray(observation.requests) && observation.requests.length > 0)
  assert(observation.requests.every((request: { status?: number }) => request.status === 200))
  assert.equal(observation.runtime?.controlled, false)
  const runtimeRequests = observation.runtime.stages.flatMap(
    (stage: { requests: Array<{ status?: number }> }) => stage.requests
  ) as Array<{ status?: number }>
  assert(runtimeRequests.length > 0 && runtimeRequests.every((request) => request.status === 200))
  assert.equal(observation.runtime.requests, runtimeRequests.length)
  const project = observation.runtime.project
  assert.equal(project?.controlledOutputs, false)
  assert.equal(project.trial.status, "completed")
  assert(project.trial.stages.length > 0)
  assert.equal(project.trial.stageIndex, project.trial.stages.length)
  const trialEvents = runtime.events.filter((event: { trial?: unknown }) => event.trial)
  assert.equal(trialEvents.length, 1)
  assert.deepEqual(trialEvents[0].trial, project.trial)
  const nativeStages = runtime.events.filter(
    (event: { status?: string }) => event.status === "succeeded"
  )
  assert.equal(nativeStages.length, project.trial.stages.length)
  assert.deepEqual(
    nativeStages.map((event: { stageId: string }) => event.stageId),
    project.trial.stages
  )
  assert(
    nativeStages.every(
      (event: { checks: Array<{ result: string }> }) =>
        event.checks.length > 0 && event.checks.every((check) => check.result === "passed")
    )
  )
  const uploads = runtime.events.filter(
    (event: { operation?: string }) => event.operation === "zip-original-upload"
  )
  assert.equal(uploads.length, 1)
  const { operation: _operation, identity, ...zip } = uploads[0]
  assert.equal(_operation, "zip-original-upload")
  assert.deepEqual(zip, project.zip)
  assert.equal(zip.upload, "original-PluginsPanel-file-input")
  assert.equal(zip.copiedGrants, false)
  const delivery = project.delivery
  sha(project.sameCandidateDigest)
  assert.equal(project.sameCandidateDigest, delivery.sourceDigest)
  assert.equal(delivery.sourceDigest, zip.sourceDigest)
  assert.equal(delivery.pluginId, zip.newInstallation)
  assert.equal(delivery.originalPluginId, zip.oldInstallation)
  assert.notEqual(zip.newInstallation, zip.oldInstallation)
  assert.deepEqual(identity, {
    pluginId: delivery.pluginId,
    name: delivery.name,
    version: delivery.version,
    digest: delivery.digest
  })
  sha(delivery.digest)
  sha(zip.sha256)
  assert.equal(delivery.digest, zip.packageDigest)
  assert.equal(zip.originalPackageDigest, zip.packageIdentity.originalContentDigest)
  assert.equal(zip.packageDigest, zip.packageIdentity.zipContentDigest)
  assert.equal(zip.sha256, zip.packageIdentity.zipSha256)
  assert.equal(assembly.originVerified, true)
  assert.equal(assembly.assemblyVerified, true)
  assert.equal(assembly.after.digest, delivery.sourceDigest)
  assert.equal(assembly.after.draftId, first.draftId)
  assert(assembly.after.revision > first.revision && assembly.after.digest !== first.digest)
  assert(/^[a-f0-9-]{36}$/.test(delivery.id), "DELIVERED_SOURCE_DELIVERY_ID_INVALID")
  return {
    observation,
    project,
    zip,
    nativeStages,
    authorRequests: observation.requests.length,
    runtimeRequests: runtimeRequests.length
  }
}

export interface DeliveredMatrixSourceProof {
  run: string
  zip: string
  identity: { name: string; version: string; digest: string }
  sourceDigest: string
  originalDirectory: string
  originalContentDigest: string
  hashes: Record<string, string>
  sourceHead: string
  driverHashes: Record<string, string>
  prior: { authorRequests: number; runtimeRequests: number; nativeStages: string[] }
  packageIdentity: Awaited<ReturnType<typeof verifyLiveProjectZipIdentity>>
}

export async function verifyDeliveredMatrixSourceProof(
  proof: Pick<DeliveredMatrixSourceProof, "hashes">
) {
  assert(Object.keys(proof.hashes).length > 0, "DELIVERED_SOURCE_HASHES_REQUIRED")
  for (const [path, expected] of Object.entries(proof.hashes)) {
    assert(isAbsolute(path), "DELIVERED_SOURCE_ABSOLUTE_PATH_REQUIRED")
    sha(expected)
    assert.equal(digest(path), expected, `DELIVERED_SOURCE_CHANGED:${path}`)
  }
}

export async function readDeliveredMatrixSourceProof(
  repository: string,
  run: string
): Promise<DeliveredMatrixSourceProof> {
  const root = realpathSync(repository)
  const ownedRun = inside(root, run)
  assert(
    /^output\/phase3-source-report-derived-[a-f0-9]{8}\/journey\/run-[A-Za-z0-9]+$/.test(
      relative(root, ownedRun).replaceAll("\\", "/")
    ),
    "DELIVERED_SOURCE_RUN_NOT_OWNED"
  )
  const caseRoot = dirname(dirname(ownedRun))
  const files = {
    caseRun: join(caseRoot, "run.json"),
    evidence: join(ownedRun, "evidence.json"),
    runtime: join(ownedRun, "evidence-matrix-1-runtime.json"),
    first: join(ownedRun, "matrix-1-first.json"),
    assembly: join(ownedRun, "matrix-1-assembly.json"),
    manifest: join(caseRoot, "candidate/source-candidate.json")
  }
  const hashes: Record<string, string> = {}
  const remember = (path: string, expected?: string) => {
    const actual = inside(root, path)
    const value = digest(actual)
    if (expected) assert.equal(value, expected, `DELIVERED_SOURCE_CONTENT_CHANGED:${actual}`)
    hashes[actual] = value
    return actual
  }
  Object.values(files).forEach((path) => remember(path))
  const candidate = readModsSourceCandidate(files.manifest)
  assert.equal(realpathSync(candidate.repository), root)
  const caseRun = read(files.caseRun)
  assert.equal(caseRun.head, candidate.head)
  assert.equal(realpathSync(caseRun.candidate), realpathSync(files.manifest))
  assert.equal(caseRun.manifestSha256, hashes[realpathSync(files.manifest)])
  assert(Object.keys(caseRun.driverHashes).length > 0)
  for (const value of Object.values(caseRun.driverHashes)) sha(value)
  const first = read(files.first),
    assembly = read(files.assembly)
  const facts = validateDeliveredMatrixEvidence({
    caseRun,
    evidence: read(files.evidence),
    runtime: read(files.runtime),
    first,
    assembly
  })
  assertMatrixAssembly(first, assembly.after, "report-derived")
  const zip = remember(inside(ownedRun, facts.zip.zip), facts.zip.sha256)
  const originalDirectory = inside(
    ownedRun,
    join(ownedRun, "data/creator-project-deliveries", facts.project.delivery.id)
  )
  for (const [file, expected] of Object.entries(facts.zip.packageIdentity.fileHashes)) {
    if (file === "devclaw.package-report.json") continue
    assert(typeof expected === "string")
    remember(inside(originalDirectory, resolve(originalDirectory, file)), expected)
  }
  const artifacts = facts.project.trial.artifacts as Array<{
    path: string
    bytes: number
    sha256: string
  }>
  assert(artifacts.length > 0)
  const runtime = read(files.runtime)
  const workspaces = new Set<string>()
  for (const artifact of artifacts) {
    assert(
      /^[A-Za-z0-9_.-]+\.json$/.test(artifact.path),
      "DELIVERED_SOURCE_ROOT_JSON_ARTIFACT_REQUIRED"
    )
    const matches = runtime.events.filter(
      (event: { kind?: string; operation?: string; filePath?: string }) =>
        event.kind === "trial" &&
        event.operation === "write_file" &&
        typeof event.filePath === "string" &&
        event.filePath.replaceAll("\\", "/").endsWith("/" + artifact.path)
    )
    assert.equal(matches.length, 1, "DELIVERED_SOURCE_TRIAL_ARTIFACT_AMBIGUOUS")
    const actual = inside(ownedRun, matches[0].filePath)
    const workspace = dirname(actual)
    workspaces.add(workspace)
    assert.equal(resolve(workspace, artifact.path), actual)
    remember(actual, artifact.sha256)
    assert.equal(statSync(actual).size, artifact.bytes)
  }
  assert.equal(workspaces.size, 1, "DELIVERED_SOURCE_TRIAL_WORKSPACE_CHANGED")
  const packageIdentity = await verifyLiveProjectZipIdentity({
    zip,
    originalDirectory,
    expectedOriginalDigest: facts.zip.originalPackageDigest,
    name: facts.project.delivery.name,
    version: facts.project.delivery.version
  })
  assert.deepEqual(packageIdentity, facts.zip.packageIdentity)
  const proof: DeliveredMatrixSourceProof = {
    run: ownedRun,
    zip,
    identity: {
      name: facts.project.delivery.name,
      version: facts.project.delivery.version,
      digest: packageIdentity.zipContentDigest
    },
    sourceDigest: facts.project.delivery.sourceDigest,
    originalDirectory,
    originalContentDigest: packageIdentity.originalContentDigest,
    hashes,
    sourceHead: candidate.head,
    driverHashes: caseRun.driverHashes,
    prior: {
      authorRequests: facts.authorRequests,
      runtimeRequests: facts.runtimeRequests,
      nativeStages: facts.nativeStages.map((stage: { stageId: string }) => stage.stageId)
    },
    packageIdentity
  }
  await verifyDeliveredMatrixSourceProof(proof)
  readModsSourceCandidate(files.manifest)
  return proof
}

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { readAuthoringProjectSource } from "../../src/main/mods/devtools/project-source"
import { nativeCompositionActionRequirements } from "../../src/main/plugins/native-composition-dependencies"
import {
  readGenericProjectCandidate,
  type GenericProjectCandidate
} from "./generic-project-creator-scenario"

/** Export a verified real author revision, adding only a reviewable source-set envelope. */
export async function prepareProjectLiveSourceContinuation(
  repository: string,
  run: string,
  output: string
) {
  const profile = realpathSync(run)
  const tail = relative(realpathSync(join(repository, "output")), profile).replaceAll("\\", "/")
  assert(
    /^phase3-source-project-[a-f0-9]{8}\/journey\/run-[A-Za-z0-9]+$/.test(tail),
    "PROJECT_CONTINUATION_REQUIRES_OWNED_REAL_RUN"
  )
  const evidencePath = join(profile, "evidence.json")
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"))
  assert(
    evidence.model?.realProvider === true && evidence.candidate.execution === "source-isolated"
  )
  assert(
    evidence.observations.length === 1 &&
      evidence.observations[0].requests.some((row: { status: number }) => row.status === 200)
  )
  const original = JSON.parse(
    readFileSync(join(profile, "generic-project-replacement.json"), "utf8")
  ).after as GenericProjectCandidate
  assert(/^[a-f0-9]{64}$/.test(original.digest) && original.revision > 1)
  const retained = readGenericProjectCandidate(profile, original)
  assert.deepEqual(retained, original, "PROJECT_CONTINUATION_NATIVE_SOURCE_CHANGED")
  assert.equal(
    nativeCompositionActionRequirements(retained.source).length,
    0,
    "PROJECT_CONTINUATION_DEPENDENCIES_REQUIRE_FRESH_REVIEW"
  )
  const snapshot = await readAuthoringProjectSource(retained.directory)
  assert.equal(snapshot.bundle.digest, retained.digest, "PROJECT_CONTINUATION_BUNDLE_CHANGED")
  assert(!existsSync(output), "PROJECT_CONTINUATION_REQUIRES_NEW_OUTPUT")
  const outputTail = relative(join(repository, "output"), output)
  assert(
    !isAbsolute(outputTail) && outputTail && !outputTail.startsWith(".."),
    "PROJECT_CONTINUATION_OUTPUT_OUTSIDE_ISOLATION"
  )
  const project = join(output, "project")
  mkdirSync(project, { recursive: true })
  const files: Array<{ path: string; sha256: string }> = []
  for (const file of snapshot.bundle.files) {
    const destination = join(project, file.path)
    const within = relative(project, destination)
    assert(
      within && !isAbsolute(within) && !within.startsWith(".."),
      "PROJECT_CONTINUATION_PATH_ESCAPE"
    )
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.text, { flag: "wx" })
    assert.equal(readFileSync(destination, "utf8"), file.text)
    files.push({ path: file.path, sha256: createHash("sha256").update(file.text).digest("hex") })
  }
  const envelope = {
    protocol: "devclaw.project-source-set/v1",
    title: "真实作者资料整理源续验",
    goal: "沿用已真实生成和对话调整后的源，使用新的隔离项目、当前检查和新授权继续验收。",
    project: "project",
    dependencies: []
  }
  writeFileSync(join(output, "devclaw.source-set.json"), JSON.stringify(envelope, null, 2), {
    flag: "wx"
  })
  const provenance = {
    evidencePath,
    originalBuild: evidence.candidate,
    originalRevision: retained.revision,
    originalSourceDigest: retained.digest,
    originalDirectory: retained.directory,
    originalSource: retained.source,
    originalSkills: retained.skills,
    files,
    addedEnvelope: "devclaw.source-set.json",
    copiedConfiguration: false,
    copiedGrants: false
  }
  writeFileSync(join(output, "continuation-provenance.json"), JSON.stringify(provenance, null, 2), {
    flag: "wx"
  })
  return { directory: output, provenance }
}

import assert from "node:assert/strict"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import { parseHostStageInstructions } from "../../src/main/harness-board/project-runtime/host-state-protocol"

export function prepareLeanResume(input: {
  run: string
  artifactRoot: string
  projectId: string
  appDigest: string
  sourceDigest: string
  feedbackPath: string
}) {
  const same = (a: string, b: string) =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
  const isolated = realpathSync(input.run)
  assert(/^run-[a-zA-Z0-9]{6}$/.test(basename(isolated)), "LEAN_RESUME_RUN_REQUIRED")
  assert(same(isolated, resolve(input.run)), "LEAN_RESUME_LINK_FORBIDDEN")
  assert(same(dirname(isolated), realpathSync(input.artifactRoot)), "LEAN_RESUME_ROOT_MISMATCH")
  for (const folder of [
    "",
    "workspace",
    "electron",
    "data",
    "home",
    "temp",
    "appdata",
    "localappdata"
  ]) {
    const path = join(isolated, folder)
    assert(
      lstatSync(path).isDirectory() &&
        !lstatSync(path).isSymbolicLink() &&
        same(realpathSync(path), path),
      "LEAN_RESUME_LINK_FORBIDDEN"
    )
  }
  const read = (name: string) => {
    const path = join(isolated, name)
    assert(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      "LEAN_RESUME_FILE_REQUIRED"
    )
    return JSON.parse(readFileSync(path, "utf8"))
  }
  const prior = read("evidence.json")
  const initial = read("baseline-prepared.json") as LocalProjectView
  const source = read("authoring-source-provenance.json")
  assert.equal(prior.candidate.sha256, input.appDigest, "LEAN_RESUME_APP_CHANGED")
  assert.match(input.sourceDigest, /^[a-f0-9]{64}$/, "LEAN_RESUME_SOURCE_DIGEST_REQUIRED")
  assert.equal(source.bundleDigest, input.sourceDigest, "LEAN_RESUME_SOURCE_CHANGED")
  assert.equal(prior.projectId, input.projectId, "LEAN_RESUME_PROJECT_CHANGED")
  assert.equal(initial.project.projectId, input.projectId, "LEAN_RESUME_PROJECT_CHANGED")
  assert(
    same(initial.project.workspace, join(isolated, "workspace")),
    "LEAN_RESUME_WORKSPACE_CHANGED"
  )
  assert.deepEqual(
    prior.expectedStages,
    initial.project.manifest.stages.map((stage) => stage.id),
    "LEAN_RESUME_MANIFEST_CHANGED"
  )
  const feedback = parseHostStageInstructions(readFileSync(input.feedbackPath, "utf8"))!
  const previous = readdirSync(isolated)
    .filter((name) => /^resume-\d{2}$/.test(name))
    .sort()
  const attempt = previous.length + 2
  assert(
    attempt <= 4 &&
      previous.every((name, index) => name === `resume-${String(index + 2).padStart(2, "0")}`),
    "LEAN_RESUME_ATTEMPT_LIMIT"
  )
  const directory = join(isolated, `resume-${String(attempt).padStart(2, "0")}`)
  mkdirSync(directory)
  writeFileSync(
    join(directory, "resume-request.json"),
    JSON.stringify(
      {
        ...input,
        isolated,
        attempt,
        feedback,
        previousEvidence: join(isolated, "evidence.json")
      },
      null,
      2
    )
  )
  return {
    isolated,
    directory,
    attempt,
    initial: initial.project,
    feedback,
    sourceDigest: source.bundleDigest as string
  }
}

export function assertLeanResumeProject(
  view: LocalProjectView,
  initial: LocalProjectView["project"]
) {
  assert.equal(view.project.projectId, initial.projectId, "LEAN_RESUME_PROJECT_CHANGED")
  assert.equal(view.project.workspace, initial.workspace, "LEAN_RESUME_WORKSPACE_CHANGED")
  assert.equal(view.project.goal, initial.goal, "LEAN_RESUME_GOAL_CHANGED")
  assert.equal(view.project.pluginDigest, initial.pluginDigest, "LEAN_RESUME_PACKAGE_CHANGED")
  assert.deepEqual(view.project.manifest, initial.manifest, "LEAN_RESUME_MANIFEST_CHANGED")
  assert.equal(view.project.status, "active", "LEAN_RESUME_ACTIVE_PROJECT_REQUIRED")
  assert.equal(
    view.project.version,
    initial.version + view.project.stageIndex,
    "LEAN_RESUME_VERSION_CHANGED"
  )
  for (const [index, stage] of initial.manifest.stages.entries()) {
    if (index >= view.project.stageIndex) break
    const completed = view.operations.filter(
      (op) =>
        op.stageId === stage.id &&
        op.expectedVersion === initial.version + index &&
        op.status === "transitioned"
    )
    assert.equal(completed.length, 1, "LEAN_RESUME_ACCEPTED_PREFIX_REQUIRED")
    assert(
      stage.checkIds.every((id) =>
        completed[0].receipts.some(
          (receipt) => receipt.checkId === id && receipt.result === "passed"
        )
      ),
      "LEAN_RESUME_RECEIPTS_REQUIRED"
    )
    if (stage.resultApproval === "human")
      assert.equal(
        completed[0].resultApproval?.decision,
        "approved",
        "LEAN_RESUME_ACCEPTANCE_REQUIRED"
      )
  }
  const stageId = initial.manifest.stages[view.project.stageIndex]?.id
  assert(
    view.operations.some(
      (op) =>
        op.stageId === stageId &&
        op.expectedVersion === view.project.version &&
        op.status === "failed"
    ),
    "LEAN_RESUME_FAILED_STAGE_REQUIRED"
  )
}

import { afterEach, expect, it } from "vitest"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import { assertLeanResumeProject, prepareLeanResume } from "../support/live-lean-resume"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const local = relative(resolve(tmpdir()), root)
    if (local.startsWith("..") || !local.startsWith("lean-resume-test-"))
      throw Error("UNSAFE_CLEANUP")
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "lean-resume-test-"))
  roots.push(parent)
  const isolated = join(parent, "run-Test01")
  mkdirSync(isolated)
  for (const folder of ["workspace", "electron", "data", "home", "temp", "appdata", "localappdata"])
    mkdirSync(join(isolated, folder))
  const initial = {
    projectId: "project",
    workspace: join(isolated, "workspace"),
    pluginDigest: "c".repeat(64),
    goal: "original goal",
    status: "active",
    version: 1,
    stageIndex: 0,
    manifest: {
      stages: [
        { id: "baseline", checkIds: ["baseline.check"], resultApproval: "human" },
        { id: "definition", checkIds: ["definition.check"] }
      ]
    }
  } as unknown as LocalProjectView["project"]
  const original = {
    candidate: { sha256: "a".repeat(64) },
    projectId: "project",
    expectedStages: ["baseline", "definition"],
    passed: false,
    error: "REAL_CHECK_FAILURE"
  }
  writeFileSync(join(isolated, "evidence.json"), JSON.stringify(original))
  writeFileSync(join(isolated, "baseline-prepared.json"), JSON.stringify({ project: initial }))
  writeFileSync(
    join(isolated, "authoring-source-provenance.json"),
    JSON.stringify({ bundleDigest: "b".repeat(64) })
  )
  const feedbackPath = join(parent, "feedback.txt")
  writeFileSync(
    feedbackPath,
    "Fix the reported public contract error without changing upstream artifacts."
  )
  const input = {
    run: isolated,
    artifactRoot: parent,
    projectId: "project",
    appDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    feedbackPath
  }
  const view = {
    project: { ...initial, version: 2, stageIndex: 1 },
    operations: [
      {
        operationId: "failed",
        stageId: "definition",
        expectedVersion: 2,
        status: "failed",
        receipts: []
      },
      {
        operationId: "accepted",
        stageId: "baseline",
        expectedVersion: 1,
        status: "transitioned",
        receipts: [{ checkId: "baseline.check", result: "passed" }],
        resultApproval: { decision: "approved" }
      }
    ]
  } as unknown as LocalProjectView
  return { isolated, initial, original, input, view }
}

it("keeps old evidence and limits explicitly requested same-run repair attempts", () => {
  const f = fixture()
  const result = prepareLeanResume(f.input)
  expect(result.attempt).toBe(2)
  expect(result.feedback).toContain("public contract")
  expect(JSON.parse(readFileSync(join(f.isolated, "evidence.json"), "utf8"))).toEqual(f.original)
  expect(prepareLeanResume(f.input).attempt).toBe(3)
  expect(prepareLeanResume(f.input).attempt).toBe(4)
  expect(() => prepareLeanResume(f.input)).toThrow("LEAN_RESUME_ATTEMPT_LIMIT")
})

it("rejects another app, source, project, root or linked profile before relaunch", () => {
  const f = fixture()
  for (const patch of [
    { appDigest: "d".repeat(64) },
    { sourceDigest: "d".repeat(64) },
    { projectId: "another" },
    { artifactRoot: tmpdir() }
  ])
    expect(() => prepareLeanResume({ ...f.input, ...patch })).toThrow(/LEAN_RESUME_/)
  const home = join(f.isolated, "home")
  rmdirSync(home)
  symlinkSync(join(f.isolated, "data"), home, process.platform === "win32" ? "junction" : "dir")
  expect(() => prepareLeanResume(f.input)).toThrow("LEAN_RESUME_LINK_FORBIDDEN")
})

it("requires the unchanged real Host project and accepted prefix before skipping stages", () => {
  const f = fixture()
  expect(() => assertLeanResumeProject(f.view, f.initial)).not.toThrow()
  for (const mutate of [
    (v: LocalProjectView) => {
      v.project.pluginDigest = "changed"
    },
    (v: LocalProjectView) => {
      v.project.goal = "changed"
    },
    (v: LocalProjectView) => {
      v.project.version++
    },
    (v: LocalProjectView) => {
      v.operations[1].receipts = []
    },
    (v: LocalProjectView) => {
      v.operations[1].resultApproval = null
    },
    (v: LocalProjectView) => {
      v.operations[0].status = "started"
    }
  ]) {
    const changed = structuredClone(f.view)
    mutate(changed)
    expect(() => assertLeanResumeProject(changed, f.initial)).toThrow(/LEAN_RESUME_/)
  }
})

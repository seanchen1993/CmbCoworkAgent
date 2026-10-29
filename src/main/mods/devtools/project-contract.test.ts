import { dirname } from "node:path"
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createProjectTemplate } from "./project-template"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import {
  assertProjectContractPassed,
  ProjectContractError,
  testProjectSource
} from "./project-contract"

const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})
const template = createProjectTemplate({ packageId: "contract-diagnostics", name: "Contract" })
const manifest = parseProjectRuntimeManifest(
  JSON.parse(template.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
)
const sample = () => ({
  apiVersion: "devclaw.project-contract/v1",
  cases: [
    {
      id: "draft-valid",
      stageId: "draft",
      files: [{ path: "draft.md", text: "private-fixture-body" }],
      expected: "passed"
    }
  ]
})
function source(value: unknown) {
  return createAuthoringSourceBundle(
    template.files.map((file) =>
      file.path === "tests/project-contract.json"
        ? { ...file, text: typeof value === "string" ? value : JSON.stringify(value) }
        : file
    )
  )
}

describe("project contract field diagnostics", () => {
  it.each([
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases[0].files[0].path = "old-artifact.json"
      },
      code: "PROJECT_CONTRACT_FILE_INVALID",
      reason: "PROJECT_CONTRACT_ARTIFACT_UNDECLARED",
      path: "/cases/0/files/0/path"
    },
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases[0].files[0] = { path: "draft.md", content: "private-fixture-body" } as never
      },
      code: "PROJECT_CONTRACT_FILE_INVALID",
      reason: "PROJECT_CONTRACT_FILE_FIELDS",
      path: "/cases/0/files/0"
    },
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases[0].files[0].text = 1 as never
      },
      code: "PROJECT_CONTRACT_FILE_INVALID",
      reason: "PROJECT_CONTRACT_FILE_TEXT",
      path: "/cases/0/files/0/text"
    },
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases[0].files.push(value.cases[0].files[0])
      },
      code: "PROJECT_CONTRACT_FILE_INVALID",
      reason: "PROJECT_CONTRACT_FILE_DUPLICATE",
      path: "/cases/0/files/1/path"
    },
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases[0].stageId = "old-stage"
      },
      code: "PROJECT_CONTRACT_INVALID",
      reason: "PROJECT_CONTRACT_STAGE_UNDECLARED",
      path: "/cases/0/stageId"
    },
    {
      change: (value: ReturnType<typeof sample>) => {
        value.cases.push(value.cases[0])
      },
      code: "PROJECT_CONTRACT_INVALID",
      reason: "PROJECT_CONTRACT_CASE_DUPLICATE",
      path: "/cases/1/id"
    }
  ])("keeps $code while locating $reason at $path", async ({ change, code, reason, path }) => {
    const value = sample()
    change(value)
    let failure: unknown
    try {
      await testProjectSource(source(value), manifest)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ProjectContractError)
    expect(failure).toMatchObject({
      message: code,
      diagnostics: [{ code: reason, file: "tests/project-contract.json", path }]
    })
    expect(JSON.stringify((failure as ProjectContractError).diagnostics)).not.toContain(
      "private-fixture-body"
    )
    if (reason === "PROJECT_CONTRACT_ARTIFACT_UNDECLARED")
      expect((failure as ProjectContractError).diagnostics[0].allowedPaths).toEqual([
        "draft.md",
        "review.json"
      ])
  })

  it("reports syntax without returning JSON parser excerpts", async () => {
    let failure: unknown
    try {
      await testProjectSource(source('{"private-fixture-body":'), manifest)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: "PROJECT_CONTRACT_INVALID",
      diagnostics: [
        { code: "PROJECT_CONTRACT_JSON_SYNTAX", file: "tests/project-contract.json", path: "" }
      ]
    })
    expect(JSON.stringify(failure)).not.toContain("private-fixture-body")
  })

  it("retains actual Host check outcomes for mismatched cases without changing validators", async () => {
    const value = sample()
    value.cases[0].files = []
    const report = await testProjectSource(source(value), manifest)
    expect(report).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "PROJECT_CONTRACT_EXPECTATION_MISMATCH",
          path: "/cases/0/expected",
          caseId: "draft-valid",
          stageId: "draft",
          expected: "passed",
          actual: "failed",
          checks: [{ checkId: "draft-exists", result: "failed" }]
        }
      ]
    })
    expect(() => assertProjectContractPassed(report)).toThrow("PROJECT_HARNESS_CONTRACT_FAILED")
    expect(await testProjectSource(source(sample()), manifest)).toMatchObject({ valid: true })
  })

  it("preserves the saved project revision when native compile rejects a stale artifact fixture", async () => {
    const original = createProjectTemplate({
      packageId: "native-contract",
      name: "Native",
      template: "native-modular"
    })
    const files = original.files.map((file) => {
      if (file.path !== "tests/project-contract.json") return file
      const value = JSON.parse(file.text)
      value.cases[0].files = [{ path: "old-artifact.json", text: "private-fixture-body" }]
      return { ...file, text: JSON.stringify(value) }
    })
    const scope = {
      threadId: "contract-diagnostics",
      workspace: "contract-workspace",
      incarnation: { token: "contract-scope", legacyCreatedAt: 1 }
    }
    const sessions = new ProjectAuthoringSessions(async () => [])
    const draft = await sessions.save(
      scope,
      { id: "native-contract", name: "Native", revision: 0, files },
      () => {}
    )
    roots.add(dirname(draft.directory))
    await expect(sessions.compile(scope, draft.id, draft.revision, () => {})).rejects.toMatchObject(
      {
        message: "PROJECT_CONTRACT_FILE_INVALID",
        diagnostics: [
          {
            code: "PROJECT_CONTRACT_ARTIFACT_UNDECLARED",
            path: "/cases/0/files/0/path"
          }
        ]
      }
    )
    expect(sessions.read(scope, draft.id).revision).toBe(draft.revision)
    expect(sessions.read(scope, draft.id).source.digest).toBe(draft.source.digest)
  })
})

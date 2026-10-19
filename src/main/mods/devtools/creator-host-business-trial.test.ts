import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { createProjectTemplate } from "./project-template"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { requestCreatorHostBusinessTrial } from "./creator-host-business-trial"
import type { DevelopmentScope } from "../v2/development-session"
import { snapshotDerivationSource } from "../../plugins/derivation-source"
import AdmZip from "adm-zip"
import { readProjectSource } from "./project-source"
import { packProjectPlugin } from "./project-tooling"

const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})
const scope: DevelopmentScope = {
  threadId: "creator-host-business",
  workspace: "workspace",
  incarnation: { token: "current", legacyCreatedAt: 1 }
}
const origin = {
  kind: "business-assembly" as const,
  planId: "12345678-1234-1234-1234-123456789abc",
  copyId: "23456789-1234-1234-1234-123456789abc",
  digest: "a".repeat(64)
}

async function fixture(
  resources: Array<{ path: string; text: string }> = [],
  declaredResources = resources.map((resource) => resource.path)
) {
  const root = await mkdtemp(join(tmpdir(), "business-host-trial-"))
  roots.add(root)
  const source = createProjectTemplate({ packageId: "independent-review", name: "独立审阅" })
  const declarations = resources.length
    ? [
        {
          path: "mods/business/manifest.json",
          text: JSON.stringify({
            apiVersion: "devclaw.business-mods/v1",
            kind: "catalog",
            kernel: {
              id: "independent.kernel",
              version: "1.0.0",
              runtime: { adapter: "host-linear-v1" },
              resources: declaredResources
            },
            modules: [
              {
                id: "draft",
                title: "Draft",
                node: { id: "draft", skill: "draft", validators: [], guards: [] },
                skill: { entry: "skills/draft/SKILL.md", resources: [] },
                resources: [],
                dependencies: { required: [], advisory: [] },
                checks: { validators: [], guards: [] }
              }
            ]
          })
        }
      ]
    : []
  for (const file of [
    ...source.files,
    { path: "devclaw.business-assembly.json", text: JSON.stringify(origin) },
    { path: "devclaw.portability.json", text: "{}" },
    ...resources,
    ...declarations
  ]) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.text)
  }
  const sessions = new ProjectAuthoringSessions()
  const snapshot = await snapshotDerivationSource(root)
  return {
    root,
    sessions,
    input: {
      root,
      sessions,
      scope,
      origin,
      expectedFiles: snapshot.files,
      name: "独立审阅",
      goal: "产出有检查证据的文档",
      guard() {
        // This fixture keeps its main-owned creator scope current.
      }
    }
  }
}

it("routes exact Host assemblies to the original isolated native project trial request", async () => {
  const f = await fixture()
  const result = await requestCreatorHostBusinessTrial(f.input)
  const draft = f.sessions.read(scope, result.request.draftId)
  roots.add(dirname(draft.directory))
  expect(result).toMatchObject({
    phase: "needs-approval",
    executed: false,
    request: { origin, goal: f.input.goal }
  })
  expect(f.sessions.trialRequest(scope)).toEqual(result.request)
  expect(draft.source.files.map((file) => file.path)).toContain("devclaw.business-assembly.json")
  expect(draft.source.files.map((file) => file.path)).toContain("devclaw.portability.json")
  expect(draft.development).toMatchObject({ status: "prepared" })
  // The original Host preparation has not fabricated a project execution or artifact PASS.
  expect(result).not.toHaveProperty("projectId")
  expect(() =>
    f.sessions.read({ ...scope, incarnation: { token: "other", legacyCreatedAt: 1 } }, draft.id)
  ).toThrow("PROJECT_DRAFT_MISSING")
})

it("rejects resources the original Host source boundary cannot retain instead of silently losing them", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "business-private"))
  await writeFile(join(f.root, "business-private", "knowledge.md"), "must not disappear")
  await expect(requestCreatorHostBusinessTrial(f.input)).rejects.toThrow(
    "BUSINESS_TRIAL_HOST_SOURCE_UNSUPPORTED"
  )
  expect(f.sessions.list(scope)).toEqual([])
  expect(f.sessions.trialRequest(scope)).toBeUndefined()
})

it("honors source authority before importing a package and does not grant approval", async () => {
  const f = await fixture()
  await expect(
    requestCreatorHostBusinessTrial({
      ...f.input,
      guard: () => {
        throw Error("SOURCE_REVOKED")
      }
    })
  ).rejects.toThrow("SOURCE_REVOKED")
  expect(f.sessions.list(scope)).toEqual([])
})

it("rejects a changed checked source rather than importing its replacement as the original candidate", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "skills/draft/SKILL.md"), "changed after checked assembly")
  await expect(requestCreatorHostBusinessTrial(f.input)).rejects.toThrow(
    "BUSINESS_TRIAL_CANDIDATE_CHANGED"
  )
  expect(f.sessions.list(scope)).toEqual([])
})

it("retains arbitrary declared business resources through original Host preparation and export", async () => {
  const resource = { path: "company-policy/admission-policy.md", text: "核对供应商证据\r\n" }
  const f = await fixture([resource], ["company-policy"])
  const result = await requestCreatorHostBusinessTrial(f.input)
  const draft = f.sessions.read(scope, result.request.draftId)
  roots.add(dirname(draft.directory))
  expect(draft.resourcePaths).toEqual([resource.path])
  const lease = f.sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
  try {
    expect(lease.snapshot.resourcePaths).toEqual([resource.path])
    expect(await readFile(join(lease.snapshot.packagePath, resource.path), "utf8")).toBe(
      resource.text
    )
  } finally {
    lease.release()
  }
  const packed = await f.sessions.inspect(scope, draft.id, draft.revision, "pack", () => {})
  if (
    !packed ||
    typeof packed !== "object" ||
    !("output" in packed) ||
    typeof packed.output !== "string"
  )
    throw Error("EXPECTED_EXPORTED_PACKAGE")
  expect(new AdmZip(packed.output).readAsText(resource.path)).toBe(resource.text)
  // The public catalog carries the same declared resource closure to a separate CLI read.
  const cliSource = await readProjectSource(f.root)
  expect(cliSource.bundle).toEqual(draft.source)
  const cliOutput = join(dirname(draft.directory), "independent-cli-export.zip")
  await packProjectPlugin(f.root, cliOutput)
  expect(new AdmZip(cliOutput).readAsText(resource.path)).toBe(resource.text)
  await expect(
    f.sessions.save(
      scope,
      {
        id: draft.id,
        name: draft.name,
        revision: draft.revision,
        files: [...draft.source.files, { path: "foreign/path.md", text: "not imported" }]
      },
      () => {}
    )
  ).rejects.toThrow("PROJECT_DRAFT_FILE_UNSUPPORTED")
})

it("rejects a missing declared resource directory during portable source readback and CLI export", async () => {
  const resource = { path: "knowledge/policy.md", text: "required declared input" }
  const f = await fixture([resource], ["knowledge"])
  expect((await readProjectSource(f.root)).bundle.files).toContainEqual(resource)
  await rm(join(f.root, resource.path))
  await expect(readProjectSource(f.root)).rejects.toThrow("PROJECT_RESOURCE_MISSING")
  await expect(packProjectPlugin(f.root, join(f.root, "must-not-publish.zip"))).rejects.toThrow(
    "PROJECT_RESOURCE_MISSING"
  )
})

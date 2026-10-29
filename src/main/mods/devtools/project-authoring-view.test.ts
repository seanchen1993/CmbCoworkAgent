import { expect, it } from "vitest"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { projectAuthoringReadView, PROJECT_AUTHORING_FILE_PAGE } from "./project-authoring-view"
import { validateClassicInput } from "../../../shared/mods/v2/classic"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { parseSkillFrontmatter } from "../../skills/frontmatter"
import { readProjectSource } from "./project-source"
import { resolve } from "node:path"

const draft = {
  id: "large",
  name: "Large plugin",
  revision: 2,
  directory: "isolated",
  source: createAuthoringSourceBundle([
    { path: "plugin.json", text: '{"name":"large","version":"1.0.0"}' },
    { path: "README.md", text: "x".repeat(60000) },
    { path: "tests/retained.json", text: "y".repeat(60000) }
  ])
}
it("indexes a large snapshot without violating the unchanged classic event bounds", () => {
  const view = projectAuthoringReadView(draft, { history: "z".repeat(60000) })
  expect(view).toMatchObject({
    readMode: "file-index",
    revision: 2,
    sourceDigest: draft.source.digest
  })
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "creator",
    transcript_path: "",
    cwd: "isolated",
    tool_name: "mod_authoring",
    tool_use_id: "read",
    tool_input: { action: "project_read", id: draft.id },
    tool_response: { ok: true, result: view }
  }
  expect(() => validateClassicInput("classic.PostToolUse", input)).not.toThrow()
  expect(() =>
    validateClassicInput("classic.PostToolUse", {
      ...input,
      tool_response: { ...draft, history: "z".repeat(60000) }
    })
  ).toThrow("MODS_CLASSIC_INPUT")
})
it("reads exact reconstructable pages and rejects unknown files and invalid cursors", () => {
  let content = "",
    cursor = 0
  do {
    const page = projectAuthoringReadView(draft, undefined, "README.md", cursor)
    if (!("file" in page)) throw Error("FILE_PAGE_REQUIRED")
    expect(page.file.text.length).toBeLessThanOrEqual(PROJECT_AUTHORING_FILE_PAGE)
    content += page.file.text
    cursor = "nextCursor" in page ? page.nextCursor! : -1
  } while (cursor !== -1)
  expect(content).toBe(draft.source.files.find((file) => file.path === "README.md")!.text)
  expect(() => projectAuthoringReadView(draft, undefined, "../private")).toThrow("FILE_MISSING")
  expect(() => projectAuthoringReadView(draft, undefined, "README.md", 60001)).toThrow(
    "CURSOR_INVALID"
  )
  expect(() => projectAuthoringReadView(draft, undefined, undefined, 1)).toThrow("PATH_REQUIRED")
})

it("identifies native source routing in both compact and indexed snapshots", () => {
  for (const large of [false, true]) {
    const native = {
      ...draft,
      source: createAuthoringSourceBundle([
        { path: "plugin.json", text: '{"name":"native","version":"1.0.0"}' },
        { path: "composition/source.json", text: '{"protocol":"devclaw.native-composition/v1"}' },
        ...(large ? [{ path: "retained.md", text: "x".repeat(60000) }] : [])
      ])
    }
    const view = projectAuthoringReadView(native, undefined)
    expect(view).toMatchObject({
      authoring: {
        stateOwner: "host",
        skillMetadata: {
          scope: "new-creator-compile-doctor-and-preparation",
          requiredFrontmatter: ["name", "description"]
        },
        sourcePath: "composition/source.json",
        nextStep: { action: "project_read", id: draft.id, assetPath: "composition/source.json" },
        dependencies: { action: "catalog", catalogSection: "project-dependencies" },
        edit: {
          action: "project_patch",
          id: draft.id,
          revision: native.revision,
          sourceDigest: native.source.digest,
          sourcePatchTarget: "composition/source.json",
          sourcePatchOperations: ["add", "replace", "remove", "test"]
        },
        configuration: {
          declaration: {
            path: "/configuration/userConfig",
            requiredFieldProperties: ["type", "title", "description"],
            numericBounds: ["min", "max"]
          },
          constants: expect.stringContaining("not saved userConfig"),
          checkedValues: expect.stringContaining("input.configuration"),
          execution: expect.stringContaining("no implicit configuration")
        }
      }
    })
    if (!("authoring" in view) || !view.authoring) throw Error("NATIVE_AUTHORING_VIEW_REQUIRED")
    const example = view.authoring.configuration.declaration.example
    expect(parseFunctionUserConfig(example)).toEqual(example)
    const skillExample = parseSkillFrontmatter(view.authoring.skillMetadata.example)
    expect(skillExample.frontmatter).toMatchObject({
      name: "example-stage",
      description: expect.any(String)
    })
    expect(view.authoring.skillMetadata.compatibility).toContain("Existing Host fixed-path")
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(24000)
  }
  expect(projectAuthoringReadView(draft, undefined)).not.toHaveProperty("authoring")
})

it("keeps new candidate rejection visible in large indexed saves without echoing private preparation paths", async () => {
  const original = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
  const source = createAuthoringSourceBundle([
    ...original.bundle.files.map((file) =>
      file.path === "modules/normalize/SKILL.md"
        ? { ...file, text: "---\nname: vendor-normalize\n---\nPRIVATE_INSTRUCTION" }
        : file
    ),
    { path: "README.md", text: "x".repeat(60000) }
  ])
  const view = projectAuthoringReadView(
    {
      ...draft,
      source,
      revision: 3,
      development: {
        devId: "retained",
        draftId: draft.id,
        revision: 2,
        digest: "a".repeat(64),
        packagePath: "PRIVATE_PREPARED_PACKAGE",
        workspace: "PRIVATE_WORKSPACE",
        currentRevision: 2,
        currentDigest: "a".repeat(64),
        pendingRevision: null,
        activeRuns: 1,
        updateState: "blocked",
        status: "prepared",
        executed: false,
        diagnostics: ["PROJECT_AUTHORING_SKILL_METADATA_INVALID"]
      }
    },
    undefined
  )
  expect(view).toMatchObject({
    readMode: "file-index",
    preparation: {
      candidateRevision: 3,
      candidateDigest: source.digest,
      candidatePrepared: false,
      previousPreparation: { revision: 2, digest: "a".repeat(64), activeRuns: 1, preserved: true },
      diagnostics: [{ path: "modules/normalize/SKILL.md", field: "description", reason: "missing" }]
    }
  })
  expect(JSON.stringify(view)).not.toContain("PRIVATE_")
  expect(JSON.stringify(view).length).toBeLessThanOrEqual(24000)
})

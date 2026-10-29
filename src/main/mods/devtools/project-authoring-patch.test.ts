import { readdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { readProjectSource } from "./project-source"
import { resolve } from "node:path"
import { projectAuthoringReadView } from "./project-authoring-view"
import { ProjectDraftFileError } from "./project-draft-file-error"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"

const scope = {
  threadId: "patch",
  workspace: "isolated",
  incarnation: { token: "current", legacyCreatedAt: 1 }
}
const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

it("keeps the actual large AutoBiz source intact when only adding a Skill", async () => {
  const source = await readProjectSource(resolve("resources/native-compositions/autobiz"))
  expect(JSON.stringify(source.bundle).length).toBeGreaterThan(24000)
  const sessions = new ProjectAuthoringSessions()
  const original = await sessions.save(
    scope,
    { id: "autobiz", name: "Actual source", revision: 0, files: source.bundle.files },
    () => {}
  )
  roots.add(dirname(original.directory))
  expect(projectAuthoringReadView(original, undefined)).toMatchObject({ readMode: "file-index" })
  const next = await sessions.patch(
    scope,
    {
      id: original.id,
      revision: original.revision,
      sourceDigest: original.source.digest,
      files: [
        {
          path: "modules/e2e/SKILL.md",
          text: "Require real test evidence; never claim unexecuted tests passed."
        }
      ]
    },
    () => {}
  )
  for (const file of original.source.files)
    expect(next.source.files.find((item) => item.path === file.path)).toEqual(file)
})

it("rejects undeclared companion files without a new revision and accepts one atomic declaration patch", async () => {
  const sessions = new ProjectAuthoringSessions(async () => [])
  const original = await sessions.scaffold(
    scope,
    "resource-closure",
    "Resources",
    () => {},
    "native-modular"
  )
  roots.add(dirname(original.directory))
  const files = [
    { path: "modules/e2e/SKILL.md", text: "---\nname: verify\n---\nRead declared test evidence." },
    {
      path: "workflows/verify.workflow.js",
      text: 'export const meta={name:"verify",description:"Verify",phases:[]}; return {checked:true}'
    },
    { path: "knowledge/e2e.md", text: "Declared test notes" },
    { path: "tests/e2e-cases/pass.json", text: '{"case":"pass"}' },
    { path: "tests/e2e-cases/fail.json", text: '{"case":"fail"}' }
  ]
  const input = {
    id: original.id,
    revision: original.revision,
    sourceDigest: original.source.digest,
    files
  }
  const directories = await readdir(dirname(original.directory))
  const rejected = await sessions
    .patch(scope, input, () => {})
    .then(
      () => undefined,
      (error) => error
    )
  expect(rejected).toBeInstanceOf(ProjectDraftFileError)
  expect(rejected).toMatchObject({
    message: "PROJECT_DRAFT_FILE_UNSUPPORTED",
    declarationPath: "composition/source.json",
    unsupportedPaths: [
      "tests/e2e-cases/fail.json",
      "tests/e2e-cases/pass.json",
      "workflows/verify.workflow.js"
    ]
  })
  expect(sessions.read(scope, original.id)).toMatchObject({ revision: 1, source: original.source })
  expect(await readdir(dirname(original.directory))).toEqual(directories)
  const declaration = original.source.files.find((file) => file.path === "composition/source.json")!
  const source = JSON.parse(declaration.text)
  source.resources = [...source.resources, ...files.map((file) => file.path)]
  const next = await sessions.patch(
    scope,
    { ...input, files: [{ path: declaration.path, text: JSON.stringify(source) }, ...files] },
    () => {}
  )
  expect(next.revision).toBe(2)
  expect(next.source.files).toEqual(expect.arrayContaining(files))
  for (const file of original.source.files.filter((file) => file.path !== declaration.path))
    expect(next.source.files.find((value) => value.path === file.path)).toEqual(file)
  const compiled = await sessions.compile(scope, next.id, next.revision, () => {})
  expect(compiled.revision).toBe(3)
  expect(compiled.source.files).toEqual(expect.arrayContaining(files))
})

it("does not suggest a native declaration for unsupported files in an ordinary Host draft", async () => {
  const sessions = new ProjectAuthoringSessions()
  const original = await sessions.scaffold(scope, "ordinary-paths", "Ordinary", () => {})
  roots.add(dirname(original.directory))
  const rejected = await sessions
    .patch(
      scope,
      {
        id: original.id,
        revision: 1,
        sourceDigest: original.source.digest,
        files: [{ path: "workflows/verify.workflow.js", text: "inert source" }]
      },
      () => {}
    )
    .then(
      () => undefined,
      (error) => error
    )
  expect(rejected).toBeInstanceOf(ProjectDraftFileError)
  expect(rejected.unsupportedPaths).toEqual(["workflows/verify.workflow.js"])
  expect(rejected).not.toHaveProperty("declarationPath")
  expect(sessions.read(scope, original.id).revision).toBe(1)
})

it("atomically appends and replaces generic native modules with exact companion files", async () => {
  const sessions = new ProjectAuthoringSessions(async () => [])
  const original = await sessions.scaffold(scope, "delta", "Delta", () => {}, "native-modular")
  roots.add(dirname(original.directory))
  const declaration = original.source.files.find((file) => file.path === "composition/source.json")!
  const before = JSON.parse(declaration.text)
  const audit = {
    ...before.modules[1],
    id: "audit",
    title: "Independent audit",
    skill: "modules/audit/SKILL.md",
    inputs: [{ artifactId: "review", contract: "review/v1" }],
    outputs: [{ id: "audit", path: "audit.json", contract: "audit/v1" }],
    checks: [
      {
        id: "audit-schema",
        kind: "json-schema",
        artifactId: "audit",
        schema: { type: "object", required: ["checked"], properties: { checked: { const: true } } }
      }
    ]
  }
  const files = [
    {
      path: audit.skill,
      text: "---\nname: audit\ndescription: Perform the declared audit.\n---\nPerform the declared audit."
    },
    { path: "workflows/audit.workflow.js", text: "// Inert declared companion workflow" },
    { path: "tests/audit-cases/pass.json", text: '{"checked":true}' }
  ]
  const appended = await sessions.patch(
    scope,
    {
      id: original.id,
      revision: original.revision,
      sourceDigest: original.source.digest,
      files,
      sourcePatch: [
        { op: "test", path: "/plugin/id", value: "delta" },
        { op: "add", path: "/modules/-", value: audit },
        ...files.map((file) => ({ op: "add", path: "/resources/-", value: file.path }))
      ]
    },
    () => {}
  )
  expect(appended.revision).toBe(2)
  const after = JSON.parse(
    appended.source.files.find((file) => file.path === declaration.path)!.text
  )
  expect(after.modules).toEqual([...before.modules, audit])
  expect(after.resources).toEqual([...before.resources, ...files.map((file) => file.path)])
  for (const key of Object.keys(before).filter((key) => !["modules", "resources"].includes(key)))
    expect(after[key]).toEqual(before[key])
  for (const file of original.source.files.filter((file) => file.path !== declaration.path))
    expect(appended.source.files.find((value) => value.path === file.path)).toEqual(file)
  expect(appended.source.files).toEqual(expect.arrayContaining(files))
  const compiled = await sessions.compile(scope, appended.id, appended.revision, () => {})
  expect(
    parseProjectRuntimeManifest(
      JSON.parse(
        compiled.source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
      )
    ).stages.map((stage) => stage.id)
  ).toEqual(["draft", "review", "audit"])
  const replacement = {
    ...before.modules[1],
    title: "Replacement review",
    skill: "modules/replacement/SKILL.md"
  }
  const replaced = await sessions.patch(
    scope,
    {
      id: compiled.id,
      revision: compiled.revision,
      sourceDigest: compiled.source.digest,
      sourcePatch: [
        { op: "test", path: "/modules/1/id", value: "review" },
        { op: "replace", path: "/modules/1", value: replacement },
        { op: "add", path: "/resources/-", value: replacement.skill }
      ],
      files: [
        {
          path: replacement.skill,
          text: "---\nname: replacement\ndescription: Review original contracts.\n---\nReview original contracts."
        }
      ]
    },
    () => {}
  )
  const middle = JSON.parse(
    replaced.source.files.find((file) => file.path === declaration.path)!.text
  )
  expect(middle.modules).toEqual([before.modules[0], replacement, audit])
  expect(replaced.source.files).toEqual(expect.arrayContaining(files))
  await expect(
    sessions.compile(scope, replaced.id, replaced.revision, () => {})
  ).resolves.toMatchObject({ revision: 5 })
})

it("rejects failed source deltas, schema errors, ambiguous source and undeclared files before any save", async () => {
  const sessions = new ProjectAuthoringSessions()
  const original = await sessions.scaffold(
    scope,
    "atomic-delta",
    "Atomic",
    () => {},
    "native-modular"
  )
  roots.add(dirname(original.directory))
  const input = { id: original.id, revision: 1, sourceDigest: original.source.digest }
  const directories = await readdir(dirname(original.directory))
  const invalid = [
    {
      sourcePatch: [
        { op: "replace", path: "/plugin/title", value: "Not saved" },
        { op: "test", path: "/modules/0/id", value: "wrong" }
      ]
    },
    { sourcePatch: [{ op: "replace", path: "/plugin/version", value: "invalid-version" }] },
    { sourcePatch: [{ op: "remove", path: "/modules" }] },
    { sourcePatch: [{ op: "add", path: "/resources/-", value: "../outside.json" }] },
    {
      sourcePatch: [{ op: "replace", path: "/plugin/title", value: "Not saved" }],
      files: [{ path: "workflows/undeclared.workflow.js", text: "// not declared" }]
    },
    {
      sourcePatch: [{ op: "replace", path: "/plugin/title", value: "Not saved" }],
      files: [original.source.files.find((file) => file.path === "composition/source.json")!]
    },
    { sourcePatch: [{ op: "add", path: "/constructor/polluted", value: true }] }
  ]
  for (const change of invalid) {
    await expect(sessions.patch(scope, { ...input, ...change }, () => {})).rejects.toThrow()
    expect(sessions.read(scope, original.id)).toMatchObject({
      revision: 1,
      source: original.source
    })
    expect(await readdir(dirname(original.directory))).toEqual(directories)
  }
  const delta = { sourcePatch: [{ op: "replace", path: "/plugin/title", value: "Saved once" }] }
  await expect(
    sessions.patch(scope, { ...input, ...delta, revision: 0 }, () => {})
  ).rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  await expect(
    sessions.patch(scope, { ...input, ...delta, sourceDigest: "0".repeat(64) }, () => {})
  ).rejects.toThrow("PROJECT_DRAFT_SOURCE_CHANGED")
  const next = await sessions.patch(scope, { ...input, ...delta }, () => {})
  expect(next.revision).toBe(2)
  for (const file of original.source.files.filter(
    (file) => file.path !== "composition/source.json"
  ))
    expect(next.source.files.find((value) => value.path === file.path)).toEqual(file)
  await expect(sessions.patch(scope, { ...input, ...delta }, () => {})).rejects.toThrow(
    "REVISION_CHANGED"
  )
})

it("retains original file limits and rejects sourcePatch on ordinary Host documents", async () => {
  const sessions = new ProjectAuthoringSessions()
  const ordinary = await sessions.scaffold(scope, "no-native", "Host", () => {})
  roots.add(dirname(ordinary.directory))
  await expect(
    sessions.patch(
      scope,
      {
        id: ordinary.id,
        revision: 1,
        sourceDigest: ordinary.source.digest,
        sourcePatch: [{ op: "add", path: "/modules/-", value: {} }]
      },
      () => {}
    )
  ).rejects.toThrow("PROJECT_SOURCE_PATCH_NATIVE_REQUIRED")
  expect(sessions.read(scope, ordinary.id).revision).toBe(1)
  const native = await sessions.scaffold(scope, "bounded", "Bounded", () => {}, "native-modular")
  const source = JSON.parse(
    native.source.files.find((file) => file.path === "composition/source.json")!.text
  )
  source.context = { retained: "x".repeat(52000) }
  const large = await sessions.patch(
    scope,
    {
      id: native.id,
      revision: 1,
      sourceDigest: native.source.digest,
      files: [{ path: "composition/source.json", text: JSON.stringify(source) }]
    },
    () => {}
  )
  await expect(
    sessions.patch(
      scope,
      {
        id: large.id,
        revision: large.revision,
        sourceDigest: large.source.digest,
        sourcePatch: [{ op: "add", path: "/context/extra", value: "x".repeat(16000) }]
      },
      () => {}
    )
  ).rejects.toThrow("AUTHORING_SOURCE")
  expect(sessions.read(scope, large.id)).toMatchObject({ revision: 2, source: large.source })
})

it("preserves all omitted files and old revisions through a small native patch", async () => {
  const sessions = new ProjectAuthoringSessions()
  const original = await sessions.scaffold(scope, "source", "Original", () => {})
  roots.add(dirname(original.directory))
  const files = [
    { path: "README.md", text: "Revised instructions" },
    { path: "skills/extra/SKILL.md", text: "New step" }
  ]
  const next = await sessions.patch(
    scope,
    { id: original.id, revision: original.revision, sourceDigest: original.source.digest, files },
    () => {}
  )
  expect(next.revision).toBe(2)
  for (const file of original.source.files.filter((item) => item.path !== "README.md"))
    expect(next.source.files.find((item) => item.path === file.path)).toEqual(file)
  expect(next.source.files).toEqual(expect.arrayContaining(files))
  expect(sessions.read(scope, original.id).source.digest).toBe(next.source.digest)
  expect(original.source.files.find((file) => file.path === "README.md")?.text).not.toBe(
    "Revised instructions"
  )
  await expect(
    sessions.patch(
      scope,
      { id: original.id, revision: 1, sourceDigest: original.source.digest, files },
      () => {}
    )
  ).rejects.toThrow("REVISION_CHANGED")
  await expect(
    sessions.patch(
      scope,
      { id: original.id, revision: 2, sourceDigest: original.source.digest, files },
      () => {}
    )
  ).rejects.toThrow("SOURCE_CHANGED")
  await expect(
    sessions.patch(
      scope,
      {
        id: original.id,
        revision: 2,
        sourceDigest: next.source.digest,
        files: [{ path: "../outside", text: "unsafe" }]
      },
      () => {}
    )
  ).rejects.toThrow()
  await expect(
    sessions.patch(
      scope,
      { id: original.id, revision: 2, sourceDigest: next.source.digest, files },
      () => {
        throw Error("REVOKED")
      }
    )
  ).rejects.toThrow("REVOKED")
  expect(sessions.read(scope, original.id).revision).toBe(2)
})

it("admits one concurrent patch and cannot overwrite it from a stale or foreign scope", async () => {
  const sessions = new ProjectAuthoringSessions()
  const original = await sessions.scaffold(scope, "race", "Original", () => {})
  roots.add(dirname(original.directory))
  const input = {
    id: original.id,
    revision: original.revision,
    sourceDigest: original.source.digest,
    files: [{ path: "README.md", text: "First accepted change" }]
  }
  const results = await Promise.allSettled([
    sessions.patch(scope, input, () => {}),
    sessions.patch(
      scope,
      { ...input, files: [{ path: "README.md", text: "Rejected race" }] },
      () => {}
    )
  ])
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
  expect(sessions.read(scope, original.id).revision).toBe(2)
  expect(
    sessions.read(scope, original.id).source.files.find((file) => file.path === "README.md")?.text
  ).toBe("First accepted change")
  await expect(
    sessions.patch(
      { ...scope, incarnation: { token: "foreign", legacyCreatedAt: 1 } },
      input,
      () => {}
    )
  ).rejects.toThrow("MISSING")
})

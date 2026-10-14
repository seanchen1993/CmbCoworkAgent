import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  ProjectAuthoringSessions,
  ProjectDraftLimitError,
  projectDraftLimitHint
} from "./project-authoring-session"
import type { DevelopmentScope } from "../v2/development-session"

const scope: DevelopmentScope = { threadId: "project-authoring-test", workspace: "workspace",
  incarnation: { token: "one", legacyCreatedAt: 1 } }
const roots = new Set<string>()
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear() })

it("keeps failure repair on immutable revisions and checks the current creator authority", async () => {
  const sessions = new ProjectAuthoringSessions()
  const first = await sessions.scaffold(scope, "draft", "项目", () => undefined)
  roots.add(dirname(first.directory))
  const broken = first.source.files.filter(file => file.path !== "skills/draft/SKILL.md")
  const second = await sessions.save(scope, { id: first.id, name: first.name, revision: 1, files: broken }, () => undefined)
  expect(await sessions.inspect(scope, first.id, 2, "doctor", () => undefined)).toMatchObject({ valid: false })
  expect(await readFile(join(first.directory, "skills/draft/SKILL.md"), "utf8")).toContain("name:")
  await expect(sessions.save(scope, { id: first.id, name: first.name, revision: 1, files: first.source.files }, () => undefined))
    .rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  const third = await sessions.save(scope, { id: first.id, name: first.name, revision: second.revision, files: first.source.files }, () => undefined)
  expect(await sessions.inspect(scope, first.id, third.revision, "test", () => undefined)).toMatchObject({ valid: true })
  await expect(sessions.inspect(scope, first.id, third.revision, "pack", () => { throw Error("revoked") }))
    .rejects.toThrow("revoked")
  expect(() => sessions.read({ ...scope, incarnation: { ...scope.incarnation, token: "new" } }, first.id)).toThrow("PROJECT_DRAFT_MISSING")
})

it("scaffolds Harness templates and compiles edited nodes into immutable revisions", async () => {
  const sessions = new ProjectAuthoringSessions()
  const guard = () => undefined
  const first = await sessions.scaffold(scope, "harness", "节点", guard, "harness-fullstack")
  roots.add(dirname(first.directory))
  const files = first.source.files.map((file) => {
    if (file.path !== "devclaw.harness.json") return file
    const value = JSON.parse(file.text)
    value.nodes[0].title = "修改后的设计节点"
    return { ...file, text: JSON.stringify(value) }
  })
  await sessions.save(scope, { id: first.id, name: first.name, revision: 1, files }, guard)
  expect(await sessions.inspect(scope, first.id, 2, "doctor", guard)).toMatchObject({
    valid: false
  })
  const compiled = await sessions.compile(scope, first.id, 2, guard)
  expect(compiled.revision).toBe(3)
  expect(await sessions.inspect(scope, first.id, 3, "test", guard)).toMatchObject({ valid: true })
  await expect(sessions.compile(scope, first.id, 2, guard)).rejects.toThrow(
    "PROJECT_DRAFT_REVISION_CHANGED"
  )
  await expect(
    sessions.compile(scope, first.id, 3, () => {
      throw Error("revoked")
    })
  ).rejects.toThrow("revoked")
  expect(
    await readFile(join(first.directory, "devclaw.project-runtime.json"), "utf8")
  ).not.toContain("修改后的设计节点")
})

it("continues an exhausted draft with exact files while preserving action locks and a running preview", async () => {
  const action = {
    pluginId: "installed-provider-id",
    plugin: "public-provider",
    digest: "a".repeat(64),
    actionId: "format",
    command: "format",
    name: "Format",
    inputSchema: { type: "object" }
  }
  const sessions = new ProjectAuthoringSessions(async () => [action])
  const guard = () => undefined
  let draft = await sessions.scaffold(scope, "original", "原项目", guard, "harness-lite")
  roots.add(dirname(draft.directory))
  draft = await sessions.bindAction(
    scope,
    {
      id: draft.id,
      revision: draft.revision,
      stageId: "draft",
      localActionId: "format",
      action,
      constants: {}
    },
    guard
  )
  await sessions.inspect(scope, draft.id, draft.revision, "dev", guard, [action])
  const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)
  try {
    while (draft.revision < 8)
      draft = await sessions.save(
        scope,
        {
          id: draft.id,
          name: draft.name,
          revision: draft.revision,
          files: draft.source.files
        },
        guard
      )
    const oldPreview = sessions.developmentStatus(scope, draft.id)
    const oldSkill = await readFile(
      join(lease.snapshot.packagePath, "skills/draft/SKILL.md"),
      "utf8"
    )
    await expect(sessions.compile(scope, draft.id, 8, guard)).rejects.toMatchObject({
      message: "PROJECT_DRAFT_LIMIT",
      reason: "revision"
    })
    const original = sessions.read(scope, draft.id)
    const copied = await sessions.save(
      scope,
      {
        id: "continued",
        name: original.name,
        revision: 0,
        files: original.source.files
      },
      guard
    )
    expect(copied.source).toEqual(original.source)
    expect(copied.development).toBeUndefined()
    expect(copied.directory).not.toBe(original.directory)
    const compiled = await sessions.compile(scope, copied.id, copied.revision, guard)
    for (const path of ["plugin.json", "devclaw.project-actions.lock.json"])
      expect(compiled.source.files.find((file) => file.path === path)?.text).toBe(
        original.source.files.find((file) => file.path === path)?.text
      )
    expect(
      JSON.parse(
        compiled.source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
      )
    ).toEqual(
      JSON.parse(
        original.source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
      )
    )
    expect(
      await sessions.inspect(scope, copied.id, compiled.revision, "doctor", guard, [action])
    ).toMatchObject({ valid: true })
    expect(
      await sessions.inspect(scope, copied.id, compiled.revision, "test", guard, [action])
    ).toMatchObject({ valid: true })
    expect(sessions.read(scope, original.id).source).toEqual(original.source)
    expect(sessions.developmentStatus(scope, original.id)).toEqual(oldPreview)
    expect(lease.snapshot.revision).toBe(2)
    expect(await readFile(join(lease.snapshot.packagePath, "skills/draft/SKILL.md"), "utf8")).toBe(
      oldSkill
    )
  } finally {
    lease.release()
  }
})

it("distinguishes draft and process capacity without changing the existing error code", async () => {
  const sessions = new ProjectAuthoringSessions()
  const guard = () => undefined
  for (let index = 0; index < 16; index++) {
    const current = { ...scope, threadId: `capacity-${index}` }
    const draft = await sessions.scaffold(current, "first", "项目", guard)
    roots.add(dirname(draft.directory))
    if (index === 0) {
      for (const id of ["second", "third", "fourth"])
        await sessions.save(
          current,
          { id, name: draft.name, revision: 0, files: draft.source.files },
          guard
        )
      await expect(sessions.scaffold(current, "fifth", "项目", guard)).rejects.toMatchObject({
        message: "PROJECT_DRAFT_LIMIT",
        reason: "drafts"
      })
      expect(sessions.read(current, "first").source).toEqual(draft.source)
    }
  }
  await expect(
    sessions.scaffold({ ...scope, threadId: "capacity-extra" }, "first", "项目", guard)
  ).rejects.toMatchObject({ message: "PROJECT_DRAFT_LIMIT", reason: "sessions" })
  for (const reason of ["revision", "drafts", "sessions"] as const) {
    expect(new ProjectDraftLimitError(reason).message).toBe("PROJECT_DRAFT_LIMIT")
    expect(projectDraftLimitHint(reason)).toContain("project_read")
  }
})

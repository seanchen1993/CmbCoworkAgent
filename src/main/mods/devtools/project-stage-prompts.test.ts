import { readFile, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import type { DevelopmentScope } from "../v2/development-session"
import { ProjectAuthoringSessions, type ProjectDraft } from "./project-authoring-session"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createProjectTemplate } from "./project-template"
import { ProjectStagePrompts, projectStagePromptsView } from "./project-stage-prompts"

const scope: DevelopmentScope = {
  threadId: "prompt-author",
  workspace: "workspace",
  incarnation: { token: "one", legacyCreatedAt: 1 }
}
const input = { threadId: scope.threadId, expectedWorkspace: scope.workspace }
const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) {
    const target = resolve(root)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !/^devclaw-project-authoring-[A-Za-z0-9]+$/.test(basename(target))
    )
      throw Error("Unsafe project prompt test cleanup")
    await rm(target, { recursive: true, force: true })
  }
  roots.clear()
})

async function fixture() {
  const sessions = new ProjectAuthoringSessions(async () => [])
  const first = await sessions.scaffold(scope, "report", "报告", () => {}, "native-modular")
  roots.add(dirname(first.directory))
  let current = true
  const prompts = new ProjectStagePrompts({
    sessions,
    workspaceKey: (value) => value,
    context: () => ({
      scope,
      assertCurrent: () => {
        if (!current) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
    })
  })
  const view = prompts.read({ ...input, id: first.id })
  const request = {
    ...input,
    id: first.id,
    revision: first.revision,
    sourceDigest: first.source.digest,
    stageId: view.stages[0].id,
    body: "核对来源，输出完整报告。\n"
  }
  return {
    sessions,
    first,
    prompts,
    request,
    view,
    revoke: () => {
      current = false
    }
  }
}

describe("project stage prompt authoring", () => {
  it("saves only the actual author body, preserves history/generated files and recompiles", async () => {
    const f = await fixture()
    expect(f.prompts.list(input).drafts).toEqual([f.view.draft])
    const path = f.view.stages[0].skillPath
    const original = f.first.source.files.find((file) => file.path === path)!.text
    const changed = await f.prompts.save(f.request)
    expect(changed.draft.revision).toBe(2)
    expect(changed.stages[0].body).toBe(f.request.body)
    expect(await readFile(join(f.first.directory, path), "utf8")).toBe(original)
    const draft = f.sessions.read(scope, f.first.id)
    expect(draft.source.files.filter((file) => file.path !== path)).toEqual(
      f.first.source.files.filter((file) => file.path !== path)
    )
    expect(draft.source.files.find((file) => file.path === path)!.text).toBe(
      original.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)![0] + f.request.body
    )
    expect(
      (
        await f.prompts.save({
          ...f.request,
          revision: 2,
          sourceDigest: changed.draft.sourceDigest
        })
      ).draft.revision
    ).toBe(2)
    const compiled = await f.sessions.compile(scope, f.first.id, 2, () => {})
    expect(
      await f.sessions.inspect(scope, f.first.id, compiled.revision, "test", () => {})
    ).toMatchObject({ valid: true })
  })

  it("rejects stale revisions, digest, scope, stage identity and oversized text", async () => {
    const f = await fixture()
    await expect(f.prompts.save({ ...f.request, sourceDigest: "a".repeat(64) })).rejects.toThrow(
      "PROJECT_DRAFT_SOURCE_CHANGED"
    )
    await expect(f.prompts.save({ ...f.request, stageId: "other" })).rejects.toThrow(
      "PROJECT_PROMPT_STAGE_MISSING"
    )
    await expect(f.prompts.save({ ...f.request, expectedWorkspace: "other" })).rejects.toThrow(
      "DEVELOPMENT_SCOPE_CHANGED"
    )
    await expect(f.prompts.save({ ...f.request, body: "文".repeat(30000) })).rejects.toThrow(
      "AUTHORING_SOURCE_LIMIT"
    )
    await f.sessions.patch(
      scope,
      {
        id: f.first.id,
        revision: 1,
        sourceDigest: f.first.source.digest,
        files: [
          {
            path: f.view.stages[0].skillPath,
            text:
              f.first.source.files.find((file) => file.path === f.view.stages[0].skillPath)!.text +
              "AI edit"
          }
        ]
      },
      () => {}
    )
    await expect(f.prompts.save(f.request)).rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
    f.revoke()
    expect(() => f.prompts.list(input)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(() => f.prompts.read({ ...input, id: f.first.id })).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    await expect(f.prompts.save(f.request)).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  })

  it("keeps the bounded history budget and grants no trial to a revised draft", async () => {
    const f = await fixture()
    let request = f.request
    for (let revision = 2; revision <= 8; revision++) {
      const view = await f.prompts.save({ ...request, body: `版本 ${revision}` })
      request = { ...request, revision: view.draft.revision, sourceDigest: view.draft.sourceDigest }
    }
    await expect(f.prompts.save({ ...request, body: "第九版" })).rejects.toMatchObject({
      message: "PROJECT_DRAFT_LIMIT",
      reason: "revision"
    })
    expect(f.sessions.read(scope, f.first.id).development).toBeUndefined()
  })

  it("uses the same projection for the Lean source and an unrelated report composition", async () => {
    const f = await fixture()
    const root = join(process.cwd(), "resources/native-compositions/autobiz-lean/project")
    const text = await readFile(join(root, "composition/source.json"), "utf8")
    const declaration = JSON.parse(text)
    const files = [
      { path: "composition/source.json", text },
      ...(await Promise.all(
        declaration.modules.map(async (module: { skill: string }) => ({
          path: module.skill,
          text: await readFile(join(root, module.skill), "utf8")
        }))
      ))
    ]
    const draft: ProjectDraft = { ...f.first, source: createAuthoringSourceBundle(files) }
    const view = projectStagePromptsView(scope, draft)
    expect(view.stages).toHaveLength(5)
    expect(view.stages.every((stage) => stage.editable && stage.checks.length)).toBe(true)
    expect(f.view.stages.every((stage) => stage.editable)).toBe(true)
  })

  it("keeps shared, missing, malformed or generated author sources read-only", async () => {
    const f = await fixture()
    const sourceFile = f.first.source.files.find((file) => file.path === "composition/source.json")!
    const native = JSON.parse(sourceFile.text)
    const firstSkill = native.modules[0].skill
    for (const kind of ["shared", "missing", "metadata", "generated", "declaration"] as const) {
      const declaration = structuredClone(native)
      let files = structuredClone(f.first.source.files)
      if (kind === "shared") declaration.modules[1].skill = firstSkill
      if (kind === "missing") files = files.filter((file) => file.path !== firstSkill)
      if (kind === "metadata")
        files.find((file) => file.path === firstSkill)!.text =
          "---\nname: [invalid]\ndescription: broken\n---\nText"
      if (kind === "generated")
        declaration.modules[0].skill = `skills/native-${native.modules[0].id}/SKILL.md`
      files.find((file) => file.path === sourceFile.path)!.text =
        kind === "declaration" ? "{" : JSON.stringify(declaration)
      const draft = { ...f.first, source: createAuthoringSourceBundle(files) }
      const view = projectStagePromptsView(scope, draft)
      if (kind === "declaration")
        expect(view).toMatchObject({ stages: [], diagnostic: expect.any(String) })
      else expect(view.stages[0]).toMatchObject({ editable: false, diagnostic: expect.any(String) })
    }
    const files = createProjectTemplate({ packageId: "old", name: "Old" }).files
    expect(
      projectStagePromptsView(scope, { ...f.first, source: createAuthoringSourceBundle(files) })
    ).toMatchObject({ stages: [], diagnostic: expect.any(String) })
  })

  it("rejects shared bodies on save and keeps a running preview pinned to its old source", async () => {
    const f = await fixture()
    await f.sessions.inspect(scope, f.first.id, 1, "dev", () => {})
    const lease = f.sessions.acquireDevelopment(scope, f.first.id, 1, () => {})
    try {
      const oldBody = await readFile(
        join(lease.snapshot.packagePath, f.view.stages[0].skillPath),
        "utf8"
      )
      await f.prompts.save(f.request)
      expect(
        await readFile(join(lease.snapshot.packagePath, f.view.stages[0].skillPath), "utf8")
      ).toBe(oldBody)
      expect(f.sessions.developmentStatus(scope, f.first.id)).toMatchObject({ activeRuns: 1 })
    } finally {
      lease.release()
    }
    const draft = f.sessions.read(scope, f.first.id)
    const native = JSON.parse(
      draft.source.files.find((file) => file.path === "composition/source.json")!.text
    )
    native.modules[1].skill = native.modules[0].skill
    const shared = await f.sessions.patch(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        sourceDigest: draft.source.digest,
        files: [{ path: "composition/source.json", text: JSON.stringify(native) }]
      },
      () => {}
    )
    await expect(
      f.prompts.save({
        ...f.request,
        revision: shared.revision,
        sourceDigest: shared.source.digest
      })
    ).rejects.toThrow("PROJECT_PROMPT_READ_ONLY")
    native.modules[1].id = native.modules[0].id
    const duplicate = {
      ...shared,
      source: createAuthoringSourceBundle(
        shared.source.files.map((file) =>
          file.path === "composition/source.json" ? { ...file, text: JSON.stringify(native) } : file
        )
      )
    }
    expect(projectStagePromptsView(scope, duplicate)).toMatchObject({
      stages: [],
      diagnostic: expect.any(String)
    })
  })

  it("preserves CRLF, metadata comments and YAML spelling exactly", async () => {
    const f = await fixture()
    const prefix =
      "---\r\n# preserve this\r\nname: 'original-name'\r\ndescription: \"Actual purpose\"\r\n---\r\n"
    const updated = await f.sessions.patch(
      scope,
      {
        id: f.first.id,
        revision: 1,
        sourceDigest: f.first.source.digest,
        files: [{ path: f.view.stages[0].skillPath, text: prefix + "Original" }]
      },
      () => {}
    )
    await f.prompts.save({
      ...f.request,
      revision: updated.revision,
      sourceDigest: updated.source.digest
    })
    expect(
      f.sessions
        .read(scope, f.first.id)
        .source.files.find((file) => file.path === f.view.stages[0].skillPath)!.text
    ).toBe(prefix + f.request.body)
  })
})

it("shows the declared stage purpose without inventing a replacement prompt", async () => {
  const f = await fixture()
  expect(f.view.stages[0].description).toBeTruthy()
  expect(f.view.stages[0].body).toBeTruthy()
  expect(f.view.stages[0].body).not.toContain("description:")
})

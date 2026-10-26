import { dirname, resolve } from "node:path"
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { readProjectSource } from "./project-source"
import { compileFunctionPlugin } from "../v2/loader"
import type { DevelopmentScope } from "../v2/development-session"

const scope: DevelopmentScope = {
  threadId: "native-composition-creator",
  workspace: "isolated-workspace",
  incarnation: { token: "current", legacyCreatedAt: 1 }
}
const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

describe("native module source through existing project_compile", () => {
  it("saves, compiles, doctors and reads the same source resources without a second runtime author source", async () => {
    const source = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
    let catalogs = 0
    const sessions = new ProjectAuthoringSessions(async () => {
      catalogs++
      return []
    })
    const draft = await sessions.save(
      scope,
      { id: "vendor", name: "供应商", revision: 0, files: source.bundle.files },
      () => {}
    )
    roots.add(dirname(draft.directory))
    const compiled = await sessions.compile(scope, draft.id, draft.revision, () => {})
    expect(catalogs).toBe(1)
    expect(compiled).toMatchObject({
      revision: 2,
      validation: {
        doctor: { valid: true },
        tests: { valid: true },
        businessActionsExecuted: false
      }
    })
    expect((await readProjectSource(compiled.directory)).bundle.digest).toBe(compiled.source.digest)
    expect(
      sessions
        .read(scope, draft.id)
        .source.files.some((file) => file.path === "composition/source.json")
    ).toBe(true)
    await expect(sessions.compile(scope, draft.id, draft.revision, () => {})).rejects.toThrow(
      "REVISION_CHANGED"
    )
    const mixed = await sessions.save(
      scope,
      {
        id: draft.id,
        name: draft.name,
        revision: compiled.revision,
        files: [...compiled.source.files, { path: "devclaw.harness.json", text: "{}" }]
      },
      () => {}
    )
    await expect(sessions.compile(scope, mixed.id, mixed.revision, () => {})).rejects.toThrow(
      "MULTIPLE_SOURCES"
    )
  })

  it("requires actual check providers and reports that compilation is not business execution", async () => {
    const original = await compileFunctionPlugin(
      resolve("resources/native-compositions/autobiz-rules")
    )
    const actions = original!.actions!.map(({ id, ...item }) => ({
      ...item,
      actionId: id,
      pluginId: "isolated-provider",
      plugin: original!.name,
      digest: original!.digest
    }))
    const knowledge = await compileFunctionPlugin(resolve("resources/native-compositions/autobiz-knowledge"))
    actions.push(...knowledge!.actions!.map(({ id, ...item }) => ({ ...item, actionId: id,
      pluginId: "isolated-knowledge", plugin: knowledge!.name, digest: knowledge!.digest })))
    let granted = false
    const sessions = new ProjectAuthoringSessions(async () => (granted ? actions : []))
    const source = await readProjectSource(resolve("resources/native-compositions/autobiz"))
    const draft = await sessions.save(
      scope,
      { id: "business", name: "AutoBiz原生切片", revision: 0, files: source.bundle.files },
      () => {}
    )
    roots.add(dirname(draft.directory))
    await expect(sessions.compile(scope, draft.id, 1, () => {})).rejects.toThrow(
      "PROVIDER_UNRESOLVED"
    )
    await expect(sessions.compile(scope, draft.id, 1, () => {})).rejects.toMatchObject({
      dependencies: expect.arrayContaining([
        expect.objectContaining({
          plugin: "autobiz-native-rules",
          actionId: "plan",
          state: "missing-or-not-authorized",
          candidates: [],
          next: expect.stringContaining("原生安装")
        })
      ])
    })
    expect(sessions.read(scope, draft.id).revision).toBe(1)
    granted = true
    const compiled = await sessions.compile(scope, draft.id, 1, () => {})
    expect(compiled).toMatchObject({
      validation: { doctor: { valid: true }, businessActionsExecuted: false }
    })
    expect(
      compiled.source.files.some((file) => file.path === "knowledge/configuration-mapping.json")
    ).toBe(true)
    expect(await sessions.inspect(scope, draft.id, 2, "doctor", () => {}, [])).toMatchObject({
      valid: false
    })
  })
})

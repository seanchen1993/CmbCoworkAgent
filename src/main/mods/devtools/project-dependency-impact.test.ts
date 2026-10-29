import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { createProjectTemplate } from "./project-template"
import { bindProjectPublicAction } from "./project-action-reuse"
import { projectDependencyImpact, summarizeProjectDependencyImpact, type DependencyImpactSource } from "./project-dependency-impact"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const action = { pluginId: "real-provider", plugin: "public-provider", digest: "a".repeat(64),
  actionId: "check", command: "check", name: "检查", inputSchema: { type: "object" } }

it.each(["LegacyProvider", "legacy_provider", "legacy.provider", "7legacy-provider", "7Legacy_Mod.v1"])(
  "accepts the existing loader's legal provider identity %s without normalizing it", async (plugin) => {
    const source = bindProjectPublicAction({
      source: createProjectTemplate({ packageId: "consumer", name: "调用者" }),
      stageId: "draft", localActionId: "check", action: { ...action, plugin }, constants: {}
    })
    const result = await projectDependencyImpact({ plugin,
      sources: [{ id: "consumer", name: "调用者", kind: "candidate", source }], assertCurrent: () => {} })
    expect(result.provider.plugin).toBe(plugin)
    expect(result.dependants[0].references).toMatchObject([
      { pluginId: action.pluginId, digest: action.digest, actionId: action.actionId, identityPinned: true }
    ])
  }
)

it("does not conflate differently cased provider identities during dependency discovery", async () => {
  const source = bindProjectPublicAction({
    source: createProjectTemplate({ packageId: "consumer", name: "调用者" }),
    stageId: "draft", localActionId: "check", action: { ...action, plugin: "Legacy_Mod.v1" }, constants: {}
  })
  const sources: DependencyImpactSource[] = [{ id: "consumer", name: "调用者", kind: "candidate", source }]
  expect((await projectDependencyImpact({ plugin: "Legacy_Mod.v1", sources, assertCurrent: () => {} }))
    .dependants).toHaveLength(1)
  expect((await projectDependencyImpact({ plugin: "legacy_mod.v1", sources, assertCurrent: () => {} }))
    .dependants).toEqual([])
})

it.each(["", "_provider", "-provider", ".provider", "../provider", "a/b", "a\\b", "a:b",
  "name space", "a\nb", "中文", "x".repeat(101)])("rejects invalid provider identity %j", async (plugin) => {
  await expect(projectDependencyImpact({ plugin, sources: [], assertCurrent: () => {} }))
    .rejects.toThrow("DEVELOPMENT_INPUT")
})

it("finds actual installed action locks and current source candidates without exposing inputs/configuration", async () => {
  const source = bindProjectPublicAction({
    source: createProjectTemplate({ packageId: "consumer", name: "调用者" }),
    stageId: "draft", localActionId: "check", action, constants: { privateText: "private-input" }
  })
  const directory = await mkdtemp(join(tmpdir(), "dependency-impact-"))
  roots.push(directory)
  await writeFile(join(directory, "devclaw.project-actions.lock.json"),
    source.files.find(file => file.path === "devclaw.project-actions.lock.json")!.text)
  const result = await projectDependencyImpact({ plugin: action.plugin, pluginId: action.pluginId,
    sources: [{ id: "installed", name: "已安装", kind: "installed", directory, enabled: false },
      { id: "draft", name: "当前候选", kind: "candidate", source }], assertCurrent: () => {} })
  expect(result.dependants).toHaveLength(2)
  expect(result.dependants[0]).toMatchObject({ enabled: false,
    references: [{ actionId: "check", digest: action.digest, identityPinned: true }] })
  expect(JSON.stringify(result)).not.toContain("private-input")
  expect(JSON.stringify(result)).not.toContain(directory)
  expect(result).toMatchObject({ complete: false, grantsAuthority: false, executed: false })
})

it("finds declarative native checks before compile and retains the actual pinned identity when both exist", async () => {
  const original = createProjectTemplate({ packageId: "native", name: "项目", template: "native-modular" })
  const sourceFile = original.files.find(file => file.path === "composition/source.json")!
  const native = JSON.parse(sourceFile.text)
  native.modules[0].checks.push({ id: "business-check", kind: "action", artifactId: native.modules[0].outputs[0].id,
    provider: { plugin: action.plugin, actionId: action.actionId }, format: "text" })
  const source = { ...original, files: original.files.map(file => file.path === sourceFile.path
    ? { ...file, text: JSON.stringify(native) } : file) }
  const result = await projectDependencyImpact({ plugin: action.plugin,
    sources: [{ id: "draft", name: "项目", kind: "candidate", source }], assertCurrent: () => {} })
  expect(result.uninspected).toEqual([])
  expect(result.dependants[0].references).toContainEqual({ actionId: action.actionId,
    usedBy: "business-check", identityPinned: false })
})

it("reports malformed sources and unknown dynamic references instead of claiming a complete safe replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dependency-impact-invalid-"))
  roots.push(directory)
  await mkdir(join(directory, "composition"))
  await writeFile(join(directory, "composition/source.json"), "{broken private C:/secret/key")
  const result = await projectDependencyImpact({ plugin: action.plugin,
    sources: [{ id: "broken", name: "损坏", kind: "installed", directory }], assertCurrent: () => {} })
  expect(result.dependants).toEqual([])
  expect(result.uninspected).toContainEqual({ id: "broken", kind: "installed",
    reason: "declaration-unreadable-or-invalid" })
  expect(JSON.stringify(result)).not.toContain("C:/secret")
  expect(result.limitation).toContain("Dynamic JavaScript")
})

it("pages source inspection and preserves revocation instead of swallowing it as a diagnostic", async () => {
  const sources: DependencyImpactSource[] = Array.from({ length: 17 }, (_, i) => ({
    id: `source-${i}`, name: "来源", kind: "candidate", source: createProjectTemplate({ packageId: `source-${i}`, name: "来源" }) }))
  const first = await projectDependencyImpact({ plugin: action.plugin, sources, assertCurrent: () => {} })
  expect(first).toMatchObject({ inspectedSources: 16, nextCursor: 16 })
  const last = await projectDependencyImpact({ plugin: action.plugin, sources, cursor: 16, assertCurrent: () => {} })
  expect(last).toMatchObject({ inspectedSources: 1, nextCursor: null })
  await expect(projectDependencyImpact({ plugin: action.plugin, sources,
    assertCurrent: () => { throw Error("revoked") } })).rejects.toThrow("revoked")
})

it("bounds display-only legal long names without changing dependency identity or blocking a native summary", async () => {
  const source = bindProjectPublicAction({ source: createProjectTemplate({ packageId: "consumer", name: "调用者" }),
    stageId: "draft", localActionId: "check", action, constants: {} })
  const longName = "合法旧插件名称".repeat(30)
  const report = await projectDependencyImpact({ plugin: action.plugin,
    sources: [{ id: "stable-installed-id", name: longName, kind: "installed", source }], assertCurrent: () => {} })
  expect(report.dependants[0].name).toHaveLength(100)
  expect(report.dependants[0].name.endsWith("…")).toBe(true)
  const summary = summarizeProjectDependencyImpact(report)
  expect(summary.knownDependants[0]).toMatchObject({ id: "stable-installed-id", actionIds: ["check"] })
  expect(summary.knownDependants[0].name).toHaveLength(100)
  expect(report.dependants[0].references[0]).toMatchObject({ pluginId: action.pluginId,
    digest: action.digest, actionId: action.actionId })
  expect(longName.length).toBeGreaterThan(100)
})

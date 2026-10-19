import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import ts from "typescript"
import { withLegacyProjectSkillSource } from "./project-runtime/legacy-entry-gate"

function resolver(deps: Record<string, unknown>) {
  const dependencies = { withLegacyProjectSkillSource, ...deps }
  const source = readFileSync(new URL("./auto-mode-action-executor.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function resolveHarnessSkill(")
  const end = source.indexOf("\nasync function prepareHarnessMessage(", start)
  const javascript = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(
    "deps",
    `const {${Object.keys(dependencies).join(",")}}=deps;${javascript};return resolveHarnessSkill`
  )(dependencies) as (project: string, skill: string, workspace: string) => Promise<{ path: string } | null>
}
it.each([true, false])(
  "original skill selection uses the retained package only for internal=%s",
  async (internal) => {
    const plugin = { id: "plugin", name: "source", path: "retained" }
    const local = vi.fn(async () => [{ name: "review", path: "unrelated-local" }])
    const list = vi.fn(async (sources?: Array<{ sourceDir: string }>) => [
      { name: "review", path: sources ? sources[0].sourceDir + "/SKILL.md" : "mutable/SKILL.md" }
    ])
    const read = vi.fn(() => (internal ? { context: { plugin } } : undefined))
    const resolve = resolver({
      readInternalHarnessProject: read,
      normalizeSkillId: (value: string) => value,
      getHarnessProjectAdapterSnapshot: async () => plugin,
      getPluginSkillSearchSources: (root: string) => [
        { sourceDir: root + "/skills/review", maxDepth: 0 }
      ],
      readPluginManifest: () => ({ manifest: {} }),
      listAllSkills: local,
      listPluginSkills: list,
      getDisabledSkills: () => [],
      isLocalSkillDisabled: () => false,
      isSkillVisibleForProjectMode: () => true,
      isSkillOwnedByBoundPlugin: (skill: { path: string }) => skill.path !== "unrelated-local"
    })
    expect((await resolve("project", "review", "workspace"))?.path).toBe(
      internal ? "retained/skills/review/SKILL.md" : "mutable/SKILL.md"
    )
    expect(local).toHaveBeenCalledTimes(internal ? 0 : 1)
    if (internal)
      expect(list).toHaveBeenCalledWith([
        expect.objectContaining({ pluginId: "plugin", pluginRoot: "retained" })
      ])
  }
)
it("a retained source replaced during skill discovery is rejected before session launch", async () => {
  let reads = 0
  const resolve = resolver({
    readInternalHarnessProject: () => ({
      context: {
        plugin: { id: "plugin", name: "source", path: ++reads === 1 ? "retained" : "replaced" }
      }
    }),
    normalizeSkillId: (value: string) => value,
    getHarnessProjectAdapterSnapshot: vi.fn(),
    getPluginSkillSearchSources: (root: string) => [{ sourceDir: root }],
    readPluginManifest: () => null,
    listAllSkills: vi.fn(),
    listPluginSkills: async () => []
  })
  await expect(resolve("project", "review", "workspace")).rejects.toThrow("COMPOSITION_INTERNAL_SOURCE_CHANGED")
})

it.each([true, false])(
  "original managed session is hidden only for an admitted internal project=%s",
  async (internal) => {
    const source = readFileSync(new URL("./auto-mode-action-executor.ts", import.meta.url), "utf8")
    const start = source.indexOf("export async function createManagedHarnessSession(")
    const javascript = ts.transpileModule(source.slice(start).replace("export async", "async"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const create = vi.fn<(metadata: Record<string, unknown>, options: unknown) => Promise<{ thread_id: string }>>(async () => ({
      thread_id: "thread"
    }))
    const invoke = new Function(
      "readInternalHarnessProject",
      "createThreadService",
      "generateTitle",
      "HARNESS_SOURCE",
      javascript + ";return createManagedHarnessSession"
    )(
      () => (internal ? { context: {} } : undefined),
      create,
      (value: string) => value,
      "autobizdevops"
    )
    await invoke({
      projectId: "project",
      workspacePath: "unit",
      featureId: "feature",
      runId: "run",
      nodeId: "node",
      nextAction: { userMessage: "Goal" }
    })
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      harnessFeature: { projectId: "project", runId: "run" }
    })
    expect(
      (create.mock.calls[0]?.[0] as unknown as Record<string, unknown>).isInternalFlowRuntime
    ).toBe(internal ? true : undefined)
  }
)

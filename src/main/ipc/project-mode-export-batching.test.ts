import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { expect, it, vi } from "vitest"

it("exports 1,020 cumulative projects in sequential 100-project batches alongside period user statistics", async () => {
  const source = createSourceFile(
    "dashboard.ts",
    readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
    ScriptTarget.Latest
  )
  const names = ["fetchProjectModeExportData", "enrichProjectModeProjectViews"]
  const functions = source.statements.filter(
    (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
  )
  expect(functions).toHaveLength(2)
  const compiled = transpileModule(
    `${functions.map((node) => node.getText(source)).join("\n")}\nglobalThis.runExport=fetchProjectModeExportData`,
    { compilerOptions: { target: ScriptTarget.ES2022 } }
  ).outputText
  const projects = Array.from({ length: 1020 }, (_, i) => ({ projectId: `p${i}`, features: [] }))
  const range = { from: "2026-10-01", to: "2026-10-31" }
  const opts = { createdInRangeOnly: false }
  const access = { sapId: "admin" }
  let active = 0,
    peak = 0
  const batchSizes: number[] = []
  async function tick() {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    active--
  }
  const usage = vi.fn(async (ids: string[], time: unknown, options: unknown, identity: unknown) => {
    expect(time).toBeNull()
    expect(options).toBe(opts)
    expect(identity).toBe(access)
    batchSizes.push(ids.length)
    await tick()
    return {
      perProject: new Map(ids.map((id) => [id, 1])),
      lastExecutionByProject: new Map(),
      executionByFeature: new Map(),
      perProjectSuspectedTechnicalDetail: new Map(),
      perProjectDevStage: new Map(),
      perProjectDevAssociatedFeatures: new Map(),
      perProjectSkills: new Map(),
      perProjectStageConversations: new Map(),
      perProjectRunCost: new Map()
    }
  })
  const metrics = vi.fn(async (ids: string[], time: unknown) => {
    expect(ids.length).toBeLessThanOrEqual(100)
    expect(time).toBeNull()
    await tick()
    return {
      byProject: new Map(),
      byProjectStage: new Map(),
      byFeature: new Map(),
      operationalByProject: new Map(),
      operationalByFeature: new Map(),
      managedRunCountByProject: new Map()
    }
  })
  const users = vi.fn(async (time: unknown, options: unknown, identity: unknown, ids: unknown) => {
    expect(time).toBe(range)
    expect(options).toBe(opts)
    expect(identity).toBe(access)
    expect(ids).toBeUndefined()
    await tick()
    return []
  })
  const context: Record<string, unknown> = {
    requireDashboardProjectModeAccess: () => access,
    fetchProjectModeExportSnapshotProjects: async () => ({
      projects,
      total: 1020,
      activeTotal: 974,
      archivedTotal: 46,
      truncated: false
    }),
    projectModeNarrowingEnabled: () => false,
    fetchProjectModeExportUsers: users,
    fetchProjectModePageUsage: usage,
    fetchProjectModeProjectMetrics: metrics,
    PROJECT_MODE_EXPORT_PROJECT_BATCH_SIZE: 100,
    PROJECT_MODE_EXPORT_PROJECT_LIMIT: 2000,
    isDashboardSuspectedTechnicalDetailAllowed: () => false,
    EMPTY_PROJECT_MODE_RUN_COST: {},
    isUserInputRequestCountComplete: () => true,
    buildStageBuckets: () => ({})
  }
  runInNewContext(compiled, context)
  const result = await (
    context.runExport as (
      range: unknown,
      options: unknown
    ) => Promise<{ projects: unknown[]; projectTotal: number; projectsTruncated: boolean }>
  )(range, opts)
  expect(result.projects).toHaveLength(1020)
  expect(result.projectTotal).toBe(1020)
  expect(result.projectsTruncated).toBe(false)
  expect(batchSizes).toEqual([...Array(10).fill(100), 20])
  expect(usage).toHaveBeenCalledTimes(11)
  expect(metrics).toHaveBeenCalledTimes(11)
  expect(users).toHaveBeenCalledTimes(1)
  expect(peak).toBe(3)
})

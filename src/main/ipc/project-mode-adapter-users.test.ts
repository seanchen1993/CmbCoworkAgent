import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { buildToolUsageAggs, parseToolUsageAggs } from "../../shared/dashboard-tool-usage"
import * as stages from "./dashboard-stage-buckets"
import { projectModeMetricTimeFilters } from "./project-mode-query-scope"
import { resolveTokenTotal } from "./dashboard-token-totals"

interface AdapterRow {
  name: string
  version?: string
  userCount: number
  allVersionsUserCount: number
  conversationCount: number
}

// Exercise the actual private query/parser and renderer aggregation without
// booting Electron or importing the complete dashboard component tree.
function compileFunctions(path: string, names: string[]) {
  const source = createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ScriptTarget.Latest
  )
  const functions = source.statements.filter(
    (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
  )
  expect(functions).toHaveLength(names.length)
  return transpileModule(
    `${functions.map((node) => node.getText(source)).join("\n")}\nglobalThis.functions = { ${names.join(",")} }`,
    { compilerOptions: { target: ScriptTarget.ES2022 } }
  ).outputText
}

const backend = compileFunctions("./dashboard.ts", [
  "asRecord",
  "asString",
  "asOptionalString",
  "asNumber",
  "adapterKey",
  "buildNonEmptySapIdFilter",
  "projectModeTraceFilters",
  "buildStageBuckets",
  "fetchProjectModeUsage"
])
const renderer = compileFunctions(
  "../../renderer/src/components/dashboard/panels/ProjectModePanel.tsx",
  ["adoptionRate", "mergeCodeStats", "mergeStageBuckets", "aggregateAdaptersByName"]
)
const range = { from: "2026-11-01", to: "2026-11-06" }
const orgFilter = { term: { upperOrgLv1: "研发部" } }

function conversations(count: number, users: number) {
  return { doc_count: count, identified_users: { user_count: { value: users } } }
}

async function usage(buckets: unknown[], projectIds?: string[]) {
  const queryToolUsage = vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(async () => ({
    aggregations: { by_adapter: { buckets } }
  }))
  const context = {
    ...stages,
    projectModeMetricTimeFilters,
    resolveTokenTotal,
    buildToolUsageAggs,
    parseToolUsageAggs,
    FILTERED_TOOL_EXCLUDES: [],
    buildProjectModeOrgFilter: () => orgFilter,
    combineSkillCountBuckets: () => [],
    parseProjectModeTopUserBuckets: () => [],
    queryToolUsage,
    functions: {} as {
      fetchProjectModeUsage: (...args: unknown[]) => Promise<{ adapters: Map<string, AdapterRow> }>
    }
  }
  runInNewContext(backend, context)
  const result = await context.functions.fetchProjectModeUsage(range, {}, {}, projectIds)
  return { adapters: [...result.adapters.values()], queryToolUsage }
}

function byName(adapters: AdapterRow[]) {
  const context = {
    functions: {} as {
      aggregateAdaptersByName: (rows: AdapterRow[]) => AdapterRow[]
    }
  }
  runInNewContext(renderer, context)
  return context.functions.aggregateAdaptersByName(adapters)
}

describe("project plugin user counts", () => {
  it("uses cross-version distinct users instead of adding version counts or conversations", async () => {
    // v1: A/B; v2: B/C. The plugin total is three people, not four or 30 turns.
    const { adapters, queryToolUsage } = await usage([
      {
        key: "plugin",
        main_agent_conversations: conversations(30, 3),
        by_version: {
          buckets: [
            { key: "v1", main_agent_conversations: conversations(10, 2) },
            { key: "v2", main_agent_conversations: conversations(20, 2) }
          ]
        }
      },
      { key: "other", main_agent_conversations: conversations(5, 1) }
    ])
    expect(
      adapters.map(({ name, version, userCount, allVersionsUserCount }) => [
        name,
        version,
        userCount,
        allVersionsUserCount
      ])
    ).toEqual([
      ["plugin", "v1", 2, 3],
      ["plugin", "v2", 2, 3],
      ["other", undefined, 1, 1]
    ])
    // Snapshot-only versions may precede the usage rows and have no activity.
    const snapshotOnly = {
      ...adapters[0],
      version: "v3",
      conversationCount: 0,
      userCount: 0,
      allVersionsUserCount: 0
    }
    expect(
      byName([snapshotOnly, ...adapters]).map(({ name, userCount, conversationCount }) => [
        name,
        userCount,
        conversationCount
      ])
    ).toEqual([
      ["plugin", 3, 30],
      ["other", 1, 5]
    ])
    expect(queryToolUsage).toHaveBeenCalledTimes(1)
  })

  it("keeps users with missing plugin versions and returns zero for anonymous-only activity", async () => {
    const { adapters } = await usage([
      {
        key: "mixed",
        main_agent_conversations: conversations(4, 3),
        by_version: {
          buckets: [
            { key: "", main_agent_conversations: conversations(1, 1) },
            { key: "v1", main_agent_conversations: conversations(3, 2) }
          ]
        }
      },
      { key: "anonymous", main_agent_conversations: conversations(9, 0) }
    ])
    expect(adapters.map(({ version, userCount }) => [version, userCount])).toEqual([
      [undefined, 1],
      ["v1", 2],
      [undefined, 0]
    ])
    expect(byName(adapters).map(({ userCount }) => userCount)).toEqual([3, 0])
  })

  it.each([
    { scope: "filtered", projectIds: ["project-a", "project-b"] },
    { scope: "empty", projectIds: [] },
    { scope: "unrestricted", projectIds: undefined }
  ])(
    "shares overview scope and a single bounded aggregation for $scope projects",
    async ({ projectIds }) => {
      const { queryToolUsage } = await usage([], projectIds)
      const query = queryToolUsage.mock.calls[0]?.[0] as unknown as {
        size: number
        query: { bool: { filter: unknown[] } }
        aggs: {
          by_adapter: {
            aggs: {
              main_agent_conversations: { filter: unknown; aggs: Record<string, unknown> }
              by_version: { terms: Record<string, unknown>; aggs: Record<string, unknown> }
            }
          }
        }
      }
      expect(query.size).toBe(0)
      expect(query.query.bool.filter).toEqual([
        { range: { startedAt: { gte: range.from, lte: range.to } } },
        { exists: { field: "harnessProjectId" } },
        orgFilter,
        ...(projectIds ? [{ terms: { harnessProjectId: projectIds } }] : [])
      ])
      const { main_agent_conversations: main, by_version: versions } = query.aggs.by_adapter.aggs
      expect(main.filter).toEqual(stages.projectModeMainAgentConversationFilter())
      expect(main.aggs.identified_users).toEqual({
        filter: {
          bool: { must: [{ exists: { field: "sapId" } }], must_not: [{ term: { sapId: "" } }] }
        },
        aggs: { user_count: { cardinality: { field: "sapId" } } }
      })
      expect(versions.aggs.main_agent_conversations).toEqual(main)
      expect(versions.terms).toEqual({ field: "harnessAdapterVersion", size: 50, missing: "" })
      expect(queryToolUsage).toHaveBeenCalledTimes(1)
    }
  )
})

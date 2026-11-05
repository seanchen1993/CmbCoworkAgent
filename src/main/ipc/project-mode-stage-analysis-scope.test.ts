import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { expect, it, vi } from "vitest"
import * as stage from "./project-mode-stage-analysis"
import {
  projectModeMetricTimeFilters,
  assertProjectModeResultComplete
} from "./project-mode-query-scope"

type Json = Record<string, unknown>
const record = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {})
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const node = source.statements.find(
  (n) => isFunctionDeclaration(n) && n.name?.text === "fetchProjectModeStageAnalysis"
)!
const compiled = transpileModule(
  `${node.getText(source)}\nglobalThis.load=fetchProjectModeStageAnalysis`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText
function fixture() {
  const esQuery = vi.fn().mockResolvedValue({ aggregations: {} })
  const context: Json = {
    ...stage,
    projectModeMetricTimeFilters,
    assertProjectModeResultComplete,
    requireDashboardProjectModeAccess: () => ({ sapId: "allowed-user" }),
    buildProjectModeOrgFilter: () => ({ term: { upperOrgLv1: "本室" } }),
    asRecord: record,
    getEsIndex: () => "trace",
    esQuery,
    isNestedMappingError: (error: unknown, field: string) => String(error).includes(field),
    UNATTRIBUTED_NODE_NAME: "未归因",
    PROJECT_MODE_FEATURE_SLUG_LIMIT: 200
  }
  runInNewContext(compiled, context)
  return {
    esQuery,
    load: context.load as (id: string, range: unknown, opts?: Json) => Promise<unknown>
  }
}
it("applies exact project/feature/permission filters before every stage aggregate with lifetime dates", async () => {
  const { load, esQuery } = fixture()
  await load("p", null, { featureSlug: "f" })
  const body = esQuery.mock.calls[0][1]
  expect(body.track_total_hits).toBe(false)
  expect(body.size).toBe(0)
  expect(body.query.bool.filter).toEqual([
    { term: { harnessProjectId: "p" } },
    { term: { harnessFeatureSlug: "f" } },
    { term: { upperOrgLv1: "本室" } }
  ])
  expect(body.aggs).toHaveProperty("stage_usage")
  expect(body.aggs).toHaveProperty("stage_duration")
  expect(JSON.stringify(body)).not.toMatch(/_raw|top_hits|"range"/)
  await load("p", null)
  expect(JSON.stringify(esQuery.mock.calls[1][1].query)).not.toContain("harnessFeatureSlug")
  expect(esQuery).toHaveBeenCalledTimes(2)
})
it("keeps feature scope through the existing old-mapping fallback and rejects partial replies", async () => {
  const { load, esQuery } = fixture()
  esQuery.mockRejectedValueOnce(new Error("missing stageUsage"))
  await load("p", null, { featureSlug: "f" })
  expect(esQuery).toHaveBeenCalledTimes(2)
  for (const [, body] of esQuery.mock.calls)
    expect(body.query.bool.filter).toContainEqual({ term: { harnessFeatureSlug: "f" } })
  expect(esQuery.mock.calls[1][1].aggs).not.toHaveProperty("stage_usage")
  esQuery.mockResolvedValueOnce({ timed_out: true, aggregations: {} })
  await expect(load("p", null, { featureSlug: "f" })).rejects.toThrow("未完整")
  await expect(load("p", null, { featureSlug: ["f"] })).rejects.toThrow("筛选无效")
})

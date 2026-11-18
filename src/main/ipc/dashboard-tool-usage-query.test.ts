import { expect, it, vi } from "vitest"
import { buildToolUsageAggs } from "../../shared/dashboard-tool-usage"
import {
  FILTERED_TOOL_EXCLUDES,
  queryWithToolUsageMappingFallback
} from "./dashboard-tool-usage-query"

it("excludes both built-in shell result tools from complete and legacy rankings", () => {
  const query = buildToolUsageAggs(FILTERED_TOOL_EXCLUDES)
  const names = ["monitor", "task_output"]
  const filters = query.tool_usage_complete.aggs.usage.aggs.filtered.filter.bool.must_not
  expect(filters[0].terms["toolUsage.name"]).toEqual(expect.arrayContaining(names))
  expect(query.tool_usage_legacy_filtered.terms.exclude).toEqual(expect.arrayContaining(names))
})

it("keeps filters and other metrics available when the nested mapping is not deployed", async () => {
  const query = {
    query: { term: { harnessProjectId: "p" } },
    aggs: { tool_usage_complete: {}, tool_usage_trace_docs: {}, total_tokens: {} }
  }
  const execute = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("ES unavailable", {
        cause: new Error("[nested] failed to find nested object under path [toolUsage]")
      })
    )
    .mockResolvedValueOnce({ ok: true })
  await expect(queryWithToolUsageMappingFallback(execute, query)).resolves.toEqual({ ok: true })
  expect(execute.mock.calls[1][0]).toEqual({
    ...query,
    aggs: { tool_usage_trace_docs: {}, total_tokens: {} }
  })
  expect(query.aggs).toHaveProperty("tool_usage_complete")
})

it("does not turn permission or network failures into an empty ranking", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("permission denied"))
  await expect(queryWithToolUsageMappingFallback(execute, {})).rejects.toThrow("permission denied")
  expect(execute).toHaveBeenCalledTimes(1)
})

/** What esQuery throws on the worker path: the ES body is in a plain-object cause. */
function workerEsError(detail: string): Error {
  const fromWorker = new Error("请检查网络连接后重试", {
    cause: { code: "DASHBOARD_ES_HTTP_ERROR", message: detail }
  })
  return new Error("请检查网络连接后重试", { cause: fromWorker })
}

it("reads the ES reason from the worker's flattened cause chain", async () => {
  const query = { aggs: { tool_usage_complete: {}, total_tokens: {} } }
  const execute = vi
    .fn()
    .mockRejectedValueOnce(
      workerEsError(
        'ES 400: {"error":{"root_cause":[{"type":"aggregation_execution_exception",' +
          '"reason":"[nested] nested path [toolUsage] is not nested"}]'
      )
    )
    .mockResolvedValueOnce({ ok: true })
  await expect(queryWithToolUsageMappingFallback(execute, query)).resolves.toEqual({ ok: true })
  expect(execute.mock.calls[1][0]).toEqual({ aggs: { total_tokens: {} } })

  const unreachable = vi.fn().mockRejectedValue(workerEsError("fetch failed"))
  await expect(queryWithToolUsageMappingFallback(unreachable, query)).rejects.toThrow(
    "请检查网络连接后重试"
  )
  expect(unreachable).toHaveBeenCalledTimes(1)
})

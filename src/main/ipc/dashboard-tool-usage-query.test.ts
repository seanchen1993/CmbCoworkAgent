import { expect, it, vi } from "vitest"
import { queryWithToolUsageMappingFallback } from "./dashboard-tool-usage-query"

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

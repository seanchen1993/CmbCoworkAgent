import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchProjectMetricPeriodCode } from "./project-metric-period-code"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
describe("周期代码项目依据", () => {
  it("完整分页超过10000条，不读取事件明细，保持生成日期和Push过滤", async () => {
    const inputs: Record<string, unknown>[] = []
    const query = vi.fn(async (_index: string, body: Record<string, unknown>) => {
      inputs.push(body)
      const page = (body.aggs as { project_code: { composite: { after?: { project: string } } } })
        .project_code.composite
      const start = page.after ? Number(page.after.project) + 1 : 0
      const end = Math.min(start + 500, 10003)
      return {
        aggregations: {
          project_code: {
            buckets: Array.from({ length: end - start }, (_, i) => ({
              key: { room: "A室", project: String(start + i) },
              code_adopt_pushed: {
                pushed_adopted_lines: { value: 2 },
                pushed_effective_generated_lines: { value: 4 }
              }
            })),
            ...(end < 10003 ? { after_key: { room: "A室", project: String(end - 1) } } : {})
          }
        }
      }
    })
    const result = await fetchProjectMetricPeriodCode(
      query,
      "events",
      [{ range: { "properties.generatedAt": { gte: "2026-10-01", lte: "2026-10-31" } } }],
      { filter: { match_all: {} }, aggs: {} }
    )
    expect(result).toHaveLength(10003)
    expect(result[0]).toEqual({
      roomName: "A室",
      harnessProjectId: "0",
      pushedAdoptedLines: 2,
      pushedEffectiveGeneratedLines: 4
    })
    expect(inputs).toHaveLength(21)
    expect(inputs[0]).toMatchObject({
      size: 0,
      query: { bool: { filter: expect.arrayContaining([{ term: { "properties.pushed": true } }]) } }
    })
    expect(JSON.stringify(inputs)).not.toContain('"createDate"')
  })
  it("失败、缺少桶、重复游标都明确失败", async () => {
    await expect(
      fetchProjectMetricPeriodCode(async () => ({ timed_out: true }), "e", [], {})
    ).rejects.toThrow("未完整返回")
    await expect(
      fetchProjectMetricPeriodCode(async () => ({ aggregations: {} }), "e", [], {})
    ).rejects.toThrow("未完整返回")
    const query = async () => ({
      aggregations: {
        project_code: {
          buckets: [{ key: { project: "x", room: null }, code_adopt_pushed: {} }],
          after_key: { room: null, project: "x" }
        }
      }
    })
    await expect(fetchProjectMetricPeriodCode(query, "e", [], {})).rejects.toThrow("分页游标")
  })
})

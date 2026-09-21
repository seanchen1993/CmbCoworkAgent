import { describe, expect, it } from "vitest"
import {
  buildProjectModeRunCostAggs,
  isUserInputRequestCountComplete,
  parseProjectModeRunCost,
  EMPTY_PROJECT_MODE_RUN_COST
} from "./project-mode-run-cost-metrics"

/**
 * 项目模式「运行开销」四项的聚合与读取。
 *
 * 这组用例主要钉两件事：
 *
 * 1. 聚合读的是 trace 顶层标量，不是数组长度。modelCalls 数组停在 64 上限、还可能被
 *    sanitizer 清空，长会话用数组会少算一个数量级——这个坑在 modelCallCount 上踩过。
 * 2. sum 缺字段时返回 0 而不是 null，所以必须有覆盖度探针，否则老数据混进来时这一列
 *    会悄悄变小且不报错。Token 总量那一列就因为同样的原因长期恒显 0。
 */

describe("运行开销的聚合条件", () => {
  it("四项读的都是 trace 顶层标量字段", () => {
    const aggs = buildProjectModeRunCostAggs() as Record<string, { sum?: { field: string } }>
    expect(aggs.run_cost_tool_calls.sum?.field).toBe("totalToolCalls")
    expect(aggs.run_cost_model_calls.sum?.field).toBe("modelCallCount")
    expect(aggs.run_cost_total_tokens.sum?.field).toBe("totalTokens")
    expect(aggs.run_cost_user_input_requests.sum?.field).toBe("userInputRequestCount")
  })

  it("请求用户回答次数额外带一个 value_count 探针", () => {
    // sum 对缺字段返回 0，分不出「真的没问过」和「这批数据没这个字段」。
    const aggs = buildProjectModeRunCostAggs() as Record<
      string,
      { value_count?: { field: string } }
    >
    expect(aggs.run_cost_user_input_docs.value_count?.field).toBe("userInputRequestCount")
  })
})

describe("运行开销的读取", () => {
  it("正常桶按字段取值", () => {
    const runCost = parseProjectModeRunCost({
      run_cost_tool_calls: { value: 1234 },
      run_cost_model_calls: { value: 89 },
      run_cost_total_tokens: { value: 456_700 },
      run_cost_input_tokens: { value: 379_100 },
      run_cost_output_tokens: { value: 59_400 },
      run_cost_user_input_requests: { value: 12 },
      run_cost_user_input_docs: { value: 40 }
    })

    expect(runCost).toEqual({
      toolCalls: 1234,
      modelCalls: 89,
      // 输入+输出 < 总量：差额是缓存读取与创建，这不是对不上，是三个不同的量。
      totalTokens: 456_700,
      inputTokens: 379_100,
      outputTokens: 59_400,
      userInputRequests: 12,
      userInputRequestDocs: 40
    })
  })

  it("桶缺失或类型不对时全零，不把 NaN 抛到界面", () => {
    expect(parseProjectModeRunCost(undefined)).toEqual(EMPTY_PROJECT_MODE_RUN_COST)
    expect(parseProjectModeRunCost({})).toEqual(EMPTY_PROJECT_MODE_RUN_COST)
    expect(
      parseProjectModeRunCost({
        run_cost_tool_calls: { value: "1234" },
        run_cost_model_calls: { value: Number.NaN },
        run_cost_total_tokens: { value: -5 }
      })
    ).toEqual(EMPTY_PROJECT_MODE_RUN_COST)
  })
})

describe("请求用户回答次数的覆盖度", () => {
  it("每一轮都带这个字段时算完整", () => {
    const runCost = {
      ...EMPTY_PROJECT_MODE_RUN_COST,
      userInputRequests: 3,
      userInputRequestDocs: 40
    }
    expect(isUserInputRequestCountComplete(runCost, 40)).toBe(true)
  })

  it("带字段的文档少于轮次数时算不完整", () => {
    // 时间范围跨到该字段上线之前：40 轮里只有 12 轮带字段，sum 出来的 3 是个下限。
    const runCost = {
      ...EMPTY_PROJECT_MODE_RUN_COST,
      userInputRequests: 3,
      userInputRequestDocs: 12
    }
    expect(isUserInputRequestCountComplete(runCost, 40)).toBe(false)
  })

  it("一轮都没有时不算缺失", () => {
    // 没有轮次就没有什么可缺的，这时候标「数据缺失」纯属噪音。
    expect(isUserInputRequestCountComplete(EMPTY_PROJECT_MODE_RUN_COST, 0)).toBe(true)
  })

  it("真的一次都没问过用户，和数据缺失要能分开", () => {
    // 40 轮都带字段、值全是 0：这是「确实没问过」，不该标缺失。
    const neverAsked = {
      ...EMPTY_PROJECT_MODE_RUN_COST,
      userInputRequests: 0,
      userInputRequestDocs: 40
    }
    expect(isUserInputRequestCountComplete(neverAsked, 40)).toBe(true)

    // 同样是 0，但一条带字段的都没有：这是缺失。
    const noField = {
      ...EMPTY_PROJECT_MODE_RUN_COST,
      userInputRequests: 0,
      userInputRequestDocs: 0
    }
    expect(isUserInputRequestCountComplete(noField, 40)).toBe(false)
  })
})

describe("输入 / 输出 Token", () => {
  it("两项各自独立聚合，字段名指向 trace 上的标量", () => {
    const aggs = buildProjectModeRunCostAggs() as Record<string, { sum?: { field: string } }>
    expect(aggs.run_cost_input_tokens.sum?.field).toBe("totalInputTokens")
    expect(aggs.run_cost_output_tokens.sum?.field).toBe("totalOutputTokens")
    // 总量仍然单独取：它还含缓存读取与创建，不是输入+输出。
    expect(aggs.run_cost_total_tokens.sum?.field).toBe("totalTokens")
  })

  it("缺字段时按 0 读，不影响其他项", () => {
    // 这两个字段比 totalTokens 晚，老 trace 上没有；ES 的 sum 对缺失字段返回 0。
    const runCost = parseProjectModeRunCost({
      run_cost_total_tokens: { value: 900 },
      run_cost_tool_calls: { value: 5 }
    })
    expect(runCost.totalTokens).toBe(900)
    expect(runCost.toolCalls).toBe(5)
    expect(runCost.inputTokens).toBe(0)
    expect(runCost.outputTokens).toBe(0)
  })
})

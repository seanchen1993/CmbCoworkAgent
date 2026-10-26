import { describe, expect, it } from "vitest"
import { resolveTokenTotal } from "./dashboard-token-totals"

/**
 * 这些用例钉的是活跃用户列表「Token」一列恒为 0 的读数问题。
 *
 * 四处聚合读取里有三处写了 `asNumber(total_tokens.value, 输入+输出)` 的兜底，另一
 * 处连兜底都没有。三处的兜底看着对，但 ES 的 sum 聚合在字段缺失时返回 0 而不是
 * null，asNumber 只在"不是有限数"时回退，所以那条兜底一次都执行不到。
 *
 * 和之前 resolveModelCallCount 是同一个形状：缺失态伪装成一个合法值
 * （sum 的 0、`Array.isArray([])` 的 true），让防御分支变成死代码。
 */
describe("resolveTokenTotal", () => {
  it("字段取不到时用 输入+输出 兜底", () => {
    // ES sum 聚合对缺失字段返回 0，不是 null——这正是原兜底失效的地方。
    expect(resolveTokenTotal(0, 1200, 340)).toBe(1540)
  })

  it("总量有值时以总量为准，不去重算", () => {
    // totalTokens 可能含 cache，与 输入+输出 不相等是正常的，不该被覆盖。
    expect(resolveTokenTotal(9000, 1200, 340)).toBe(9000)
  })

  it("真的一个 token 都没用时仍然是 0", () => {
    // 比如整个窗口只有一条没走模型调用的定时任务 trace。
    expect(resolveTokenTotal(0, 0, 0)).toBe(0)
  })

  it("聚合容器缺失或类型不对时不崩，退到 输入+输出", () => {
    expect(resolveTokenTotal(undefined, 700, 300)).toBe(1000)
    expect(resolveTokenTotal(null, 700, 300)).toBe(1000)
    expect(resolveTokenTotal("9000", 700, 300)).toBe(1000)
    expect(resolveTokenTotal(Number.NaN, 700, 300)).toBe(1000)
  })

  it("负数按取不到处理", () => {
    // token 不可能为负；真出现说明这个值不可信，用输入输出更稳。
    expect(resolveTokenTotal(-5, 700, 300)).toBe(1000)
  })
})

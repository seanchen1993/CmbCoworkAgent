import { describe, expect, it } from "vitest"
import {
  mainAgentConversationAggs,
  parseStageBucketConversations,
  projectModeMainAgentConversationFilter,
  readMainAgentConversations,
  stageBucketAggKey,
  stageBucketCodeAggs,
  stageBucketTraceAggs,
  stageBucketTraceFilterClause
} from "./dashboard-stage-buckets"

/**
 * 这些用例钉的是一次读数事故：项目列表的「对话数」早就只算主动触发的主 Agent
 * root trace，但阶段细分、stage×skill 三桶、插件维度的对话数都挂在那个 filter
 * 之外。一次用户轮次派出 10 个 Task 子代理就被记成 11 次对话，于是「插件约束
 * 3 对话 523 行 vs VibeCoding 38 对话 296 行」读起来像 VibeCoding 压倒性占优，
 * 实际多出来的分母全是子代理 trace。
 *
 * 断言 ES body 的字面结构没有意义——嵌错一层照样"结构正确"。所以下面用一个
 * 最小 DSL 求值器，把构造出来的过滤条件真的作用在样本文档上，断言的是语义：
 * 哪些 trace 会被算进对话数，哪条产出落进哪个桶。
 */

type Doc = Record<string, unknown>
type Clause = Record<string, unknown>

/**
 * 够用就好的 ES query DSL 求值器：只覆盖本模块实际用到的
 * term / terms / exists / bool(filter, should, must_not, minimum_should_match)。
 * 缺字段按 ES 语义处理：exists 为假，空数组也视为不存在。
 */
function matches(clause: Clause, doc: Doc): boolean {
  if ("term" in clause) {
    const [field, expected] = Object.entries(clause.term as Record<string, unknown>)[0]
    return readField(doc, field) === expected
  }
  if ("terms" in clause) {
    const [field, expected] = Object.entries(clause.terms as Record<string, unknown>)[0]
    return (expected as unknown[]).includes(readField(doc, field))
  }
  if ("exists" in clause) {
    const field = (clause.exists as { field: string }).field
    const value = readField(doc, field)
    if (value === undefined || value === null) return false
    // ES 把空数组当作字段不存在，三桶的「有无 Skill」正好踩这条。
    return !(Array.isArray(value) && value.length === 0)
  }
  if ("bool" in clause) {
    const bool = clause.bool as {
      filter?: Clause | Clause[]
      should?: Clause | Clause[]
      must_not?: Clause | Clause[]
      minimum_should_match?: number
    }
    const asList = (value: Clause | Clause[] | undefined): Clause[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value]
    if (!asList(bool.filter).every((c) => matches(c, doc))) return false
    if (asList(bool.must_not).some((c) => matches(c, doc))) return false
    const should = asList(bool.should)
    if (should.length > 0) {
      const hits = should.filter((c) => matches(c, doc)).length
      if (hits < (bool.minimum_should_match ?? 1)) return false
    }
    return true
  }
  throw new Error(`unsupported clause: ${JSON.stringify(clause)}`)
}

/** 字段名可能带 `.keyword` 或 `properties.` 前缀，样本文档按扁平键存放。 */
function readField(doc: Doc, field: string): unknown {
  if (field in doc) return doc[field]
  const withoutKeyword = field.replace(/\.keyword$/, "")
  return doc[withoutKeyword]
}

/** 桶名 → 该桶的过滤条件，从构造出来的 aggs 里取，确保测的是真正下发的东西。 */
function traceBucketClause(bucket: Parameters<typeof stageBucketAggKey>[0]): Clause {
  const aggs = stageBucketTraceAggs() as Record<string, { filter: Clause }>
  return aggs[stageBucketAggKey(bucket)].filter
}

function codeBucketClause(bucket: Parameters<typeof stageBucketAggKey>[0]): Clause {
  const aggs = stageBucketCodeAggs({ noop: {} }) as Record<string, { filter: Clause }>
  return aggs[stageBucketAggKey(bucket)].filter
}

/** 落进哪个桶。三桶互斥且穷尽，所以恰好应当命中一个。 */
function traceBucketOf(doc: Doc): string {
  const hit = (["plugin_constrained", "vibecoding", "unattributed"] as const).filter((bucket) =>
    matches(traceBucketClause(bucket), doc)
  )
  expect(hit).toHaveLength(1)
  return hit[0]
}

const rootTurn: Doc = { triggerSource: "chat", traceKind: "root" }

describe("主 Agent 对话数口径", () => {
  const filter = projectModeMainAgentConversationFilter()

  it("算进用户主动触发的 root 轮次", () => {
    expect(matches(filter, rootTurn)).toBe(true)
  })

  it("不算 Task 子代理——这正是三桶对话数被吹大的原因", () => {
    expect(
      matches(filter, {
        triggerSource: "chat",
        traceKind: "subagent",
        subagentKind: "task",
        parentTraceId: "t-parent"
      })
    ).toBe(false)
  })

  it("不算 workflow agent 与 coordinator worker", () => {
    for (const subagentKind of ["workflow_agent", "coordinator_worker"]) {
      expect(
        matches(filter, {
          triggerSource: "chat",
          traceKind: "subagent",
          subagentKind,
          parentTraceId: "t-parent"
        })
      ).toBe(false)
    }
  })

  it("不算定时任务、心跳等后台触发", () => {
    expect(matches(filter, { triggerSource: "schedule", traceKind: "root" })).toBe(false)
  })

  it("把多 Agent 可观测性上线前的历史文档当作 root", () => {
    // 既无 triggerSource 也无 traceKind / parent 字段，旧时间范围不能整段落空。
    expect(matches(filter, {})).toBe(true)
  })

  it("只判主动触发是不够的——子 trace 会继承 triggerSource=chat", () => {
    const childInheritingChat: Doc = {
      triggerSource: "chat",
      traceKind: "subagent",
      subagentKind: "task",
      parentTraceId: "t-parent"
    }
    // 单看触发来源，子代理和用户轮次长得一模一样。
    expect(matches({ term: { triggerSource: "chat" } }, childInheritingChat)).toBe(true)
    expect(matches(filter, childInheritingChat)).toBe(false)
  })
})

describe("stage×skill 三桶", () => {
  it("进行中且调用了 Skill → 插件约束", () => {
    expect(traceBucketOf({ harnessNodeStatus: "进行中", usedSkills: ["cmbdev-v1.0.0"] })).toBe(
      "plugin_constrained"
    )
  })

  it("进行中但没调 Skill → VibeCoding", () => {
    expect(traceBucketOf({ harnessNodeStatus: "进行中" })).toBe("vibecoding")
  })

  it("usedSkills 是空数组时按没调 Skill 算", () => {
    // 事件上的 usedSkills 恒为数组，无归因时是 []，ES 的 exists 对空数组为假。
    expect(traceBucketOf({ harnessNodeStatus: "进行中", usedSkills: [] })).toBe("vibecoding")
  })

  it("已完成后的产出一律算 VibeCoding，不论有没有 Skill", () => {
    expect(traceBucketOf({ harnessNodeStatus: "已完成", usedSkills: ["cmbdev-v1.0.0"] })).toBe(
      "vibecoding"
    )
    expect(traceBucketOf({ harnessNodeStatus: "已完成" })).toBe("vibecoding")
  })

  it("其余状态与无状态的历史数据 → 未归因", () => {
    expect(traceBucketOf({ harnessNodeStatus: "未开始" })).toBe("unattributed")
    expect(traceBucketOf({})).toBe("unattributed")
  })

  it("「查看对话」用的过滤条件与计数用的是同一份", () => {
    // 抽屉按桶过滤 trace 时单独取 stageBucketTraceFilterClause，计数走
    // stageBucketTraceAggs。两者一旦分叉，点开一个显示 3 的桶会列出别的东西。
    for (const bucket of ["plugin_constrained", "vibecoding", "unattributed"] as const) {
      expect(stageBucketTraceFilterClause(bucket)).toEqual(traceBucketClause(bucket))
    }
  })

  it("code 侧读的是 properties.* 字段，分类结果与 trace 侧一致", () => {
    const event: Doc = {
      "properties.harnessNodeStatus": "进行中",
      "properties.usedSkills": ["cmbdev-v1.0.0"]
    }
    expect(matches(codeBucketClause("plugin_constrained"), event)).toBe(true)
    expect(matches(codeBucketClause("vibecoding"), event)).toBe(false)
    expect(matches(codeBucketClause("unattributed"), event)).toBe(false)
    // trace 侧的无前缀字段不该命中 code 侧条件，反之亦然——写错前缀会让整桶变空。
    expect(matches(codeBucketClause("plugin_constrained"), rootTurn)).toBe(false)
  })
})

describe("主 Agent 口径的写入与读取成对", () => {
  it("读取端能取回写入端埋的子聚合", () => {
    const aggs = mainAgentConversationAggs(stageBucketTraceAggs())
    // 模拟一份 ES 响应：按写入端的结构回填 doc_count。
    const [key] = Object.keys(aggs)
    const response = {
      [key]: {
        doc_count: 7,
        [stageBucketAggKey("plugin_constrained")]: { doc_count: 3 },
        [stageBucketAggKey("vibecoding")]: { doc_count: 4 },
        [stageBucketAggKey("unattributed")]: { doc_count: 0 }
      }
    }
    const container = readMainAgentConversations(response)
    expect(container.doc_count).toBe(7)
    expect(parseStageBucketConversations(container)).toEqual({
      plugin_constrained: 3,
      vibecoding: 4,
      unattributed: 0
    })
  })

  it("从没包 filter 的响应里读不出东西——嵌错层会静默归零", () => {
    // 这正是修复前的形状：三桶与 main_agent_conversations 平级。
    const flat = {
      [stageBucketAggKey("plugin_constrained")]: { doc_count: 3 },
      [stageBucketAggKey("vibecoding")]: { doc_count: 38 }
    }
    expect(parseStageBucketConversations(readMainAgentConversations(flat))).toEqual({
      plugin_constrained: 0,
      vibecoding: 0,
      unattributed: 0
    })
  })

  it("写入端把子聚合原样放在 aggs 下，不改键名", () => {
    const inner = { conversation_count: { value_count: { field: "traceId" } } }
    const [wrapper] = Object.values(mainAgentConversationAggs(inner)) as [
      { filter: Clause; aggs: Record<string, unknown> }
    ]
    expect(wrapper.aggs).toEqual(inner)
    expect(matches(wrapper.filter, rootTurn)).toBe(true)
  })
})

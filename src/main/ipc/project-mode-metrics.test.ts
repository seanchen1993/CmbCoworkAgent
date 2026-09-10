import { describe, expect, it } from "vitest"
import { countDevAssociatedFeatures, countDevStageConversations } from "./project-mode-metrics"

describe("countDevStageConversations", () => {
  it("sums all plugin-specific nodes in the Dev group", () => {
    expect(
      countDevStageConversations([
        { key: "Dev-行为规格", doc_count: 3 },
        { key: "DEV-代码实现", doc_count: 5 },
        { key: "Ops-发布", doc_count: 7 }
      ])
    ).toBe(8)
  })
})

describe("countDevAssociatedFeatures", () => {
  it("counts each bound Feature once when it has any Dev-stage conversation", () => {
    expect(
      countDevAssociatedFeatures([
        {
          key: "feature-a",
          by_node: {
            buckets: [
              { key: "Dev-行为规格", doc_count: 4 },
              { key: "Dev-代码实现", doc_count: 9 }
            ]
          }
        },
        {
          // A duplicated response bucket must not double-count the same Feature.
          key: "feature-a",
          by_node: { buckets: [{ key: "DEV-单元测试", doc_count: 2 }] }
        },
        {
          key: "feature-b",
          by_node: { buckets: [{ key: "Ops-发布", doc_count: 6 }] }
        },
        {
          key: "feature-c",
          by_node: { buckets: [{ key: "  Ｄｅｖ-插件自定义节点  ", doc_count: 1 }] }
        },
        {
          // Unbound conversations are not part of a harnessFeatureSlug terms bucket.
          key: "",
          by_node: { buckets: [{ key: "Dev-代码实现", doc_count: 10 }] }
        }
      ])
    ).toBe(2)
  })

  it("returns zero for malformed aggregation data", () => {
    expect(countDevAssociatedFeatures(null)).toBe(0)
    expect(countDevAssociatedFeatures([{ key: "feature-a", by_node: {} }])).toBe(0)
  })
})

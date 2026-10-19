import { expect, it } from "vitest"
import type { HarnessRunNode } from "../../../shared/harness-board-types"
import {
  groupStageNodes,
  harnessStageOverview
} from "../components/harness-board/harness-stage-overview"

const node = (id: string, group?: string): HarnessRunNode => ({
  id,
  label: id,
  group,
  nodeStatus: "not_started",
  status: { label: "未开始", uiKind: "unknown" },
  artifacts: [],
  hooks: []
})

it("shows all nine ordered nodes without an implicit current-group filter", () => {
  const nodes = [
    node("biz.prd", "Biz"),
    ...["specs", "design", "plan", "detail_design", "code"].map((id) => node(`dev.${id}`, "Dev")),
    node("warehouse.model", "Dev"),
    node("warehouse.sql", "Dev"),
    node("warehouse.quality", "Ops")
  ]
  const groups = groupStageNodes(nodes)
  const overview = harnessStageOverview(nodes, groups, "feature", { detailKey: "", groupKey: null })
  expect(overview.group).toBeNull()
  expect(overview.nodes).toBe(nodes)
  expect(groups.map((group) => group.nodes.length)).toEqual([1, 7, 1])
})

it("filters only an explicitly selected arbitrary group and preserves source order", () => {
  const nodes = [node("a", "澄清"), node("b", "团队校验"), node("c", "澄清"), node("d")]
  const groups = groupStageNodes(nodes)
  expect(groups.map((group) => group.label)).toEqual(["澄清", "团队校验", "未分组"])
  expect(
    harnessStageOverview(nodes, groups, "feature", {
      detailKey: "feature",
      groupKey: "group:澄清"
    }).nodes.map((item) => item.id)
  ).toEqual(["a", "c"])
  expect(
    harnessStageOverview(nodes, groups, "feature", {
      detailKey: "feature",
      groupKey: null
    }).nodes
  ).toBe(nodes)
})

it("does not carry a filter into another feature or hide nodes after a group disappears", () => {
  const nodes = [node("one", "单一阶段"), node("two", "单一阶段")]
  const groups = groupStageNodes(nodes)
  expect(
    harnessStageOverview(nodes, groups, "other", {
      detailKey: "feature",
      groupKey: "group:单一阶段"
    }).nodes
  ).toBe(nodes)
  expect(
    harnessStageOverview(nodes, groups, "feature", {
      detailKey: "feature",
      groupKey: "group:已删除"
    }).nodes
  ).toBe(nodes)
  expect(
    harnessStageOverview(nodes, groups, "feature", {
      detailKey: "feature",
      groupKey: null
    }).nodes
  ).toHaveLength(2)
  expect(
    harnessStageOverview([], [], "feature", { detailKey: "feature", groupKey: null }).nodes
  ).toEqual([])
  expect(groupStageNodes([node("ungrouped")])).toEqual([])
})

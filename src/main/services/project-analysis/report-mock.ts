import type { ProjectReportScope } from "../../../shared/project-analysis-report"
import {
  resolveOperationsPeriod,
  type OperationsFeatureContribution,
  type ProjectOperationsPeriodData
} from "../../../shared/project-operations-period"
import {
  emptyOperationsMetrics,
  summarizeOperationsContributions
} from "../../ipc/project-operations-period"

/** DEV-only period fixture: never substitute the cumulative project-analysis dataset. */
export function makeReportPeriodExample(scope: ProjectReportScope): ProjectOperationsPeriodData {
  const period = resolveOperationsPeriod(scope.period)
  const dataAsOf = new Date().toISOString()
  const contributions: OperationsFeatureContribution[] = Array.from({ length: 8 }, (_, i) => ({
    projectId: `example-project-${i % 2}`,
    featureSlug: `feature-${i % 4}`,
    personKey: `sap:example-${i}`,
    metrics: {
      ...emptyOperationsMetrics(),
      traceCount: 12 + i,
      conversationCount: 10 + i,
      harnessConversationCount: 6 + i,
      vibeConversationCount: 4,
      knowledgeReadCount: i === 7 ? null : 5 + i,
      knowledgeReadSummaryCount: i === 7 ? 0 : 1,
      code: {
        generatedLines: 200 + i * 10,
        effectiveGeneratedLines: 200 + i * 10,
        measuredGeneratedLines: 200 + i * 10,
        measuredEffectiveGeneratedLines: 200 + i * 10,
        adoptedLines: 100 + i * 5,
        pushedAdoptedLines: 80 + i * 4,
        adoptionRate: 0.5,
        pushedAdoptionRate: 0.4
      },
      harnessAdoptedLines: 70 + i * 5,
      vibeAdoptedLines: 30
    }
  }))
  return {
    period,
    room: scope.upperOrgLv1,
    dataAsOf,
    periodComplete: period.toExclusive <= dataAsOf,
    summary: summarizeOperationsContributions(contributions),
    contributions,
    people: contributions.map((r, i) => ({
      key: r.personKey!,
      sapId: `example-${i}`,
      ystIds: [],
      name: `演示成员${i + 1}`,
      summary: summarizeOperationsContributions([r])
    })),
    projects: [0, 1].map((i) => ({
      projectId: `example-project-${i}`,
      name: ["支付服务", "运营平台"][i],
      fromLean: i === 0,
      lifecycleStatus: "active",
      snapshotAt: dataAsOf,
      features: [i, i + 2].map((n) => ({
        slug: `feature-${n}`,
        title: ["账单查询", "运营报表", "批量付款", "指标筛选"][n],
        stage: n > 1 ? "开发" : "测试",
        status: "进行中"
      }))
    })),
    coverage: {
      unidentifiedContributions: 0,
      missingProjectSnapshots: 0,
      ambiguousIdentityCount: 0
    },
    notes: [
      "演示周期数据。对话为主动触发的主 Agent 轮次；成员为本期有记录的人员，不代表全室花名册。",
      "代码按生成时间归期；Commit/Push 采纳率均为已采纳行数 / 全部有效生成行数，采用查询时测量值。",
      "知识调用为周期内成功读取次数；缺失不补零。阶段为查询时快照，不是历史期末状态。"
    ]
  }
}

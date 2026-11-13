import type {
  KnowledgeAccumulationData,
  KnowledgeActiveDetails
} from "../../../shared/dashboard-knowledge-overview"
import type { ProjectReportScope } from "../../../shared/project-analysis-report"
import type {
  OperationsMetrics,
  ProjectOperationsPeriodData
} from "../../../shared/project-operations-period"
import { summarizeOperationsContributions } from "../../ipc/project-operations-period"
import type { ProjectPageData } from "./page-data"

export type ReportRow = Record<string, string | number | null>
export interface ReportFacts {
  meta: ReportRow
  summary: ReportRow
  knowledge: ReportRow
  members: ReportRow[]
  projects: ReportRow[]
  features: ReportRow[]
  knowledgeFiles: ReportRow[]
}
export interface ReportSnapshot {
  schema: 1
  scope: ProjectReportScope
  periodData: ProjectOperationsPeriodData
  facts: ReportFacts
  notes: string[]
  exampleData: boolean
  /** Absent only in reports created before page-oriented data access was introduced. */
  pageData?: ProjectPageData
}

function metrics(m: OperationsMetrics): ReportRow {
  return {
    conversations: m.conversationCount,
    harnessConversations: m.harnessConversationCount,
    vibeConversations: m.vibeConversationCount,
    knowledgeReads: m.knowledgeReadCount,
    generatedLines: m.code?.generatedLines ?? null,
    effectiveGeneratedLines: m.code?.effectiveGeneratedLines ?? null,
    adoptedLines: m.code?.adoptedLines ?? null,
    pushedAdoptedLines: m.code?.pushedAdoptedLines ?? null,
    adoptionRate:
      m.code?.adoptionRate == null ? null : `${(m.code.adoptionRate * 100).toFixed(1)}%`,
    pushedAdoptionRate:
      m.code?.pushedAdoptionRate == null
        ? null
        : `${(m.code.pushedAdoptionRate * 100).toFixed(1)}%`,
    harnessAdoptedLines: m.harnessAdoptedLines,
    vibeAdoptedLines: m.vibeAdoptedLines
  }
}

export function buildReportSnapshot(input: {
  scope: ProjectReportScope
  data: ProjectOperationsPeriodData
  accumulation: KnowledgeAccumulationData | null
  active: KnowledgeActiveDetails | null
  knowledgeAsOf: string
  exampleData?: boolean
}): ReportSnapshot {
  const { data, scope, accumulation, active, knowledgeAsOf } = input
  const notes = [...data.notes]
  const from = new Date(Date.parse(knowledgeAsOf) - 30 * 86400000).toISOString()
  const date = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10)
  const window = `${date(from)} — ${date(knowledgeAsOf)}（查询时近30天，非报告周期）`
  notes.push(
    `外部知识数据：${window}；窗口按接口近30天约定标注，不支持回查历史周期，不与本期项目指标直接比较。`
  )
  notes.push(
    "服务单元知识与特性效果尚无完整关联，暂不提供按服务单元的采纳率、因果结论或阶段停留天数。"
  )
  if (!data.periodComplete) notes.push("所选周期尚未结束，报告只包含查询时已上报的数据。")
  if (!accumulation || accumulation.unavailableReason || Object.keys(accumulation.errors).length)
    notes.push("外部知识统计部分或全部不可用，缺失指标不补零。")
  if (!active || active.unavailableReason) notes.push("外部活跃知识明细不可用。")
  if (input.exampleData) notes.unshift("演示数据：本报告用于功能预览，不代表真实运营情况。")
  const groups = new Map<string, typeof data.contributions>()
  for (const row of data.contributions) {
    const key = JSON.stringify([row.projectId, row.featureSlug])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const totals = accumulation?.unavailableReason ? null : accumulation?.totals
  return {
    schema: 1,
    scope,
    periodData: data,
    notes,
    exampleData: !!input.exampleData,
    facts: {
      meta: {
        room: data.room,
        period: data.period.label,
        periodKind: data.period.kind === "week" ? "周报" : "月报",
        dataAsOf: data.dataAsOf,
        periodStatus: data.periodComplete ? "完整周期" : "进行中",
        dataKind: input.exampleData ? "演示数据" : "运营数据"
      },
      summary: {
        ...metrics(data.summary),
        projectCount: data.summary.projectCount,
        featureCount: data.summary.featureCount,
        activePeople: data.summary.personCount,
        leanProjectCount: data.projects.filter((p) => p.fromLean === true).length,
        unknownLeanProjectCount: data.projects.filter((p) => p.fromLean === null).length,
        unidentifiedContributions: data.coverage.unidentifiedContributions
      },
      knowledge: {
        window,
        queriedAt: knowledgeAsOf,
        total: totals?.totalNum ?? null,
        active: totals?.activeNum ?? null,
        abandoned: totals?.abandonedNum ?? null,
        periodReads: data.summary.knowledgeReadCount
      },
      members: data.people.map((p) => ({
        name: p.name || p.sapId || p.ystIds[0] || p.key,
        identity: p.sapId || p.ystIds.join("/"),
        projectCount: p.summary.projectCount,
        featureCount: p.summary.featureCount,
        ...metrics(p.summary)
      })),
      projects: data.projects.map((p) => {
        const s = summarizeOperationsContributions(
          data.contributions.filter((r) => r.projectId === p.projectId)
        )
        return {
          name: p.name,
          projectId: p.projectId,
          lean: p.fromLean === null ? "未记录" : p.fromLean ? "已关联" : "未关联",
          status: p.lifecycleStatus ?? "未记录",
          snapshotAt: p.snapshotAt,
          featureCount: s.featureCount,
          activePeople: s.personCount,
          ...metrics(s)
        }
      }),
      features: [...groups.values()].map((rows) => {
        const first = rows[0]
        const project = data.projects.find((p) => p.projectId === first.projectId)
        const feature = project?.features.find((f) => f.slug === first.featureSlug)
        return {
          projectId: first.projectId,
          featureSlug: first.featureSlug,
          project: project?.name ?? first.projectId,
          name: feature?.title ?? first.featureSlug ?? "未关联特性",
          stage: feature?.stage ?? "未记录",
          status: feature?.status ?? "未记录",
          stageBasis: "查询时当前快照，非历史期末",
          ...metrics(summarizeOperationsContributions(rows))
        }
      }),
      knowledgeFiles: active?.unavailableReason
        ? []
        : (active?.items ?? []).map((k) => ({
            name: k.fileName,
            deployUnit: k.deployUnit,
            updatedAt: k.lastCommitDate,
            updatedBy: k.lastCommitUser
          }))
    }
  }
}

/** Model context is bounded; complete rows are expanded from the snapshot during HTML rendering. */
export function reportDataPage(
  snapshot: ReportSnapshot,
  section: string,
  offset = 0,
  projectId?: string
) {
  const f = snapshot.facts
  if (projectId && section !== "projects" && section !== "features")
    throw new Error("按项目查询周期数据请使用projects或features；overview为全室汇总")
  if (projectId && !snapshot.periodData.projects.some((p) => p.projectId === projectId))
    throw new Error("该项目没有本报告周期数据；不能用项目累计值代替周期数据")
  if (section === "overview")
    return { meta: f.meta, summary: f.summary, knowledge: f.knowledge, notes: snapshot.notes }
  const key = section === "knowledge" ? "knowledgeFiles" : section
  if (!["members", "projects", "features", "knowledgeFiles"].includes(key))
    throw new Error("未知数据分区")
  const source = f[key as "members"]
  if (projectId && section === "features" && source.some((row) => !Object.hasOwn(row, "projectId")))
    throw new Error("历史报告缺少特性项目标识；可查看完整特性分区，或新建报告")
  const rows = projectId ? source.filter((row) => row.projectId === projectId) : source
  const page = rows.slice(offset, offset + 12)
  return {
    section,
    basis: section === "knowledge" ? f.knowledge.window : `报告自然周期：${f.meta.period}`,
    projectId,
    total: rows.length,
    offset,
    rows: page,
    nextOffset: offset + page.length < rows.length ? offset + page.length : null
  }
}

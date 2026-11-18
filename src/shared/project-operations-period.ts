/** Natural calendar periods in Asia/Shanghai; end is exclusive. */
export type OperationsPeriodSelection =
  | { kind: "week"; anchorDate: string }
  | { kind: "month"; month: string }

export interface OperationsPeriod {
  kind: "week" | "month"
  label: string
  from: string
  toExclusive: string
  timezone: "Asia/Shanghai"
}

const DAY = 86400000
const SHANGHAI_OFFSET = 8 * 3600000

export function resolveOperationsPeriod(selection: OperationsPeriodSelection): OperationsPeriod {
  const date = selection.kind === "month" ? `${selection.month}-01` : selection.anchorDate
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择有效的周或月")
  const [year, month, day] = date.split("-").map(Number)
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 2000 ||
    year > 2100 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    throw new Error("请选择有效的周或月")
  const start =
    selection.kind === "month"
      ? calendar.getTime()
      : calendar.getTime() - ((calendar.getUTCDay() + 6) % 7) * DAY
  const end = selection.kind === "month" ? Date.UTC(year, month, 1) : start + 7 * DAY
  const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)
  return {
    kind: selection.kind,
    label:
      selection.kind === "month" ? selection.month : `${dayLabel(start)} — ${dayLabel(end - DAY)}`,
    from: new Date(start - SHANGHAI_OFFSET).toISOString(),
    toExclusive: new Date(end - SHANGHAI_OFFSET).toISOString(),
    timezone: "Asia/Shanghai"
  }
}

export interface ProjectOperationsPeriodInput {
  period: OperationsPeriodSelection
  /** A report/statistics request always selects exactly one room. */
  upperOrgLv1: string
  person?: { idType: "sapId" | "ystId"; id: string }
}

export interface OperationsCodeMetrics {
  generatedLines: number
  measuredGeneratedLines: number
  measuredEffectiveGeneratedLines: number
  /** Measured effective lines plus still-unmeasured generations in this cohort. */
  effectiveGeneratedLines: number
  adoptedLines: number
  pushedAdoptedLines: number
  adoptionRate: number | null
  pushedAdoptionRate: number | null
}

export interface OperationsMetrics {
  traceCount: number
  conversationCount: number
  noSkillConversationCount: number
  harnessConversationCount: number
  vibeConversationCount: number
  durationMs: number | null
  toolCalls: number | null
  modelCalls: number | null
  toolReportedTraceCount: number
  modelReportedTraceCount: number
  /** Successful plugin sys-file reads; null means no read summaries were recorded. */
  knowledgeReadCount: number | null
  knowledgeReadSummaryCount: number
  code: OperationsCodeMetrics | null
  harnessAdoptedLines: number
  vibeAdoptedLines: number
}

export interface OperationsPerson {
  key: string
  sapId: string | null
  ystIds: string[]
  name: string | null
}

export interface OperationsFeatureContribution {
  projectId: string
  featureSlug: string | null
  /** null means missing or ambiguous stable identity, never a name-based join. */
  personKey: string | null
  metrics: OperationsMetrics
}

export interface OperationsPeriodSummary extends OperationsMetrics {
  projectCount: number
  featureCount: number
  personCount: number
}

export interface OperationsProjectContext {
  projectId: string
  name: string
  fromLean: boolean | null
  lifecycleStatus: string | null
  /** Current snapshot time, not the historical period-end state. */
  snapshotAt: string | null
  features: Array<{ slug: string; title: string; stage: string | null; status: string | null }>
}

export interface ProjectOperationsPeriodData {
  period: OperationsPeriod
  room: string
  dataAsOf: string
  periodComplete: boolean
  summary: OperationsPeriodSummary
  people: Array<OperationsPerson & { summary: OperationsPeriodSummary }>
  contributions: OperationsFeatureContribution[]
  projects: OperationsProjectContext[]
  coverage: {
    unidentifiedContributions: number
    missingProjectSnapshots: number
    ambiguousIdentityCount: number
  }
  notes: string[]
}

export interface ProjectOperationsPeriodResponse {
  success: boolean
  data?: ProjectOperationsPeriodData
  error?: string
  cancelled?: boolean
}

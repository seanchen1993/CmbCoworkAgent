import {
  PROJECT_METRIC_TEAM,
  type ProjectMetricFilters,
  type ProjectMetricIndicatorExportData,
  type ProjectMetricProjectEvidence,
  type ProjectMetricValueKey,
  type ProjectMetricOverviewData,
  type ProjectMetricSummaryData
} from "../../shared/project-metrics"
import {
  PROJECT_METRIC_INDICATORS,
  PROJECT_AI_RATE_TIP,
  PROJECT_FEATURE_COVERAGE_TIP,
  PROJECT_MONTHLY_TIP
} from "../../shared/project-metric-indicators"
import { formatProjectDate, projectDateMillis } from "../../shared/project-metric-calendar"
import {
  PROJECT_METRIC_SAMPLE_KEYS,
  projectCandidateReason,
  projectMetricSampleReasons,
  type ProjectMetricSampleKey,
  type ProjectMetricSampleReasons
} from "../../shared/project-metric-samples"
import {
  excelColumn,
  excelDataStart,
  type DashboardExcelCell,
  type DashboardExcelSheet
} from "./dashboard-excel-workbook"

type Field = [key: string, label: string]
type RecordCells = Record<string, DashboardExcelCell>
interface Table {
  sheet: DashboardExcelSheet
  columns: Map<string, number>
  add: (row: RecordCells) => number
}
const sourceNames = {
  "devagent-ide": "devagent-ide",
  "devagent-cloud": "devagent-cloud",
  "devagent-cli": "devagent-cli",
  devclaw: "CMBDevClaw",
  cumulative: "累计 AI 入库代码占比（硅碳比）"
}
const modeNames = { devclaw: "智能化", non_devclaw: "常规" }
const num = (value: number | null | undefined): DashboardExcelCell =>
  value == null || !Number.isFinite(value) ? "—" : value
const text = (value: string | null | undefined): string => value || "—"
function date(value: string | null): string {
  const time = projectDateMillis(value)
  return time === null ? text(value) : formatProjectDate(time)
}
function makeTable(name: string, fields: Field[], summaryRows: DashboardExcelCell[][]): Table {
  const sheet: DashboardExcelSheet = {
    name,
    header: fields.map(([, label]) => label),
    rows: [],
    summaryRows,
    autoFilter: true
  }
  return {
    sheet,
    columns: new Map(fields.map(([key], i) => [key, i])),
    add: (record) => {
      const row = excelDataStart(sheet) + sheet.rows.length
      sheet.rows.push(fields.map(([key]) => record[key] ?? "—"))
      return row
    }
  }
}
function link(table: Table, row?: number, label = "查看依据"): DashboardExcelCell {
  return {
    value: label,
    hyperlink: `#'${table.sheet.name}'!A${row ?? excelDataStart(table.sheet) - 1}`
  }
}
function cell(table: Table, key: string, row: number): string {
  const col = table.columns.get(key)
  if (col === undefined) throw new Error(`导出依据缺少列：${key}`)
  return `${excelColumn(col)}${row}`
}
function range(table: Table, key: string): string {
  const col = table.columns.get(key)
  if (col === undefined) throw new Error(`导出依据缺少列：${key}`)
  const letter = excelColumn(col)
  const start = excelDataStart(table.sheet)
  return `'${table.sheet.name}'!$${letter}$${start}:$${letter}$${Math.max(start, start + table.sheet.rows.length - 1)}`
}
function criteria(value: string | number): string {
  return typeof value === "number"
    ? String(value)
    : `"${value.replace(/~/g, "~~").replace(/\*/g, "~*").replace(/\?/g, "~?").replace(/"/g, '""')}"`
}
function sum(
  table: Table,
  column: string,
  conditions: Array<[string, string | number]>,
  value: number | null
): DashboardExcelCell {
  if (value === null) return "—"
  return {
    value,
    formula: table.sheet.rows.length
      ? `SUMIFS(${range(table, column)},${conditions.flatMap(([key, expected]) => [range(table, key), criteria(expected)]).join(",")})`
      : "0",
    numberFormat: "0.########"
  }
}
interface Scope {
  room: string | null
  name: string
  level: string
  summary: ProjectMetricSummaryData
  overview: ProjectMetricOverviewData
}
function projectConditions(scope: Scope, mode?: string): Array<[string, string | number]> {
  return [
    ["team", PROJECT_METRIC_TEAM],
    ...(scope.room === null ? [] : [["room", scope.room] as [string, string]]),
    ...(mode ? [["mode", mode] as [string, string]] : [])
  ]
}
const projectFields: Field[] = [
  ["prjCode", "项目编号"],
  ["name", "项目名称"],
  ["team", "项目所属团队"],
  ["room", "项目所属室"],
  ["mode", "项目类型"],
  ["phase", "项目阶段"],
  ["features", "关联特性编号"],
  ["featureNames", "关联特性名称"]
]
const projectDateFields: Field[] = [
  ["approved", "项目最早特性审批完成日期"],
  ["created", "立项日期"],
  ["st", "首次ST发起日期"],
  ["uat", "首次UAT发起日期"],
  ["completed", "开发完成日期"],
  ["online", "首次上线日期"]
]
const featureFields: Field[] = [
  ["level", "统计层级"],
  ["scope", "统计组织"],
  ["feature", "特性编号"],
  ["name", "特性名称"],
  ["project", "关联项目编号"],
  ["projectName", "项目名称"],
  ["team", "项目所属团队"],
  ["room", "项目所属室"],
  ["coverageSmart", "对应用研发智能化特性占比分子贡献"],
  ["coverageTotal", "对应用研发智能化特性占比分母贡献"],
  ["throughputSmart", "对月人均特性吞吐率分子贡献（智能化项目）"],
  ["throughputRegular", "对月人均特性吞吐率分子贡献（常规项目）"],
  ["featureMode", "应用研发智能化特性占比分类（按全部关联项目判断）"],
  ["approved", "特性审批完成日期"]
]
const codeFields: Field[] = [
  ["level", "统计层级"],
  ["scope", "代码统计组织"],
  ["team", "代码统计团队"],
  ["period", "统计周期"],
  ["source", "数据来源"],
  ["project", "项目模式项目编号"],
  ["projectName", "项目名称"],
  ["projectRoom", "项目所属室"],
  ["lines", "入库代码行数"],
  ["effective", "对应已Push有效生成行数"]
]
interface Operand {
  column: string
  sample: ProjectMetricSampleKey
  numeratorName: string
  denominatorColumn?: string
  denominatorName: string
  detailNames: [numerator: string, denominator?: string]
}
const operands: Record<ProjectMetricValueKey, Operand> = {
  functionPointsPerPersonMonth: {
    detailNames: ["功能点", "开发报工小时（功能点产出）"],
    column: "fp",
    sample: "productivity",
    numeratorName: "功能点合计",
    denominatorColumn: "hours",
    denominatorName: "开发报工小时合计"
  },
  featuresPerPersonMonth: {
    detailNames: ["", "开发报工小时（特性吞吐）"],
    column: "",
    sample: "throughput",
    numeratorName: "去重特性数",
    denominatorColumn: "hours",
    denominatorName: "开发报工小时合计"
  },
  avgApprovalDevelopmentDays: {
    detailNames: ["特性审批完成到开发完成耗时"],
    column: "approvalDevelopment",
    sample: "approvalDevelopment",
    numeratorName: "审批至开发完成耗时合计",
    denominatorName: "有效项目数"
  },
  avgApprovalCreationDays: {
    detailNames: ["特性审批完成到立项完成耗时"],
    column: "approvalCreation",
    sample: "approvalCreation",
    numeratorName: "审批至立项完成耗时合计",
    denominatorName: "有效项目数"
  },
  avgBugCount: {
    detailNames: ["缺陷数"],
    column: "bugs",
    sample: "bug",
    numeratorName: "缺陷数合计",
    denominatorName: "有效项目数"
  },
  avgKenanIssueCount: {
    detailNames: ["非功能问题数"],
    column: "kenan",
    sample: "kenanIssue",
    numeratorName: "非功能问题数合计",
    denominatorName: "全部样本项目数"
  },
  avgFuncPointCount: {
    detailNames: ["功能点"],
    column: "fp",
    sample: "functionPoint",
    numeratorName: "功能点合计",
    denominatorName: "有效项目数"
  },
  defectDensityPer100Fp: {
    detailNames: ["缺陷数", "功能点"],
    column: "bugs",
    sample: "defectDensity",
    numeratorName: "缺陷数合计",
    denominatorColumn: "fp",
    denominatorName: "同批项目功能点合计"
  },
  avgTestLeadDays: {
    detailNames: ["立项至首次 ST 发起耗时"],
    column: "testLead",
    sample: "testLead",
    numeratorName: "立项至ST耗时合计",
    denominatorName: "有效项目数"
  },
  avgUatLeadDays: {
    detailNames: ["立项至首次 UAT 发起耗时"],
    column: "uatLead",
    sample: "uatLead",
    numeratorName: "立项至UAT耗时合计",
    denominatorName: "有效项目数"
  },
  avgDeliveryDays: {
    detailNames: ["特性审批至首次上线耗时"],
    column: "delivery",
    sample: "delivery",
    numeratorName: "审批至上线耗时合计",
    denominatorName: "有效项目数"
  },
  avgInputTokens: {
    detailNames: ["累计输入 Token"],
    column: "input",
    sample: "token",
    numeratorName: "累计输入Token合计",
    denominatorName: "有效项目数"
  },
  avgOutputTokens: {
    detailNames: ["累计输出 Token"],
    column: "output",
    sample: "token",
    numeratorName: "累计输出Token合计",
    denominatorName: "有效项目数"
  },
  avgPushedAdoptedLines: {
    detailNames: ["累计已 Push 采纳行数"],
    column: "lines",
    sample: "codeLines",
    numeratorName: "累计已Push采纳行数合计",
    denominatorName: "有效项目数"
  },
  inputTokensPerAdoptedLine: {
    detailNames: ["累计输入 Token（单行消耗计算）", "已 Push 采纳行数（输入 Token 单行消耗）"],
    column: "input",
    sample: "tokensPerLine",
    numeratorName: "同批项目累计输入Token",
    denominatorColumn: "lines",
    denominatorName: "同批项目已Push采纳行数"
  },
  outputTokensPerAdoptedLine: {
    detailNames: ["累计输出 Token（单行消耗计算）", "已 Push 采纳行数（输出 Token 单行消耗）"],
    column: "output",
    sample: "tokensPerLine",
    numeratorName: "同批项目累计输出Token",
    denominatorColumn: "lines",
    denominatorName: "同批项目已Push采纳行数"
  }
}
function metricColumn(key: ProjectMetricValueKey, part: "numerator" | "denominator"): string {
  const operand = operands[key]
  const column = part === "numerator" ? operand.column : operand.denominatorColumn
  return column === "fp" || column === "bugs" ? column : `${key}:${part}`
}
const metricFields: Field[] = [
  ...new Map(
    PROJECT_METRIC_INDICATORS.flatMap((metric): Field[] => {
      const operand = operands[metric.key]
      return [
        ...(operand.column
          ? [[metricColumn(metric.key, "numerator"), operand.detailNames[0]] as Field]
          : []),
        ...(operand.denominatorColumn
          ? [[metricColumn(metric.key, "denominator"), operand.detailNames[1]!] as Field]
          : [])
      ]
    })
  ).entries()
]
function countNumbers(
  table: Table,
  column: string,
  conditions: Array<[string, string | number]>,
  value: number
): DashboardExcelCell {
  return {
    value,
    formula: table.sheet.rows.length
      ? `COUNTIFS(${range(table, column)},">=0"${conditions.map(([key, expected]) => `,${range(table, key)},${criteria(expected)}`).join("")})`
      : "0",
    numberFormat: "0"
  }
}
const summaryFields: Field[] = [
  ["scope", "统计组织"],
  ["metric", "指标"],
  ["result", "结果"],
  ["mode", "项目类型或来源"],
  ["numeratorName", "分子名称"],
  ["numerator", "分子"],
  ["denominatorName", "分母名称"],
  ["denominator", "分母"],
  ["samples", "有效样本项目数"],
  ["formula", "计算说明"],
  ["numeratorLink", "分子依据"],
  ["denominatorLink", "分母依据"]
]

export function projectMetricIndicatorSheets(
  data: ProjectMetricIndicatorExportData,
  filters: ProjectMetricFilters
): DashboardExcelSheet[] {
  const projectDateLabel =
    filters.dateBasis === "created" ? "立项日期" : "开发完成日期（ST发起优先，无ST取UAT发起）"
  const metadata: DashboardExcelCell[][] = [
    ["团队", PROJECT_METRIC_TEAM],
    ["统计开始", date(filters.range.from)],
    ["统计结束", date(filters.range.to)],
    ["项目日期筛选", projectDateLabel],
    ["项目阶段", filters.phaseStatuses?.join("、") || "全部"],
    ["功能点区间", `${filters.functionPointMin ?? "不限"}～${filters.functionPointMax ?? "不限"}`],
    ["智能化项目插件", filters.adapterName || "全部"],
    [
      "智能化项目累计Token区间",
      `${filters.tokenConsumptionMin ?? "不限"}～${filters.tokenConsumptionMax ?? "不限"}`
    ],
    ["项目数据保留起点", "2026-06-01 00:00:00"],
    ["导出时间（GMT+8）", data.exportedAt]
  ]
  const categories = [
    ...new Set(
      data.evidence.projects.flatMap(({ project }) =>
        project.kenanIssueCategories.map((c) => c.category)
      )
    )
  ].sort()
  const projectTable = makeTable(
    "项目依据",
    [
      ...projectFields,
      ...metricFields,
      ...categories.map((category): Field => [`category:${category}`, `非功能问题－${category}`]),
      ...projectDateFields
    ],
    [
      ...metadata,
      [
        "说明",
        "每个项目一行，不参与该指标的值显示—，有效零值显示0。均值按数值项目计数；比率先分别合计对应分子、分母再计算。报工、代码和Token为项目累计值。"
      ]
    ]
  )
  const featureTable = makeTable("特性依据", featureFields, [
    ...metadata,
    ["说明", "同一统计组织内特性去重计数；报工仅在项目依据累加。其他室、周期外关联可用于全局分类。"]
  ])
  const codeTable = makeTable("代码入库依据", codeFields, [
    ...metadata,
    [
      "说明",
      "CMBDevClaw按企业项目及代码上报室汇总周期数据；其他来源保留组织月度填报值。入库代码行数按数据来源区分渠道行数和组织总量；组织总量仅在专用行记录一次。"
    ]
  ])
  const byProject = new Map(data.evidence.projects.map((p) => [p.project.prjCode, p]))
  const projectRows = new Map<string, number>()
  const evaluated = new Map<string, { reasons: ProjectMetricSampleReasons; candidate: boolean }>()
  for (const entry of data.evidence.projects) {
    const p = entry.project
    const reasons = projectMetricSampleReasons(p, { ...filters, upperOrgLv1: [] })
    if (!entry.factAvailable)
      for (const key of PROJECT_METRIC_SAMPLE_KEYS)
        reasons[key] = "项目事实未保存，不能用于项目指标"
    const candidate =
      entry.factAvailable && !projectCandidateReason(p, { ...filters, upperOrgLv1: [] })
    evaluated.set(p.prjCode, { reasons, candidate })
    if (!Object.values(reasons).some((reason) => reason === null)) continue
    const row: RecordCells = {
      prjCode: p.prjCode,
      name: text(p.prjName),
      team: text(p.teamName),
      room: text(p.roomName),
      mode: modeNames[p.developmentMode],
      phase: text(p.phaseStatus),
      features: p.featureCodes.join("\n") || "—",
      featureNames:
        p.features.map((f) => `${f.featureCode} ${f.featureName ?? "名称未同步"}`).join("\n") ||
        "—",
      approved: date(p.approvedDate),
      created: date(p.createDate),
      st: date(p.firstStStartDate),
      uat: date(p.firstUatStartDate),
      completed: date(p.firstStStartDate || p.firstUatStartDate),
      online: date(p.firstOnlineDate)
    }
    const values: Record<string, number | null> = {
      fp: p.notAdjustFuns,
      hours: p.devWorkHours,
      bugs: p.bugNum,
      kenan: p.kenanIssueCount ?? 0,
      input: p.totalInputTokens,
      output: p.totalOutputTokens,
      lines: p.pushedAdoptedLines,
      approvalDevelopment: p.approvalDevelopmentDays,
      approvalCreation: p.approvalCreationDays,
      testLead: p.testLeadDays,
      uatLead: p.uatLeadDays,
      delivery: p.deliveryDays
    }
    for (const metric of PROJECT_METRIC_INDICATORS) {
      const operand = operands[metric.key]
      const included = reasons[operand.sample] === null
      if (operand.column && operand.column !== "fp" && operand.column !== "bugs")
        row[metricColumn(metric.key, "numerator")] = included ? num(values[operand.column]) : "—"
      if (operand.denominatorColumn && operand.denominatorColumn !== "fp")
        row[metricColumn(metric.key, "denominator")] = included
          ? num(values[operand.denominatorColumn])
          : "—"
    }
    row.fp = reasons.functionPoint === null ? num(p.notAdjustFuns) : "—"
    row.bugs = reasons.bug === null ? num(p.bugNum) : "—"
    for (const category of categories)
      row[`category:${category}`] =
        reasons.kenanIssue === null
          ? p.kenanIssueCategories
              .filter((c) => c.category === category)
              .reduce((total, c) => total + c.count, 0)
          : "—"
    projectRows.set(p.prjCode, projectTable.add(row))
  }
  const scopes: Scope[] = [
    { room: null, name: PROJECT_METRIC_TEAM, level: "团队", ...data.team },
    ...data.rooms.map((room) => ({
      room: room.roomName,
      name: room.roomName,
      level: "室",
      ...room
    }))
  ]
  const belongs = (entry: ProjectMetricProjectEvidence, scope: Scope): boolean =>
    entry.project.teamName === PROJECT_METRIC_TEAM &&
    (scope.room === null || entry.project.roomName === scope.room)
  const projectReference = (prjCode: string): DashboardExcelCell => {
    const row = projectRows.get(prjCode)
    return row ? link(projectTable, row, prjCode) : prjCode
  }
  const firstFeatureRows = new Map<string, number>()
  for (const scope of scopes) {
    for (const feature of data.evidence.features) {
      const associated = feature.projectCodes
        .map((code) => byProject.get(code))
        .filter((p): p is ProjectMetricProjectEvidence => Boolean(p))
      if (scope.room !== null && !associated.some((p) => belongs(p, scope))) continue
      const candidates = associated.filter(
        (p) => belongs(p, scope) && evaluated.get(p.project.prjCode)?.candidate
      )
      const smartThroughput = associated.find(
        (p) =>
          belongs(p, scope) &&
          p.project.developmentMode === "devclaw" &&
          evaluated.get(p.project.prjCode)?.reasons.throughput === null
      )
      const regularThroughput = associated.find(
        (p) =>
          belongs(p, scope) &&
          p.project.developmentMode === "non_devclaw" &&
          evaluated.get(p.project.prjCode)?.reasons.throughput === null
      )
      if (!candidates.length && !smartThroughput && !regularThroughput) continue
      const intelligent = associated.some((p) => p.eligibleBindingCount > 0)
      if (candidates.length && !feature.classificationComplete)
        throw new Error("特性关联在导出期间发生变化，请重新导出")
      for (const entry of associated) {
        const p = entry.project
        const counted = candidates[0]?.project.prjCode === p.prjCode
        const row = featureTable.add({
          level: scope.level,
          scope: scope.name,
          feature: feature.featureCode,
          name: text(feature.featureName),
          approved: date(feature.approvedDate),
          project: projectReference(p.prjCode),
          projectName: text(p.prjName),
          team: text(p.teamName),
          room: text(p.roomName),
          featureMode: feature.classificationComplete
            ? intelligent
              ? "智能化"
              : "常规"
            : "仅审批参考",
          coverageTotal: counted ? 1 : "—",
          coverageSmart: counted ? Number(intelligent) : "—",
          throughputSmart: smartThroughput?.project.prjCode === p.prjCode ? 1 : "—",
          throughputRegular: regularThroughput?.project.prjCode === p.prjCode ? 1 : "—"
        })
        const key = `${scope.level}:${scope.name}`
        if (!firstFeatureRows.has(key)) firstFeatureRows.set(key, row)
      }
    }
  }
  for (const record of data.evidence.monthly) {
    const common = {
      level: record.orgLevel === "team" ? "团队" : "室",
      scope: record.orgLevel === "team" ? PROJECT_METRIC_TEAM : text(record.roomName),
      team: record.teamName,
      period: record.month
    }
    codeTable.add({
      ...common,
      source: "组织累计入库",
      lines: num(record.totalPushedLines)
    })
    for (const [source, lines] of [
      ["devagent-ide", record.devagentIdePushedLines],
      ["devagent-cloud", record.devagentCloudPushedLines],
      ["devagent-cli", record.devagentCliPushedLines]
    ] as const)
      codeTable.add({
        ...common,
        source,
        lines: num(lines)
      })
  }
  for (const record of data.evidence.code)
    codeTable.add({
      level: "室",
      scope: text(record.roomName),
      team: PROJECT_METRIC_TEAM,
      period: `${date(filters.range.from)} 至 ${date(filters.range.to)}`,
      source: "CMBDevClaw",
      project: projectReference(record.prjCode),
      projectName: text(record.prjName),
      projectRoom: text(record.projectRoomName),
      lines: record.pushedAdoptedLines,
      effective: record.pushedEffectiveGeneratedLines
    })
  const teamTable = makeTable("团队指标", summaryFields, metadata)
  const roomTable = makeTable("各室指标", summaryFields, metadata)
  const addSummary = (
    table: Table,
    record: RecordCells,
    numerator: DashboardExcelCell,
    denominator: DashboardExcelCell,
    factor: number,
    value: number | null
  ): void => {
    const row = excelDataStart(table.sheet) + table.sheet.rows.length
    const n = cell(table, "numerator", row),
      d = cell(table, "denominator", row)
    const unit = String(record.unit)
    table.add({
      ...record,
      numerator,
      denominator,
      result: {
        value: value ?? "—",
        formula: `IF(AND(ISNUMBER(${n}),ISNUMBER(${d}),${d}>0),${n}*${factor}/${d},"—")`,
        numberFormat: `0.00"${unit === "%" ? "" : " "}${unit}"`
      }
    })
  }
  for (const scope of scopes) {
    const table = scope.room === null ? teamTable : roomTable
    const featureConditions: Array<[string, string | number]> = [
      ["level", scope.level],
      ["scope", scope.name]
    ]
    const overview = scope.overview
    const coverage = overview.features
    addSummary(
      table,
      {
        scope: scope.name,
        metric: "应用研发智能化特性占比",
        mode: "总体",
        numeratorName: "智能化去重特性数",
        denominatorName: "全部去重特性数",
        unit: "%",
        samples: [...evaluated].filter(
          ([code, e]) => e.candidate && belongs(byProject.get(code)!, scope)
        ).length,
        formula: PROJECT_FEATURE_COVERAGE_TIP,
        numeratorLink: link(featureTable, firstFeatureRows.get(`${scope.level}:${scope.name}`)),
        denominatorLink: link(featureTable, firstFeatureRows.get(`${scope.level}:${scope.name}`))
      },
      sum(featureTable, "coverageSmart", featureConditions, coverage?.intelligent ?? null),
      sum(featureTable, "coverageTotal", featureConditions, coverage?.total ?? null),
      100,
      coverage?.rate == null ? null : coverage.rate * 100
    )
    for (const metric of PROJECT_METRIC_INDICATORS)
      for (const group of scope.summary.groups) {
        const operand = operands[metric.key]
        const calculation = group.calculations[metric.key]
        const notApplicable =
          group.developmentMode === "non_devclaw" &&
          ["token", "codeLines", "tokensPerLine"].includes(operand.sample)
        const conditions = projectConditions(scope, modeNames[group.developmentMode])
        if (metric.key === "functionPointsPerPersonMonth")
          conditions.push(["fp", ">=0"], [metricColumn(metric.key, "denominator"), ">=0"])
        if (metric.key === "defectDensityPer100Fp") conditions.push(["fp", ">0"], ["bugs", ">=0"])
        const featureNumerator = metric.key === "featuresPerPersonMonth"
        const first = data.evidence.projects.find(
          (p) =>
            belongs(p, scope) &&
            p.project.developmentMode === group.developmentMode &&
            evaluated.get(p.project.prjCode)?.reasons[operand.sample] === null
        )
        const projectLink = link(
          projectTable,
          first ? projectRows.get(first.project.prjCode) : undefined
        )
        addSummary(
          table,
          {
            scope: scope.name,
            metric: metric.label,
            mode: modeNames[group.developmentMode],
            numeratorName: operand.numeratorName,
            denominatorName: operand.denominatorName,
            unit: metric.unit,
            samples: notApplicable ? "—" : group.samples[operand.sample],
            formula: `${metric.formula}${group.samples[operand.sample] === 0 ? " 无有效样本。" : calculation.denominator === 0 ? " 分母为零。" : ""}`,
            numeratorLink: featureNumerator
              ? link(featureTable, firstFeatureRows.get(`${scope.level}:${scope.name}`))
              : projectLink,
            denominatorLink: projectLink
          },
          notApplicable
            ? "—"
            : featureNumerator
              ? sum(
                  featureTable,
                  group.developmentMode === "devclaw" ? "throughputSmart" : "throughputRegular",
                  featureConditions,
                  calculation.numerator
                )
              : sum(
                  projectTable,
                  metricColumn(metric.key, "numerator"),
                  conditions,
                  calculation.numerator
                ),
          notApplicable
            ? "—"
            : operand.denominatorColumn
              ? sum(
                  projectTable,
                  metricColumn(metric.key, "denominator"),
                  conditions,
                  calculation.denominator
                )
              : countNumbers(
                  projectTable,
                  metricColumn(metric.key, "numerator"),
                  conditions,
                  calculation.denominator
                ),
          calculation.multiplier,
          group[metric.key]
        )
      }
    for (const category of new Set(
      scope.summary.groups.flatMap((group) => group.kenanIssueCategories.map((c) => c.category))
    ))
      for (const group of scope.summary.groups) {
        const count = group.kenanIssueCategories.find((c) => c.category === category)?.count ?? 0
        const conditions = projectConditions(scope, modeNames[group.developmentMode])
        addSummary(
          table,
          {
            scope: scope.name,
            metric: `平均非功能问题数－${category}`,
            mode: modeNames[group.developmentMode],
            numeratorName: "该类别问题数合计",
            denominatorName: "全部样本项目数",
            unit: "个",
            samples: group.projectCount,
            formula: "类别问题数合计÷全部样本项目数，包含零问题项目。",
            numeratorLink: link(projectTable),
            denominatorLink: link(projectTable)
          },
          sum(projectTable, `category:${category}`, conditions, count),
          countNumbers(
            projectTable,
            metricColumn("avgKenanIssueCount", "numerator"),
            conditions,
            group.projectCount
          ),
          1,
          group.projectCount ? count / group.projectCount : null
        )
      }
    const codeConditions: Array<[string, string | number]> = [
      ["source", "CMBDevClaw"],
      ...(scope.room === null ? [] : [["scope", scope.room] as [string, string]])
    ]
    const code = overview.code
    addSummary(
      table,
      {
        scope: scope.name,
        metric: "AI代码入库率",
        mode: "总体",
        numeratorName: "已Push采纳行数",
        denominatorName: "对应已Push有效生成行数",
        unit: "%",
        samples: new Set(
          data.evidence.code
            .filter((c) => scope.room === null || c.roomName === scope.room)
            .map((c) => c.prjCode)
        ).size,
        formula: PROJECT_AI_RATE_TIP,
        numeratorLink: link(codeTable),
        denominatorLink: link(codeTable)
      },
      sum(codeTable, "lines", codeConditions, code?.pushedAdoptedLines ?? null),
      sum(codeTable, "effective", codeConditions, code?.pushedEffectiveGeneratedLines ?? null),
      100,
      code?.pushedAdoptionRate == null ? null : code.pushedAdoptionRate * 100
    )
    if (overview.monthly) {
      const monthly = overview.monthly
      const manualConditions: Array<[string, string | number]> = [
        ["level", scope.level],
        ["scope", scope.name]
      ]
      const denominatorConditions: Array<[string, string | number]> = [
        ...manualConditions,
        ["source", "组织累计入库"]
      ]
      for (const source of [
        { source: "cumulative" as const, ...monthly.cumulative },
        ...monthly.sources
      ]) {
        let numerator: DashboardExcelCell
        if (source.source === "cumulative") {
          const parts = ["devagent-ide", "devagent-cloud", "devagent-cli"].map((name) =>
            sum(codeTable, "lines", [...manualConditions, ["source", name]], 0)
          )
          parts.push(sum(codeTable, "lines", codeConditions, 0))
          numerator =
            source.pushedLines === null
              ? "—"
              : {
                  value: source.pushedLines,
                  formula: parts
                    .map((part) => (typeof part === "object" ? `(${part.formula})` : String(part)))
                    .join("+")
                }
        } else
          numerator = sum(
            codeTable,
            "lines",
            source.source === "devclaw"
              ? codeConditions
              : [...manualConditions, ["source", sourceNames[source.source]]],
            source.pushedLines
          )
        addSummary(
          table,
          {
            scope: scope.name,
            metric: `代码入库情况－${sourceNames[source.source]}`,
            mode: sourceNames[source.source],
            numeratorName: source.source === "cumulative" ? "四渠道入库行数合计" : "该渠道入库行数",
            denominatorName: "组织累计入库行数",
            unit: "%",
            samples: "—",
            formula: `完整自然月 ${monthly.month}。${PROJECT_MONTHLY_TIP}${source.missing ? " 未完整填报或来源不可用。" : monthly.totalPushedLines === 0 ? " 分母为零。" : ""}`,
            numeratorLink: link(codeTable),
            denominatorLink: link(codeTable)
          },
          numerator,
          sum(codeTable, "lines", denominatorConditions, monthly.totalPushedLines),
          100,
          source.rate === null ? null : source.rate * 100
        )
      }
    }
  }
  for (const table of [teamTable, roomTable]) {
    const scopeColumn = table.columns.get("scope")!
    const metricColumn = table.columns.get("metric")!
    const modeColumn = table.columns.get("mode")!
    for (let i = 1; i < table.sheet.rows.length; i++) {
      const previous = table.sheet.rows[i - 1]
      const current = table.sheet.rows[i]
      if (
        previous[scopeColumn] !== current[scopeColumn] ||
        previous[metricColumn] !== current[metricColumn] ||
        previous[modeColumn] !== "智能化" ||
        current[modeColumn] !== "常规"
      )
        continue
      for (const key of ["numeratorName", "denominatorName", "formula"]) {
        const column = table.columns.get(key)!
        if (previous[column] === current[column]) current[column] = ""
      }
    }
  }
  return [teamTable.sheet, roomTable.sheet, projectTable.sheet, featureTable.sheet, codeTable.sheet]
}

import { PROJECT_METRIC_TEAM } from "../../shared/project-metrics"

export const PROJECT_METRIC_MOCK_ROOMS = ["测试 1 部", "开发二部", "平台三部"]

export const PROJECT_METRIC_MOCK_FEATURES = [
  ["BU135598-F16114", "客户接触事件查询", "2026-10-09 17:29:27"],
  ["BU135598-F16127", "客户标签检索", "2026-10-08 10:00:00"],
  ["BU135598-F16128", "客户资料展示", "2026-10-09 11:30:00"],
  ["BU135598-F16198", "实时数据权限管理", "2026-10-09 15:00:00"],
  ["BU135598-F16201", "经营报表查询优化", "2026-09-22 09:00:00"],
  ["BU135598-F16202", "活动配置校验", "2026-10-08 09:00:00"],
  ["BU135598-F16203", "客户消息模板调整", "2026-10-12 10:00:00"],
  ["BU135598-F16204", "客户画像数据更新", "2026-10-10 10:00:00"],
  ["BU135598-F16205", "渠道事件接入", "2026-09-29 09:00:00"],
  ["BU135598-F16206", "名单导入校验", "2026-10-13 14:00:00"],
  ["BU135598-F16207", "接口访问审计", "2026-10-15 09:00:00"],
  ["BU135598-F16208", "任务进度通知", "2026-10-15 15:00:00"]
].map(([featureCode, featureName, approvedDate]) => ({ featureCode, featureName, approvedDate }))

const featureCodes = (...indices: number[]): string[] =>
  indices.map((index) => PROJECT_METRIC_MOCK_FEATURES[index - 1].featureCode)

/** 固定业务事实，场景由下面的项目覆盖；不使用随机数或相对当前日期。 */
export const PROJECT_METRIC_MOCK_PROJECTS = [
  {
    prjCode: "T26MCB21",
    prjName: "客户接触实时数据查询",
    room: 0,
    featureCodes: featureCodes(1, 2, 3, 4),
    notAdjustFuns: 214.72,
    devWorkHours: 217,
    bugNum: 2,
    createDate: "2026-10-12 00:00:00",
    firstStStartDate: "2026-10-19 09:15:47",
    firstUatStartDate: "2026-10-14 11:33:19",
    firstOnlineDate: "2026-10-21 00:00:00"
  },
  {
    prjCode: "T26MCB22",
    prjName: "客户接触事件服务改造",
    room: 1,
    featureCodes: featureCodes(1),
    notAdjustFuns: 128,
    devWorkHours: 304.5,
    bugNum: 5,
    createDate: "2026-10-13 00:00:00",
    firstStStartDate: "2026-10-20 10:00:00",
    firstOnlineDate: "2026-10-22 00:00:00"
  },
  {
    prjCode: "T26MCB23",
    prjName: "经营报表查询服务优化",
    room: 2,
    featureCodes: featureCodes(5),
    notAdjustFuns: 180,
    devWorkHours: 228.375,
    bugNum: 1,
    createDate: "2026-09-24 00:00:00",
    firstStStartDate: "2026-09-30 16:00:00",
    firstOnlineDate: "2026-10-12 00:00:00"
  },
  {
    prjCode: "T26MCB24",
    prjName: "活动配置校验完善",
    room: 0,
    featureCodes: featureCodes(6),
    notAdjustFuns: 86,
    devWorkHours: 152.25,
    bugNum: 0,
    createDate: "2026-10-09 00:00:00",
    firstStStartDate: null,
    firstUatStartDate: "2026-10-15 14:30:00",
    firstOnlineDate: "2026-10-20 00:00:00"
  },
  {
    prjCode: "T26MCB25",
    prjName: "客户消息模板调整",
    room: 1,
    featureCodes: featureCodes(7),
    notAdjustFuns: 0,
    devWorkHours: 76.125,
    bugNum: 0,
    createDate: "2026-10-12 00:00:00",
    firstStStartDate: "2026-10-19 10:00:00",
    firstOnlineDate: "2026-10-23 00:00:00"
  },
  {
    prjCode: "T26MCB26",
    prjName: "客户画像数据同步",
    room: 2,
    featureCodes: featureCodes(8),
    notAdjustFuns: 120,
    devWorkHours: 304.5,
    bugNum: 3,
    createDate: "2026-10-12 00:00:00",
    firstStStartDate: "2026-10-21 09:00:00",
    firstOnlineDate: "2026-10-27 00:00:00"
  },
  {
    prjCode: "T26MCB27",
    prjName: "渠道事件统一接入",
    room: 0,
    featureCodes: featureCodes(9),
    notAdjustFuns: 240,
    devWorkHours: 380.625,
    bugNum: 4,
    createDate: "2026-09-30 00:00:00",
    firstStStartDate: "2026-10-14 15:00:00",
    firstOnlineDate: "2026-11-03 00:00:00"
  },
  {
    prjCode: "T26MCB28",
    prjName: "名单导入校验优化",
    room: 1,
    featureCodes: featureCodes(10),
    notAdjustFuns: null,
    devWorkHours: 152.25,
    bugNum: 2,
    createDate: "2026-10-14 00:00:00",
    firstStStartDate: "2026-10-22 11:00:00",
    firstOnlineDate: "2026-10-28 00:00:00"
  },
  {
    prjCode: "T26MCB29",
    prjName: "接口访问审计补充",
    room: 2,
    featureCodes: featureCodes(11),
    notAdjustFuns: 50,
    devWorkHours: null,
    bugNum: 1,
    createDate: "2026-10-16 00:00:00",
    firstStStartDate: "2026-10-26 14:00:00",
    firstOnlineDate: "2026-10-30 00:00:00"
  },
  {
    prjCode: "T26MCB30",
    prjName: "任务进度通知完善",
    room: 0,
    featureCodes: featureCodes(12),
    notAdjustFuns: 90,
    devWorkHours: 152.25,
    bugNum: 5,
    createDate: "2026-10-16 00:00:00",
    firstStStartDate: "2026-10-27 10:00:00",
    firstOnlineDate: "2026-10-30 00:00:00"
  },
  {
    prjCode: "T26MCB31",
    prjName: "经营报表前端查询优化",
    room: 1,
    featureCodes: featureCodes(5),
    notAdjustFuns: 160,
    devWorkHours: 250,
    bugNum: 4,
    createDate: "2026-09-25 00:00:00",
    firstStStartDate: "2026-10-12 10:00:00",
    firstOnlineDate: "2026-10-16 00:00:00"
  },
  {
    prjCode: "T26MCB32",
    prjName: "客户画像展示优化",
    room: 2,
    featureCodes: featureCodes(8),
    notAdjustFuns: 75,
    devWorkHours: 120,
    bugNum: null,
    createDate: "2026-10-14 00:00:00",
    firstStStartDate: "2026-10-23 16:00:00",
    firstOnlineDate: "2026-11-06 00:00:00"
  }
].map(({ room, ...project }, index) => ({
  ...project,
  teamName: PROJECT_METRIC_TEAM,
  roomName: PROJECT_METRIC_MOCK_ROOMS[room],
  groupName: `示例开发组${room + 1}`,
  pm: `示例负责人${room + 1}/MOCK000${room + 1}`,
  phaseStatus: project.firstOnlineDate.startsWith("2026-10") ? "结项完成" : "开发中",
  approvedDate: project.featureCodes
    .map(
      (code) =>
        PROJECT_METRIC_MOCK_FEATURES.find((feature) => feature.featureCode === code)!.approvedDate
    )
    .sort()[0],
  kenanIssueCount: index % 3,
  kenanIssueCategoryCount:
    index % 3 ? [{ category: index % 2 ? "性能" : "安全", count: index % 3 }] : [],
  syncBatchNo: "mock-20261116",
  syncedAt: "2026-11-16 16:46:28"
}))

export const PROJECT_METRIC_MOCK_TELEMETRY = [
  { prjCode: "T26MCB21", input: 1250000, output: 250000, lines: 2400 },
  { prjCode: "T26MCB23", input: 800000, output: 160000, lines: 1600 },
  { prjCode: "T26MCB25", input: 400000, output: 80000, lines: 600 },
  { prjCode: "T26MCB27", input: 1600000, output: 320000, lines: 3200 },
  { prjCode: "T26MCB29", input: 250000, output: 50000, lines: 300 },
  { prjCode: "T26MCB31", input: 900000, output: 180000, lines: 1800 }
]

export const PROJECT_METRIC_MOCK_CODE = [
  {
    prjCode: "T26MCB21",
    room: 0,
    generatedAt: "2026-10-18 10:00:00",
    adopted: 1300,
    effective: 1700
  },
  {
    prjCode: "T26MCB21",
    room: 1,
    generatedAt: "2026-10-18 11:00:00",
    adopted: 500,
    effective: 700
  },
  {
    prjCode: "T26MCB23",
    room: 2,
    generatedAt: "2026-10-02 09:00:00",
    adopted: 800,
    effective: 1000
  },
  {
    prjCode: "T26MCB25",
    room: 1,
    generatedAt: "2026-10-18 14:00:00",
    adopted: 400,
    effective: 500
  },
  {
    prjCode: "T26MCB27",
    room: 0,
    generatedAt: "2026-10-13 10:00:00",
    adopted: 2200,
    effective: 2600
  },
  {
    prjCode: "T26MCB29",
    room: 2,
    generatedAt: "2026-10-25 16:00:00",
    adopted: 200,
    effective: 300
  },
  {
    prjCode: "T26MCB31",
    room: 1,
    generatedAt: "2026-10-10 09:00:00",
    adopted: 1400,
    effective: 1700
  }
]

export function projectMetricMockMonthlyRecords(months: string[]) {
  const rooms = [
    {
      totalPushedLines: 280000,
      devagentIdePushedLines: 50000,
      devagentCloudPushedLines: 1200,
      devagentCliPushedLines: 2000
    },
    {
      totalPushedLines: 500000,
      devagentIdePushedLines: 100000,
      devagentCloudPushedLines: 3000,
      devagentCliPushedLines: 3000
    },
    {
      totalPushedLines: 275649,
      devagentIdePushedLines: 61403,
      devagentCloudPushedLines: 1297,
      devagentCliPushedLines: 1256
    }
  ]
  return months.flatMap((timeRange) => {
    const common = {
      teamName: PROJECT_METRIC_TEAM,
      timeRange,
      updatedAt: "2026-11-16 15:54:05",
      updatedBy: "示例数据"
    }
    return [
      {
        ...common,
        orgLevel: "team" as const,
        roomName: null,
        totalPushedLines: 1055649,
        devagentIdePushedLines: 211403,
        devagentCloudPushedLines: 5497,
        devagentCliPushedLines: 6256
      },
      ...rooms.map((record, index) => ({
        ...common,
        ...record,
        orgLevel: "room" as const,
        roomName: PROJECT_METRIC_MOCK_ROOMS[index]
      }))
    ]
  })
}

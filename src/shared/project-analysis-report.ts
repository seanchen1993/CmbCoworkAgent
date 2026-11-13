import type { ProjectAgentRunListener } from "./project-agent-run"
import type { OperationsPeriod, OperationsPeriodSelection } from "./project-operations-period"

export interface ProjectReportScope {
  upperOrgLv1: string
  period: OperationsPeriodSelection
}

export interface ProjectReportSummary {
  id: string
  title: string
  room: string
  selection: OperationsPeriodSelection
  period: OperationsPeriod
  dataAsOf: string
  createdAt: string
  updatedAt: string
  latestVersion: number
  exampleData: boolean
}

export interface ProjectReportVersion {
  version: number
  createdAt: string
  instruction: string
  modelName: string
}

export interface ProjectReportDocument {
  summary: ProjectReportSummary
  /** The requested version; older versions remain available. */
  version: ProjectReportVersion
  versions: ProjectReportVersion[]
  html: string
  notes: string[]
}

export interface ProjectReportTemplate {
  id: string
  name: string
  /** Older saved templates without a kind are personal templates. */
  kind?: "builtin" | "personal"
  preferences: string
  createdAt: string
  updatedAt: string
}

export const RECOMMENDED_REPORT_TEMPLATE_ID = "3f1fb688-5391-4857-9b3d-5754f9ecf0f8"
export const RECOMMENDED_REPORT_TEMPLATE_NAME = "室级综合运营报告 · 内置推荐"

export interface ProjectReportWorkspace {
  reports: ProjectReportSummary[]
  templates: ProjectReportTemplate[]
  ownRoom: string
  canChooseRoom: boolean
  rooms: string[]
}

export type ProjectReportGenerateInput =
  | { action: "create"; scope: ProjectReportScope; instruction: string; templateId?: string }
  | { action: "revise"; reportId: string; baseVersion: number; instruction: string }

export interface ProjectReportTemplateInput {
  reportId: string
  version: number
  name: string
  preferences: string
}

export interface ProjectReportResponse<T> {
  success: boolean
  data?: T
  error?: string
  cancelled?: boolean
}

export interface ProjectReportApi {
  projectReportWorkspace: () => Promise<ProjectReportResponse<ProjectReportWorkspace>>
  projectReportRead: (input: {
    reportId: string
    version?: number
  }) => Promise<ProjectReportResponse<ProjectReportDocument>>
  projectReportGenerate: (
    input: ProjectReportGenerateInput,
    onEvent?: ProjectAgentRunListener
  ) => Promise<ProjectReportResponse<ProjectReportDocument>>
  projectReportSaveTemplate: (
    input: ProjectReportTemplateInput
  ) => Promise<ProjectReportResponse<ProjectReportTemplate>>
  projectReportDeleteTemplate: (input: {
    templateId: string
  }) => Promise<ProjectReportResponse<null>>
  projectReportDelete: (input: { reportId: string }) => Promise<ProjectReportResponse<null>>
  projectReportExport: (input: {
    reportId: string
    version: number
  }) => Promise<ProjectReportResponse<{ filePath: string }>>
}

export const PROJECT_REPORT_GENERATION_FAMILY = "dashboard:projectReportGenerate"

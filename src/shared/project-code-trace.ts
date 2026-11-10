import { STAGE_DONE_LABEL, STAGE_IN_PROGRESS_LABEL, type StageBucket } from "./harness-stage-bucket"

export interface ProjectCodeTraceCursor {
  after: Array<string | number>
  asOf: string
  scope: string
}

export interface ProjectCodeTraceRequest {
  projectId: string
  bucket: StageBucket
  upperOrgLv1?: string | string[] | null
  cursor?: ProjectCodeTraceCursor | null
  pageSize?: number
}

export interface ProjectCodeTraceSummary {
  harnessLines: number
  vibeLines: number
  unattributedLines: number
}

export interface ProjectCodeTraceItem {
  eventId: string
  genEventId: string | null
  file: string | null
  tool: string | null
  language: string | null
  generatedLines: number
  effectiveLines: number
  adoptedLines: number
  usedSkills: string[]
  skillSource: string[]
  nodeName: string | null
  nodeStatus: string | null
  featureSlug: string | null
  pluginName: string | null
  pluginVersion: string | null
  model: string | null
  userName: string | null
  agentKind: string | null
  agentLabel: string | null
  threadId: string | null
  traceId: string | null
  rootThreadId: string | null
  parentThreadId: string | null
  generatedAt: string | null
  measuredAt: string | null
  commitSha: string | null
  commitUrl: string | null
  repository: string | null
  branch: string | null
  pushed: boolean
  verdict: string | null
  generationAvailable: boolean
  attributionMismatch: boolean
  generationAttribution: {
    nodeName: string | null
    nodeStatus: string | null
    usedSkills: string[]
  } | null
}

export interface ProjectCodeTracePage {
  items: ProjectCodeTraceItem[]
  total?: number
  summary?: ProjectCodeTraceSummary
  nextCursor: ProjectCodeTraceCursor | null
}

export function projectCodeClassificationReason(status: string | null, hasSkill: boolean): string {
  if (status === STAGE_DONE_LABEL) return "生成代码时阶段已完成，按规则归为 VibeCoding"
  if (status === STAGE_IN_PROGRESS_LABEL) {
    return hasSkill ? "阶段进行中，代码记录了 Skill 归因" : "阶段进行中，未使用SKILL"
  }
  return "生成时的阶段状态不足以判定归属"
}

export function projectCodeAgentLabel(kind: string | null): string {
  if (kind === "coordinator_worker") return "Team 子 Agent"
  if (kind === "workflow_agent") return "Workflow 子 Agent"
  if (kind === "task") return "Task 子 Agent"
  if (kind === "root") return "主 Agent"
  return "未记录"
}

import type { BotAvatarShape } from "./contracts"

/** A follow belongs to one Bot conversation. Native project threads and runs retain their own identities. */
export interface BotFeatureFollow {
  id: string
  projectId: string
  slug: string
  projectName: string
  title: string
}

export const featureTaskLabels = {
  following: "跟进中",
  linked: "跟进中",
  running: "正在处理",
  managed: "托管中",
  question: "待你回答",
  approval: "待桌面审批",
  decision: "待项目确认",
  replied: "已回复",
  failed: "执行失败",
  stopped: "已停止",
  completed: "已完成",
  unknown: "状态暂不可用"
} as const
export type FeatureTaskPhase = keyof typeof featureTaskLabels
export interface BotFeatureTask extends BotFeatureFollow {
  kind: "feature"
  state: "active" | "completed"
  version: number
  updatedAt: number
  phase: FeatureTaskPhase
  attentionThreadId?: string
}

export interface BotFeatureSession {
  threadId: string
  title: string
  phase:
    | "idle"
    | "running"
    | "question"
    | "approval"
    | "decision"
    | "interrupted"
    | "failed"
    | "unavailable"
    | "unknown"
  /** Live child execution/result-delivery detail; never inferred from transcript text. */
  activity?: string
  questions?: string[]
  nodeId?: string
}

export interface BotFeatureDetail extends BotFeatureTask {
  sessions: BotFeatureSession[]
  run?: {
    runId: string
    status: "running" | "failed" | "completed" | "cancelled" | "corrupt"
    nodeId?: string
    currentThreadId?: string
    decision?: string
    retryAt?: string
    waitingForDecision?: string
  }
}

/** Local desktop picker metadata. A group uses its local IM conversation ID. */
export interface BotFeatureTarget {
  botId: string
  botName: string
  color: string
  shape?: BotAvatarShape
  groupId?: string
  label: string
  linked: boolean
  unavailable?: "archived" | "revoked"
}

export interface BotFeatureClient {
  targets(feature?: Pick<BotFeatureFollow, "projectId" | "slug">): Promise<BotFeatureTarget[]>
  projects(botId: string, groupId?: string): Promise<{ id: string; name: string }[]>
  catalog(
    botId: string,
    projectId: string,
    groupId?: string
  ): Promise<{ slug: string; title: string }[]>
  follow(
    botId: string,
    projectId: string,
    slug: string,
    groupId?: string
  ): Promise<BotFeatureFollow>
  list(botId: string, groupId?: string): Promise<BotFeatureTask[]>
  lifecycle(
    botId: string,
    id: string,
    action: "complete" | "reopen",
    version: number,
    groupId?: string
  ): Promise<void>
  detail(botId: string, id: string, groupId?: string): Promise<BotFeatureDetail>
  /** Compatibility entry for older clients that explicitly assigned a project conversation. */
  link(botId: string, id: string, threadId: string, groupId?: string): Promise<void>
}

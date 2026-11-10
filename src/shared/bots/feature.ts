/** A follow belongs to one Bot conversation. Native project threads and runs retain their own identities. */
export interface BotFeatureFollow {
  id: string
  projectId: string
  slug: string
  projectName: string
  title: string
}

export const featureTaskLabels = {
  following: "仅跟进",
  linked: "已关联会话",
  running: "正在处理",
  managed: "托管中",
  question: "待你回答",
  approval: "待桌面审批",
  decision: "待项目确认",
  replied: "已回复",
  failed: "执行失败",
  stopped: "已停止",
  completed: "已完成"
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
  phase: "idle" | "running" | "question" | "approval" | "interrupted" | "failed" | "unavailable"
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

export interface BotFeatureClient {
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
  /** Only the desktop user can grant access to an existing project conversation. */
  link(botId: string, id: string, threadId: string, groupId?: string): Promise<void>
}

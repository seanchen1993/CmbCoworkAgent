import type { StageBucket } from "./harness-stage-bucket"

export interface DashboardThreadTraceScope {
  scope?: "platform" | "project"
  projectId?: string
  range?: { from: string; to: string }
  featureSlug?: string
  nodeName?: string
  nodeStatus?: string
  stageBucket?: StageBucket
  triggerScope?: "active" | "all"
}

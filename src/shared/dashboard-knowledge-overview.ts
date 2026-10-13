import type { DashboardKnowledgeCommitRateUnavailableReason } from "./dashboard-knowledge-commit-rate"

export interface KnowledgeDistributionItem {
  name: string
  value: number
}

export interface KnowledgeAccumulationTotals {
  totalNum: number
  abandonedNum: number
  activeNum: number
}

export type KnowledgeSection = "totals" | "users" | "orgs" | "systems"

export interface KnowledgeAccumulationData {
  totals: KnowledgeAccumulationTotals | null
  users: KnowledgeDistributionItem[] | null
  orgs: KnowledgeDistributionItem[] | null
  systems: KnowledgeDistributionItem[] | null
  errors: Partial<Record<KnowledgeSection, string>>
  unavailableReason?: DashboardKnowledgeCommitRateUnavailableReason
}

export interface KnowledgeProjectStats {
  projectCount: number
  loadedProjectCount: number
  readProjectCount: number
  successfulReadCount: number
}

export interface KnowledgeRecentConstraintFiles {
  fileCount: number
  /** False when old records have missing/ambiguous file identity or truncated lists. */
  complete: boolean
}

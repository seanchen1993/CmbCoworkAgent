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

export interface KnowledgeActiveFile {
  filePath: string
  fileName: string
  subProduct: string
  deployUnit: string
  lastCommitDate: string
  lastCommitUser: string
  roomId: string
  roomName: string
}

export interface KnowledgeActiveDetails {
  items: KnowledgeActiveFile[]
  unavailableReason?: DashboardKnowledgeCommitRateUnavailableReason
}

export interface KnowledgeReadFile {
  filePath: string
  pluginId: string
  pluginName: string
  /** Approximate latest read time from matching summary records. */
  lastReadAt?: string
  /** Unambiguous names used by historical records for this plugin ID. */
  pluginAliases?: string[]
}

export type KnowledgeReadFileRef = Pick<KnowledgeReadFile, "filePath" | "pluginId" | "pluginName">

export interface KnowledgeReader {
  key: string
  userName: string
  sapId: string
  ystId: string
  departments: string[]
  nameOnly: boolean
  lastReadAt?: string
}

export interface KnowledgeFileReaders {
  items: KnowledgeReader[]
  hasUnknownReaders: boolean
}

export interface KnowledgeReadDetails extends KnowledgeRecentConstraintFiles {
  items: KnowledgeReadFile[]
}

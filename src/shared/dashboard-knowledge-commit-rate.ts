/**
 * 当前筛选下给不出知识文档入库率的原因。
 *
 * - multipleRooms：选了多个室。接口只返回比率、不带分子分母，多个室的比率没法合并。
 * - unclassified：选了「未归类」，它不是一个室，没有室编号。
 * - roomNotMapped：该室不在 .env 的室编号映射里。看板的室筛选存的是名称，接口要的是编号。
 * - noAccess：非管理员只能看本室，所选的室里不含本室。
 */
export type DashboardKnowledgeCommitRateUnavailableReason =
  | "multipleRooms"
  | "unclassified"
  | "roomNotMapped"
  | "noAccess"

export interface DashboardKnowledgeCommitRate {
  /** 0–1 的比例。为 null 且没有 unavailableReason 时，表示接口本身没给数。 */
  rate: number | null
  unavailableReason?: DashboardKnowledgeCommitRateUnavailableReason
}

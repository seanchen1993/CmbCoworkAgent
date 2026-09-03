export type RequirementModule = {
  moduleId: string
  name: string
  filePath: string
  description: string
  keywords: string[]
}

export type RequirementPrdManifest = {
  prd: {
    name: string
    status: "" | "init" | "draft" | "generated" | "published"
    description: string
    file: string
    prDetailUrl?: string
  }
  functions: Array<{
    fr: string
    name: string
    description: string
    file: string
    keywords: string[]
  }>
}

export type RequirementRecord = {
  id: string
  threadId: string | null
  threadIds?: string[]
  systemId: string
  title: string
  requirementPath: string
  workspaceMissing: boolean
  coreFilesMissing: boolean
  coreFilesMissingReason: string | null
  updatedAt: string
  updatedAtTimestamp?: number
  system: string
  status: string
  fileName: string
  link: string
  sourceType: "file" | "text" | "link"
  sourceName: string
  initialDescription: string
  prdGenerated: boolean
  prdManifest: RequirementPrdManifest
  prd: "是" | "否"
}

export function getRequirementThreadIds(
  requirement: Pick<RequirementRecord, "threadId" | "threadIds">
): string[] {
  return [
    ...new Set(
      [...(requirement.threadId ? [requirement.threadId] : []), ...(requirement.threadIds ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ]
}

function formatRequirementTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString("zh-CN", { hour12: false })
}

export function fromPersistedRequirement(
  item: Awaited<ReturnType<typeof window.api.requirements.list>>[number],
  systemName: string
): RequirementRecord {
  const generated = item.prdManifest.prd.status.trim().toLowerCase() === "generated"
  const abnormal = item.coreFilesMissing || item.workspaceMissing
  return {
    id: item.reqId,
    threadId: item.threadId,
    threadIds: getRequirementThreadIds(item),
    systemId: item.systemId,
    title: item.title,
    requirementPath: item.requirementPath,
    workspaceMissing: item.workspaceMissing,
    coreFilesMissing: item.coreFilesMissing,
    coreFilesMissingReason: item.coreFilesMissingReason,
    updatedAt: formatRequirementTime(item.updatedAt),
    updatedAtTimestamp: Date.parse(item.updatedAt),
    system: systemName,
    status: abnormal
      ? "异常"
      : item.prdManifest.prd.status.trim().toLowerCase() === "published"
        ? "已发布"
        : item.status === "delivered"
          ? "已交付"
          : generated
            ? "已生成"
            : "沟通中",
    fileName: item.source.fileName,
    link: item.source.url ?? "",
    sourceType: item.source.type,
    sourceName: item.source.fileName,
    initialDescription: item.source.initialDescription ?? "",
    prdGenerated: generated,
    prdManifest: item.prdManifest,
    prd: generated ? "是" : "否"
  }
}

export function getRequirementModules(requirement: RequirementRecord): RequirementModule[] {
  return requirement.prdManifest.functions.map((functionInfo) => ({
    moduleId: functionInfo.fr,
    name: functionInfo.name,
    filePath: functionInfo.file,
    description: functionInfo.description,
    keywords: functionInfo.keywords
  }))
}

export function isRequirementPublished(requirement: RequirementRecord): boolean {
  return requirement.prdManifest.prd.status.trim().toLowerCase() === "published"
}

export function isRequirementGenerated(requirement: RequirementRecord): boolean {
  return requirement.prdManifest.prd.status.trim().toLowerCase() === "generated"
}

function getRequirementUpdatedAtTimestamp(requirement: RequirementRecord): number {
  if (
    typeof requirement.updatedAtTimestamp === "number" &&
    Number.isFinite(requirement.updatedAtTimestamp)
  ) {
    return requirement.updatedAtTimestamp
  }
  const timestamp = Date.parse(requirement.updatedAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function sortRequirementsByUpdatedAt(
  requirements: RequirementRecord[]
): RequirementRecord[] {
  return requirements
    .map((requirement, index) => ({ requirement, index }))
    .sort((left, right) => {
      const timestampDifference =
        getRequirementUpdatedAtTimestamp(right.requirement) -
        getRequirementUpdatedAtTimestamp(left.requirement)
      return timestampDifference || left.index - right.index
    })
    .map(({ requirement }) => requirement)
}

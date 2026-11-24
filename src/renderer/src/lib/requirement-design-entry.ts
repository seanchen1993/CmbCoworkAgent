import {
  commitRequirementRelations,
  getRequirementRelations,
  setRequirementNavigation
} from "./requirement-product-store"

export type RequirementDesignEntry = {
  origin?: "design" | "uploaded"
  source?: "local" | "space"
  scope?: "function" | "full-prd"
  requirementId: string
  requirementName?: string
  functionName?: string
  workspacePath?: string
  previewThreadId?: string
  requirementOverviewFilePath?: string
  requirementFilePath: string
  requirementFiles?: Array<{ name: string; filePath: string }>
  requirementContent?: string
  designSystemId?: string
  prompt: string
  htmlId: string
  htmlFile?: string
}

export function storeUploadedRequirementHtml(entry: RequirementDesignEntry): void {
  storeActiveRequirementDesignEntry({ ...entry, origin: "uploaded" }, entry.htmlId)
}

export function getRequirementDesignFilePaths(entry: RequirementDesignEntry): string[] {
  return [
    entry.requirementFilePath,
    ...(entry.requirementFiles ?? []).map((item) => item.filePath)
  ].filter((filePath, index, paths) => Boolean(filePath) && paths.indexOf(filePath) === index)
}

export type RequirementDesignEntryPayload =
  | RequirementDesignEntry
  | { entries: RequirementDesignEntry[] }

export function isRequirementPrototypeComplete({
  skipped,
  allFunctionsComplete,
  fullPrdHtmlFile,
  published
}: {
  skipped: boolean
  allFunctionsComplete: boolean
  fullPrdHtmlFile?: string
  published: boolean
}): boolean {
  return skipped || allFunctionsComplete || Boolean(fullPrdHtmlFile?.trim()) || published
}

export function buildRequirementDesignPrompt(
  functionName: string,
  requirementFile: string
): string {
  const target = functionName.trim() || "当前功能"
  const coreRequirementFile = requirementFile.trim() || "当前功能需求文档"
  return [
    `请根据已附加的需求文件「${coreRequirementFile}」，为「${target}」设计高保真交互原型。`
  ].join("\n")
}

export function buildFullPrdDesignPrompt(requirementFile: string): string {
  const prdFile = requirementFile.trim() || "完整 PRD 文档"
  return [`请根据已附加的需求PRD 文档「${prdFile}」，设计高保真 UI 交互原型。`].join("\n")
}

export function buildGroupedRequirementDesignPrompt(functionNames: string[]): string {
  const targets = functionNames.map((name) => name.trim()).filter(Boolean)
  return [
    `请将「${targets.join("、") || "所选功能"}」作为一个完整体验，设计成同一个高保真交互原型。`
  ].join("\n")
}

export function buildSpaceRequirementDesignPrompt(requirementName: string): string {
  const target = requirementName.trim() || "当前需求"
  return [`请根据已附加的需求文档，为「${target}」生成高保真交互原型。`].join("\n")
}

export function openRequirementDesign(entry: RequirementDesignEntry): void {
  setRequirementNavigation({ target: "design", entries: [entry] })
}

export function openRequirementDesignBatch(entries: RequirementDesignEntry[]): void {
  if (entries.length === 0) return
  setRequirementNavigation({ target: "design", entries })
}

export function returnToRequirementConversation(requirementId: string): void {
  setRequirementNavigation({ target: "requirement", requirementId })
}

type RequirementEntryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function storeActiveRequirementDesignEntry(
  entry: RequirementDesignEntry | null,
  sessionId: string | null,
  storage: RequirementEntryStorage = localStorage
): void {
  // entry 为空表示显式删除指定设计会话的关联。
  const associationId = entry ? entry.htmlId : sessionId
  if (!associationId) return
  commitRequirementRelations((current) => {
    let requirementId = entry?.requirementId
    if (!requirementId) {
      for (const [id, relations] of Object.entries(current.requirements)) {
        if (relations.designSessions[associationId]) {
          requirementId = id
          break
        }
      }
    }
    if (!requirementId) return current
    const existing = current.requirements[requirementId] ?? {
      designSessions: {},
      developmentThreads: {}
    }
    const designSessions = { ...existing.designSessions }
    if (entry) {
      const persistedEntry = { ...entry }
      delete persistedEntry.requirementContent
      designSessions[associationId] = persistedEntry
    } else delete designSessions[associationId]
    const requirements = { ...current.requirements }
    if (Object.keys(designSessions).length || Object.keys(existing.developmentThreads).length) {
      requirements[requirementId] = { ...existing, designSessions }
    } else delete requirements[requirementId]
    return { ...current, requirements }
  }, storage)
}

export function storeRequirementDesignEntries(
  entries: RequirementDesignEntry[],
  storage: RequirementEntryStorage = localStorage
): void {
  commitRequirementRelations((current) => {
    let next = current
    for (const entry of entries) {
      if (!entry.htmlId) continue
      const existing = next.requirements[entry.requirementId] ?? {
        designSessions: {},
        developmentThreads: {}
      }
      const persistedEntry = { ...entry }
      delete persistedEntry.requirementContent
      next = {
        ...next,
        requirements: {
          ...next.requirements,
          [entry.requirementId]: {
            ...existing,
            designSessions: { ...existing.designSessions, [entry.htmlId]: persistedEntry }
          }
        }
      }
    }
    return next
  }, storage)
}

export async function removeRequirementDesignSessions(
  sessionIds: Iterable<string>,
  removeSession: (sessionId: string) => Promise<void>,
  storage: RequirementEntryStorage = localStorage
): Promise<string[]> {
  const ids = [...new Set(sessionIds)].filter(Boolean)
  const results = await Promise.allSettled(
    ids.map((sessionId) => removeSession(sessionId))
  )
  const failedIds = ids.filter((_, index) => results[index].status === "rejected")
  const failedSet = new Set(failedIds)
  removeRequirementDesignAssociations(ids.filter((id) => !failedSet.has(id)), storage)
  return failedIds
}

export function removeRequirementDesignAssociations(
  sessionIds: Iterable<string>,
  storage: RequirementEntryStorage = localStorage
): void {
  const ids = new Set([...sessionIds].filter(Boolean))
  if (ids.size === 0) return
  commitRequirementRelations((current) => {
    let changed = false
    const requirements = { ...current.requirements }
    for (const [requirementId, existing] of Object.entries(current.requirements)) {
      const designSessions = Object.fromEntries(
        Object.entries(existing.designSessions).filter(([sessionId]) => !ids.has(sessionId))
      )
      if (Object.keys(designSessions).length === Object.keys(existing.designSessions).length) continue
      changed = true
      if (Object.keys(designSessions).length || Object.keys(existing.developmentThreads).length) {
        requirements[requirementId] = { ...existing, designSessions }
      } else delete requirements[requirementId]
    }
    return changed ? { ...current, requirements } : current
  }, storage)
}

export function loadActiveRequirementDesignEntry(
  sessionId: string | null,
  storage: RequirementEntryStorage = localStorage
): RequirementDesignEntry | null {
  if (!sessionId) return null
  return readRequirementDesignAssociations(storage)[sessionId] ?? null
}

export function listRequirementDesignEntries(
  requirementId: string,
  storage: RequirementEntryStorage = localStorage,
  preferredSessionId?: string
): RequirementDesignEntry[] {
  const entriesByFunction = new Map<string, RequirementDesignEntry>()
  const entries =
    getRequirementRelations(storage).requirements[requirementId]?.designSessions ?? {}
  for (const entry of Object.values(entries)) {
    for (const filePath of getRequirementDesignFilePaths(entry)) {
      const existing = entriesByFunction.get(filePath)
      if (
        !existing ||
        entry.htmlId === preferredSessionId ||
        existing.htmlId !== preferredSessionId
      ) {
        entriesByFunction.set(filePath, entry)
      }
    }
  }
  return [
    ...new Map(
      [...entriesByFunction.values()].map((entry) => [entry.htmlId, entry] as const)
    ).values()
  ]
}

export function listAllRequirementDesignEntries(
  requirementId: string,
  storage: RequirementEntryStorage = localStorage
): RequirementDesignEntry[] {
  return Object.values(
    getRequirementRelations(storage).requirements[requirementId]?.designSessions ?? {}
  )
}

export function findRequirementDesignEntry(
  requirementId: string,
  storage: RequirementEntryStorage = localStorage
): RequirementDesignEntry | null {
  const matches = Object.values(
    getRequirementRelations(storage).requirements[requirementId]?.designSessions ?? {}
  )
  return matches.at(-1) ?? null
}

function readRequirementDesignAssociations(
  storage: RequirementEntryStorage
): Record<string, RequirementDesignEntry> {
  void storage
  const valid: Record<string, RequirementDesignEntry> = {}
  for (const relations of Object.values(getRequirementRelations(storage).requirements)) {
    for (const [id, entry] of Object.entries(relations.designSessions)) {
      if (
        entry?.htmlId === id &&
        entry.requirementId &&
        (entry.source === "space" || entry.workspacePath) &&
        entry.requirementFilePath
      ) {
        valid[id] = entry
      }
    }
  }
  return valid
}

export const REQUIREMENT_DESIGN_ENTRY_KEY = "pending-requirement-design"
// 独立保存“设计会话 -> 需求功能”映射，不侵入原有设计会话数据结构。
export const REQUIREMENT_DESIGN_ASSOCIATIONS_KEY = "requirement-design-associations"
export const REQUIREMENT_DESIGN_NAVIGATE_EVENT = "requirement-design:navigate"
export const REQUIREMENT_CONVERSATION_ENTRY_KEY = "pending-requirement-conversation"
export const REQUIREMENT_CONVERSATION_NAVIGATE_EVENT = "requirement-conversation:navigate"

export type RequirementDesignEntry = {
  requirementId: string
  requirementName?: string
  functionName?: string
  workspacePath: string
  previewThreadId?: string
  requirementOverviewFilePath?: string
  requirementFilePath: string
  designSystemId?: string
  prompt: string
  htmlId: string
  htmlFile?: string
}

export type RequirementDesignEntryPayload =
  | RequirementDesignEntry
  | { entries: RequirementDesignEntry[] }

export function shouldCreateRequirementDesignSession(
  htmlId: string,
  existingSessionIds: ReadonlySet<string>
): boolean {
  return !htmlId || !existingSessionIds.has(htmlId)
}

export function buildRequirementDesignPrompt(
  functionName: string,
  requirementFile: string
): string {
  const target = functionName.trim() || "当前功能"
  const coreRequirementFile = requirementFile.trim() || "当前功能需求文档"
  return [
    `请根据已附加的需求文件「${coreRequirementFile}」，为「${target}」设计高保真交互原型。`,
    "",
    "需求文件是业务范围、流程和规则的主要依据；其他资料仅作补充，冲突时以需求文件为准。请覆盖核心流程及必要的空状态、异常状态，输出可独立运行、主要流程可交互的单页 HTML。关键信息缺失时先提问确认。"
  ].join("\n")
}

export function openRequirementDesign(entry: RequirementDesignEntry): void {
  localStorage.setItem(REQUIREMENT_DESIGN_ENTRY_KEY, JSON.stringify(entry))
  window.dispatchEvent(new Event(REQUIREMENT_DESIGN_NAVIGATE_EVENT))
}

export function openRequirementDesignBatch(entries: RequirementDesignEntry[]): void {
  if (entries.length === 0) return
  localStorage.setItem(REQUIREMENT_DESIGN_ENTRY_KEY, JSON.stringify({ entries }))
  window.dispatchEvent(new Event(REQUIREMENT_DESIGN_NAVIGATE_EVENT))
}

export function returnToRequirementConversation(requirementId: string): void {
  localStorage.setItem(REQUIREMENT_CONVERSATION_ENTRY_KEY, requirementId)
  window.dispatchEvent(new Event(REQUIREMENT_CONVERSATION_NAVIGATE_EVENT))
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
  const associations = readRequirementDesignAssociations(storage)
  if (entry) associations[associationId] = entry
  else delete associations[associationId]
  if (Object.keys(associations).length > 0) {
    storage.setItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY, JSON.stringify(associations))
  } else {
    storage.removeItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY)
  }
}

export function storeRequirementDesignEntries(
  entries: RequirementDesignEntry[],
  storage: RequirementEntryStorage = localStorage
): void {
  const associations = readRequirementDesignAssociations(storage)
  for (const entry of entries) {
    if (entry.htmlId) associations[entry.htmlId] = entry
  }
  if (Object.keys(associations).length > 0) {
    storage.setItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY, JSON.stringify(associations))
  }
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
  for (const entry of Object.values(readRequirementDesignAssociations(storage))) {
    if (entry.requirementId !== requirementId) continue
    const existing = entriesByFunction.get(entry.requirementFilePath)
    if (
      !existing ||
      entry.htmlId === preferredSessionId ||
      existing.htmlId !== preferredSessionId
    ) {
      entriesByFunction.set(entry.requirementFilePath, entry)
    }
  }
  return [...entriesByFunction.values()]
}

function readRequirementDesignAssociations(
  storage: RequirementEntryStorage
): Record<string, RequirementDesignEntry> {
  const raw = storage.getItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, RequirementDesignEntry>
    const valid: Record<string, RequirementDesignEntry> = {}
    for (const [id, entry] of Object.entries(parsed)) {
      if (
        entry?.htmlId === id &&
        entry.requirementId &&
        entry.workspacePath &&
        entry.requirementFilePath
      ) {
        valid[id] = entry
      }
    }
    return valid
  } catch {
    return {}
  }
}

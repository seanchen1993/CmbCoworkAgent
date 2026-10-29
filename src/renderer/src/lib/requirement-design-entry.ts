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
  prompt: string
  htmlId: string
  htmlFile?: string
}

export type RequirementDesignEntryPayload =
  | RequirementDesignEntry
  | { entries: RequirementDesignEntry[] }

export function buildRequirementDesignPrompt(
  functionName: string,
  requirementFile: string
): string {
  const target = functionName.trim() || "当前功能"
  const coreRequirementFile = requirementFile.trim() || "当前功能需求文档"
  return [
    `请以已附加的核心需求文件「${coreRequirementFile}」为主要依据，为「${target}」完成高保真交互原型设计。`,
    "",
    "资料使用原则：",
    `- 「${coreRequirementFile}」是本功能的核心需求文件，业务目标、功能范围、流程规则和验收边界均以该文件为准；`,
    "- 其他附件属于补充参考资料，可用于理解业务背景、产品约束、上下游关系及视觉偏好；",
    "- 当补充资料与核心需求文件存在冲突时，以核心需求文件为准，并明确指出冲突内容；",
    "",
    "设计要求：",
    "- 准确覆盖核心需求文件定义的业务目标、核心流程与功能规则；",
    "- 完整覆盖关键使用场景，以及必要的异常状态和空状态；",
    "- 建立清晰的信息架构，并提供符合实际使用场景的操作反馈；",
    "- 输出完整、可独立运行的单页 HTML，确保主要流程可交互，并适配常见桌面视口。",
    "",
    "请综合核心需求文件与补充资料进行设计；若核心需求中的关键信息存在歧义或缺失，请先提出必要的澄清问题，避免自行假设业务规则。"
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

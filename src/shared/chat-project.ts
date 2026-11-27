import { isBtwThreadId } from "./btw-chat"
import { isHarnessProjectModeThread } from "./thread-search-scope"

export interface ChatProject {
  code: string
  name?: string
  fromLean: boolean
}

export type ChatProjectChange =
  | { kind: "workspace"; path: string; project: ChatProject | null }
  | {
      kind: "thread"
      id: string
      createdAt: number
      updatedAt: number
      project: ChatProject | null
    }

export const CHAT_PROJECT_EVENT = "chat.project.binding"
export const CHAT_PROJECT_CODE_LIMIT = 15
export const CHAT_PROJECT_NAME_LIMIT = 128

export function readChatProject(value: unknown): ChatProject | null {
  if (!value || typeof value !== "object") return null
  const { code, name, fromLean } = value as Partial<ChatProject>
  if (
    typeof code !== "string" ||
    code.length > CHAT_PROJECT_CODE_LIMIT * 2 ||
    !/^[\u4e00-\u9fffA-Za-z0-9_-]+$/u.test(code.trim()) ||
    [...code.trim()].length > CHAT_PROJECT_CODE_LIMIT ||
    typeof fromLean !== "boolean" ||
    (name != null && (typeof name !== "string" || name.trim().length > CHAT_PROJECT_NAME_LIMIT))
  )
    return null
  return { code: code.trim(), fromLean, ...(name?.trim() ? { name: name.trim() } : {}) }
}

export function chatGenerationMode(threadId: string, metadata: Record<string, unknown>) {
  if (isBtwThreadId(threadId)) return null
  if (isHarnessProjectModeThread({ metadata })) return "project"
  if (
    metadata.harnessFeature ||
    metadata.harnessProjectSession ||
    metadata.threadType ||
    metadata.botId ||
    metadata.botHostId ||
    metadata.targetKind ||
    metadata.imDeliveryContext ||
    metadata.remoteThread ||
    metadata.isHeartbeat ||
    metadata.scheduledTaskId ||
    metadata.heartbeat ||
    metadata.heartbeatSession ||
    metadata.partnerInputOnly
  )
    return null
  return "chat"
}

export interface UserGenerationSplit {
  project: number
  unbound: number
  unknown: number
  projects: Array<ChatProject & { lines: number }>
}

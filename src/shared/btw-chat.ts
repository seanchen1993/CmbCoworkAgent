const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const sideThreadId = new RegExp(`^btw-(${uuid})-${uuid}$`, "i")

export function getBtwParentId(threadId: string): string | undefined {
  return sideThreadId.exec(threadId)?.[1]
}

export function isBtwThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === "string" && getBtwParentId(threadId) !== undefined
}
export interface BtwMessage {
  role: "user" | "assistant"
  content: string
}

export const BTW_FILE_CANDIDATE_LIMIT = 128
export const BTW_FILE_CANDIDATE_PATH_LIMIT = 4096

export interface BtwRequest {
  parentId: string
  modelId: string
  fileCandidates?: string[]
}

export interface BtwSkillRequestClosed {
  threadId: string
  requestId: string
  kind: "intent" | "confirm"
}

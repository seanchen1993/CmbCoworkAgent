import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"
export type ServiceOperation = "selectModel" | "tasks" | "read" | "send" | "cancel" | "updates"
const keys: Record<ServiceOperation, string[]> = {
  updates: ["conversationId", "taskRef", "requestIds"],
  selectModel: ["conversationId", "modelRef"],
  tasks: ["conversationId", "cursor"],
  read: ["conversationId", "taskRef", "cursor"],
  send: ["conversationId", "taskRef", "requestId", "text"],
  cancel: ["conversationId", "requestId"]
}
/** Validate before opening SQLite, resolving a model or making HTTP calls. */
export function serviceConversationInput(
  operation: ServiceOperation,
  raw: unknown
): Record<string, unknown> {
  const v = partnerObject(raw, keys[operation])
  partnerId(v.conversationId)
  if ("taskRef" in v && !(operation === "send" && v.taskRef === null)) partnerId(v.taskRef)
  if ("requestId" in v) partnerId(v.requestId)
  if ("requestIds" in v) {
    if (
      !Array.isArray(v.requestIds) ||
      v.requestIds.length > 40 ||
      new Set(v.requestIds).size !== v.requestIds.length
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    v.requestIds.forEach(partnerId)
  }
  if (
    "modelRef" in v &&
    (typeof v.modelRef !== "string" ||
      !/^(builtin|custom):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v.modelRef))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  if (
    "cursor" in v &&
    v.cursor !== null &&
    (typeof v.cursor !== "string" ||
      v.cursor.length < 1 ||
      v.cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(v.cursor))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  if (
    "text" in v &&
    (typeof v.text !== "string" ||
      !v.text.trim() ||
      v.text.length > 16384 ||
      /[\u0000\uD800-\uDFFF]/u.test(v.text))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return v
}

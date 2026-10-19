import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"
export type ServiceOperation =
  | "chatTasks"
  | "chat"
  | "taskLifecycle"
  | "retryChat"
  | "selectModel"
  | "tasks"
  | "read"
  | "send"
  | "cancel"
  | "updates"
  | "delivery"
  | "deliveryVersion"
  | "publish"
  | "review"
  | "retryRevision"
const keys: Record<ServiceOperation, string[]> = {
  chatTasks: ["conversationId", "cursor", "query"],
  chat: ["conversationId", "taskRef", "role", "requestId", "text"],
  taskLifecycle: ["conversationId", "taskRef", "operationId", "action"],
  retryChat: ["conversationId", "taskRef", "requestId", "operationId"],
  delivery: ["conversationId", "taskRef", "before"],
  deliveryVersion: ["conversationId", "taskRef", "versionId"],
  publish: ["conversationId", "requestId"],
  review: ["conversationId", "taskRef", "operationId", "versionId", "decision", "comment"],
  retryRevision: ["conversationId", "taskRef", "actionId", "operationId"],
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
  const optionalSelection =
    operation === "chatTasks" &&
    !!raw &&
    typeof raw === "object" &&
    Object.hasOwn(raw, "selectedRef")
  const v = partnerObject(raw, [...keys[operation], ...(optionalSelection ? ["selectedRef"] : [])])
  if (optionalSelection && v.selectedRef !== null) partnerId(v.selectedRef)
  partnerId(v.conversationId)
  if ("taskRef" in v && !(["send", "chat"].includes(operation) && v.taskRef === null))
    partnerId(v.taskRef)
  if (
    operation === "chat" &&
    (!["main", "task"].includes(String(v.role)) || (v.role === "main" && v.taskRef !== null))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  if (operation === "taskLifecycle" && !["complete", "reopen"].includes(String(v.action)))
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  if (
    operation === "chatTasks" &&
    (typeof v.query !== "string" || v.query.length > 160 || v.query.includes("\u0000"))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  for (const key of ["versionId", "operationId", "actionId"]) if (key in v) partnerId(v[key])
  if (
    "before" in v &&
    v.before !== null &&
    (!Number.isSafeInteger(v.before) || Number(v.before) < 1)
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  if (
    operation === "review" &&
    (!["approve", "reject"].includes(String(v.decision)) ||
      (v.decision === "approve"
        ? v.comment !== null
        : typeof v.comment !== "string" ||
          !v.comment.trim() ||
          v.comment.length > 16384 ||
          /[\u0000\uD800-\uDFFF]/u.test(v.comment)))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
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

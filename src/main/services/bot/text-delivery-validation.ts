import { createHash } from "node:crypto"
import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"
import type {
  TextDeliveryDecision,
  TextDeliveryDetail,
  TextDeliveryHead,
  TextDeliveryInput,
  TextDeliveryReceipt,
  TextDeliverySummary,
  TextDeliveryVersion,
  TextDeliveryVersionSummary
} from "../../../shared/bot/text-delivery"
const invalid = (): never => {
  throw new PartnerLocalFault("INVALID_PAYLOAD")
}
const num = (v: unknown, min = 1): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : invalid()
const date = (v: unknown): string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v))
    ? v
    : invalid()
export const deliveryText = (v: unknown): string =>
  typeof v === "string" && !!v.trim() && [...v].length <= 16384 && !/[\u0000\uD800-\uDFFF]/u.test(v)
    ? v
    : invalid()
const nullableId = (v: unknown) => (v === null ? null : partnerId(v))
const digest = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v) ? v : invalid()
export const textDigest = (text: string) =>
  "sha256:" + createHash("sha256").update(text, "utf8").digest("hex")
export function parseDeliveryHead(
  raw: unknown,
  space: string,
  task: string
): TextDeliveryHead | null {
  if (raw === null) return null
  const v = partnerObject(raw, [
    "spaceId",
    "groupId",
    "taskId",
    "botId",
    "revision",
    "versionId",
    "number",
    "status",
    "reviewerPrincipalId",
    "feedbackMessageId",
    "updatedAt"
  ])
  for (const k of ["spaceId", "groupId", "taskId", "botId", "versionId", "reviewerPrincipalId"])
    partnerId(v[k])
  if (
    v.spaceId !== space ||
    v.taskId !== task ||
    !["pending", "changes_requested", "invalidated", "completed"].includes(String(v.status))
  )
    invalid()
  num(v.revision)
  num(v.number)
  nullableId(v.feedbackMessageId)
  date(v.updatedAt)
  return v as unknown as TextDeliveryHead
}
export function parseDeliverySummary(
  raw: unknown,
  space: string,
  task: string
): TextDeliverySummary {
  const v = partnerObject(raw, ["taskId", "taskVersion", "taskStatus", "head", "canReview"])
  if (
    v.taskId !== task ||
    typeof v.canReview !== "boolean" ||
    !["active", "awaiting_business", "completed"].includes(String(v.taskStatus))
  )
    invalid()
  num(v.taskVersion)
  const head = parseDeliveryHead(v.head, space, task)
  if (
    (v.taskStatus === "awaiting_business") !== (head?.status === "pending") ||
    (v.taskStatus === "completed") !== (head?.status === "completed") ||
    (v.canReview && head?.status !== "pending")
  )
    invalid()
  return { ...v, head } as TextDeliverySummary
}
const versionKeys = [
  "id",
  "spaceId",
  "groupId",
  "taskId",
  "botId",
  "number",
  "sourceRunId",
  "sourceAttemptId",
  "inputTaskVersion",
  "digest",
  "sizeBytes",
  "createdAt",
  "createdBy",
  "baseVersionId",
  "feedbackMessageId"
]
export function parseDeliveryVersion(
  raw: unknown,
  space: string,
  task: string,
  full: true
): TextDeliveryVersion
export function parseDeliveryVersion(
  raw: unknown,
  space: string,
  task: string,
  full: false
): TextDeliveryVersionSummary
export function parseDeliveryVersion(
  raw: unknown,
  space: string,
  task: string,
  full: boolean
): TextDeliveryVersionSummary {
  const v = partnerObject(raw, [...versionKeys, ...(full ? ["text"] : [])])
  for (const k of [
    "id",
    "spaceId",
    "groupId",
    "taskId",
    "botId",
    "sourceRunId",
    "sourceAttemptId",
    "createdBy"
  ])
    partnerId(v[k])
  if (v.spaceId !== space || v.taskId !== task) invalid()
  num(v.number)
  num(v.inputTaskVersion)
  num(v.sizeBytes)
  if (Number(v.sizeBytes) > 65536) invalid()
  digest(v.digest)
  date(v.createdAt)
  nullableId(v.baseVersionId)
  nullableId(v.feedbackMessageId)
  if ((v.baseVersionId === null) !== (v.feedbackMessageId === null)) invalid()
  if (full) {
    const text = deliveryText(v.text)
    if (textDigest(text) !== v.digest || Buffer.byteLength(text, "utf8") !== v.sizeBytes) invalid()
  }
  return v as unknown as TextDeliveryVersionSummary
}
export function parseDeliveryDecision(
  raw: unknown,
  space: string,
  task: string,
  target: string
): TextDeliveryDecision | null {
  if (raw === null) return null
  const v = partnerObject(raw, [
    "id",
    "spaceId",
    "taskId",
    "versionId",
    "principalId",
    "decision",
    "comment",
    "createdAt",
    "feedbackMessageId",
    "taskVersion"
  ])
  for (const k of ["id", "spaceId", "taskId", "versionId", "principalId"]) partnerId(v[k])
  if (
    v.spaceId !== space ||
    v.taskId !== task ||
    v.versionId !== target ||
    !["approve", "reject"].includes(String(v.decision))
  )
    invalid()
  num(v.taskVersion)
  date(v.createdAt)
  nullableId(v.feedbackMessageId)
  if (v.decision === "reject") {
    deliveryText(v.comment)
    if (!v.feedbackMessageId) invalid()
  } else if (v.comment !== null || v.feedbackMessageId !== null) invalid()
  return v as unknown as TextDeliveryDecision
}
export function parseDeliveryReceipt(
  raw: unknown,
  space: string,
  task: string
): TextDeliveryReceipt {
  const v = partnerObject(raw, ["versionId", "decision", "summary"]),
    target = partnerId(v.versionId)
  return {
    versionId: target,
    decision: parseDeliveryDecision(v.decision, space, task, target),
    summary: parseDeliverySummary(v.summary, space, task)
  }
}
export function parseDeliveryDetail(
  raw: unknown,
  space: string,
  task: string,
  target: string
): TextDeliveryDetail {
  const v = partnerObject(raw, ["summary", "version", "decision"]),
    ver = parseDeliveryVersion(v.version, space, task, true)
  if (ver.id !== target) invalid()
  return {
    summary: parseDeliverySummary(v.summary, space, task),
    version: ver,
    decision: parseDeliveryDecision(v.decision, space, task, target)
  }
}
export function parseDeliveryInput(
  raw: unknown,
  space: string,
  task: string,
  run: string,
  taskVersion: number
): TextDeliveryInput | null {
  if (raw === null || raw === undefined) return null
  const v = partnerObject(raw, [
    "runId",
    "spaceId",
    "taskId",
    "taskVersion",
    "versionId",
    "number",
    "digest",
    "text",
    "feedbackMessageId",
    "feedbackText",
    "feedbackTaskVersion"
  ])
  for (const k of ["runId", "spaceId", "taskId", "versionId", "feedbackMessageId"]) partnerId(v[k])
  num(v.taskVersion)
  num(v.number)
  num(v.feedbackTaskVersion)
  if (
    v.spaceId !== space ||
    v.taskId !== task ||
    v.runId !== run ||
    v.taskVersion !== taskVersion ||
    Number(v.feedbackTaskVersion) > taskVersion ||
    textDigest(deliveryText(v.text)) !== digest(v.digest)
  )
    invalid()
  deliveryText(v.feedbackText)
  return v as unknown as TextDeliveryInput
}

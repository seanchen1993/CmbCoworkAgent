import type {
  GroupMemory,
  GroupMemoryList,
  GroupMemoryReceipt,
  GroupMemorySnapshot,
  GroupMemorySource
} from "../../../shared/bot/group-memory"
import { GROUP_MEMORY_LIMITS, groupMemoryEncodedLength } from "../../../shared/bot/group-memory"
import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"

function invalid(): never {
  throw new PartnerLocalFault("INVALID_PAYLOAD")
}
export function memoryVersion(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid()
  return Number(value)
}
export function memoryText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > GROUP_MEMORY_LIMITS.text ||
    /[\u0000\uD800-\uDFFF]/u.test(value)
  )
    invalid()
  return value
}
export function memorySource(value: unknown): GroupMemorySource {
  const kind = (value as { kind?: unknown } | null)?.kind
  if (kind === "manual") {
    partnerObject(value, ["kind"])
    return { kind }
  }
  if (kind === "task") {
    const v = partnerObject(value, ["kind", "taskId", "taskVersion"])
    return { kind, taskId: partnerId(v.taskId), taskVersion: memoryVersion(v.taskVersion) }
  }
  if (kind === "result") {
    const v = partnerObject(value, ["kind", "runId"])
    return { kind, runId: partnerId(v.runId) }
  }
  return invalid()
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid()
  if (
    new Date(value).toISOString() !==
    value.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_match, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`
    )
  )
    invalid()
  return value
}
export function parseGroupMemory(value: unknown, spaceId: string, groupId: string): GroupMemory {
  const v = partnerObject(value, [
    "id",
    "spaceId",
    "groupId",
    "version",
    "text",
    "status",
    "source",
    "createdBy",
    "updatedBy",
    "createdAt",
    "updatedAt"
  ])
  if (v.spaceId !== spaceId || v.groupId !== groupId) throw new PartnerLocalFault("FORBIDDEN")
  if (v.status !== "active" && v.status !== "disabled") invalid()
  const memory: GroupMemory = {
    id: partnerId(v.id),
    spaceId: partnerId(v.spaceId),
    groupId: partnerId(v.groupId),
    version: memoryVersion(v.version),
    text: memoryText(v.text),
    status: v.status,
    source: memorySource(v.source),
    createdBy: partnerId(v.createdBy),
    updatedBy: partnerId(v.updatedBy),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt)
  }
  if (Date.parse(memory.updatedAt) < Date.parse(memory.createdAt)) invalid()
  return memory
}
function entries(
  value: unknown,
  spaceId: string,
  groupId: string,
  activeOnly: boolean
): GroupMemory[] {
  if (
    !Array.isArray(value) ||
    value.length > (activeOnly ? GROUP_MEMORY_LIMITS.active : GROUP_MEMORY_LIMITS.stored)
  )
    invalid()
  const memories = value.map((m) => parseGroupMemory(m, spaceId, groupId))
  for (let i = 0; i < memories.length; i++) {
    if (i && memories[i - 1].id >= memories[i].id) invalid()
    if (activeOnly && memories[i].status !== "active") invalid()
  }
  const active = memories.filter((m) => m.status === "active")
  if (
    active.length > GROUP_MEMORY_LIMITS.active ||
    groupMemoryEncodedLength(active) > GROUP_MEMORY_LIMITS.encoded
  )
    invalid()
  return memories
}
export function parseMemorySnapshot(
  value: unknown,
  spaceId: string,
  groupId: string
): GroupMemorySnapshot | null {
  if (value === null) return null
  const v = partnerObject(value, ["revision", "memories"])
  const revision = memoryVersion(v.revision, 0),
    memories = entries(v.memories, spaceId, groupId, true)
  if (memories.some((m) => m.version > revision)) invalid()
  return {
    revision,
    memories
  }
}
export function parseMemoryList(value: unknown, spaceId: string, groupId: string): GroupMemoryList {
  const v = partnerObject(value, ["revision", "memories", "botPolicies", "canManage"])
  if (
    typeof v.canManage !== "boolean" ||
    !Array.isArray(v.botPolicies) ||
    !v.botPolicies.length ||
    v.botPolicies.length > 100
  )
    invalid()
  const seen = new Set<string>()
  const botPolicies = v.botPolicies.map((entry): GroupMemoryList["botPolicies"][number] => {
    const p = partnerObject(entry, ["botId", "botVersionId", "memoryPolicy"])
    const botId = partnerId(p.botId)
    if (seen.has(botId) || (p.memoryPolicy !== "disabled" && p.memoryPolicy !== "explicit_only"))
      invalid()
    seen.add(botId)
    return { botId, botVersionId: partnerId(p.botVersionId), memoryPolicy: p.memoryPolicy }
  })
  const revision = memoryVersion(v.revision, 0),
    memories = entries(v.memories, spaceId, groupId, false)
  if (memories.some((m) => m.version > revision)) invalid()
  return {
    revision,
    memories,
    botPolicies,
    canManage: v.canManage
  }
}
export function parseMemoryReceipt(
  value: unknown,
  spaceId: string,
  groupId: string
): GroupMemoryReceipt {
  const v = partnerObject(value, ["revision", "memory"])
  const revision = memoryVersion(v.revision),
    memory = parseGroupMemory(v.memory, spaceId, groupId)
  if (memory.version > revision) invalid()
  return {
    revision,
    memory
  }
}

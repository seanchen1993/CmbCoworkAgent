import type {
  ExpertMemory,
  ExpertMemoryList,
  ExpertMemoryReceipt,
  ExpertMemorySnapshot
} from "../../../shared/bot/expert-memory"
import { GROUP_MEMORY_LIMITS, groupMemorySourceRef } from "../../../shared/bot/group-memory"
import { memoryVersion, parseGroupMemory, parseMemorySnapshot } from "./group-memory-validation"
import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"

function invalid(): never {
  throw new PartnerLocalFault("INVALID_PAYLOAD")
}
function entry(value: unknown, space: string, bot: string): ExpertMemory {
  const v = partnerObject(value, [
    "id",
    "spaceId",
    "botId",
    "version",
    "text",
    "status",
    "source",
    "createdBy",
    "updatedBy",
    "createdAt",
    "updatedAt"
  ])
  if (v.botId !== bot || v.spaceId !== space) throw new PartnerLocalFault("FORBIDDEN")
  const source = partnerObject(v.source, ["kind"])
  if (source.kind !== "manual") invalid()
  // Reuse the exact text/time/version boundary, not Group authorization.
  const { botId, ...fields } = v
  const {
    groupId: _group,
    source: _source,
    ...parsed
  } = parseGroupMemory({ ...fields, groupId: botId }, space, bot)
  return { ...parsed, botId: partnerId(botId), source: { kind: "manual" } }
}
function entries(
  value: unknown,
  revision: number,
  space: string,
  bot: string,
  activeOnly: boolean
): ExpertMemory[] {
  if (
    !Array.isArray(value) ||
    value.length > (activeOnly ? GROUP_MEMORY_LIMITS.active : GROUP_MEMORY_LIMITS.stored)
  )
    invalid()
  const result = value.map((v) => entry(v, space, bot))
  for (let i = 0; i < result.length; i++)
    if (
      result[i].version > revision ||
      (i > 0 && result[i - 1].id >= result[i].id) ||
      (activeOnly && result[i].status !== "active")
    )
      invalid()
  const active = result.filter((m) => m.status === "active")
  const encoded = JSON.stringify(
    active.map((m) => ({ scope: "bot", sourceRef: groupMemorySourceRef(m), text: m.text }))
  ).replace(/[<>&`]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
  if (active.length > GROUP_MEMORY_LIMITS.active || encoded.length > GROUP_MEMORY_LIMITS.encoded)
    invalid()
  return result
}
export function parseExpertMemoryList(
  value: unknown,
  space: string,
  bot: string
): ExpertMemoryList {
  const v = partnerObject(value, ["botId", "revision", "memories", "canManage"])
  if (v.botId !== bot) throw new PartnerLocalFault("FORBIDDEN")
  if (typeof v.canManage !== "boolean") invalid()
  const revision = memoryVersion(v.revision, 0)
  return {
    botId: partnerId(v.botId),
    revision,
    memories: entries(v.memories, revision, space, bot, false),
    canManage: v.canManage
  }
}
export function parseExpertMemoryReceipt(
  value: unknown,
  space: string,
  bot: string
): ExpertMemoryReceipt {
  const v = partnerObject(value, ["revision", "memory"]),
    revision = memoryVersion(v.revision),
    memory = entry(v.memory, space, bot)
  if (memory.version > revision) invalid()
  return { revision, memory }
}
export function parseRunMemorySnapshot(
  value: unknown,
  space: string,
  group: string,
  bot: string,
  scope: "group" | "bot" = "group"
) {
  if (scope === "group") return parseMemorySnapshot(value, space, group)
  if (value === null) return null
  const v = partnerObject(value, ["scope", "botId", "revision", "memories"])
  if (v.scope !== "bot" || v.botId !== bot) throw new PartnerLocalFault("FORBIDDEN")
  const revision = memoryVersion(v.revision, 0)
  return {
    scope: "bot",
    botId: partnerId(v.botId),
    revision,
    memories: entries(v.memories, revision, space, bot, true)
  } satisfies ExpertMemorySnapshot
}

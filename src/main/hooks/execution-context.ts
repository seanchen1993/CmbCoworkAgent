import { AsyncLocalStorage } from "node:async_hooks"

export const HOOK_AGENT_OWNER_METADATA_KEY = "cmb_subagent_owner_tool_call_id"

const hookAgentIdStorage = new AsyncLocalStorage<string>()

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined
}

function normalizeAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function getCurrentHookAgentId(): string | undefined {
  return hookAgentIdStorage.getStore()
}

export function getHookAgentIdFromRequest(request: unknown): string | undefined {
  const record = asRecord(request)
  const runtime = asRecord(record?.runtime)
  const candidates = [
    asRecord(runtime?.configurable)?.[HOOK_AGENT_OWNER_METADATA_KEY],
    asRecord(asRecord(runtime?.config)?.configurable)?.[HOOK_AGENT_OWNER_METADATA_KEY],
    asRecord(record?.configurable)?.[HOOK_AGENT_OWNER_METADATA_KEY],
    asRecord(record?.metadata)?.[HOOK_AGENT_OWNER_METADATA_KEY],
    asRecord(runtime?.metadata)?.[HOOK_AGENT_OWNER_METADATA_KEY]
  ]

  for (const candidate of candidates) {
    const agentId = normalizeAgentId(candidate)
    if (agentId) return agentId
  }
  return undefined
}

export function runWithHookAgentId<T>(agentId: string | undefined, callback: () => T): T {
  const normalizedAgentId = normalizeAgentId(agentId)
  if (!normalizedAgentId) return callback()
  return hookAgentIdStorage.run(normalizedAgentId, callback)
}

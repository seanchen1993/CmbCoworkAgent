import { createHash } from "node:crypto"
import {
  getCheckpointGraphInputReplay,
  getForkReplayMessagePayload
} from "../../shared/checkpoint-transcript"
import { MAX_FORK_DURABLE_TAIL_MESSAGES } from "../../shared/checkpoint-forkability"

export function forkReplayMessageDigest(message: unknown): string | undefined {
  const payload = getForkReplayMessagePayload(message)
  if (!payload) return
  const serialized = JSON.stringify(payload, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const fields = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]))
  })
  return createHash("sha256").update(serialized).digest("hex")
}

export function readGraphInputForkReplay(checkpoint: unknown): Array<{
  id: string
  message: Record<string, unknown>
  digest: string
}> {
  const evidence: ReturnType<typeof readGraphInputForkReplay> = []
  for (const entry of getCheckpointGraphInputReplay(checkpoint, MAX_FORK_DURABLE_TAIL_MESSAGES)) {
    const digest = forkReplayMessageDigest(entry.message)
    if (!digest) return []
    evidence.push({ ...entry, digest })
  }
  return evidence
}

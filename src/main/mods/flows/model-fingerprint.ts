import { createHash } from "node:crypto"
import type { ResolvedModelConfig } from "../../models/registry"

/** Persist only this digest. Credentials remain live host references and never enter snapshots. */
export function clawModelFingerprint(model: ResolvedModelConfig): string {
  const fields = [
    "ref",
    "baseUrl",
    "model",
    "maxTokens",
    "maxOutputTokens",
    "temperature",
    "topP",
    "topK",
    "interleavedThinking",
    "enableThinking",
    "enableThinkingEffort",
    "thinkingEffort"
  ] as const
  return createHash("sha256")
    .update(JSON.stringify(fields.map((key) => [key, model[key] ?? null])))
    .digest("hex")
}

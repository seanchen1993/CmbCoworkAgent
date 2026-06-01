import type { EvolutionCandidate } from "@/api/evolution"

const CLOUD_EVOLUTION_PROMPT_SIGNATURE_KEY = "trace-evolver-cloud-update-prompt-signature"
const CLOUD_EVOLUTION_VIEWED_SIGNATURE_KEY = "trace-evolver-cloud-update-viewed-signature"

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) || ""
  } catch {
    return ""
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // Notification de-duplication is best-effort; the update list still works without storage.
  }
}

export function pendingCloudEvolutionUpdates(updates: EvolutionCandidate[]): EvolutionCandidate[] {
  return updates.filter((candidate) => candidate.local_adoption_status !== "adopted")
}

export function cloudEvolutionUpdateSignature(updates: EvolutionCandidate[]): string {
  return pendingCloudEvolutionUpdates(updates)
    .map((update) => `${update.candidate_id}:${update.target_version || ""}`)
    .sort()
    .join("|")
}

export function getCloudEvolutionPromptSignature(): string {
  return readStorage(CLOUD_EVOLUTION_PROMPT_SIGNATURE_KEY)
}

export function setCloudEvolutionPromptSignature(signature: string): void {
  writeStorage(CLOUD_EVOLUTION_PROMPT_SIGNATURE_KEY, signature)
}

export function hasUnreadCloudEvolutionUpdates(updates: EvolutionCandidate[]): boolean {
  const signature = cloudEvolutionUpdateSignature(updates)
  return Boolean(signature && signature !== readStorage(CLOUD_EVOLUTION_VIEWED_SIGNATURE_KEY))
}

export function markCloudEvolutionUpdatesSeen(updates: EvolutionCandidate[]): void {
  const signature = cloudEvolutionUpdateSignature(updates)
  if (signature) {
    writeStorage(CLOUD_EVOLUTION_VIEWED_SIGNATURE_KEY, signature)
  }
}

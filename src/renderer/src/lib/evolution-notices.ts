import type { EvolutionCandidate } from "@/api/evolution"
import { normalizeMarketSkillKey } from "@/components/dashboard/skill-market"

const CLOUD_EVOLUTION_PROMPT_SIGNATURE_KEY = "trace-evolver-cloud-update-prompt-signature"
const CLOUD_EVOLUTION_VIEWED_SIGNATURE_KEY = "trace-evolver-cloud-update-viewed-signature"
const NOTIFIED_REVIEW_IDS_KEY = "trace-evolver-review-notified-candidate-ids"

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

/**
 * 从「待审批」候选里挑出个人有权审批发布的项：仅自己上传技能的候选
 * （按归一化 skill key 比对）。该提醒只面向个人，管理员不在范围内。
 */
export function reviewableCandidates(
  candidates: EvolutionCandidate[],
  ownedSkillKeys: Set<string>
): EvolutionCandidate[] {
  if (ownedSkillKeys.size === 0) return []
  return candidates.filter(
    (candidate) =>
      (candidate.evolution_status === "awaiting_review" ||
        candidate.status === "awaiting_review") &&
      ownedSkillKeys.has(normalizeMarketSkillKey(candidate.skill_name))
  )
}

function readNotifiedReviewCandidateIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFIED_REVIEW_IDS_KEY) || "[]") as unknown
    return new Set(
      Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    )
  } catch {
    return new Set()
  }
}

/**
 * 从可审批候选里筛出「从未通知过」的那些，保证每条候选只触发一次提醒。
 * 去重以 candidate_id 记账并持久化，集合增删都不会让老候选被重复提醒。
 */
export function unnotifiedReviewCandidates(candidates: EvolutionCandidate[]): EvolutionCandidate[] {
  const notified = readNotifiedReviewCandidateIds()
  return candidates.filter((candidate) => !notified.has(candidate.candidate_id))
}

export function markReviewCandidatesNotified(candidates: EvolutionCandidate[]): void {
  if (candidates.length === 0) return
  const notified = readNotifiedReviewCandidateIds()
  for (const candidate of candidates) notified.add(candidate.candidate_id)
  try {
    localStorage.setItem(NOTIFIED_REVIEW_IDS_KEY, JSON.stringify([...notified]))
  } catch {
    // 去重记账尽力而为；写入失败最多导致下次重复提醒一次，不影响审批本身。
  }
}

import type { EvolutionCandidate } from "@/api/evolution"

const EVENT_CATEGORY = "skill"

type CloudEvolutionEventName = "skill.evolution.cloud.published" | "skill.evolution.cloud.accepted"

interface CloudEvolutionEventProperties {
  candidateId: string
  runId: string
  skillName: string
  sourceVersion: string | null
  targetVersion: string | null
  baseSkillId: string | null
  sourceBundleHash: string | null
  evaluationScore: string | null
  filesChangedCount: number
  sourceTraceCount: number
  sourceThreadCount: number
  publishedAt: string | null
  publishedS3Path: string | null
  [key: string]: unknown
}

function baseCandidateProperties(candidate: EvolutionCandidate): CloudEvolutionEventProperties {
  return {
    candidateId: candidate.candidate_id,
    runId: candidate.run_id,
    skillName: candidate.skill_name,
    sourceVersion: candidate.source_version ?? null,
    targetVersion: candidate.target_version ?? null,
    baseSkillId: candidate.base_skill_id ?? null,
    sourceBundleHash: candidate.source_bundle_hash ?? null,
    evaluationScore: candidate.evaluation_score ?? null,
    filesChangedCount: candidate.files_changed?.length ?? 0,
    sourceTraceCount: candidate.source_trace_ids?.length ?? 0,
    sourceThreadCount: candidate.source_thread_ids?.length ?? 0,
    publishedAt: candidate.published_at ?? null,
    publishedS3Path: candidate.published_s3_path ?? null
  }
}

function trackCloudEvolutionEvent(
  eventName: CloudEvolutionEventName,
  candidate: EvolutionCandidate,
  properties: Record<string, unknown> = {}
): void {
  const ipcRenderer = window.electron?.ipcRenderer
  if (!ipcRenderer?.invoke) return

  void ipcRenderer
    .invoke("track-event", {
      eventName,
      eventCategory: EVENT_CATEGORY,
      properties: {
        ...baseCandidateProperties(candidate),
        ...properties
      }
    })
    .catch((error) => {
      console.warn(`[CloudEvolutionEvents] Failed to track ${eventName}:`, error)
    })
}

export function trackCloudEvolutionCandidatePublished(
  candidate: EvolutionCandidate,
  reviewer: string
): void {
  trackCloudEvolutionEvent("skill.evolution.cloud.published", candidate, {
    reviewer,
    action: "publish"
  })
}

export function trackCloudEvolutionCandidateAccepted(
  candidate: EvolutionCandidate,
  previousVersion?: string | null
): void {
  trackCloudEvolutionEvent("skill.evolution.cloud.accepted", candidate, {
    trigger: "install_click",
    previousVersion: previousVersion ?? null,
    targetVersion: candidate.target_version ?? null,
    installSource: "cloud-evolution"
  })
}

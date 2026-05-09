function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") || ""
}

const TRACE_EVOLVER_BASE_URL =
  normalizeBaseUrl(import.meta.env.VITE_TRACE_EVOLVER_ENDPOINT as string | undefined) ||
  "http://127.0.0.1:8017"
const USE_DEV_MOCK =
  import.meta.env.DEV &&
  String(import.meta.env.VITE_TRACE_EVOLVER_MOCK ?? "true").trim().toLowerCase() !== "false"
const IGNORED_EVOLUTION_UPDATES_KEY = "trace-evolver-ignored-update-candidates"

export interface InstalledSkillLike {
  name: string
  version?: string | null
}

export interface EvolutionCandidate {
  candidate_id: string
  run_id: string
  status: string
  recommendation: string | null
  base_skill_id: string | null
  full_bundle_path: string
  files_changed: string[]
  source_trace_ids: string[]
  source_thread_ids: string[]
  skill_name: string
  evolution_status: string
  source_version?: string | null
  target_version?: string | null
  source_bundle_hash?: string | null
  auto_optimized: boolean
  evaluation_score?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_by?: string | null
  rejected_at?: string | null
  published_at?: string | null
  published_s3_path?: string | null
  notes?: string | null
}

export interface EvolutionRunRequest {
  skill_name: string
  time_range: { from: string; to: string }
  max_traces: number
  thread_ids?: string[] | null
  model_profile?: string
  output_root?: string | null
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() - offsetMs).toISOString()
}

function devPublishedCandidates(): EvolutionCandidate[] {
  return [
    {
      candidate_id: "cand-dev-cloud-elementui-001",
      run_id: "run-dev-cloud-elementui",
      status: "published",
      recommendation: "promotable",
      base_skill_id: "elementui-page",
      full_bundle_path: "/dev/mock/trace-evolver/elementui-page/bundle",
      files_changed: ["SKILL.md", "references/quality-gates.md"],
      source_trace_ids: [
        "e831aa63-b396-4340-a83f-3374343f4632",
        "7164cc45-358c-48c1-b347-bbc142725e8c",
        "fcec666b-f94c-459c-982a-3ee6e604acd1"
      ],
      source_thread_ids: ["thread-customer-approval", "thread-style-correction"],
      skill_name: "elementui-page",
      evolution_status: "published",
      source_version: "v1.0.3",
      target_version: "v1.0.4",
      source_bundle_hash: "dev-cloud-elementui-hash",
      auto_optimized: true,
      evaluation_score: "0.86",
      approved_by: "trace-evolver-dev",
      approved_at: nowIso(120_000),
      published_at: nowIso(60_000),
      published_s3_path: "s3://dev-trace-evolver/skills/elementui-page/v1.0.4/cand-dev-cloud-elementui-001.zip",
      notes: "DEV fallback: published cloud-evolved candidate for local UI testing."
    },
    {
      candidate_id: "cand-dev-cloud-ts-electron-001",
      run_id: "run-dev-cloud-ts-electron",
      status: "published",
      recommendation: "promotable",
      base_skill_id: "ts_electron_bug_review",
      full_bundle_path: "/dev/mock/trace-evolver/ts_electron_bug_review/bundle",
      files_changed: ["SKILL.md", "references/review-checklist.md"],
      source_trace_ids: [
        "b61af2fd-3d21-41f4-b4f8-7e708dfb7a11",
        "9a00bf3e-3b77-4bd8-944c-d1b3f88f1e2e"
      ],
      source_thread_ids: ["thread-electron-review", "thread-ipc-risk"],
      skill_name: "ts_electron_bug_review",
      evolution_status: "published",
      source_version: "1.0.0",
      target_version: "1.0.1",
      source_bundle_hash: "dev-cloud-ts-electron-hash",
      auto_optimized: true,
      evaluation_score: "0.79",
      approved_by: "trace-evolver-dev",
      approved_at: nowIso(180_000),
      published_at: nowIso(90_000),
      published_s3_path: "s3://dev-trace-evolver/skills/ts_electron_bug_review/1.0.1/cand-dev-cloud-ts-electron-001.zip",
      notes: "DEV fallback: published cloud-evolved candidate for local UI testing."
    }
  ]
}

function devCandidate(candidateId: string): EvolutionCandidate {
  const candidate = devPublishedCandidates().find((item) => item.candidate_id === candidateId)
  if (!candidate) throw new Error(`DEV fallback candidate not found: ${candidateId}`)
  return candidate
}

function devListCandidates(status?: string): EvolutionCandidate[] {
  if (status && status !== "published") return []
  return devPublishedCandidates()
}

function devDiff(candidateId: string): string {
  const candidate = devCandidate(candidateId)
  const referencePath = candidate.skill_name === "elementui-page"
    ? "references/quality-gates.md"
    : "references/review-checklist.md"
  return `diff --git a/SKILL.md b/SKILL.md
index dev111..dev222 100644
--- a/SKILL.md
+++ b/SKILL.md
@@ -1,7 +1,8 @@
 ---
 name: ${candidate.skill_name}
 description: ${candidate.skill_name === "elementui-page" ? "Generate ElementUI pages with quality gates." : "Review Electron/TypeScript changes with risk-focused checks."}
-version: ${candidate.source_version || "v1.0.0"}
+version: ${candidate.target_version || "v1.0.1"}
+evolved-by: CMBDevClaw Trace Evolver
 ---
 
 # ${candidate.skill_name}
@@ -10,3 +11,7 @@
 
 ## Workflow
 
+- Treat repeated user corrections from cloud traces as high-priority guardrails.
+- Before final response, verify generated artifacts against the user's explicit feedback.
+- If a reference checklist exists, read it before applying workflow-specific constraints.
+- Keep related outputs consistent in the same workflow.

diff --git a/${referencePath} b/${referencePath}
new file mode 100644
--- /dev/null
+++ b/${referencePath}
@@ -0,0 +1,6 @@
+# Cloud Trace Quality Gates
+
+- Confirm the final answer directly addresses the user's correction.
+- Prefer reusable guardrails over one-off fixes.
+- Preserve framework or project conventions unless explicitly changed by the user.
+- Record ambiguous evidence as review notes instead of claiming validation.
`
}

function devSkillMarkdown(candidate: EvolutionCandidate): string {
  return `---
name: ${candidate.skill_name}
description: ${candidate.skill_name === "elementui-page" ? "Generate ElementUI pages with quality gates." : "Review Electron/TypeScript changes with risk-focused checks."}
version: ${candidate.target_version || "v1.0.1"}
evolved-by: CMBDevClaw Trace Evolver
---

# ${candidate.skill_name}

## Workflow

- Treat repeated user corrections from cloud traces as high-priority guardrails.
- Before final response, verify generated artifacts against the user's explicit feedback.
- If a reference checklist exists, read it before applying workflow-specific constraints.
- Keep related outputs consistent in the same workflow.
`
}

function devReferenceMarkdown(): string {
  return `# Cloud Trace Quality Gates

- Confirm the final answer directly addresses the user's correction.
- Prefer reusable guardrails over one-off fixes.
- Preserve framework or project conventions unless explicitly changed by the user.
- Record ambiguous evidence as review notes instead of claiming validation.
`
}

async function devCandidateZip(candidateId: string): Promise<{ blob: Blob; filename: string }> {
  const candidate = devCandidate(candidateId)
  const { default: JSZip } = await import("jszip")
  const zip = new JSZip()
  const referencePath = candidate.skill_name === "elementui-page"
    ? "references/quality-gates.md"
    : "references/review-checklist.md"
  zip.file("SKILL.md", devSkillMarkdown(candidate))
  zip.file(referencePath, devReferenceMarkdown())
  return {
    blob: await zip.generateAsync({ type: "blob", mimeType: "application/zip" }),
    filename: `${candidate.skill_name}-${candidate.target_version || "v1.0.1"}.zip`
  }
}

function normalizeVersion(version?: string | null): string | null {
  const raw = String(version ?? "").trim()
  if (!raw) return null
  return raw.startsWith("v") ? raw.slice(1) : raw
}

export function compareEvolutionVersions(left?: string | null, right?: string | null): number {
  const lv = normalizeVersion(left)
  const rv = normalizeVersion(right)
  // If either side is missing, no reliable comparison — suppress the update.
  if (lv === null || rv === null) return 0
  const l = lv.split(".").map((part) => Number(part) || 0)
  const r = rv.split(".").map((part) => Number(part) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (l[i] || 0) - (r[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function filterAvailableUpdates(
  candidates: EvolutionCandidate[],
  installedSkills: InstalledSkillLike[]
): EvolutionCandidate[] {
  const ignored = getIgnoredEvolutionCandidateIds()
  const available = candidates
    .filter((candidate) => !ignored.has(candidate.candidate_id))
    .filter((candidate) => candidate.auto_optimized !== false)
    .filter((candidate) => {
      const installed = installedSkills.find((skill) => skill.name === candidate.skill_name)
      if (!installed) return false
      return compareEvolutionVersions(candidate.target_version, installed.version) > 0
    })

  const latestBySkill = new Map<string, EvolutionCandidate>()
  for (const candidate of available) {
    const current = latestBySkill.get(candidate.skill_name)
    if (!current || compareEvolutionVersions(candidate.target_version, current.target_version) > 0) {
      latestBySkill.set(candidate.skill_name, candidate)
    }
  }

  return [...latestBySkill.values()].sort((a, b) => a.skill_name.localeCompare(b.skill_name))
}

function getIgnoredEvolutionCandidateIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(IGNORED_EVOLUTION_UPDATES_KEY) || "[]") as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${TRACE_EVOLVER_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(text || `Trace Evolver request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const evolutionApi = {
  async createRun(payload: EvolutionRunRequest): Promise<{ run_id: string; status: string }> {
    try {
      return await requestJson("/evolution/runs", {
        method: "POST",
        body: JSON.stringify(payload)
      })
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return { run_id: `run-dev-${payload.skill_name}-${Date.now()}`, status: "exported" }
    }
  },

  async listCandidates(status = "awaiting_review", limit = 50): Promise<EvolutionCandidate[]> {
    try {
      return await requestJson(`/evolution/candidates?status=${encodeURIComponent(status)}&limit=${limit}`)
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return devListCandidates(status).slice(0, limit)
    }
  },

  async listAvailableUpdates(installedSkills: InstalledSkillLike[]): Promise<EvolutionCandidate[]> {
    const published = await this.listCandidates("published")
    return filterAvailableUpdates(published, installedSkills)
  },

  ignoreCandidateUpdate(candidateId: string): void {
    const ignored = getIgnoredEvolutionCandidateIds()
    ignored.add(candidateId)
    localStorage.setItem(IGNORED_EVOLUTION_UPDATES_KEY, JSON.stringify([...ignored]))
  },

  async getCandidate(candidateId: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}`)
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return devCandidate(candidateId)
    }
  },

  async getDiff(candidateId: string): Promise<string> {
    try {
      const response = await fetch(`${TRACE_EVOLVER_BASE_URL}/evolution/candidates/${encodeURIComponent(candidateId)}/diff`)
      if (!response.ok) {
        throw new Error(`Failed to load diff: ${response.status}`)
      }
      return response.text()
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return devDiff(candidateId)
    }
  },

  async downloadCandidateBundle(candidateId: string): Promise<{ blob: Blob; filename: string }> {
    try {
      const response = await fetch(`${TRACE_EVOLVER_BASE_URL}/evolution/candidates/${encodeURIComponent(candidateId)}/bundle.zip`)
      if (!response.ok) {
        throw new Error(`Failed to download candidate bundle: ${response.status}`)
      }
      const blob = await response.blob()
      const contentDisposition = response.headers.get("Content-Disposition")
      const filename = contentDisposition?.match(/filename="?([^"]+)"?/)?.[1] || `${candidateId}.zip`
      return { blob, filename }
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return devCandidateZip(candidateId)
    }
  },

  async approve(candidateId: string, reviewer?: string, notes?: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewer, notes })
      })
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return { ...devCandidate(candidateId), status: "approved", evolution_status: "approved", approved_by: reviewer || "trace-evolver-dev", notes }
    }
  },

  async reject(candidateId: string, reviewer?: string, notes?: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewer, notes })
      })
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return { ...devCandidate(candidateId), status: "rejected", evolution_status: "rejected", rejected_by: reviewer || "trace-evolver-dev", notes }
    }
  },

  async publish(candidateId: string, reviewer?: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ reviewer })
      })
    } catch (error) {
      if (!USE_DEV_MOCK || !isNetworkError(error)) throw error
      return { ...devCandidate(candidateId), status: "published", evolution_status: "published", approved_by: reviewer || "trace-evolver-dev" }
    }
  }
}

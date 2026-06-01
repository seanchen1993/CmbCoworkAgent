import { buildBundleUnifiedDiff, createTextBundleZip, type TextBundleFile } from "@/lib/skill-bundle-diff"

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim().replace(/\/+$/, "") || ""
  if (!raw) return ""
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
}

const TRACE_EVOLVER_LOCAL_DEBUG_URL = "http://127.0.0.1:8017"
const TRACE_EVOLVER_CONFIGURED_BASE_URL =
  normalizeBaseUrl(import.meta.env.VITE_TRACE_EVOLVER_ENDPOINT as string | undefined) ||
  TRACE_EVOLVER_LOCAL_DEBUG_URL
const USE_DEV_MOCK =
  import.meta.env.DEV &&
  String(import.meta.env.VITE_TRACE_EVOLVER_MOCK ?? "true").trim().toLowerCase() !== "false"
const LOCAL_DEBUG_ENDPOINT_KEY = "trace-evolver-use-local-debug-endpoint"
const IGNORED_EVOLUTION_UPDATES_KEY = "trace-evolver-ignored-update-candidates"
const ADOPTED_EVOLUTION_UPDATES_KEY = "trace-evolver-adopted-update-candidates"

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
  local_adoption_status?: "adopted"
  local_adopted_at?: string
  local_backup_id?: string
  local_backup_path?: string
}

export interface EvolutionAdoptionRecord {
  candidate_id: string
  skill_name: string
  source_version?: string | null
  target_version?: string | null
  adopted_at: string
  backup_id: string
  backup_path?: string
  candidate?: EvolutionCandidate
}

export interface EvolutionRunRequest {
  skill_name: string
  time_range: { from: string; to: string }
  max_traces: number
  thread_ids?: string[] | null
  model_profile?: string
  output_root?: string | null
}

export type EvolutionDraftFile = TextBundleFile

const DEV_DRAFTS = new Map<string, TextBundleFile[]>()

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError
}

function isLocalDebugEndpointEnabled(): boolean {
  try {
    return localStorage.getItem(LOCAL_DEBUG_ENDPOINT_KEY) === "true"
  } catch {
    return false
  }
}

function setLocalDebugEndpointEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LOCAL_DEBUG_ENDPOINT_KEY, String(enabled))
  } catch {
    // ignore storage failures; the current call site state still updates.
  }
}

function traceEvolverBaseUrl(): string {
  return isLocalDebugEndpointEnabled() ? TRACE_EVOLVER_LOCAL_DEBUG_URL : TRACE_EVOLVER_CONFIGURED_BASE_URL
}

function traceEvolverNoCacheUrl(path: string): string {
  const url = new URL(`${traceEvolverBaseUrl()}${path}`)
  url.searchParams.set("_", Date.now().toString())
  return url.toString()
}

function shouldUseDevMock(error: unknown): boolean {
  return USE_DEV_MOCK && !isLocalDebugEndpointEnabled() && isNetworkError(error)
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
  const draft = DEV_DRAFTS.get(candidateId)
  if (draft) {
    const referencePath = candidate.skill_name === "elementui-page"
      ? "references/quality-gates.md"
      : "references/review-checklist.md"
    return buildBundleUnifiedDiff(
      [
        {
          path: "SKILL.md",
          content: `---
name: ${candidate.skill_name}
description: ${candidate.skill_name === "elementui-page" ? "Generate ElementUI pages with quality gates." : "Review Electron/TypeScript changes with risk-focused checks."}
version: ${candidate.source_version || "v1.0.0"}
---

# ${candidate.skill_name}

## Workflow
`
        },
        { path: referencePath, content: "" }
      ],
      draft
    )
  }
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

function devBaseSkillMarkdown(candidate: EvolutionCandidate): string {
  return `---
name: ${candidate.skill_name}
description: ${candidate.skill_name === "elementui-page" ? "Generate ElementUI pages with quality gates." : "Review Electron/TypeScript changes with risk-focused checks."}
version: ${candidate.source_version || "v1.0.0"}
---

# ${candidate.skill_name}

## Workflow

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
  const draft = DEV_DRAFTS.get(candidateId)
  if (draft) {
    const zip = await createTextBundleZip(draft, `${candidate.skill_name}-${candidate.target_version || "v1.0.1"}.zip`)
    return { blob: new Blob([zip.buffer], { type: "application/zip" }), filename: zip.filename }
  }
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

async function devCandidateBaseZip(candidateId: string): Promise<{ blob: Blob; filename: string }> {
  const candidate = devCandidate(candidateId)
  const zip = await createTextBundleZip(
    [{ path: "SKILL.md", content: devBaseSkillMarkdown(candidate) }],
    `${candidate.skill_name}-${candidate.source_version || "base"}.zip`
  )
  return { blob: new Blob([zip.buffer], { type: "application/zip" }), filename: zip.filename }
}

function devSaveDraft(candidateId: string, files: TextBundleFile[], notes?: string): EvolutionCandidate {
  DEV_DRAFTS.set(candidateId, files)
  return {
    ...devCandidate(candidateId),
    notes: notes ?? devCandidate(candidateId).notes
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
  const adopted = getAdoptedEvolutionCandidates()
  const available = candidates
    .filter((candidate) => !ignored.has(candidate.candidate_id))
    .filter((candidate) => candidate.auto_optimized !== false)
    .filter((candidate) => {
      const installed = installedSkills.find((skill) => skill.name === candidate.skill_name)
      if (!installed) return false
      return compareEvolutionVersions(candidate.target_version, installed.version) > 0
    })
    .map((candidate) => {
      const record = adopted.get(candidate.candidate_id)
      return record ? withAdoptionRecord(candidate, record) : candidate
    })

  const latestBySkill = new Map<string, EvolutionCandidate>()
  for (const candidate of available) {
    const current = latestBySkill.get(candidate.skill_name)
    if (!current || compareEvolutionVersions(candidate.target_version, current.target_version) > 0) {
      latestBySkill.set(candidate.skill_name, candidate)
    }
  }

  for (const record of adopted.values()) {
    if (ignored.has(record.candidate_id)) continue
    const current = latestBySkill.get(record.skill_name)
    if (!current) {
      latestBySkill.set(record.skill_name, candidateFromAdoptionRecord(record))
      continue
    }
    if (
      current.candidate_id === record.candidate_id &&
      compareEvolutionVersions(record.target_version, current.target_version) >= 0
    ) {
      latestBySkill.set(record.skill_name, candidateFromAdoptionRecord(record))
    }
  }

  return [...latestBySkill.values()].sort((a, b) => {
    const statusDelta = Number(Boolean(a.local_adoption_status)) - Number(Boolean(b.local_adoption_status))
    if (statusDelta !== 0) return statusDelta
    return a.skill_name.localeCompare(b.skill_name)
  })
}

function getIgnoredEvolutionCandidateIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(IGNORED_EVOLUTION_UPDATES_KEY) || "[]") as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

function getAdoptedEvolutionCandidates(): Map<string, EvolutionAdoptionRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADOPTED_EVOLUTION_UPDATES_KEY) || "[]") as unknown
    const records = Array.isArray(parsed) ? parsed.filter(isEvolutionAdoptionRecord) : []
    return new Map(records.map((record) => [record.candidate_id, record]))
  } catch {
    return new Map()
  }
}

function isEvolutionAdoptionRecord(value: unknown): value is EvolutionAdoptionRecord {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<EvolutionAdoptionRecord>
  return (
    typeof candidate.candidate_id === "string" &&
    typeof candidate.skill_name === "string" &&
    typeof candidate.adopted_at === "string" &&
    typeof candidate.backup_id === "string"
  )
}

function setAdoptedEvolutionCandidate(record: EvolutionAdoptionRecord): void {
  const adopted = getAdoptedEvolutionCandidates()
  adopted.set(record.candidate_id, record)
  localStorage.setItem(ADOPTED_EVOLUTION_UPDATES_KEY, JSON.stringify([...adopted.values()]))
}

function clearAdoptedEvolutionCandidate(candidateId: string): void {
  const adopted = getAdoptedEvolutionCandidates()
  adopted.delete(candidateId)
  localStorage.setItem(ADOPTED_EVOLUTION_UPDATES_KEY, JSON.stringify([...adopted.values()]))
}

function withAdoptionRecord(candidate: EvolutionCandidate, record: EvolutionAdoptionRecord): EvolutionCandidate {
  return {
    ...candidate,
    local_adoption_status: "adopted",
    local_adopted_at: record.adopted_at,
    local_backup_id: record.backup_id,
    local_backup_path: record.backup_path
  }
}

function candidateFromAdoptionRecord(record: EvolutionAdoptionRecord): EvolutionCandidate {
  const candidate = record.candidate
  if (candidate) return withAdoptionRecord(candidate, record)
  return withAdoptionRecord({
    candidate_id: record.candidate_id,
    run_id: "",
    status: "published",
    recommendation: null,
    base_skill_id: record.skill_name,
    full_bundle_path: "",
    files_changed: [],
    source_trace_ids: [],
    source_thread_ids: [],
    skill_name: record.skill_name,
    evolution_status: "published",
    source_version: record.source_version || null,
    target_version: record.target_version || null,
    source_bundle_hash: null,
    auto_optimized: true,
    evaluation_score: null,
    published_at: null,
    published_s3_path: null,
    notes: "本地已采纳记录"
  }, record)
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${traceEvolverBaseUrl()}${path}`, {
    ...init,
    cache: init?.cache ?? "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
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
  getEndpoint(): string {
    return traceEvolverBaseUrl()
  },

  getConfiguredEndpoint(): string {
    return TRACE_EVOLVER_CONFIGURED_BASE_URL
  },

  getLocalDebugEndpoint(): string {
    return TRACE_EVOLVER_LOCAL_DEBUG_URL
  },

  isLocalDebugEndpointEnabled(): boolean {
    return isLocalDebugEndpointEnabled()
  },

  setLocalDebugEndpointEnabled(enabled: boolean): void {
    setLocalDebugEndpointEnabled(enabled)
  },

  async createRun(payload: EvolutionRunRequest): Promise<{ run_id: string; status: string }> {
    try {
      return await requestJson("/evolution/runs", {
        method: "POST",
        body: JSON.stringify(payload)
      })
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return { run_id: `run-dev-${payload.skill_name}-${Date.now()}`, status: "exported" }
    }
  },

  async listCandidates(status = "awaiting_review", limit = 50): Promise<EvolutionCandidate[]> {
    try {
      return await requestJson(`/evolution/candidates?status=${encodeURIComponent(status)}&limit=${limit}`)
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devListCandidates(status).slice(0, limit)
    }
  },

  async listAvailableUpdates(installedSkills: InstalledSkillLike[]): Promise<EvolutionCandidate[]> {
    try {
      const published = await this.listCandidates("published")
      return filterAvailableUpdates(published, installedSkills)
    } catch (error) {
      const adopted = [...getAdoptedEvolutionCandidates().values()].map(candidateFromAdoptionRecord)
      if (adopted.length > 0) return adopted.sort((a, b) => a.skill_name.localeCompare(b.skill_name))
      throw error
    }
  },

  ignoreCandidateUpdate(candidateId: string): void {
    const ignored = getIgnoredEvolutionCandidateIds()
    ignored.add(candidateId)
    localStorage.setItem(IGNORED_EVOLUTION_UPDATES_KEY, JSON.stringify([...ignored]))
  },

  markCandidateAdopted(record: EvolutionAdoptionRecord): void {
    setAdoptedEvolutionCandidate(record)
  },

  clearCandidateAdoption(candidateId: string): void {
    clearAdoptedEvolutionCandidate(candidateId)
  },

  applyLocalAdoption(candidate: EvolutionCandidate): EvolutionCandidate {
    const record = getAdoptedEvolutionCandidates().get(candidate.candidate_id)
    return record ? withAdoptionRecord(candidate, record) : candidate
  },

  async getCandidate(candidateId: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}`)
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devCandidate(candidateId)
    }
  },

  async getDiff(candidateId: string): Promise<string> {
    try {
      const response = await fetch(
        traceEvolverNoCacheUrl(`/evolution/candidates/${encodeURIComponent(candidateId)}/diff`),
        { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
      )
      if (!response.ok) {
        throw new Error(`Failed to load diff: ${response.status}`)
      }
      return response.text()
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devDiff(candidateId)
    }
  },

  async downloadCandidateBundle(candidateId: string): Promise<{ blob: Blob; filename: string }> {
    try {
      const response = await fetch(
        traceEvolverNoCacheUrl(`/evolution/candidates/${encodeURIComponent(candidateId)}/bundle.zip`),
        { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
      )
      if (!response.ok) {
        throw new Error(`Failed to download candidate bundle: ${response.status}`)
      }
      const blob = await response.blob()
      const contentDisposition = response.headers.get("Content-Disposition")
      const filename = contentDisposition?.match(/filename="?([^"]+)"?/)?.[1] || `${candidateId}.zip`
      return { blob, filename }
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devCandidateZip(candidateId)
    }
  },

  async downloadCandidateBaseBundle(candidateId: string): Promise<{ blob: Blob; filename: string }> {
    try {
      const response = await fetch(
        traceEvolverNoCacheUrl(`/evolution/candidates/${encodeURIComponent(candidateId)}/base-bundle.zip`),
        { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
      )
      if (!response.ok) {
        throw new Error(`Failed to download candidate base bundle: ${response.status}`)
      }
      const blob = await response.blob()
      const contentDisposition = response.headers.get("Content-Disposition")
      const filename = contentDisposition?.match(/filename="?([^"]+)"?/)?.[1] || `${candidateId}-base.zip`
      return { blob, filename }
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devCandidateBaseZip(candidateId)
    }
  },

  async approve(candidateId: string, reviewer?: string, notes?: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewer, notes })
      })
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
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
      if (!shouldUseDevMock(error)) throw error
      return { ...devCandidate(candidateId), status: "rejected", evolution_status: "rejected", rejected_by: reviewer || "trace-evolver-dev", notes }
    }
  },

  async saveDraft(
    candidateId: string,
    files: EvolutionDraftFile[],
    reviewer?: string,
    notes?: string
  ): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/draft`, {
        method: "PUT",
        body: JSON.stringify({ reviewer, notes, files })
      })
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return devSaveDraft(candidateId, files, notes)
    }
  },

  async deleteCandidate(candidateId: string): Promise<{ detail: string }> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}`, {
        method: "DELETE"
      })
    } catch (error) {
      throw error
    }
  },

  async publish(candidateId: string, reviewer?: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ reviewer })
      })
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return { ...devCandidate(candidateId), status: "published", evolution_status: "published", approved_by: reviewer || "trace-evolver-dev" }
    }
  },

  async unpublish(candidateId: string): Promise<EvolutionCandidate> {
    try {
      return await requestJson(`/evolution/candidates/${encodeURIComponent(candidateId)}/unpublish`, {
        method: "POST"
      })
    } catch (error) {
      if (!shouldUseDevMock(error)) throw error
      return {
        ...devCandidate(candidateId),
        status: "approved",
        evolution_status: "approved",
        published_at: null,
        published_s3_path: null
      }
    }
  }
}

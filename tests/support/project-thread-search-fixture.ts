import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ThreadSearchStartRequest } from "../../src/shared/thread-search-types"

export const PROBE_PROJECT_ID = "project-candidate-sparse"
export const PROBE_OTHER_PROJECT_ID = "project-candidate-many"
export const PROBE_EMPTY_PROJECT_ID = "project-candidate-empty"
export const PROBE_FEATURE_SLUG = "search-fixture-feature"

export function seedProbeProjects(dataRoot: string, workspacePath: string, count = 2048) {
  const ids = [
    ...Array.from({ length: count - 3 }, (_, i) => "project-catalog-noise-" + i),
    PROBE_PROJECT_ID,
    PROBE_OTHER_PROJECT_ID,
    PROBE_EMPTY_PROJECT_ID
  ]
  const projectDir = "search-history-fixture"
  mkdirSync(join(workspacePath, projectDir), { recursive: true })
  const projects = ids.map((projectId) => ({
    projectId,
    name: "共享名称 · 项目历史 🧩",
    workspacePath,
    projectDir,
    "harness-adapter": { id: "search-fixture", name: "search-fixture", type: "plugin" },
    lifecycle: { status: "active" },
    description: ""
  }))
  const filler = "项目目录容量夹具。"
  const baseBytes = Buffer.byteLength(JSON.stringify({ projects }))
  const padding = count === 2048
    ? Math.floor((4 * 1024 * 1024 * 0.97 - baseBytes) / (count * Buffer.byteLength(filler)))
    : 0
  for (const project of projects) project.description = filler.repeat(Math.max(0, padding))
  const source = JSON.stringify({ projects })
  writeFileSync(join(dataRoot, "harness-board-projects.json"), source)
  return { projects: new Map(projects.map(({ projectId, name }) => [projectId, { label: name }])),
    bytes: Buffer.byteLength(source) }
}

export function projectProbeMetadata(index: number, threads: number, withFeatures = false) {
  // The selected project has two widely-separated sessions, and a second project is empty.
  if (withFeatures && index === threads - 2) {
    return { harnessFeature: { projectId: PROBE_PROJECT_ID, slug: PROBE_FEATURE_SLUG } }
  }
  if (index === 1 || index === threads - 2) {
    return { harnessProjectSession: { projectId: PROBE_PROJECT_ID, kind: "chat" } }
  }
  if (index % 3 === 1) {
    return { harnessProjectSession: { projectId: PROBE_OTHER_PROJECT_ID, kind: "chat" } }
  }
  return {}
}

type Scope = NonNullable<ThreadSearchStartRequest["scope"]>

interface ProjectProbeCase {
  scope: Scope
  label: "title" | "recent" | "oldest" | "noMatch"
  query: string
  expectedIndex: number | null
  expectedCandidates: number
  hot: number
  cold: number
}

export function projectProbeCases(threads: number, withFeatures = false): ProjectProbeCase[] {
  const all = Array.from({ length: threads }, (_, index) => index)
  const projectByRow = all.map((index) => {
    const metadata = projectProbeMetadata(index, threads, withFeatures)
    return metadata.harnessFeature?.projectId ?? metadata.harnessProjectSession?.projectId
  })
  const partitions = {
    ordinary: all.filter((index) => !projectByRow[index]),
    project: all.filter((index) => projectByRow[index] === PROBE_PROJECT_ID),
    projects: all.filter((index) => projectByRow[index]),
    all
  }
  const cases: ProjectProbeCase[] = []
  for (const [key, items] of Object.entries(partitions)) {
    const scope: Scope = key === "project"
      ? { kind: "project", projectId: PROBE_PROJECT_ID }
      : { kind: key as "ordinary" | "projects" | "all" }
    const first = items[0]
    const last = items.at(-1)!
    const expectedCandidates = items.length
    cases.push(
      { scope, label: "title", query: projectProbeTitle(last), expectedIndex: last,
        expectedCandidates, hot: 1000, cold: 2000 },
      { scope, label: "recent", query: projectProbeMarker(last, 9), expectedIndex: last,
        expectedCandidates, hot: 1000, cold: 2000 },
      { scope, label: "oldest", query: projectProbeMarker(first, 0), expectedIndex: first,
        expectedCandidates, hot: 10000, cold: 20000 },
      { scope, label: "noMatch", query: "absent-project-search-needle", expectedIndex: null,
        expectedCandidates, hot: 10000, cold: 20000 }
    )
  }
  cases.push({
    scope: { kind: "project", projectId: PROBE_EMPTY_PROJECT_ID },
    label: "noMatch", query: "absent-empty-project-search-needle", expectedIndex: null,
    expectedCandidates: 0, hot: 1000, cold: 2000
  })
  return cases
}

export function projectProbeTitle(index: number) {
  return "project-title-" + String(index).padStart(5, "0")
}

export function projectProbeMarker(index: number, ordinal: number) {
  return ordinal === 0 || ordinal === 9
    ? "project-body-" + String(index).padStart(5, "0") + "-" + ordinal
    : ""
}

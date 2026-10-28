import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HarnessProjectListItem } from "../../shared/harness-board-types"

const service = vi.hoisted(() => ({
  listHarnessProjects: vi.fn(),
  getHarnessProjectDetails: vi.fn(),
  getHarnessProjectAdapterSnapshot: vi.fn()
}))
vi.mock("../harness-board/service", () => service)
vi.mock("./event-reporter", () => ({
  buildEvent: (eventName: string, eventCategory: string, properties: unknown) => ({
    eventName,
    eventCategory,
    properties
  })
}))
import { reportProjectSnapshotNow } from "./harness-status-reporter"

const project = (isTestProject?: boolean) =>
  ({ projectId: "p1", name: "project", isTestProject }) as HarnessProjectListItem
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv("VITE_ES_NODES", "http://es.test")
  vi.stubEnv("VITE_API_TRACE_BASE_URL", "http://relay.test")
  vi.stubEnv("VITE_ES_USERNAME", "")
  vi.stubEnv("VITE_ES_PASSWORD", "")
  service.getHarnessProjectDetails.mockResolvedValue({ p1: { runs: [] } })
  service.getHarnessProjectAdapterSnapshot.mockResolvedValue(null)
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("test-project snapshot reporting", () => {
  it.each([true, false, undefined])(
    "reports metadata %s as a Boolean through the existing relay document",
    async (flag) => {
      service.listHarnessProjects.mockResolvedValue([project(flag)])
      await reportProjectSnapshotNow("p1")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe("http://relay.test/api/traces/project-snapshot")
      const payload = JSON.parse(request.body as string)
      expect(payload.document.properties.isTestProject).toBe(flag === true)
      expect(payload.preserveIfEmpty).toBe(true)
      expect(payload.docId).toBe("harness_project_p1")
    }
  )

  it.each([true, false])(
    "changes classification to %s while preserving a non-empty snapshot on inspect failure",
    async (flag) => {
      vi.stubEnv("VITE_API_TRACE_BASE_URL", "")
      service.listHarnessProjects.mockResolvedValue([project(flag)])
      service.getHarnessProjectDetails.mockRejectedValueOnce(new Error("inspect failed"))
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ _source: { properties: { featureCount: 5, isTestProject: !flag } } })
        )
      )
      await reportProjectSnapshotNow("p1")
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [readUrl] = fetchMock.mock.calls[0] as unknown as [string]
      expect(readUrl).toContain("properties.features.slug")
      expect(readUrl).not.toContain("properties.features,")
      const [url, request] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
      expect(url).toContain("/_update/harness_project_p1")
      expect(request.method).toBe("POST")
      expect(JSON.parse(request.body as string)).toEqual({
        doc: { properties: { isTestProject: flag } }
      })
    }
  )

  it("does not add an ES write to an unchanged preserved snapshot", async () => {
    vi.stubEnv("VITE_API_TRACE_BASE_URL", "")
    service.listHarnessProjects.mockResolvedValue([project(true)])
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ _source: { properties: { featureCount: 5, isTestProject: true } } })
      )
    )
    await reportProjectSnapshotNow("p1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not overwrite feature data when the existing snapshot cannot be read", async () => {
    vi.stubEnv("VITE_API_TRACE_BASE_URL", "")
    service.listHarnessProjects.mockResolvedValue([project(true)])
    fetchMock.mockRejectedValue(new Error("offline"))
    await reportProjectSnapshotNow("p1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("writes a new empty project with the flag after 404", async () => {
    vi.stubEnv("VITE_API_TRACE_BASE_URL", "")
    service.listHarnessProjects.mockResolvedValue([project(true)])
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }))
    await reportProjectSnapshotNow("p1")
    const [url, request] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toContain("/_doc/harness_project_p1")
    expect(request.method).toBe("PUT")
    expect(JSON.parse(request.body as string).properties).toMatchObject({
      isTestProject: true,
      featureCount: 0,
      features: []
    })
  })
})

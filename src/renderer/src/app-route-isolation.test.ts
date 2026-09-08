import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8")

function heavyRouteSurface(): string {
  const start = appSource.indexOf("Main content below titlebar")
  const end = appSource.indexOf("<PetStateBridge />")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function backgroundThreadRefreshSurface(): string {
  const start = appSource.indexOf("Reload thread list when main process signals a change")
  const end = appSource.indexOf("if (isLoading)")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe("App route isolation", () => {
  it("defers one atomic route object instead of task and mode independently", () => {
    expect(appSource).toContain("const selectedRenderRoute = useMemo(")
    expect(appSource).toContain("const renderedRoute = useDeferredValue(selectedRenderRoute)")
    expect(appSource).toContain("threadId: currentThreadId")
    expect(appSource).toContain("harnessSessionThreadId,")
    expect(appSource).toContain("workerFocusView,")
    expect(appSource).toContain("subagentFocusView,")
    expect(appSource).toContain("workflowAgentFocusView")
  })

  it("keeps heavy center and right surfaces on the deferred task identity", () => {
    const surface = heavyRouteSurface()
    expect(surface).not.toMatch(/\bcurrentThreadId\b/)
    expect(surface).not.toMatch(/\bharnessSessionThreadId\b/)
    expect(surface).not.toMatch(/\bmainView\s*[!=]==/)
    expect(surface).toContain("threadId={renderedThreadId}")
    expect(surface).toContain("threadId={renderedHarnessSessionThreadId}")
    expect(surface).toContain("aria-busy={renderRoutePending}")
  })

  it("keeps navigation usable while stale task controls are shielded", () => {
    const surface = heavyRouteSurface()
    expect(surface).toContain("data-app-route-control")
    expect(surface).toContain("renderRoutePending &&")
    expect(surface).toContain("正在切换任务")
  })

  it("reserves automatic thread selection for startup bootstrap", () => {
    expect(appSource.match(/loadThreads\(\{ selectInitialThread: true \}\)/g)).toHaveLength(1)

    const refreshSurface = backgroundThreadRefreshSurface()
    expect(refreshSurface).toContain("onThreadsChanged")
    expect(refreshSurface).toContain('window.addEventListener("focus", onFocus)')
    expect(refreshSurface.match(/loadThreads\(\)/g)).toHaveLength(2)
    expect(refreshSurface).not.toContain("selectInitialThread")
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  new URL("../components/harness-board/HarnessBoardView.tsx", import.meta.url),
  "utf8"
)

describe("Harness project sidebar directory pagination", () => {
  it("keeps older project sessions reachable beyond the initial bounded directory", () => {
    const sidebarStart = source.indexOf("function ProjectFeatureSidebar(")
    const sidebarEnd = source.indexOf("interface HarnessBoardViewProps", sidebarStart)
    const sidebar = source.slice(sidebarStart, sidebarEnd)
    const drainStart = source.indexOf("const drainSidebarProjectLookupQueue = useCallback")
    const drainEnd = source.indexOf("useEffect(() => {", drainStart)
    const drain = source.slice(drainStart, drainEnd)

    expect(sidebarStart).toBeGreaterThanOrEqual(0)
    expect(drainStart).toBeGreaterThanOrEqual(0)
    expect(sidebar).toContain("threadDirectoryHasMore")
    expect(sidebar).toContain("threadDirectoryLoadingMore")
    expect(sidebar).toContain("void loadMoreThreads()")
    expect(sidebar).toContain("加载更早项目会话")
    expect(source).toContain("enqueueHarnessSidebarProjectLookups(")
    expect(drain).toContain("takeHarnessSidebarProjectLookupBatch(")
    expect(drain).toContain("sidebarProjectLookupInFlightRef.current")
    expect(drain).toContain("sidebarProjectLookupTimerRef.current = window.setTimeout(")
    expect(drain).toContain("}, 0)")
    expect(source).not.toContain("64 - Object.keys(sidebarProjectsById).length")
    expect(sidebar.indexOf("groups.length === 0")).toBeLessThan(
      sidebar.indexOf("threadDirectoryHasMore &&")
    )
  })
})

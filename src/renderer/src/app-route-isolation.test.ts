import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { createLatestRefreshCoordinator } from "./lib/latest-refresh-coordinator"

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

  it("keeps the app shell's z-index out of the root stacking context", () => {
    // 壳内的 z-index 必须关在自己的层叠上下文里。Radix 的 Dialog/Popover 都 portal 到
    // document.body，是 #root 的兄弟；壳一旦不构成层叠上下文，壳内任何 positioned +
    // z-index 的元素就会直接和 portal 比大小。侧边栏的 relative z-[60] 曾因此盖住
    // DialogContent 的 z-50——窗口够宽时弹窗左边缘落在侧边栏右侧看不出来，窗口一窄
    // 就压上去了。<Toaster /> 是这层壳的兄弟，不在隔离范围内。
    expect(appSource).toContain(
      '<div className="isolate flex flex-col h-screen overflow-hidden bg-background">'
    )
  })

  it("reserves automatic thread selection for startup bootstrap", async () => {
    expect(appSource.match(/loadThreads\(\{ selectInitialThread: true \}\)/g)).toHaveLength(1)

    const refreshSurface = backgroundThreadRefreshSurface()
    expect(refreshSurface).toContain("onThreadsChanged")
    expect(refreshSurface).toContain('window.addEventListener("focus", onFocus)')
    expect(refreshSurface).not.toContain("selectInitialThread")

    const file = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest,
      true, ts.ScriptKind.TSX)
    const effects: ts.ArrowFunction[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" &&
        node.arguments.length === 2 && ts.isArrowFunction(node.arguments[0]) &&
        node.arguments[0].getText(file).includes("createLatestRefreshCoordinator") &&
        node.arguments[0].getText(file).includes("onThreadsChanged"))
        effects.push(node.arguments[0])
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(effects).toHaveLength(1)
    const pending: Array<() => void> = []
    const notifications = new Set<() => void>()
    let active = 0, maximumActive = 0
    const loadThreads = vi.fn<(...args: unknown[]) => Promise<void>>(() => {
      active++
      maximumActive = Math.max(maximumActive, active)
      return new Promise(resolve => pending.push(() => { active--; resolve() }))
    })
    const clearCompletedTasks = vi.fn()
    const localWindow = Object.assign(new EventTarget(), { api: {
      threads: { onThreadsChanged: (notify: () => void) => {
        notifications.add(notify)
        return () => { notifications.delete(notify) }
      } },
      pet: { clearCompletedTasks }
    } })
    const callback = runInNewContext(ts.transpileModule(`(${effects[0].getText(file)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText, {
      window: localWindow, useAppStore: { getState: () => ({ loadThreads }) },
      createLatestRefreshCoordinator, console: { error: vi.fn() }
    }) as () => () => void
    const settle = async (): Promise<void> => {
      for (let tick = 0; tick < 12; tick++) await Promise.resolve()
    }
    const cleanup = callback()
    try {
      expect(notifications.size).toBe(1)
      for (const notify of notifications) notify()
      localWindow.dispatchEvent(new Event("focus"))
      for (let count = 0; count < 10; count++)
        for (const notify of notifications) notify()
      await settle()
      expect(loadThreads).toHaveBeenCalledTimes(1)
      expect(maximumActive).toBe(1)
      expect(clearCompletedTasks).not.toHaveBeenCalled()
      pending.shift()!()
      await settle()
      expect(loadThreads).toHaveBeenCalledTimes(2)
      expect(maximumActive).toBe(1)
      expect(clearCompletedTasks).toHaveBeenCalledTimes(1)
      pending.shift()!()
      await settle()
      expect(loadThreads.mock.calls).toEqual([[], []])
      expect(active).toBe(0)
    } finally {
      cleanup()
      for (const release of pending.splice(0)) release()
      await settle()
    }
    const completed = loadThreads.mock.calls.length
    expect(notifications.size).toBe(0)
    localWindow.dispatchEvent(new Event("focus"))
    await settle()
    expect(loadThreads).toHaveBeenCalledTimes(completed)
  })
})

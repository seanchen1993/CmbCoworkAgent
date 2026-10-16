import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
interface FixtureState {
  currentThreadId: string
  showCustomizeView: boolean
  threads: Array<{
    thread_id: string
    title: string
    metadata: { workspacePath: string; agentMode: string }
  }>
  selectThread(id: string): Promise<void>
  setShowCustomizeView(show: boolean): void
}
const fixture = vi.hoisted(() => ({ state: {} as FixtureState }))
vi.mock("@/lib/store", () => ({ useAppStore: { getState: () => fixture.state } }))
import {
  beginConfigurationTarget, captureConfigurationScope, chooseConfigurationTarget,
  configurationTargetValid, goToConfigurationThread, readConfigurationTarget,
  supportsConfiguration
} from "./configuration-target"

let close: () => void
const a = { threadId: "a", workspace: "C:/alpha" }
const b = { threadId: "b", workspace: "C:/beta" }
describe("independent configuration target", () => {
  beforeEach(() => {
    fixture.state = {
      currentThreadId: "a", showCustomizeView: true,
      threads: [a, b].map((scope) => ({ thread_id: scope.threadId, title: "同名聊天",
        metadata: { workspacePath: scope.workspace, agentMode: "normal" } })),
      selectThread: vi.fn(async (id) => { fixture.state.currentThreadId = id; fixture.state.showCustomizeView = false }),
      setShowCustomizeView: vi.fn((show) => { fixture.state.showCustomizeView = show })
    }
    close = beginConfigurationTarget(a)
  })
  afterEach(() => close())
  it("chooses B without changing A; only explicit use navigates B", () => {
    expect(chooseConfigurationTarget(b)).toBeNull()
    expect(fixture.state.currentThreadId).toBe("a")
    expect(fixture.state.selectThread).not.toHaveBeenCalled()
    expect(goToConfigurationThread(b)).toBe(true)
    expect(fixture.state.selectThread).toHaveBeenCalledWith("b")
  })
  it("fences old async callbacks even after A→B→A", () => {
    const current = captureConfigurationScope(a)
    chooseConfigurationTarget(b)
    chooseConfigurationTarget(a)
    expect(current()).toBe(false)
  })
  it("keeps deleted/replaced target rather than falling back to current A", () => {
    chooseConfigurationTarget(b)
    fixture.state.threads[1].metadata.workspacePath = "C:/replacement"
    expect(configurationTargetValid(b, fixture.state.threads)).toBe(false)
    expect(goToConfigurationThread(b)).toBe(false)
    expect(readConfigurationTarget()?.threadId).toBe("b")
    fixture.state.threads.pop()
    expect(goToConfigurationThread(b)).toBe(false)
    expect(fixture.state.currentThreadId).toBe("a")
  })
  it("excludes internal, remote and unsupported targets", () => {
    for (const metadata of [
      { workspacePath: "C:/x", hostProjectRuntime: {} },
      { workspacePath: "C:/x", parentThreadId: "a" },
      { workspacePath: "C:/x", remoteReadOnly: true }, {}
    ]) expect(supportsConfiguration({ thread_id: "x", metadata })).toBe(false)
  })
  it("old settings cleanup cannot erase a new session", () => {
    const next = beginConfigurationTarget(b)
    close()
    expect(readConfigurationTarget()?.threadId).toBe("b")
    next()
  })
})

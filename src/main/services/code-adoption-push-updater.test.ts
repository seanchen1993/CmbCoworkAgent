import { afterEach, expect, it, vi } from "vitest"
import { scheduleMarkCodeAdoptionCommitsPushed } from "./code-adoption-push-updater"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each(["absent", "relay", "direct"] as const)(
  "schedules telemetry only when its backend is configured: %s",
  (mode) => {
    vi.useFakeTimers()
    vi.stubEnv("VITE_API_TRACE_BASE_URL", mode === "relay" ? "https://fixture.invalid" : "")
    vi.stubEnv("VITE_ES_NODES", mode === "direct" ? "https://fixture.invalid" : "")
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    scheduleMarkCodeAdoptionCommitsPushed({
      commitShas: ["abc"],
      repoPath: "fixture",
      branch: "fixture",
      remoteUrl: "",
      repositoryName: "",
      repositoryFullName: "",
      repositoryHost: "",
      repositoryWebUrl: "",
      commitUrlTemplate: "",
      pushedAt: "",
      pushOperationId: ""
    })
    expect(vi.getTimerCount()).toBe(mode === "absent" ? 0 : 4)
    if (mode === "absent") expect(log).not.toHaveBeenCalled()
    vi.clearAllTimers()
  }
)

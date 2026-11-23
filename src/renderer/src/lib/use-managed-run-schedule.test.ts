import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ManagedRunSchedule,
  ManagedRunScheduleChange
} from "../../../shared/managed-run-schedule"

// Run the query hooks in Node: no browser, DOM, or component preview is needed.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  state: [] as unknown[],
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>
}))
vi.mock("react", () => ({
  useState<T>(initial: T | (() => T)) {
    const slot = hooks.cursor++
    if (!(slot in hooks.state)) {
      hooks.state[slot] = typeof initial === "function" ? (initial as () => T)() : initial
    }
    return [
      hooks.state[slot],
      (value: T | ((current: T) => T)) => {
        hooks.state[slot] =
          typeof value === "function" ? (value as (current: T) => T)(hooks.state[slot] as T) : value
      }
    ]
  },
  useCallback<T>(callback: T) {
    hooks.cursor++
    return callback
  },
  useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
    const slot = hooks.cursor++
    const previous = hooks.effects[slot]
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return
    hooks.pending.push(() => {
      previous?.cleanup?.()
      hooks.effects[slot] = { deps, cleanup: effect() }
    })
  }
}))
import { useManagedRunSchedule, useManagedRunScheduleIndex } from "./use-managed-run-schedule"

const schedule: ManagedRunSchedule = {
  projectId: "project",
  featureId: "feature",
  scheduleId: "reservation",
  workspacePath: "/workspace",
  scheduledAt: "2026-10-28 22:00:00",
  createdAt: "2026-10-28 18:00:00",
  updatedAt: "2026-10-28 18:00:00",
  status: "pending"
}
const listeners = new Set<(event: ManagedRunScheduleChange) => void>()
const getOne = vi.fn<() => Promise<ManagedRunSchedule | null>>()
const getAll = vi.fn<() => Promise<ManagedRunSchedule[]>>()
function render<T>(hook: () => T): T {
  hooks.cursor = 0
  const result = hook()
  hooks.pending.splice(0).forEach((effect) => effect())
  return result
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
beforeEach(() => {
  hooks.state = []
  hooks.effects = []
  hooks.pending = []
  listeners.clear()
  getOne.mockReset()
  getAll.mockReset()
  vi.stubGlobal("window", {
    api: {
      harnessBoard: {
        getManagedRunSchedule: getOne,
        getActiveManagedRunSchedules: getAll,
        onManagedRunScheduleChanged: (listener: (event: ManagedRunScheduleChange) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
})
afterEach(() => {
  hooks.effects.forEach((effect) => effect?.cleanup?.())
  vi.unstubAllGlobals()
})

describe("managed reservation query recovery", () => {
  it("can retry an initial detail failure without leaving the feature", async () => {
    getOne
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce(schedule)
    const useQuery = () => useManagedRunSchedule("project", "feature")
    render(useQuery)
    await settle()
    const failed = render(useQuery)
    expect(failed.error).toContain("temporarily unavailable")
    failed.reload()
    render(useQuery)
    await settle()
    const recovered = render(useQuery)
    expect(recovered.error).toBeUndefined()
    expect(recovered.schedule).toEqual(schedule)
    expect(getOne).toHaveBeenCalledTimes(2)
  })

  it("retries detail loading when the existing page refresh revision changes", async () => {
    getOne.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce(null)
    let revision = 0
    const useQuery = () => useManagedRunSchedule("project", "feature", revision)
    render(useQuery)
    await settle()
    expect(render(useQuery).error).toContain("locked")
    revision++
    render(useQuery)
    await settle()
    expect(render(useQuery).error).toBeUndefined()
    expect(render(useQuery).schedule).toBeNull()
  })

  it("reloads sidebar icons after the initial index query fails", async () => {
    getAll.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce([schedule])
    const log = vi.spyOn(console, "warn").mockImplementation(() => {})
    let revision = 0
    const useQuery = () => useManagedRunScheduleIndex(revision)
    render(useQuery)
    await settle()
    expect(render(useQuery).size).toBe(0)
    revision++
    render(useQuery)
    await settle()
    expect(render(useQuery).get(JSON.stringify(["project", "feature"]))).toBe(schedule.scheduledAt)
    log.mockRestore()
  })

  it("does not restore a cancelled reservation from an older sidebar refresh result", async () => {
    let resolve!: (rows: ManagedRunSchedule[]) => void
    getAll.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const useQuery = () => useManagedRunScheduleIndex(1)
    render(useQuery)
    for (const listener of listeners)
      listener({ projectId: "project", featureId: "feature", schedule: null })
    resolve([schedule])
    await settle()
    expect(render(useQuery).size).toBe(0)
  })
})

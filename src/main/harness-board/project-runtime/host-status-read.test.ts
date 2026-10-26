import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { HostProjectStore } from "./host-store"
import { HostProjectService } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture, prepareFixture } from "./host-fixtures.test-helper"

it("reads persisted task status without inspecting a package, executing tools or preparing knowledge", () => {
  const root = mkdtempSync(join(tmpdir(), "host-status-read-"))
  const store = new HostProjectStore(join(root, "state.sqlite"))
  try {
    const project = store.create(hostProjectFixture(root))
    store.prepare(prepareFixture())
    const unavailable = vi.fn(() => { throw Error("Status must not enter execution") })
    const snapshots = new HostPackageSnapshots(join(root, "packages"))
    vi.spyOn(snapshots, "read").mockImplementation(unavailable)
    const service = new HostProjectService(store, snapshots, {
      resolveInstalledPlugin: unavailable,
      authorize: unavailable,
      prepareInputIdentity: unavailable,
      inputIdentity: unavailable,
      executeSkill: unavailable
    })
    const durations: number[] = []
    for (let index = 0; index < 200; index++) {
      const start = performance.now()
      expect(service.get(project.projectId)?.stageIndex).toBe(0)
      expect(service.operations(project.projectId, 20)).toHaveLength(1)
      durations.push(performance.now() - start)
    }
    expect(unavailable).not.toHaveBeenCalled()
    durations.sort((a, b) => a - b)
    // Observations only: timing assertions under parallel CI load would hide the real invariant.
    console.info("Host status read (SQLite + assertion overhead)", {
      samples: durations.length, p50Ms: durations[99], p95Ms: durations[189],
      executionCalls: unavailable.mock.calls.length
    })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

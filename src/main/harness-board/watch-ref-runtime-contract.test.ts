import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const mainSource = readFileSync(new URL("./watch-ref-watcher.ts", import.meta.url), "utf8")
const workerSource = readFileSync(new URL("./watch-ref-worker.ts", import.meta.url), "utf8")

describe("Harness watch-ref runtime isolation contract", () => {
  it("keeps path probes and fs.watch installation out of Electron main", () => {
    expect(mainSource).toContain("HarnessWatchRefWorkerClient")
    expect(mainSource).not.toMatch(/from ["'](?:node:)?fs["']/)
    expect(mainSource).not.toContain("existsSync(")
    expect(mainSource).not.toContain("statSync(")
    expect(mainSource).not.toContain("watch(")
  })

  it("retains path safety, debounce, and cancellation inside the worker", () => {
    expect(workerSource).toContain("HARNESS_WATCH_REF_MAX_REFS")
    expect(workerSource).toContain("relative(resolve(workspacePath), resolve(targetPath))")
    expect(workerSource).toContain("DEBOUNCE_MS = 500")
    expect(workerSource).toContain("Atomics.load")
  })
})

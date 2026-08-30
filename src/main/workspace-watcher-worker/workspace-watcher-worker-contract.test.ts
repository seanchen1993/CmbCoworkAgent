import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("workspace watcher native isolation contract", () => {
  it("keeps directory validation and recursive watch installation in the worker", () => {
    const worker = readFileSync(new URL("./workspace-watcher-worker.ts", import.meta.url), "utf8")
    const coordinator = readFileSync(
      new URL("../services/workspace-watcher.ts", import.meta.url),
      "utf8"
    )

    expect(worker.indexOf("fs.lstatSync(request.workspacePath)")).toBeLessThan(
      worker.indexOf("watcher = fs.watch(")
    )
    expect(coordinator).not.toContain("fs.promises.lstat(workspacePath)")
    expect(coordinator.indexOf("registerPendingWatcherStart(threadId")).toBeLessThan(
      coordinator.indexOf("await watcher.start()")
    )
  })
})

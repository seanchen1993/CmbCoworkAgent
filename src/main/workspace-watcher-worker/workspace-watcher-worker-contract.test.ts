import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

const workerSource = readFileSync(new URL("./workspace-watcher-worker.ts", import.meta.url), "utf8")
const workerCode = ts.transpileModule(workerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function installedWorker(change?: "inode" | "canonical") {
  const postMessage = vi.fn()
  let message!: (request: { type: string; requestId: number; workspacePath: string }) => void
  let installed = false
  const close = vi.fn()
  const stat = vi.fn(() => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    dev: 999999999999999999n,
    ino: installed && change === "inode" ? 5n : 888888888888888888n
  }))
  const fs = {
    lstatSync: stat,
    realpathSync: {
      native: () => (installed && change === "canonical" ? "/different" : "/canonical/workspace")
    },
    watch: vi.fn(() => {
      installed = true
      return { close, on: vi.fn() }
    })
  }
  runInNewContext(workerCode, {
    exports: {},
    Buffer,
    setImmediate,
    clearImmediate,
    require(name: string) {
      if (name === "node:fs") return fs
      if (name === "node:worker_threads")
        return {
          parentPort: {
            postMessage,
            on: (_name: string, callback: typeof message) => {
              message = callback
            }
          }
        }
      if (name === "./protocol")
        return {
          WORKSPACE_WATCHER_EVENT_BATCH_MAX_ENTRIES: 128,
          WORKSPACE_WATCHER_EVENT_BATCH_MAX_BYTES: 98304
        }
      throw Error(`UNEXPECTED_WORKER_REQUIRE:${name}`)
    }
  })
  message({ type: "start", requestId: 1, workspacePath: "/workspace" })
  return { postMessage, close, fs }
}

describe("workspace watcher native isolation contract", () => {
  it("keeps directory validation and recursive watch installation in the worker", () => {
    const worker = readFileSync(new URL("./workspace-watcher-worker.ts", import.meta.url), "utf8")
    const coordinator = readFileSync(
      new URL("../services/workspace-watcher.ts", import.meta.url),
      "utf8"
    )

    expect(worker.indexOf("directoryObservation(request.workspacePath)")).toBeLessThan(
      worker.indexOf("watcher = fs.watch(")
    )
    expect(coordinator).not.toContain("fs.promises.lstat(workspacePath)")
    expect(coordinator.indexOf("registerPendingWatcherStart(threadId")).toBeLessThan(
      coordinator.indexOf("await watcher.start()")
    )
  })

  it("reports precise stable directory identity around the actual worker watch installation", () => {
    const worker = installedWorker()
    expect(worker.fs.watch).toHaveBeenCalledOnce()
    expect(worker.fs.lstatSync).toHaveBeenCalledTimes(2)
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "start-result",
      requestId: 1,
      ok: true,
      observation: {
        canonicalPath: "/canonical/workspace",
        rootIdentity: "999999999999999999:888888888888888888"
      }
    })
    expect(worker.close).not.toHaveBeenCalled()
  })
  it.each(["inode", "canonical"] as const)(
    "rejects a changed %s during watch installation",
    (change) => {
      const worker = installedWorker(change)
      expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "start-result",
          ok: false,
          error: expect.objectContaining({ code: "WORKSPACE_WATCHER_ROOT_CHANGED" })
        })
      )
      expect(worker.close).toHaveBeenCalledOnce()
    }
  )
})

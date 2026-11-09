import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import type {
  HarnessWatchRefStartRequest,
  HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

let workerCode: string
const workers: Worker[] = []
const roots: string[] = []
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./watch-ref-worker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false
  })
  workerCode = result.outputFiles[0].text
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "harness-watch-worker-"))
  roots.push(root)
  return root
}

function fixture() {
  const worker = new Worker(workerCode, { eval: true })
  workers.push(worker)
  const messages: HarnessWatchRefWorkerResponse[] = []
  worker.on("message", (message) => messages.push(message))
  return {
    worker,
    messages,
    async start(root: string, scopeKey: string, refs: HarnessWatchRef[], notifyChanges = true) {
      const request: HarnessWatchRefStartRequest = {
        type: "start",
        scopeKey,
        generation: 1,
        workspacePath: root,
        refs,
        notifyChanges,
        attributionTarget: { projectId: "p", featureSlug: scopeKey },
        cancelBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      }
      worker.postMessage(request)
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "installed",
            scopeKey,
            watcherCount: refs.length,
            cancelled: false
          })
        )
      )
      return request
    }
  }
}

describe("watch-ref worker notification costs", () => {
  it("filters unrelated siblings for the page and distinguishes artifact from stage invalidation", async () => {
    const root = await workspace()
    const { messages, start } = fixture()
    await start(root, "feature", [
      { path: "STATE.md", purpose: "run-state" },
      { path: "artifact.json", purpose: "artifacts" }
    ])
    messages.length = 0
    await writeFile(join(root, "code.ts"), "unrelated")
    await pause(650)
    expect(messages).toEqual([])

    await writeFile(join(root, "artifact.json"), "artifact")
    await vi.waitFor(
      () => expect(messages.some((message) => message.type === "changed")).toBe(true),
      { timeout: 2_000 }
    )
    expect(
      messages
        .filter((message) => message.type === "dirty")
        .every((message) => message.stageChanged === false)
    ).toBe(true)
    expect(messages).toContainEqual(expect.objectContaining({ type: "dirty", stageChanged: false }))
    messages.length = 0
    await writeFile(join(root, "STATE.md"), "new stage")
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "dirty", stageChanged: true })
      )
    )
  })

  it("shares directory handles across refs and scopes and keeps remaining subscribers alive", async () => {
    const root = await workspace()
    const otherRoot = await workspace()
    const { worker, messages, start } = fixture()
    await start(
      root,
      "first",
      [
        { path: "one.json", purpose: "run-state" },
        { path: "two.json", purpose: "run-state" }
      ],
      false
    )
    const second = await start(root, "second", [{ path: "two.json", purpose: "run-state" }], false)
    expect(
      messages
        .filter((message) => message.type === "installed")
        .map((message) => message.sharedWatcherCount)
    ).toEqual([1, 1])

    messages.length = 0
    worker.postMessage(second)
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "installed", sharedWatcherCount: 1 })
      )
    )
    expect(Atomics.load(new Int32Array(second.cancelBuffer), 0)).toBe(0)
    worker.postMessage({ type: "stop", scopeKey: "first", generation: 1 })
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "stopped")).toBe(true)
    )
    messages.length = 0
    await writeFile(join(root, "two.json"), "updated")
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "dirty", scopeKey: "second" })
      )
    )
    await pause(650)
    expect(
      messages.every((message) => message.type === "dirty" && message.scopeKey === "second")
    ).toBe(true)

    worker.postMessage({ type: "stop", scopeKey: "second", generation: 1 })
    await start(otherRoot, "third", [{ path: "state.json", purpose: "run-state" }], false)
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "installed", scopeKey: "third", sharedWatcherCount: 1 })
    )
  })
})

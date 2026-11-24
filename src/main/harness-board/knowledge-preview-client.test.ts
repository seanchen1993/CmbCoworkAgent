import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { serialize } from "node:v8"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  HarnessKnowledgePreviewCancelledError,
  HarnessKnowledgePreviewClient
} from "./knowledge-preview-client"
import { HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES } from "./knowledge-preview-protocol"

const tempRoots: string[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "harness-knowledge-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "knowledge-preview-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./knowledge-preview-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class FakeKnowledgePreviewWorker extends EventEmitter {
  request: Record<string, unknown> | null = null
  terminateCalls = 0

  postMessage(message: Record<string, unknown>): void {
    this.request = message
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1
    return Promise.resolve(0)
  }
}

const target = (idKey: string) => ({
  idKey,
  name: `Knowledge ${idKey}`,
  path: join(tmpdir(), idKey)
})

describe("Harness knowledge preview worker client", () => {
  it("keeps the main event loop responsive while a real worker scans a bounded tree", async () => {
    const knowledgePath = await mkdtemp(join(tmpdir(), "framework-knowledge-worker-"))
    tempRoots.push(knowledgePath)
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeFile(join(knowledgePath, `entry-${index}.md`), "body", "utf8")
      )
    )

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const client = new HarnessKnowledgePreviewClient(
      async () => new Worker(workerBundlePath, { name: "harness-knowledge-preview-test" })
    )
    const result = await client.read(
      { idKey: "kb-main", name: "Main knowledge", path: knowledgePath },
      "harness-knowledge:1:kb-main"
    )
    clearInterval(ticker)

    expect(result.files).toHaveLength(200)
    expect(ticks).toBeGreaterThan(0)
    expect(serialize(result).byteLength).toBeLessThanOrEqual(
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES
    )
    await client.close()
  })

  it("terminates a superseded same-knowledge-base scan and only accepts the latest result", async () => {
    const firstWorker = new FakeKnowledgePreviewWorker()
    const secondWorker = new FakeKnowledgePreviewWorker()
    const workers = [firstWorker, secondWorker]
    const client = new HarnessKnowledgePreviewClient(
      async () => workers.shift()! as unknown as Worker
    )

    const first = client.read(target("kb-a"), "harness-knowledge:7:kb-a")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = client.read(target("kb-a"), "harness-knowledge:7:kb-a")
    await expect(first).rejects.toBeInstanceOf(HarnessKnowledgePreviewCancelledError)
    expect(firstWorker.terminateCalls).toBeGreaterThan(0)

    await new Promise((resolve) => setTimeout(resolve, 0))
    const requestId = secondWorker.request?.requestId
    secondWorker.emit("message", {
      type: "read-result",
      requestId,
      ok: true,
      result: {
        exists: false,
        files: []
      }
    })
    await expect(second).resolves.toMatchObject({ exists: false })
    await client.close()
  })

  it("cancels all knowledge-base scans owned by an unmounted renderer", async () => {
    const workers = [new FakeKnowledgePreviewWorker(), new FakeKnowledgePreviewWorker()]
    const client = new HarnessKnowledgePreviewClient(
      async () => workers.shift()! as unknown as Worker
    )
    const first = client.read(target("kb-a"), "harness-knowledge:9:kb-a")
    const second = client.read(target("kb-b"), "harness-knowledge:9:kb-b")
    await new Promise((resolve) => setTimeout(resolve, 0))

    client.cancelScopesWithPrefix("harness-knowledge:9:")
    await expect(first).rejects.toBeInstanceOf(HarnessKnowledgePreviewCancelledError)
    await expect(second).rejects.toBeInstanceOf(HarnessKnowledgePreviewCancelledError)
    expect(workers).toHaveLength(0)
    await client.close()
  })

  it("rejects a pending request when a worker exits cleanly and recovers next request", async () => {
    const firstWorker = new FakeKnowledgePreviewWorker()
    const replacement = new FakeKnowledgePreviewWorker()
    const workers = [firstWorker, replacement]
    const client = new HarnessKnowledgePreviewClient(
      async () => workers.shift()! as unknown as Worker
    )

    const exited = client.read(target("kb-a"), "harness-knowledge:10:kb-a")
    await new Promise((resolve) => setTimeout(resolve, 0))
    firstWorker.emit("exit", 0)
    await expect(exited).rejects.toThrow("exited: 0")

    const retried = client.read(target("kb-a"), "harness-knowledge:10:kb-a")
    await new Promise((resolve) => setTimeout(resolve, 0))
    replacement.emit("message", {
      type: "read-result",
      requestId: replacement.request?.requestId,
      ok: true,
      result: {
        exists: false,
        files: []
      }
    })
    await expect(retried).resolves.toMatchObject({ exists: false })
    await client.close()
  })
})

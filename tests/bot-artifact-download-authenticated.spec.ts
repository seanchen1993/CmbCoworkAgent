import { fork } from "node:child_process"
import { once } from "node:events"
import { randomUUID, createHash } from "node:crypto"
import { mkdtemp, realpath, rm, stat, readFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import assert from "node:assert/strict"
import { test } from "node:test"
import { BotTransportClient, type BotHostDescriptor } from "../src/main/bots/transport-client"
import { DesktopArtifactDownloadSource } from "../src/main/bots/desktop-artifact-download-provider"
import { DesktopArtifactDownloads } from "../src/main/bots/desktop-artifact-downloads"
import { BotDomainError, type BotArtifact } from "../src/shared/bot-types"
import { BOT_FILE_CHUNK_BYTES } from "../src/shared/bot-files"
import type { BotArtifactDownloadSource } from "../src/shared/bot-artifact-downloads"

interface Seed {
  artifacts: BotArtifact[]
  dataEpoch: string
}
interface Metrics {
  sockets: number
  heldRequests: number
  rss: number
  peakRSS: number
  resources: string[]
}
async function fixture(size = BOT_FILE_CHUNK_BYTES * 2 + 3) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-download-auth-")))
  const compiled = process.env.CMB_BOT_DOWNLOAD_HOST_FIXTURE
  const child = fork(compiled ?? resolve("tests/fixtures/bot-artifact-download-host.ts"), [root], {
    execArgv: compiled ? [] : ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  })
  let stderr = ""
  child.stderr?.on("data", (bytes: Buffer) => {
    if (stderr.length < 8192) stderr += bytes.toString().slice(0, 8192 - stderr.length)
  })
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  let readyResolve!: (value: BotHostDescriptor) => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<BotHostDescriptor>((yes, no) => {
    readyResolve = yes
    readyReject = no
  })
  const readyTimer = setTimeout(
    () => readyReject(new Error(`Host fixture startup timeout: ${stderr}`)),
    15_000
  )
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return
    if ("type" in raw && raw.type === "ready" && "descriptor" in raw) {
      clearTimeout(readyTimer)
      readyResolve(raw.descriptor as BotHostDescriptor)
      return
    }
    if (!("id" in raw) || typeof raw.id !== "string") return
    const request = pending.get(raw.id)
    if (!request) return
    pending.delete(raw.id)
    clearTimeout(request.timer)
    if ("ok" in raw && raw.ok === true && "value" in raw) request.resolve(raw.value)
    else request.reject(new Error("error" in raw ? String(raw.error) : "Fixture command failed"))
  })
  child.once("exit", () => {
    clearTimeout(readyTimer)
    const error = new Error(`Host fixture exited: ${stderr}`)
    readyReject(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  })
  const clients: BotTransportClient[] = []
  const close = async () => {
    await Promise.all(clients.map((client) => client.closeAndWait()))
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit")
      child.disconnect()
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000)
      try {
        await exit
        // A source-mode tsx loader can hand stderr to its compiler child.
        // Close the parent-owned pipe explicitly after the fixture has exited.
        if (child.stderr && !child.stderr.closed) {
          const closed = once(child.stderr, "close")
          child.stderr.destroy()
          await closed
        }
      } finally {
        clearTimeout(deadline)
      }
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    const descriptor = await ready
    const command = <T>(op: string, fields: Record<string, unknown> = {}): Promise<T> => {
      const id = randomUUID()
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Fixture ${op} timeout`))
        }, 15_000)
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
        child.send({ id, op, ...fields }, (error) => {
          if (error) {
            clearTimeout(timer)
            pending.delete(id)
            reject(error)
          }
        })
      })
    }
    const seed = await command<Seed>("seed", { size })
    assert.equal(seed.artifacts.length, 2)
    const source = new DesktopArtifactDownloadSource(
      async (signal) => {
        signal.throwIfAborted()
        const client = new BotTransportClient(descriptor)
        clients.push(client)
        return client
      },
      () => undefined
    )
    const sources: BotArtifactDownloadSource[] = seed.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      conversationId: artifact.conversationId,
      size: artifact.size,
      sha256: artifact.sha256,
      dataEpoch: seed.dataEpoch
    }))
    const control = new BotTransportClient(descriptor)
    clients.push(control)
    return { root, child, source, sources, artifacts: seed.artifacts, command, control, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function waitFor(check: () => Promise<boolean>, deadline = 5000) {
  const end = performance.now() + deadline
  do {
    if (await check()) return
    await delay(10)
  } while (performance.now() < end)
  throw new Error("Timed out waiting for the actual native resource boundary")
}
async function fileHash(path: string) {
  const hash = createHash("sha256")
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest("hex")
}
const changed = (error: unknown) =>
  error instanceof BotDomainError && error.code === "download_source_changed"

test("actual authenticated Host metadata/content read uses one isolated socket and release drains it", async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  try {
    const description = await f.source.describe(f.sources[0]!, signal)
    assert.equal(description.artifact.sha256, f.sources[0]!.sha256)
    const value = await f.source.read(f.sources[0]!, 0, signal)
    assert.equal(Buffer.from(value.chunk.base64, "base64").length, BOT_FILE_CHUNK_BYTES)
    assert.equal((await f.command<Metrics>("metrics")).sockets, 1)
    await f.source.release(signal)
    await f.source.release(signal)
    await waitFor(async () => (await f.command<Metrics>("metrics")).sockets === 0)
  } finally {
    await f.source.release(signal)
    await f.close()
  }
})

test("actual Host source deletion produces a durable failed download without opening another chooser or publishing", async () => {
  const f = await fixture()
  let choices = 0
  const manager = new DesktopArtifactDownloads(join(f.root, "ledger", "downloads.sqlite"), {
    source: f.source,
    choose: async (name) => {
      choices++
      const source = f.sources[0]!
      await f.control.call("deleteFile", {
        nonce: randomUUID(),
        conversationId: source.conversationId,
        id: source.artifactId,
        sha256: source.sha256
      })
      return join(f.root, name)
    },
    reveal: async () => undefined,
    assertOwnership: () => undefined,
    withPublication: async (_source, _signal, operation) => operation()
  })
  try {
    const nonce = randomUUID()
    const job = await manager.start({ nonce, source: f.sources[0]! })
    assert.equal(job.state, "failed")
    assert.equal(job.diagnostic?.code, "download_source_changed")
    assert.equal((await manager.start({ nonce, source: f.sources[0]! })).state, "failed")
    assert.equal(choices, 1)
    await assert.rejects(readFile(join(f.root, "a.mp4")), { code: "ENOENT" })
    await manager.close()
    const reopened = new DesktopArtifactDownloads(join(f.root, "ledger", "downloads.sqlite"), {
      source: f.source,
      choose: async () => {
        throw new Error("Replay must not choose")
      },
      reveal: async () => undefined,
      assertOwnership: () => undefined,
      withPublication: async (_source, _signal, operation) => operation()
    })
    try {
      assert.equal((await reopened.page({})).items[0]?.diagnostic?.code, "download_source_changed")
    } finally {
      await reopened.close()
    }
  } finally {
    await manager.close()
    await f.close()
  }
})

test("actual authenticated response whose epoch changes during fileChunk is rejected after the read", async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const second = new AbortController().signal
  try {
    await f.source.describe(f.sources[0]!, signal)
    await f.command("flip-after-chunk")
    await assert.rejects(f.source.read(f.sources[0]!, 0, signal), changed)
    await assert.rejects(f.source.describe(f.sources[0]!, second), changed)
  } finally {
    await f.source.release(signal)
    await f.source.release(second)
    await f.close()
  }
})

test("actual held Host fileChunk abort releases its private socket without cancelling the shared UI connection", async () => {
  const f = await fixture()
  const controller = new AbortController()
  try {
    await f.control.call("status")
    await f.source.describe(f.sources[0]!, controller.signal)
    await f.command("hold")
    const pending = f.source.read(f.sources[0]!, 0, controller.signal)
    const failed = assert.rejects(pending)
    await waitFor(async () => (await f.command<Metrics>("metrics")).heldRequests === 1)
    controller.abort(new Error("Download cancelled"))
    await f.source.release(controller.signal)
    await failed
    await waitFor(async () => (await f.command<Metrics>("metrics")).sockets === 1)
    assert.equal((await f.control.call("status")).hostId.length > 0, true)
    await f.command("release")
  } finally {
    await f.source.release(controller.signal)
    await f.close()
  }
})

test(
  "2 x 200 MiB actual authenticated native Main downloads have bounded memory, event-loop delay and released handles",
  { skip: process.env.CMB_BOT_DOWNLOAD_PERFORMANCE !== "1", timeout: 90_000 },
  async () => {
    const size = 200 * 1024 ** 2
    const f = await fixture(size)
    const manager = new DesktopArtifactDownloads(join(f.root, "ledger", "downloads.sqlite"), {
      source: f.source,
      choose: async (name) => join(f.root, name),
      reveal: async () => undefined,
      assertOwnership: () => undefined,
      withPublication: async (_source, _signal, operation) => operation()
    })
    await manager.page({})
    const baselineMemory = process.memoryUsage()
    const baselineRSS = baselineMemory.rss
    const baselineResources = process.getActiveResourcesInfo()
    const cpu = process.cpuUsage()
    let peakRSS = baselineRSS,
      last = performance.now(),
      maxLag = 0
    const lags: number[] = []
    const timer = setInterval(() => {
      const now = performance.now(),
        lag = Math.max(0, now - last - 5)
      last = now
      lags.push(lag)
      maxLag = Math.max(maxLag, lag)
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss)
    }, 5)
    const started = performance.now()
    try {
      await Promise.all(f.sources.map((source) => manager.start({ nonce: randomUUID(), source })))
      await waitFor(async () => {
        const page = await manager.page({})
        assert.ok(!page.items.some((job) => job.state === "failed"), JSON.stringify(page))
        return (
          page.items.length === 2 &&
          page.items.every((job) => job.state === "completed" && job.bytes === size)
        )
      }, 60_000)
      await manager.close()
      clearInterval(timer)
      await waitFor(async () => (await f.command<Metrics>("metrics")).sockets === 0)
      lags.sort((a, b) => a - b)
      const used = process.cpuUsage(cpu)
      const metrics = {
        scope: `actual production Main download backend, authenticated child Host, native ${process.platform} ${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`}`,
        files: 2,
        size,
        elapsedMs: performance.now() - started,
        baselineRSS,
        peakRSS,
        rssGrowth: peakRSS - baselineRSS,
        baselineMemory,
        finalMemory: process.memoryUsage(),
        maxTimerLagMs: maxLag,
        p95TimerLagMs: lags[Math.floor(lags.length * 0.95)] ?? 0,
        samples: lags.length,
        cpuUserMs: used.user / 1000,
        cpuSystemMs: used.system / 1000,
        baselineResources,
        finalResources: process.getActiveResourcesInfo(),
        host: await f.command<Metrics>("metrics")
      }
      console.log(`DOWNLOAD_PERFORMANCE ${JSON.stringify(metrics)}`)
      assert.ok(
        metrics.rssGrowth < 128 * 1024 ** 2,
        `Main RSS grew ${metrics.rssGrowth}; no whole-file buffering allowed`
      )
      assert.ok(metrics.maxTimerLagMs < 100, `Main timer delay ${metrics.maxTimerLagMs} ms`)
      const nativeResources = (resources: string[]) =>
        resources.filter((name) => /(?:Pipe|TCP|File|Process)Wrap|FileHandle/.test(name)).sort()
      assert.deepEqual(nativeResources(metrics.finalResources), nativeResources(baselineResources))
      for (const artifact of f.artifacts) {
        assert.equal((await stat(join(f.root, artifact.name))).size, size)
        assert.equal(await fileHash(join(f.root, artifact.name)), artifact.sha256)
      }
    } finally {
      clearInterval(timer)
      await manager.close()
      await f.close()
    }
  }
)

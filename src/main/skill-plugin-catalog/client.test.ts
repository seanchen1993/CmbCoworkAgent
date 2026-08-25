import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Worker as WorkerType } from "node:worker_threads"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SkillPluginCatalogPage } from "../types"
import {
  SkillPluginCatalogClient,
  SkillPluginCatalogRequestCancelledError,
  SkillPluginCatalogWorkerUnavailableError
} from "./client"
import {
  SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_SKILLS,
  type SkillPluginCatalogSourceConfig
} from "./protocol"

const temporaryDirectories: string[] = []
const clients: SkillPluginCatalogClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-catalog-build-"))
  workerBundlePath = join(workerBuildDirectory, "skill-plugin-catalog-worker.cjs")
  await build({
    entryPoints: [
      fileURLToPath(new URL("./skill-plugin-catalog-worker.ts", import.meta.url))
    ],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
  rmSync(workerBuildDirectory, { recursive: true, force: true })
}, 60_000)

function makeSource(root: string): SkillPluginCatalogSourceConfig {
  return {
    builtinSkillsDir: join(root, "builtin-skills"),
    customSkillsDir: join(root, "custom-skills"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled-skills.json")
  }
}

function trackClient(client: SkillPluginCatalogClient): SkillPluginCatalogClient {
  clients.push(client)
  return client
}

async function waitForRequests(worker: FakeCatalogWorker, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && worker.requests.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(worker.requests).toHaveLength(count)
}

describe("SkillPluginCatalogClient", () => {
  it("shares an identical in-flight key across scopes and keeps latest-wins per scope", async () => {
    const worker = new FakeCatalogWorker()
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => worker as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )

    const sharedA = client.readPage({ kind: "skills", revision: "1" }, "renderer:a")
    const sharedB = client.readPage({ kind: "skills", revision: "1" }, "renderer:b")
    await waitForRequests(worker, 1)
    const sharedRequest = worker.requests[0]
    worker.emit("message", successResponse(sharedRequest.requestId, emptyPage("skills")))
    await expect(Promise.all([sharedA, sharedB])).resolves.toHaveLength(2)
    expect(worker.requests).toHaveLength(1)

    const superseded = client
      .readPage({ kind: "plugins", revision: "1" }, "renderer:latest")
      .catch((error) => error)
    await waitForRequests(worker, 2)
    const supersededRequest = worker.requests[1]
    const latest = client.readPage(
      { kind: "plugins", revision: "2" },
      "renderer:latest"
    )
    await waitForRequests(worker, 3)
    await expect(superseded).resolves.toBeInstanceOf(
      SkillPluginCatalogRequestCancelledError
    )
    expect(Atomics.load(new Int32Array(supersededRequest.cancelBuffer), 0)).toBe(1)
    const latestRequest = worker.requests[2]
    worker.emit("message", successResponse(latestRequest.requestId, emptyPage("plugins")))
    await expect(latest).resolves.toMatchObject({ kind: "plugins" })

    const unmounted = client
      .readPage({ kind: "disabled", revision: "3" }, "renderer:unmount")
      .catch((error) => error)
    await waitForRequests(worker, 4)
    const unmountedRequest = worker.requests[3]
    client.cancelScope("renderer:unmount")
    await expect(unmounted).resolves.toBeInstanceOf(
      SkillPluginCatalogRequestCancelledError
    )
    expect(Atomics.load(new Int32Array(unmountedRequest.cancelBuffer), 0)).toBe(1)
  })

  it("cancels preview A when preview B supersedes the same sender scope", async () => {
    const worker = new FakeCatalogWorker()
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => worker as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )
    const first = client
      .resolvePreview(
        { id: "alpha", name: "Alpha", source: "user" },
        "skill-preview:wc:7"
      )
      .catch((error) => error)
    await waitForRequests(worker, 1)
    const firstRequest = worker.requests[0]

    const latest = client.resolvePreview(
      { id: "beta", name: "Beta", source: "user" },
      "skill-preview:wc:7"
    )
    await waitForRequests(worker, 2)
    expect(Atomics.load(new Int32Array(firstRequest.cancelBuffer), 0)).toBe(1)
    await expect(first).resolves.toBeInstanceOf(SkillPluginCatalogRequestCancelledError)

    worker.emit("message", {
      type: "resolve-preview-result",
      requestId: worker.requests[1].requestId,
      ok: true,
      resolution: { filePath: "C:\\catalog-fixture\\custom-skills\\beta\\SKILL.md" }
    })
    await expect(latest).resolves.toEqual({
      filePath: "C:\\catalog-fixture\\custom-skills\\beta\\SKILL.md"
    })
  })

  it("creates a fresh isolated Worker after the previous Worker fails", async () => {
    const workers = [new FakeCatalogWorker(), new FakeCatalogWorker()]
    let factoryCalls = 0
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => workers[factoryCalls++] as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )

    const failed = client.readPage({ kind: "skills", revision: "1" }, "renderer:retry")
    await waitForRequests(workers[0], 1)
    workers[0].emit("error", new Error("worker crashed"))
    await expect(failed).rejects.toBeInstanceOf(SkillPluginCatalogWorkerUnavailableError)

    const retried = client.readPage({ kind: "skills", revision: "2" }, "renderer:retry")
    await waitForRequests(workers[1], 1)
    workers[1].emit(
      "message",
      successResponse(workers[1].requests[0].requestId, emptyPage("skills"))
    )

    await expect(retried).resolves.toMatchObject({ kind: "skills" })
    expect(factoryCalls).toBe(2)
  })

  it("parses 20k skills plus a 2 MiB file off-main while pages stay bounded", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-catalog-large-"))
    temporaryDirectories.push(root)
    const source = makeSource(root)
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.pluginsStorePath, "[]")
    writeFileSync(source.disabledSkillsPath, "[]")
    writeFileSync(
      join(source.builtinSkillsDir, "SKILL.md"),
      `---\nname: oversized-root\ndescription: bounded\n---\n${"x".repeat(2 * 1024 * 1024)}`
    )
    for (let index = 0; index < SKILL_PLUGIN_CATALOG_MAX_SKILLS - 1; index += 1) {
      const directory = join(
        source.builtinSkillsDir,
        `skill-${String(index).padStart(5, "0")}`
      )
      mkdirSync(directory)
      writeFileSync(join(directory, "SKILL.md"), `---\nname: skill-${index}\n---\n`)
    }

    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => new Worker(workerBundlePath, { name: "skill-plugin-catalog-test" }),
        () => source
      )
    )
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const page = await client.readPage(
      { kind: "skills", limit: 128, revision: "large" },
      "renderer:large"
    )
    clearInterval(ticker)

    expect(ticks).toBeGreaterThan(10)
    expect(page.skills).toHaveLength(128)
    expect(page.stats.discoveredSkills).toBe(SKILL_PLUGIN_CATALOG_MAX_SKILLS)
    expect(page.stats.readBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(page.truncated).toBe(true)
    expect(page.truncatedReasons).toEqual(
      expect.arrayContaining(["skill-md-bytes", "skill-count"])
    )
    expect(Buffer.byteLength(JSON.stringify(page), "utf-8")).toBeLessThanOrEqual(
      SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES
    )

    await expect(
      client.resolvePreview(
        { id: "skill-19998", name: "skill-19998", source: "project" },
        "renderer:large-preview"
      )
    ).resolves.toEqual({
      filePath: join(source.builtinSkillsDir, "skill-19998", "SKILL.md")
    })
    await expect(
      client.resolvePreview(
        { id: "oversized-root", name: "oversized-root", source: "project" },
        "renderer:oversized-preview"
      )
    ).resolves.toEqual({ filePath: join(source.builtinSkillsDir, "SKILL.md") })
  }, 180_000)
})

interface FakeRequest {
  requestId: number
  cancelBuffer: SharedArrayBuffer
}

class FakeCatalogWorker extends EventEmitter {
  readonly requests: FakeRequest[] = []

  postMessage(message: FakeRequest): void {
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

function successResponse(
  requestId: number,
  page: SkillPluginCatalogPage
): Record<string, unknown> {
  return { type: "read-page-result", requestId, ok: true, page }
}

function emptyPage(kind: SkillPluginCatalogPage["kind"]): SkillPluginCatalogPage {
  return {
    kind,
    skills: [],
    plugins: [],
    disabledSkillIds: [],
    cursor: null,
    total: 0,
    enabledSkillCount: 0,
    truncated: false,
    truncatedReasons: [],
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 }
  }
}

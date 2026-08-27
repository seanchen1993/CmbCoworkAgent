import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Worker as WorkerType } from "node:worker_threads"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SkillPluginCatalogPage } from "../types"
import {
  SKILL_PLUGIN_CATALOG_MAX_ACTIVE_SCOPES,
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
const require = createRequire(import.meta.url)
const electronPath = require("electron") as string
const { createPackage } = require("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>
}
const execFileAsync = promisify(execFile)
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
    disabledSkillsPath: join(root, "disabled-skills.json"),
    globalRevision: 0
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
  it("routes plugin and skill catalog requests through isolated Worker lanes", () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8")

    expect(source).toContain("defaultSkillClient")
    expect(source).toContain("defaultPluginClient")
    expect(source).toContain('if (kind === "plugins")')
    expect(source).toContain('createBundledWorker("plugin-catalog")')
    expect(source).toContain('createBundledWorker("skill-catalog")')
  })

  it("shares an identical in-flight key across scopes and keeps latest-wins per scope", async () => {
    const worker = new FakeCatalogWorker()
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => worker as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )

    const sharedA = client.readPage({ kind: "skills", revision: "1" }, "renderer:a")
    const sharedB = client.readPage({ kind: "skills", revision: "other-window" }, "renderer:b")
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

  it("bounds active scopes and cleans state after a synchronous dispatch failure", async () => {
    const worker = new FakeCatalogWorker()
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => worker as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )
    const active = Array.from(
      { length: SKILL_PLUGIN_CATALOG_MAX_ACTIVE_SCOPES },
      (_, index) =>
        client.readPage({ kind: "skills" }, `renderer:${index}`).catch((error) => error)
    )
    await waitForRequests(worker, 1)
    await expect(
      client.readPage({ kind: "skills" }, "renderer:overflow")
    ).rejects.toThrow(/capacity exceeded/)
    await client.close()
    await Promise.all(active)

    const retryWorker = new FakeCatalogWorker()
    const retryClient = trackClient(
      new SkillPluginCatalogClient(
        async () => retryWorker as unknown as WorkerType,
        () => makeSource("C:\\catalog-fixture")
      )
    )
    retryWorker.postError = new Error("dispatch failed")
    await expect(
      retryClient.readPage({ kind: "skills" }, "renderer:same")
    ).rejects.toThrow("dispatch failed")
    retryWorker.postError = null
    const retry = retryClient.readPage({ kind: "skills" }, "renderer:same")
    await waitForRequests(retryWorker, 1)
    retryWorker.emit(
      "message",
      successResponse(retryWorker.requests[0].requestId, emptyPage("skills"))
    )
    await expect(retry).resolves.toMatchObject({ kind: "skills" })
  })

  it("invalidates a read still resolving its source when closed", async () => {
    let resolveSource: ((source: SkillPluginCatalogSourceConfig) => void) | undefined
    const source = new Promise<SkillPluginCatalogSourceConfig>((resolve) => {
      resolveSource = resolve
    })
    const factory = vi.fn(async () => new FakeCatalogWorker() as unknown as WorkerType)
    const client = trackClient(new SkillPluginCatalogClient(factory, () => source))
    const read = client.readPage({ kind: "skills" }, "renderer:closing")

    await client.close()
    resolveSource?.(makeSource("C:\\catalog-fixture"))

    await expect(read).rejects.toBeInstanceOf(SkillPluginCatalogRequestCancelledError)
    expect(factory).not.toHaveBeenCalled()
  })

  it("reads bundled skills from an ASAR directory in a real Electron Worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-catalog-asar-"))
    temporaryDirectories.push(root)
    const packageRoot = join(root, "package")
    const asarPath = join(root, "app.asar")
    const builtinSkillsDir = join(packageRoot, "out", "skills")
    const customSkillsDir = join(root, "custom-skills")
    const pluginsStorePath = join(root, "plugins.json")
    const disabledSkillsPath = join(root, "disabled-skills.json")
    mkdirSync(join(builtinSkillsDir, "bundled-example"), { recursive: true })
    mkdirSync(customSkillsDir, { recursive: true })
    writeFileSync(
      join(builtinSkillsDir, "bundled-example", "SKILL.md"),
      "---\nname: bundled-example\ndescription: ASAR fixture\n---\n"
    )
    writeFileSync(pluginsStorePath, "[]")
    writeFileSync(disabledSkillsPath, "[]")
    await createPackage(packageRoot, asarPath)

    const runnerPath = join(root, "electron-worker-runner.cjs")
    writeFileSync(
      runnerPath,
      `const { Worker } = require("node:worker_threads")
const [workerPath, builtinSkillsDir, customSkillsDir, pluginsStorePath, disabledSkillsPath] = process.argv.slice(2)
const worker = new Worker(workerPath, { name: "skill-plugin-catalog-asar-test" })
const timeout = setTimeout(() => {
  console.error("catalog worker timed out")
  void worker.terminate()
  process.exit(1)
}, 20_000)
worker.once("error", (error) => {
  clearTimeout(timeout)
  console.error(error)
  process.exit(1)
})
worker.once("message", (message) => {
  clearTimeout(timeout)
  console.log(JSON.stringify(message))
  void worker.terminate().finally(() => process.exit(message.ok ? 0 : 1))
})
worker.postMessage({
  type: "read-page",
  requestId: 1,
  input: { kind: "skills", limit: 128, revision: "asar-regression" },
  source: { builtinSkillsDir, customSkillsDir, pluginsStorePath, disabledSkillsPath, globalRevision: 0 },
  cancelBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
})
`
    )

    const { stdout } = await execFileAsync(
      electronPath,
      [
        runnerPath,
        workerBundlePath,
        join(asarPath, "out", "skills"),
        customSkillsDir,
        pluginsStorePath,
        disabledSkillsPath
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 30_000,
        windowsHide: true
      }
    )
    const response = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "null") as {
      ok: boolean
      page?: SkillPluginCatalogPage
    }

    expect(response.ok).toBe(true)
    expect(response.page?.skills).toEqual([
      expect.objectContaining({
        id: "bundled-example",
        name: "bundled-example",
        source: "project"
      })
    ])
    expect(response.page?.total).toBe(1)
    expect(response.page?.truncated).toBe(false)
  }, 60_000)

  it("invalidates shared detail snapshots only when the main epoch advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-catalog-epoch-"))
    temporaryDirectories.push(root)
    const source = makeSource(root)
    const skillDirectory = join(source.builtinSkillsDir, "epoch-skill")
    mkdirSync(skillDirectory, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.pluginsStorePath, "[]")
    writeFileSync(source.disabledSkillsPath, "[]")
    const skillPath = join(skillDirectory, "SKILL.md")
    writeFileSync(skillPath, "---\nname: epoch-skill\ndescription: before\n---\n")
    const client = trackClient(
      new SkillPluginCatalogClient(
        async () => new Worker(workerBundlePath, { name: "skill-plugin-catalog-epoch" }),
        () => source
      )
    )

    const first = await client.readPage(
      { kind: "skills", revision: "renderer-a" },
      "renderer:a"
    )
    writeFileSync(skillPath, "---\nname: epoch-skill\ndescription: after\n---\n")
    const crossWindow = await client.readPage(
      { kind: "skills", revision: "renderer-b" },
      "renderer:b"
    )
    expect(crossWindow.skills[0]?.description).toBe("before")

    source.globalRevision += 1
    const invalidated = await client.readPage(
      { kind: "skills", revision: "renderer-b-still-local" },
      "renderer:b"
    )
    expect(first.skills[0]?.description).toBe("before")
    expect(invalidated.skills[0]?.description).toBe("after")
  }, 30_000)

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

    writeFileSync(
      join(source.builtinSkillsDir, "SKILL.md"),
      "---\nname: oversized-root\ndescription: changed-after-snapshot\n---\n"
    )
    const reusedByOtherWindow = await client.readPage(
      { kind: "skills", limit: 128, revision: "different-renderer-nonce" },
      "renderer:large-second-window"
    )
    expect(reusedByOtherWindow.skills[0]).toMatchObject({
      name: "oversized-root",
      description: "bounded"
    })
    expect(reusedByOtherWindow.stats).toEqual(page.stats)

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
  postError: Error | null = null

  postMessage(message: FakeRequest): void {
    if (this.postError) throw this.postError
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

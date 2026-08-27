import { EventEmitter } from "node:events"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Worker as WorkerType } from "node:worker_threads"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { HookCatalogPageInput } from "../types"
import {
  HOOK_CATALOG_MAX_ACTIVE_SCOPES,
  HookCatalogClient,
  HookCatalogRequestCancelledError
} from "./client"
import {
  HOOK_CATALOG_MAX_RESPONSE_BYTES,
  HOOK_CATALOG_MAX_SNAPSHOT_BYTES,
  type HookCatalogSourceConfig
} from "./protocol"

const temporaryDirectories: string[] = []
const clients: HookCatalogClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""
const GENERATED_HOOK_MTIME = new Date("2025-02-03T04:05:06.000Z")

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-build-"))
  workerBundlePath = join(workerBuildDirectory, "hook-catalog-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./hook-catalog-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  rmSync(workerBuildDirectory, { recursive: true, force: true })
}, 30_000)

function makeSource(root: string, skillsDir = join(root, "skills")): HookCatalogSourceConfig {
  return {
    openworkDir: root,
    globalHooksPath: join(root, "hooks.json"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled-skills.json"),
    skillSourceDirs: [skillsDir],
    globalRevision: 0,
    workspaceRevision: 0
  }
}

function makeClient(source: HookCatalogSourceConfig): HookCatalogClient {
  const client = new HookCatalogClient(
    async () => new Worker(workerBundlePath, { name: "hook-catalog-test" }),
    (input) => ({
      ...source,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {})
    })
  )
  clients.push(client)
  return client
}

function makeFixture(): { root: string; source: HookCatalogSourceConfig; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-fixture-"))
  temporaryDirectories.push(root)
  const skillsDir = join(root, "skills")
  const skillDir = join(skillsDir, "review")
  const pluginDir = join(root, "plugin-one")
  const pluginSkillDir = join(pluginDir, "skills", "plugin-skill")
  const workspace = join(root, "workspace")
  mkdirSync(join(skillDir, "hooks"), { recursive: true })
  mkdirSync(join(pluginDir, "hooks"), { recursive: true })
  mkdirSync(pluginSkillDir, { recursive: true })
  mkdirSync(join(workspace, ".cmbdevclaw", "hooks"), { recursive: true })
  writeFileSync(
    join(root, "hooks.json"),
    JSON.stringify([
      {
        id: "global-one",
        event: "PreToolUse",
        type: "command",
        command: "echo global",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    ])
  )
  writeFileSync(join(root, "disabled-skills.json"), "[]")
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: review",
      "hooks:",
      "  PreSkillUse:",
      "    - hooks:",
      "        - type: command",
      "          command: echo frontmatter",
      "---",
      "body"
    ].join("\n")
  )
  writeFileSync(
    join(skillDir, "hooks", "hooks.json"),
    JSON.stringify([
      { id: "file", event: "PostSkillUse", type: "command", command: "echo file" }
    ])
  )
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "plugin-one", skills: "skills" })
  )
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify([
      { id: "plugin-hook", event: "Stop", type: "command", command: "echo plugin" }
    ])
  )
  writeFileSync(join(pluginSkillDir, "SKILL.md"), "---\nname: plugin-skill\n---\nbody")
  writeFileSync(
    join(pluginSkillDir, "hooks.json"),
    JSON.stringify([
      { id: "owned", event: "PreSkillUse", type: "command", command: "echo owned" }
    ])
  )
  writeFileSync(
    join(root, "plugins.json"),
    JSON.stringify([
      {
        id: "plugin-one",
        name: "Plugin One",
        version: "1",
        description: "",
        author: "",
        path: pluginDir,
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        hookCount: 1,
        hookPath: "hooks/hooks.json",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    ])
  )
  writeFileSync(
    join(workspace, ".cmbdevclaw", "hooks", "workspace.json"),
    JSON.stringify({ event: "Stop", type: "command", command: "echo workspace" })
  )
  for (const filePath of [
    join(skillDir, "SKILL.md"),
    join(skillDir, "hooks", "hooks.json"),
    join(pluginDir, "hooks", "hooks.json"),
    join(pluginSkillDir, "hooks.json"),
    join(workspace, ".cmbdevclaw", "hooks", "workspace.json")
  ]) {
    utimesSync(filePath, GENERATED_HOOK_MTIME, GENERATED_HOOK_MTIME)
  }
  return { root, source: makeSource(root, skillsDir), workspace }
}

async function readAll(
  client: HookCatalogClient,
  input: HookCatalogPageInput,
  scope: string
): Promise<{
  pages: Awaited<ReturnType<HookCatalogClient["readPage"]>>[]
  ids: string[]
}> {
  const pages: Awaited<ReturnType<HookCatalogClient["readPage"]>>[] = []
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.readPage({ ...input, cursor }, scope)
    pages.push(page)
    ids.push(
      ...page.globalHooks.map((hook) => hook.id),
      ...page.workspaceHooks.map((hook) => hook.id),
      ...page.pluginHooks.map((hook) => hook.id),
      ...page.skillHooks.map((hook) => hook.id)
    )
    cursor = page.nextCursor
  } while (cursor)
  return { pages, ids }
}

describe("HookCatalogClient", () => {
  it("keeps catalog source discovery off the Electron main-thread sync-fs path", () => {
    const hookClient = readFileSync(new URL("./client.ts", import.meta.url), "utf8")
    const skillClient = readFileSync(
      new URL("../skill-plugin-catalog/client.ts", import.meta.url),
      "utf8"
    )
    const sourcePaths = readFileSync(
      new URL("../catalog-source-paths.ts", import.meta.url),
      "utf8"
    )
    for (const source of [hookClient, skillClient, sourcePaths]) {
      expect(source).not.toMatch(/\b(?:existsSync|mkdirSync|statSync|readdirSync)\b/)
    }
    expect(hookClient).not.toContain("getOpenworkDir")
    expect(hookClient).not.toContain("getSkillsSources")
    expect(skillClient).not.toContain("getSkillsDir")
    expect(skillClient).not.toContain("getCustomSkillsDir")
    expect(hookClient).toContain("maxOldGenerationSizeMb: 192")
    expect(sourcePaths).toContain("(await stat(candidate)).isDirectory()")
  })

  it("releases an old snapshot before a cache-miss scan allocates the replacement", () => {
    const source = readFileSync(new URL("./reader.ts", import.meta.url), "utf8")
    const build = source.slice(
      source.indexOf("function buildGlobalSnapshot("),
      source.indexOf("function workspaceSnapshotSourceKey(")
    )

    expect(build.indexOf("reserveGlobalSnapshotSlot()"))
      .toBeLessThan(build.indexOf("const startedAt"))
    expect(build.match(/reserveGlobalSnapshotSlot\(\)/g)).toHaveLength(1)
    expect(build.indexOf("deleteGlobalSnapshot(previousId)"))
      .toBeLessThan(build.indexOf("reserveGlobalSnapshotSlot()"))
  })

  it("keeps display parsing semantically aligned across all four hook sources", async () => {
    const fixture = makeFixture()
    const client = makeClient(fixture.source)
    const { pages, ids } = await readAll(
      client,
      { requestScope: "semantic", workspacePath: fixture.workspace, limit: 2 },
      "renderer:semantic"
    )
    expect(pages.length).toBeGreaterThan(2)
    expect(ids).toEqual([
      "global-one",
      "ws:workspace",
      "plugin:plugin-one/plugin-hook",
      "skill:review/SKILL.md/PreSkillUse:0:0",
      "skill:review/hooks/hooks.json:file",
      "skill:plugin-skill/owned"
    ])
    expect(pages[0]).toMatchObject({
      totalEntries: 6,
      enabledEntries: 6,
      relatedSummary: {
        skillEntries: 2,
        enabledSkillEntries: 2,
        pluginEntries: 1
      }
    })
    const hooks = pages.flatMap((page) => [
      ...page.globalHooks,
      ...page.workspaceHooks,
      ...page.pluginHooks,
      ...page.skillHooks
    ])
    expect(hooks.find((hook) => hook.id === "skill:review/SKILL.md/PreSkillUse:0:0")).toMatchObject({
      matcher: "review",
      command: "echo frontmatter",
      enabled: true
    })
    const pluginHookStats = statSync(join(fixture.root, "plugin-one", "hooks", "hooks.json"))
    const expectedPluginHookCreatedAt =
      (pluginHookStats.birthtime.getTime() > 0
        ? pluginHookStats.birthtime
        : pluginHookStats.ctime
      ).toISOString()
    expect(hooks.find((hook) => hook.id === "plugin:plugin-one/plugin-hook")).toMatchObject({
      pluginId: "plugin-one",
      pluginName: "Plugin One",
      hookSourceType: "plugin",
      updatedAt: GENERATED_HOOK_MTIME.toISOString(),
      createdAt: expectedPluginHookCreatedAt
    })
    for (const id of [
      "ws:workspace",
      "skill:review/SKILL.md/PreSkillUse:0:0",
      "skill:review/hooks/hooks.json:file",
      "skill:plugin-skill/owned"
    ]) {
      expect(hooks.find((hook) => hook.id === id)?.updatedAt).toBe(
        GENERATED_HOOK_MTIME.toISOString()
      )
    }
    for (const page of pages) {
      expect(page.stats.responseBytes).toBeLessThanOrEqual(HOOK_CATALOG_MAX_RESPONSE_BYTES)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        HOOK_CATALOG_MAX_RESPONSE_BYTES
      )
    }
  }, 30_000)

  it("reuses a main-revision snapshot for header summary and detail reads", async () => {
    const fixture = makeFixture()
    const client = makeClient(fixture.source)
    const summary = await client.readPage(
      {
        requestScope: "summary",
        workspacePath: fixture.workspace,
        revision: "revision-1",
        limit: 1
      },
      "renderer:summary"
    )
    expect(summary).toMatchObject({ totalEntries: 6, enabledEntries: 6 })

    writeFileSync(fixture.source.globalHooksPath, "[]")
    const cachedDetail = await client.readPage(
      {
        requestScope: "detail",
        workspacePath: fixture.workspace,
        revision: "revision-1",
        limit: 1
      },
      "renderer:detail"
    )
    expect(cachedDetail.totalEntries).toBe(6)

    fixture.source.globalRevision += 1
    const refreshed = await client.readPage(
      {
        requestScope: "summary",
        workspacePath: fixture.workspace,
        revision: "revision-2",
        limit: 1
      },
      "renderer:summary"
    )
    expect(refreshed).toMatchObject({ totalEntries: 5, enabledEntries: 5 })
  }, 30_000)

  it("reuses the global skill tree when only the workspace overlay changes", async () => {
    const fixture = makeFixture()
    const client = makeClient(fixture.source)
    const first = await client.readPage(
      { requestScope: "workspace-a", workspacePath: fixture.workspace, limit: 1 },
      "renderer:workspace-a"
    )
    expect(first.stats).toMatchObject({
      globalScanReused: false,
      workspaceScanReused: false
    })

    const secondWorkspace = join(fixture.root, "workspace-b")
    const secondHooksDir = join(secondWorkspace, ".cmbdevclaw", "hooks")
    mkdirSync(secondHooksDir, { recursive: true })
    writeFileSync(
      join(secondHooksDir, "second.json"),
      JSON.stringify({ event: "Stop", type: "command", command: "echo second" })
    )
    const switched = await client.readPage(
      { requestScope: "workspace-b", workspacePath: secondWorkspace, limit: 1 },
      "renderer:workspace-b"
    )
    expect(switched.stats).toMatchObject({
      globalScanReused: true,
      workspaceScanReused: false
    })
    expect(switched.relatedSummary).toEqual(first.relatedSummary)

    writeFileSync(
      join(secondHooksDir, "third.json"),
      JSON.stringify({ event: "Stop", type: "command", command: "echo third" })
    )
    fixture.source.workspaceRevision += 1
    const overlayInvalidated = await client.readPage(
      { requestScope: "workspace-b", workspacePath: secondWorkspace, limit: 20 },
      "renderer:workspace-b"
    )
    expect(overlayInvalidated.stats).toMatchObject({
      globalScanReused: true,
      workspaceScanReused: false
    })
    expect(overlayInvalidated.workspaceHooks).toHaveLength(2)
  }, 30_000)

  it("keeps same-name plugin skill hooks when the standalone skill is disabled", async () => {
    const fixture = makeFixture()
    writeFileSync(fixture.source.disabledSkillsPath, '["review"]')
    writeFileSync(
      join(fixture.root, "plugin-one", "skills", "plugin-skill", "SKILL.md"),
      "---\nname: review\n---\nbody"
    )
    const client = makeClient(fixture.source)
    const { pages } = await readAll(
      client,
      { requestScope: "same-name-plugin", workspacePath: fixture.workspace, limit: 20 },
      "renderer:same-name-plugin"
    )
    const skillHooks = pages.flatMap((page) => page.skillHooks)

    expect(pages[0].relatedSummary).toMatchObject({
      skillEntries: 2,
      enabledSkillEntries: 1,
      pluginEntries: 1
    })
    expect(skillHooks.some((hook) => hook.pluginId === undefined)).toBe(false)
    expect(skillHooks).toEqual([
      expect.objectContaining({
        id: "skill:review/owned",
        pluginId: "plugin-one",
        pluginName: "Plugin One",
        skillName: "review"
      })
    ])
  }, 30_000)

  it("truncates projected hook bytes before the bounded worker can exhaust memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-byte-cap-"))
    temporaryDirectories.push(root)
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir)
    writeFileSync(join(root, "plugins.json"), "[]")
    writeFileSync(join(root, "disabled-skills.json"), "[]")
    writeFileSync(join(root, "hooks.json"), "[]")
    const largeHeaders = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`header-${index}`, "h".repeat(2_048)])
    )
    const largeHook = {
      id: "large",
      event: "Stop",
      type: "command",
      command: "c".repeat(8_192),
      prompt: "p".repeat(8_192),
      headers: largeHeaders,
      onBlock: {
        reason: "r".repeat(2_048),
        systemMessage: "s".repeat(2_048),
        additionalContext: "a".repeat(2_048),
        requiredSkill: "k".repeat(1_024)
      }
    }
    for (let index = 0; index < 140; index += 1) {
      const skillDir = join(skillsDir, `large-${String(index).padStart(3, "0")}`)
      mkdirSync(skillDir)
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: large-${index}\n---\n`)
      writeFileSync(join(skillDir, "hooks.json"), JSON.stringify([largeHook]))
    }
    const client = makeClient(makeSource(root, skillsDir))
    const page = await client.readPage(
      { requestScope: "byte-cap", limit: 32 },
      "renderer:byte-cap"
    )

    expect(page.truncatedReasons).toContain("snapshot-bytes")
    expect(page.truncated).toBe(true)
    expect(page.totalEntries).toBeLessThan(140)
    expect(page.relatedSummary.skillEntries).toBe(140)
    expect(page.stats.readBytes).toBeGreaterThan(HOOK_CATALOG_MAX_SNAPSHOT_BYTES * 0.9)
    expect(page.stats.responseBytes).toBeLessThanOrEqual(HOOK_CATALOG_MAX_RESPONSE_BYTES)
  }, 60_000)

  it("bounds aggregate plugin skill-source probes without materializing every source", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-source-cap-"))
    temporaryDirectories.push(root)
    const skillsDir = join(root, "skills")
    const pluginRoot = join(root, "shared-plugin")
    mkdirSync(skillsDir)
    mkdirSync(pluginRoot)
    writeFileSync(join(root, "hooks.json"), "[]")
    writeFileSync(join(root, "disabled-skills.json"), "[]")
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "source-probe",
        skills: Array.from({ length: 64 }, (_, index) => `missing-${index}`)
      })
    )
    writeFileSync(
      join(root, "plugins.json"),
      JSON.stringify(
        Array.from({ length: 160 }, (_, index) => ({
          id: `plugin-${index}`,
          name: `Plugin ${index}`,
          path: pluginRoot,
          enabled: true
        }))
      )
    )

    const page = await makeClient(makeSource(root, skillsDir)).readPage(
      { requestScope: "source-probe-cap", limit: 1 },
      "renderer:source-probe-cap"
    )

    expect(page.relatedSummary.pluginEntries).toBe(160)
    expect(page.relatedSummary.skillTruncated).toBe(true)
    expect(page.relatedSummary.skillTruncatedReasons).toContain(
      "plugin-skill-source-count"
    )
    expect(page.truncatedReasons).toContain("plugin-skill-source-count")
  }, 30_000)

  it("scans 10k disabled skills and an oversized SKILL.md off-main with bounded pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-large-"))
    temporaryDirectories.push(root)
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir)
    writeFileSync(join(root, "plugins.json"), "[]")
    writeFileSync(
      join(root, "disabled-skills.json"),
      JSON.stringify(
        Array.from(
          { length: 10_000 },
          (_, index) => `skill-${String(index).padStart(5, "0")}`
        )
      )
    )
    writeFileSync(join(root, "hooks.json"), "[]")
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      [
        "---",
        "name: huge-root",
        "hooks:",
        "  Stop:",
        "    - hooks:",
        "        - type: command",
        "          command: echo huge",
        "---",
        "x".repeat(2 * 1024 * 1024)
      ].join("\n")
    )
    for (let index = 0; index < 10_000; index += 1) {
      const directory = join(skillsDir, `skill-${String(index).padStart(5, "0")}`)
      mkdirSync(directory)
      writeFileSync(join(directory, "SKILL.md"), `---\nname: skill-${index}\n---\n`)
    }
    const client = makeClient(makeSource(root, skillsDir))
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const page = await client.readPage(
      { requestScope: "large", limit: 32 },
      "renderer:large"
    )
    clearInterval(ticker)
    expect(ticks).toBeGreaterThan(10)
    expect(page.skillHooks.map((hook) => hook.id)).toContain(
      "skill:huge-root/SKILL.md/Stop:0:0"
    )
    expect(page.stats.discoveredSkills).toBe(10_001)
    // Discovery content is reused for frontmatter-hook parsing. The previous
    // implementation read every SKILL.md twice, so this proxy was ~20k files.
    expect(page.stats.scannedFiles).toBeLessThan(10_100)
    expect(page.relatedSummary).toMatchObject({
      skillEntries: 10_001,
      enabledSkillEntries: 1,
      pluginEntries: 0
    })
    expect(page.truncated).toBe(true)
    expect(page.truncatedReasons).toContain("skill-md-bytes")
    expect(page.stats.responseBytes).toBeLessThanOrEqual(HOOK_CATALOG_MAX_RESPONSE_BYTES)

    const reused = await client.readPage(
      { requestScope: "large-second-window", limit: 1 },
      "renderer-2:large"
    )
    expect(reused.stats.globalScanReused).toBe(true)
    expect(reused.stats.durationMs).toBe(0)
    expect(reused.relatedSummary).toEqual(page.relatedSummary)
  }, 120_000)

  it("cancels A when B supersedes it and cancels an in-flight request on close", async () => {
    const worker = new FakeHookCatalogWorker()
    const source = makeSource("C:\\fixture")
    const client = new HookCatalogClient(
      async () => worker as unknown as WorkerType,
      () => source
    )
    const first = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
    const second = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await expect(first).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    await vi.waitFor(() => expect(worker.requests).toHaveLength(2))
    const secondRequest = worker.requests.at(-1)!
    worker.emit("message", {
      type: "read-page-result",
      requestId: secondRequest.requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(second).resolves.toMatchObject({ totalEntries: 0 })

    const closing = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await vi.waitFor(() => expect(worker.requests).toHaveLength(3))
    await client.close()
    await expect(closing).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    expect(worker.terminated).toBe(true)
  })

  it("bounds active scopes and cleans state after a synchronous dispatch failure", async () => {
    const worker = new FakeHookCatalogWorker()
    const source = makeSource("C:\\fixture")
    const client = new HookCatalogClient(
      async () => worker as unknown as WorkerType,
      (input) => ({ ...source, workspacePath: `C:\\fixture\\${input.requestScope}` })
    )
    const active = Array.from({ length: HOOK_CATALOG_MAX_ACTIVE_SCOPES }, (_, index) =>
      client.readPage({ requestScope: `scope-${index}` }, `renderer:${index}`).catch((error) => error)
    )
    await vi.waitFor(() => expect(worker.requests).toHaveLength(HOOK_CATALOG_MAX_ACTIVE_SCOPES))
    await expect(
      client.readPage({ requestScope: "overflow" }, "renderer:overflow")
    ).rejects.toThrow(/capacity exceeded/)
    await client.close()
    await Promise.all(active)

    const retryWorker = new FakeHookCatalogWorker()
    const retryClient = new HookCatalogClient(
      async () => retryWorker as unknown as WorkerType,
      () => source
    )
    retryWorker.postError = new Error("dispatch failed")
    await expect(
      retryClient.readPage({ requestScope: "same" }, "renderer:same")
    ).rejects.toThrow("dispatch failed")
    retryWorker.postError = null
    const retry = retryClient.readPage({ requestScope: "same" }, "renderer:same")
    await vi.waitFor(() => expect(retryWorker.requests).toHaveLength(1))
    retryWorker.emit("message", {
      type: "read-page-result",
      requestId: retryWorker.requests[0].requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(retry).resolves.toMatchObject({ totalEntries: 0 })
    await retryClient.close()
  })

  it("invalidates a read still resolving its source when closed", async () => {
    let resolveSource: ((source: HookCatalogSourceConfig) => void) | undefined
    const source = new Promise<HookCatalogSourceConfig>((resolve) => {
      resolveSource = resolve
    })
    const factory = vi.fn(async () => new FakeHookCatalogWorker() as unknown as WorkerType)
    const client = new HookCatalogClient(factory, () => source)
    const read = client.readPage({ requestScope: "closing" }, "renderer:closing")

    await client.close()
    resolveSource?.(makeSource("C:\\fixture"))

    await expect(read).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    expect(factory).not.toHaveBeenCalled()
  })

  it("evicts the oldest workspace overlay before a fourth workspace is cached", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-hook-catalog-workspace-lru-"))
    temporaryDirectories.push(root)
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir)
    writeFileSync(join(root, "hooks.json"), "[]")
    writeFileSync(join(root, "plugins.json"), "[]")
    writeFileSync(join(root, "disabled-skills.json"), "[]")
    const workspaces = Array.from({ length: 4 }, (_, index) => {
      const workspace = join(root, `workspace-${index}`)
      const hookDirectory = join(workspace, ".cmbdevclaw", "hooks")
      mkdirSync(hookDirectory, { recursive: true })
      for (let hookIndex = 0; hookIndex < 2; hookIndex += 1) {
        writeFileSync(
          join(hookDirectory, `hook-${hookIndex}.json`),
          JSON.stringify({
            event: "Stop",
            type: "command",
            command: `echo ${index}-${hookIndex}`
          })
        )
      }
      return workspace
    })
    const client = makeClient(makeSource(root, skillsDir))
    const firstPage = await client.readPage(
      { requestScope: "workspace-lru-0", workspacePath: workspaces[0], limit: 1 },
      "renderer:workspace-lru-0"
    )
    expect(firstPage.nextCursor).toBeTruthy()

    for (let index = 1; index < workspaces.length; index += 1) {
      await client.readPage(
        {
          requestScope: `workspace-lru-${index}`,
          workspacePath: workspaces[index],
          limit: 1
        },
        `renderer:workspace-lru-${index}`
      )
    }

    await expect(
      client.readPage(
        {
          requestScope: "workspace-lru-expired",
          workspacePath: workspaces[0],
          cursor: firstPage.nextCursor,
          limit: 1
        },
        "renderer:workspace-lru-expired"
      )
    ).rejects.toThrow("cursor expired")
  })

  it("shares one in-flight scan across renderers and cancellation detaches one consumer", async () => {
    const worker = new FakeHookCatalogWorker()
    const source = makeSource("C:\\fixture")
    const client = new HookCatalogClient(
      async () => worker as unknown as WorkerType,
      () => source
    )
    const first = client.readPage(
      { requestScope: "summary", revision: "renderer-a", limit: 1 },
      "renderer-a:summary"
    )
    const second = client.readPage(
      { requestScope: "summary", revision: "renderer-b", limit: 1 },
      "renderer-b:summary"
    )
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
    const request = worker.requests[0]
    client.cancelScope("renderer-a:summary")
    await expect(first).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    expect(Atomics.load(new Int32Array(request.cancelBuffer as SharedArrayBuffer), 0)).toBe(0)

    worker.emit("message", {
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(second).resolves.toMatchObject({ totalEntries: 0 })
    await client.close()
  })

  it("drops a failed bounded worker and starts a clean replacement", async () => {
    const firstWorker = new FakeHookCatalogWorker()
    const replacementWorker = new FakeHookCatalogWorker()
    const workers = [firstWorker, replacementWorker]
    const factory = vi.fn(async () => workers.shift() as unknown as WorkerType)
    const client = new HookCatalogClient(factory, () => makeSource("C:\\fixture"))

    const failed = client.readPage({ requestScope: "summary", limit: 1 }, "renderer:failed")
    await vi.waitFor(() => expect(firstWorker.requests).toHaveLength(1))
    firstWorker.emit("error", new Error("worker out of memory"))
    await expect(failed).rejects.toThrow("stopped unexpectedly")

    const recovered = client.readPage(
      { requestScope: "summary", limit: 1 },
      "renderer:recovered"
    )
    await vi.waitFor(() => expect(replacementWorker.requests).toHaveLength(1))
    replacementWorker.emit("message", {
      type: "read-page-result",
      requestId: replacementWorker.requests[0].requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(recovered).resolves.toMatchObject({ totalEntries: 0 })
    expect(factory).toHaveBeenCalledTimes(2)
    await client.close()
  })

  it("rejects pending work and replaces a Worker that exits cleanly unexpectedly", async () => {
    const firstWorker = new FakeHookCatalogWorker()
    const replacementWorker = new FakeHookCatalogWorker()
    const workers = [firstWorker, replacementWorker]
    const factory = vi.fn(async () => workers.shift() as unknown as WorkerType)
    const client = new HookCatalogClient(factory, () => makeSource("C:\\fixture"))

    const interrupted = client.readPage(
      { requestScope: "summary", limit: 1 },
      "renderer:clean-exit"
    )
    await vi.waitFor(() => expect(firstWorker.requests).toHaveLength(1))
    firstWorker.emit("exit", 0)
    await expect(interrupted).rejects.toThrow("stopped unexpectedly")

    const recovered = client.readPage(
      { requestScope: "summary", limit: 1 },
      "renderer:clean-exit-retry"
    )
    await vi.waitFor(() => expect(replacementWorker.requests).toHaveLength(1))
    replacementWorker.emit("message", {
      type: "read-page-result",
      requestId: replacementWorker.requests[0].requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(recovered).resolves.toMatchObject({ totalEntries: 0 })
    expect(factory).toHaveBeenCalledTimes(2)
    await client.close()
  })
})

function emptyPage(): Record<string, unknown> {
  return {
    globalHooks: [],
    workspaceHooks: [],
    pluginHooks: [],
    skillHooks: [],
    totalEntries: 0,
    enabledEntries: 0,
    relatedSummary: {
      skillEntries: 0,
      enabledSkillEntries: 0,
      skillTruncated: false,
      skillTruncatedReasons: [],
      pluginEntries: 0,
      pluginTruncated: false,
      pluginTruncatedReasons: []
    },
    truncated: false,
    truncatedReasons: [],
    stats: {
      durationMs: 0,
      responseBytes: 0,
      globalScanReused: false,
      workspaceScanReused: false,
      scannedDirectories: 0,
      scannedFiles: 0,
      discoveredSkills: 0,
      readBytes: 0
    }
  }
}

class FakeHookCatalogWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []
  terminated = false
  postError: Error | null = null

  postMessage(message: Record<string, unknown>): void {
    if (this.postError) throw this.postError
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

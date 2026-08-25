import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Worker as WorkerType } from "node:worker_threads"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HookCatalogPageInput } from "../types"
import {
  HookCatalogClient,
  HookCatalogRequestCancelledError
} from "./client"
import {
  HOOK_CATALOG_MAX_RESPONSE_BYTES,
  type HookCatalogSourceConfig
} from "./protocol"

const temporaryDirectories: string[] = []
const clients: HookCatalogClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

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
    skillSourceDirs: [skillsDir]
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
  it("releases an old snapshot before a cache-miss scan allocates the replacement", () => {
    const source = readFileSync(new URL("./reader.ts", import.meta.url), "utf8")
    const build = source.slice(
      source.indexOf("function buildSnapshot("),
      source.indexOf("function parseCursor(")
    )

    expect(build.indexOf("reserveSnapshotSlot()"))
      .toBeLessThan(build.indexOf("const startedAt"))
    expect(build.match(/reserveSnapshotSlot\(\)/g)).toHaveLength(1)
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
    expect(pages[0]).toMatchObject({ totalEntries: 6, enabledEntries: 6 })
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
    expect(hooks.find((hook) => hook.id === "plugin:plugin-one/plugin-hook")).toMatchObject({
      pluginId: "plugin-one",
      pluginName: "Plugin One",
      hookSourceType: "plugin"
    })
    for (const page of pages) {
      expect(page.stats.responseBytes).toBeLessThanOrEqual(HOOK_CATALOG_MAX_RESPONSE_BYTES)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        HOOK_CATALOG_MAX_RESPONSE_BYTES
      )
    }
  }, 30_000)

  it("reuses a revision-keyed snapshot for header summary and detail reads", async () => {
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
    expect(page.truncated).toBe(true)
    expect(page.truncatedReasons).toContain("skill-md-bytes")
    expect(page.stats.responseBytes).toBeLessThanOrEqual(HOOK_CATALOG_MAX_RESPONSE_BYTES)
  }, 120_000)

  it("cancels A when B supersedes it and cancels an in-flight request on close", async () => {
    const worker = new FakeHookCatalogWorker()
    const source = makeSource("C:\\fixture")
    const client = new HookCatalogClient(
      async () => worker as unknown as WorkerType,
      () => source
    )
    const first = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await Promise.resolve()
    const second = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await expect(first).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    const secondRequest = worker.requests.at(-1)!
    worker.emit("message", {
      type: "read-page-result",
      requestId: secondRequest.requestId,
      ok: true,
      page: emptyPage()
    })
    await expect(second).resolves.toMatchObject({ totalEntries: 0 })

    const closing = client.readPage({ requestScope: "panel" }, "renderer:panel")
    await Promise.resolve()
    await client.close()
    await expect(closing).rejects.toBeInstanceOf(HookCatalogRequestCancelledError)
    expect(worker.terminated).toBe(true)
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
    truncated: false,
    truncatedReasons: [],
    stats: {
      durationMs: 0,
      responseBytes: 0,
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

  postMessage(message: Record<string, unknown>): void {
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

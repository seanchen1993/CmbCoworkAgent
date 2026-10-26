/** Real Electron + preload IPC + SQLite + React deletion, using an isolated home.
 * npm run build && npx tsx tests/workspace-deletion-e2e.spec.ts
 * Performance budgets cover 10,000 persisted 2 KiB messages, not model/network latency.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binary = createRequire(import.meta.url)("electron") as string
const artifacts = join(root, "output/workspace-deletion")
type Api = {
  threads: {
    create(metadata: Record<string, unknown>): Promise<{ thread_id: string }>
    appendMessages(id: string, messages: Array<Record<string, unknown>>): Promise<{ count: number }>
    delete(id: string, options?: { requireIdle: boolean }): Promise<void>
    listGroupIds(options: {
      selector: { type: "workspace"; workspacePath: string | null }
    }): Promise<{
      entries: Array<{ threadId: string }>
    }>
  }
}
type Probe = { last: number; maxGap: number; ticks: number; timer: ReturnType<typeof setInterval> }

async function main(): Promise<void> {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-deletion-e2e-"))
  mkdirSync(artifacts, { recursive: true })
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|display|lang)$/i.test(
        key
      )
    )
      env[key] = value
  }
  for (const [key, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "openwork",
    TEMP: "temp",
    TMP: "temp",
    TMPDIR: "temp",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data"
  })) {
    env[key] = join(isolated, folder)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "127.0.0.1,localhost"
  })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const checks: string[] = []
  const metrics: Record<string, unknown> = {}
  const pass = (name: string): void => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  try {
    app = await _electron.launch({
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.evaluate("globalThis.__name = value => value")
    const deadline = Date.now() + 60_000
    while (!page && Date.now() < deadline) {
      for (const candidate of app.windows()) {
        if (
          await candidate
            .evaluate(() => Boolean((window as unknown as { api?: Api }).api))
            .catch(() => false)
        ) {
          page = candidate
          break
        }
      }
      if (!page) await new Promise((done) => setTimeout(done, 100))
    }
    assert(page, "main window must expose the real preload")
    await page.bringToFront()
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    const ids = await page.evaluate(async () => {
      const api = (window as unknown as { api: Api }).api
      const ids: string[] = []
      // Creation order puts a protected task between valid tasks in the sidebar.
      for (const [title, agentMode] of [
        ["Delete E2E first", "normal"],
        ["Delete E2E protected", "workflow"],
        ["Delete E2E last", "normal"]
      ]) {
        ids.push((await api.threads.create({ title, agentMode, workspacePath: null })).thread_id)
      }
      return ids
    })
    const retainedDirectory = join(workspace, "retained-worktree")
    mkdirSync(retainedDirectory)
    const retainedFile = join(retainedDirectory, "unmerged.txt")
    writeFileSync(retainedFile, "unmerged user work")
    const writeRetainedRun = (id: string): void => {
      const dir = join(workspace, ".cmbdevclaw", "workflows", id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "wf_retained123.json"),
        JSON.stringify({
          version: 1,
          runId: "wf_retained123",
          threadId: id,
          workflowName: "retained",
          script: "export default async () => null",
          scriptSha256: "retained",
          status: "completed",
          phases: [],
          currentPhase: null,
          agents: [],
          logs: [],
          journal: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          notificationDelivered: true,
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 1
          },
          worktrees: [
            { id: "retained", status: "ready", cleanupPending: false, directory: retainedDirectory }
          ]
        })
      )
    }
    writeRetainedRun(ids[1])
    for (const requireIdle of [true, false]) {
      const error = await page.evaluate(
        async ({ id, requireIdle }) => {
          try {
            await (window as unknown as { api: Api }).api.threads.delete(
              id,
              requireIdle ? { requireIdle: true } : undefined
            )
            return ""
          } catch (error) {
            return String(error)
          }
        },
        { id: ids[1], requireIdle }
      )
      assert.match(error, /缺少工作区路径/)
    }
    pass("both bulk and individual IPC reject a missing workflow workspace")
    await page.reload({ waitUntil: "domcontentloaded" })
    const group = page.getByText("未关联工作区", { exact: true }).first()
    await group.click({ button: "right", timeout: 30_000 })
    await page.getByRole("menuitem", { name: "删除工作区会话", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "确认删除工作区会话" })
    await dialog.getByRole("button", { name: "删除全部", exact: true }).click()
    await page
      .getByText(/已删除.*已跳过其余会话/)
      .first()
      .waitFor({ timeout: 30_000 })
    const remaining = await page.evaluate(async () =>
      (
        await (window as unknown as { api: Api }).api.threads.listGroupIds({
          selector: { type: "workspace", workspacePath: null }
        })
      ).entries.map((entry) => entry.threadId)
    )
    assert(remaining.includes(ids[1]))
    assert(!remaining.includes(ids[0]) && !remaining.includes(ids[2]))
    await page.screenshot({ path: join(artifacts, "partial-deletion.png") })
    await dialog.getByRole("button", { name: "删除全部", exact: true }).click()
    await page
      .getByText(/已删除 0\/1/)
      .first()
      .waitFor()
    pass(
      "real sidebar deletion skips a protected task, deletes both neighbors, and retries only the survivor"
    )
    await dialog.getByRole("button", { name: "取消", exact: true }).click()

    assert.equal(readFileSync(retainedFile, "utf8"), "unmerged user work")
    const knownWorkspaceThread = await page.evaluate(
      async (workspace) =>
        (
          await (window as unknown as { api: Api }).api.threads.create({
            title: "Protected worktree",
            agentMode: "workflow",
            workspacePath: workspace
          })
        ).thread_id,
      workspace
    )
    writeRetainedRun(knownWorkspaceThread)
    const retainedError = await page.evaluate(async (id) => {
      try {
        await (window as unknown as { api: Api }).api.threads.delete(id, { requireIdle: true })
        return ""
      } catch (error) {
        return String(error)
      }
    }, knownWorkspaceThread)
    assert.match(retainedError, /未处理或待清理的 workflow worktree/)
    assert.equal(readFileSync(retainedFile, "utf8"), "unmerged user work")
    const protectedRows = await page.evaluate(
      async (workspace) =>
        (
          await (window as unknown as { api: Api }).api.threads.listGroupIds({
            selector: { type: "workspace", workspacePath: workspace }
          })
        ).entries.map((entry) => entry.threadId),
      workspace
    )
    assert(
      protectedRows.includes(knownWorkspaceThread),
      "worktree protection must preserve the task record"
    )
    pass("retained worktrees survive deletion with both known and missing workspace metadata")

    for (const [round, count] of [100, 10_000, 10_000, 10_000].entries()) {
      const id = await page.evaluate(
        async ({ count, workspace }) => {
          const api = (window as unknown as { api: Api }).api
          const id = (
            await api.threads.create({
              title: `Delete performance ${count}`,
              workspacePath: workspace,
              agentMode: "normal"
            })
          ).thread_id
          for (let offset = 0; offset < count; offset += 500) {
            const messages = Array.from({ length: Math.min(500, count - offset) }, (_, index) => ({
              id: `message-${offset + index}`,
              role: "assistant",
              content: "x".repeat(2048),
              created_at: new Date()
            }))
            const result = await api.threads.appendMessages(id, messages)
            if (result.count !== messages.length) throw new Error("Incomplete performance fixture")
          }
          return id
        },
        { count, workspace }
      )
      await app.evaluate(() => {
        const state = globalThis as unknown as { deletionProbe: Probe }
        state.deletionProbe = {
          last: Date.now(),
          maxGap: 0,
          ticks: 0,
          timer: setInterval(() => {
            const p = state.deletionProbe
            const now = Date.now()
            p.maxGap = Math.max(p.maxGap, now - p.last)
            p.last = now
            p.ticks++
          }, 10)
        }
      })
      const renderer = await page.evaluate(async (id) => {
        const start = performance.now()
        let last = start,
          maxGap = 0,
          frame = 0
        const tick = (now: number): void => {
          maxGap = Math.max(maxGap, now - last)
          last = now
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        try {
          await (window as unknown as { api: Api }).api.threads.delete(id, { requireIdle: true })
          const elapsedMs = performance.now() - start
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          return { elapsedMs, maxGap }
        } finally {
          cancelAnimationFrame(frame)
        }
      }, id)
      const elapsed = renderer.elapsedMs
      const probe = await app.evaluate(async () => {
        await new Promise((done) => setTimeout(done, 30))
        const p = (globalThis as unknown as { deletionProbe: Probe }).deletionProbe
        clearInterval(p.timer)
        return { maxGap: p.maxGap, ticks: p.ticks }
      })
      metrics[count + "-round-" + round] = {
        elapsedMs: elapsed,
        mainMaxGapMs: probe.maxGap,
        rendererMaxGapMs: renderer.maxGap,
        ticks: probe.ticks
      }
      assert(elapsed < 5000, `delete ${count} messages exceeded 5s: ${elapsed}`)
      assert(renderer.maxGap < 250, `renderer blocked for ${renderer.maxGap}ms`)
      assert(probe.maxGap < 250, `main loop blocked for ${probe.maxGap}ms`)
      const remaining = await page.evaluate(
        async (workspace) =>
          (
            await (window as unknown as { api: Api }).api.threads.listGroupIds({
              selector: { type: "workspace", workspacePath: workspace }
            })
          ).entries.map((entry) => entry.threadId),
        workspace
      )
      assert(!remaining.includes(id))
      pass(`delete ${count} persisted messages within latency and event-loop budgets`)
    }
    const batchWorkspace = join(isolated, "batch-workspace")
    mkdirSync(batchWorkspace)
    await page.evaluate(async (workspace) => {
      const api = (window as unknown as { api: Api }).api
      for (let index = 0; index < 20; index++) {
        const id = (
          await api.threads.create({
            title: "Batch " + index,
            workspacePath: workspace,
            agentMode: index === 0 ? "coordinator" : "normal"
          })
        ).thread_id
        const messages = Array.from({ length: 100 }, (_, n) => ({
          id: "batch-" + n,
          role: "assistant",
          content: "x".repeat(2048),
          created_at: new Date()
        }))
        const result = await api.threads.appendMessages(id, messages)
        if (result.count !== messages.length) throw new Error("Incomplete batch fixture")
      }
    }, batchWorkspace)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("batch-workspace", { exact: true }).first().click({ button: "right" })
    await page.getByRole("menuitem", { name: "删除工作区会话", exact: true }).click()
    const batchDialog = page.getByRole("dialog", { name: "确认删除工作区会话" })
    const batchStart = Date.now()
    await batchDialog.getByRole("button", { name: "删除全部", exact: true }).click()
    await batchDialog.getByRole("status").filter({ hasText: /已处理 \d+\/20/ }).waitFor()
    await page.screenshot({ path: join(artifacts, "batch-progress.png") })
    await batchDialog.waitFor({ state: "hidden", timeout: 10_000 })
    const batchElapsed = Date.now() - batchStart
    const batchRemaining = await page.evaluate(
      async (workspace) =>
        (
          await (window as unknown as { api: Api }).api.threads.listGroupIds({
            selector: { type: "workspace", workspacePath: workspace }
          })
        ).entries,
      batchWorkspace
    )
    assert.equal(batchRemaining.length, 0)
    assert(batchElapsed < 10_000)
    metrics.batch20 = { elapsedMs: batchElapsed, messages: 2000 }
    pass("real sidebar deletes 20 tasks with 2000 messages within the batch budget")
    await page.screenshot({ path: join(artifacts, "batch-complete.png") })
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    writeFileSync(
      join(artifacts, "results.json"),
      JSON.stringify({ isolated, checks, metrics }, null, 2)
    )
    await app?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

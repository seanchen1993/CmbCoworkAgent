/** Real Electron / React / preload / SQLite / hydration Worker navigation regression.
 * Model output and the offline project rollout gate use controlled fixtures.
 * Run: npm run test:chat-navigation:e2e
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright"
import type {
  ThreadSearchOpenRequest, ThreadSearchPage, ThreadSearchStartRequest,
  ThreadSearchSummary, ThreadSearchWindow
} from "../src/shared/thread-search-types"
import { queueStorageKey } from "../src/renderer/src/lib/queued-message-content"
import {
  PROBE_EMPTY_PROJECT_ID, PROBE_FEATURE_SLUG, PROBE_OTHER_PROJECT_ID, PROBE_PROJECT_ID,
  seedProbeProjects
} from "./support/project-thread-search-fixture"
import {
  installProjectSearchHarnessAdapter,
  PROJECT_SEARCH_FIXTURE_FEATURE_TITLE
} from "./support/project-search-harness-adapter"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const applicationRoot = process.env.CHAT_NAVIGATION_APP_ROOT
  ? resolve(process.env.CHAT_NAVIGATION_APP_ROOT)
  : root
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const artifacts = process.env.CHAT_NAVIGATION_ARTIFACT_DIR
  ? resolve(process.env.CHAT_NAVIGATION_ARTIFACT_DIR)
  : join(root, "output/chat-navigation/e2e")
const titles = {
  running: "Navigation E2E running",
  cached: "Navigation E2E cached 80",
  folded: "Navigation E2E folded answer",
  history: "Navigation E2E historical pages"
}
interface FixtureApi {
  threads: {
    create(metadata: Record<string, unknown>): Promise<{ id?: string; thread_id?: string }>
    appendMessages(
      threadId: string,
      messages: Array<Record<string, unknown>>
    ): Promise<{ count: number }>
    searchMessages(threadId: string, query: string): Promise<{ matches: Array<{ messageId: string }> }>
    searchStart(request: ThreadSearchStartRequest): Promise<ThreadSearchPage>
    searchContinue(cursor: string): Promise<ThreadSearchPage>
    searchCancel(id?: string): Promise<void>
    delete(threadId: string): Promise<unknown>
    searchSummary(request: ThreadSearchOpenRequest): Promise<ThreadSearchSummary | null>
    searchTargetWindow(request: ThreadSearchOpenRequest): Promise<ThreadSearchWindow>
  }
  workspace: { set(threadId: string, path: string): Promise<unknown> }
}
interface ControlledRun {
  senderId: number
  channel: string
  count: number
  timer: ReturnType<typeof setInterval>
}

async function until(
  check: () => Promise<boolean>,
  label: string,
  timeout = 30_000
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 80))
  }
  throw new Error(`Timeout: ${label}`)
}

async function getAppPage(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await until(async () => {
    for (const candidate of app.windows()) {
      if (
        await candidate
          .evaluate(() => Boolean((window as unknown as { api?: unknown }).api))
          .catch(() => false)
      ) {
        page = candidate
        return true
      }
    }
    return false
  }, "preload ready")
  return page!
}

async function search(page: Page, query: string): Promise<void> {
  // A keyed chat mounts its global shortcut listener in a passive effect. A click resolving
  // does not guarantee that listener is installed yet; retry the idempotent open shortcut.
  await until(async () => {
    if (await page.getByPlaceholder("在当前会话中搜索").isVisible()) return true
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f")
    return false
  }, "chat search shortcut ready")
  const input = page.getByPlaceholder("在当前会话中搜索")
  await input.waitFor()
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
  await input.fill(query)
}

async function globalSearchHits(page: Page, query: string): Promise<ThreadSearchPage["results"]> {
  return page.evaluate(async (query) => {
    const { threads } = (window as unknown as { api: FixtureApi }).api
    let next = await threads.searchStart({ query })
    const session = next.sessionId
    const results = [...next.results]
    try {
      while (next.nextCursor) {
        next = await threads.searchContinue(next.nextCursor)
        results.push(...next.results)
      }
      return results
    } finally {
      await threads.searchCancel(session)
    }
  }, query)
}

async function matchSnapshot(page: Page) {
  return page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
    const range = [...(registry.get("chat-search-active") ?? [])][0]
    const row = range?.startContainer.parentElement?.closest<HTMLElement>("[data-chat-message-id]")
    const viewport = row?.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
    const rect = range?.getBoundingClientRect()
    const box = viewport?.getBoundingClientRect()
    return {
      messageId: row?.dataset.chatMessageId,
      text: range?.toString(),
      visible: Boolean(range?.startContainer.isConnected && range.endContainer.isConnected &&
        rect && rect.height > 0 && box && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
      scrollTop: viewport?.scrollTop,
      status: document.querySelector("[data-chat-search-overlay] [aria-live]")?.textContent
    }
  })
}

async function expectVisibleMatch(
  page: Page, text: string, messageId: string, stableMilliseconds = 100
): Promise<void> {
  let visibleSince: number | null = null
  await until(async () => {
    const snapshot = await matchSnapshot(page)
    if (!snapshot.visible || snapshot.text !== text || snapshot.messageId !== messageId) {
      visibleSince = null
      return false
    }
    visibleSince ??= performance.now()
    return performance.now() - visibleSince >= stableMilliseconds
  }, `visible ${text} in ${messageId}`)
}

async function expectMessageTime(page: Page, messageId: string, expected: string): Promise<void> {
  const timestamp = page.locator(`[data-chat-message-id="${messageId}"] time`)
  // Virtualized rows can mount offscreen before the final layout is measured.
  await until(async () => {
    if (!(await timestamp.isVisible())) return false
    return (await timestamp.innerText().catch(() => "")).trim() === expected
  }, `visible timestamp for ${messageId} (${expected})`)
  assert.equal(await timestamp.getAttribute("datetime"), expected.replace(/^开始于 /, ""))
  const opacity = await timestamp.evaluate((element) => {
    let value = 1
    for (let node: Element | null = element; node; node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity)
    }
    return value
  })
  assert.equal(opacity, 1, "timestamp must remain visible without hovering its message")
}

async function armProjectSearchDelay(
  app: ElectronApplication,
  threadId: string,
  channel = "threads:search-confirm-route"
) {
  await app.evaluate(({ ipcMain }, { channel, threadId }) => {
    const original = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (event: unknown, request: ThreadSearchOpenRequest) => unknown>
    })._invokeHandlers.get(channel)!
    const fixture = globalThis as {
      releaseProjectConfirmation?: () => void
      projectConfirmationFinished?: boolean
    }
    fixture.releaseProjectConfirmation = undefined
    fixture.projectConfirmationFinished = false
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, request: ThreadSearchOpenRequest) => {
      if (request.threadId !== threadId) return original(event, request)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      await new Promise<void>((resolve) => {
        fixture.releaseProjectConfirmation = resolve
      })
      try {
        return await original(event, request)
      } finally {
        fixture.projectConfirmationFinished = true
      }
    })
  }, { channel, threadId })

  return {
    waitUntilPending: () => until(() => app.evaluate(() =>
      Boolean((globalThis as { releaseProjectConfirmation?: () => void }).releaseProjectConfirmation)
    ), `${channel} pending`),
    release: async () => {
      await app.evaluate(() =>
        (globalThis as { releaseProjectConfirmation?: () => void }).releaseProjectConfirmation?.()
      )
      await until(() => app.evaluate(() =>
        Boolean((globalThis as { projectConfirmationFinished?: boolean }).projectConfirmationFinished)
      ), `${channel} returned`)
    }
  }
}

function prepareProjectSearchFixture(dataRoot: string, workspace: string) {
  const catalog = seedProbeProjects(dataRoot, workspace, 72)
  assert.equal(catalog.projects.size, 72)
  const catalogPath = join(dataRoot, "harness-board-projects.json")
  const catalogFile = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    projects: Array<{
      projectId: string
      projectDir?: string
      description?: string
      lifecycle: { status: string }
    }>
  }
  const adapterLog = installProjectSearchHarnessAdapter(dataRoot, PROBE_FEATURE_SLUG)
  const featureProject = catalogFile.projects.find(({ projectId }) => projectId === PROBE_OTHER_PROJECT_ID)!
  featureProject.projectDir = "feature-fixture"
  mkdirSync(join(workspace, featureProject.projectDir))
  const offlineProject = catalogFile.projects.find(({ projectId }) =>
    projectId === PROBE_EMPTY_PROJECT_ID)!
  offlineProject.projectDir = "missing-project-directory"
  writeFileSync(catalogPath, JSON.stringify(catalogFile))
  return { catalogPath, catalogFile, adapterLog }
}

async function runProjectSearchScenarios(
  app: ElectronApplication,
  page: Page,
  dataRoot: string,
  workspace: string,
  pass: (description: string) => void,
  fixture: ReturnType<typeof prepareProjectSearchFixture>
): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const channel = "featureGates:isEnabled"
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
    })._invokeHandlers
    const original = handlers.get(channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, name, options) =>
      name === "projectMode" ? { enabled: true, reason: "local e2e fixture" }
        : original?.(event, name, options))
  })
  // Project mode has a separately managed rollout gate. Exercise an entitled
  // offline window without making any search or project-ownership API a mock.
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.evaluate("globalThis.__name = (value) => value")
  await page.evaluate(async () => {
    const guide = { guideId: "project-mode-getting-started", revision: 1, maxShowCount: 3 }
    await window.api.uiGuides.getState(guide)
    await window.api.uiGuides.acknowledge(guide)
  })
  const dialog = page.getByRole("dialog", { name: "搜索会话" })
  const globalInput = dialog.getByRole("combobox", { name: "搜索会话" })
  const searchButton = page.getByRole("button", { name: "搜索会话", exact: true })
  await searchButton.waitFor()
  assert.equal(await searchButton.count(), 1, "chat mode exposes one search button")
  const projectSidebar = page.locator("#harness-sidebar-portal")
  const expectSidebarAnchor = async (threadId: string) => {
    await page.waitForFunction((id) => {
      const row = document.querySelector<HTMLElement>(
        `[data-sidebar-thread-id="${CSS.escape(id)}"][aria-current="true"]`
      )
      const viewport = row?.closest("[data-radix-scroll-area-viewport]")
      if (!row || !viewport) return false
      const bounds = row.getBoundingClientRect()
      const clip = viewport.getBoundingClientRect()
      return bounds.height > 0 && bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1
    }, threadId)
  }
  const { catalogPath, catalogFile, adapterLog } = fixture
  const ids = await page.evaluate(async ({ workspace, projectId, otherProjectId, offlineProjectId }) => {
    const api = (window as unknown as { api: FixtureApi }).api
    const marker = "PROJECT_SCOPE_SHARED_MARKER"
    const seeds = [
      { label: "regular", metadata: {} },
      { label: "project", metadata: { harnessProjectSession: { projectId, kind: "chat" } } },
      { label: "other", metadata: {
        harnessProjectSession: { projectId: otherProjectId, kind: "chat" }
      } },
      { label: "unknown-feature", metadata: {} },
      { label: "eligible-feature", metadata: {} },
      { label: "offline-feature", metadata: {} },
      { label: "offline-project", metadata: {
        harnessProjectSession: { projectId: offlineProjectId, kind: "chat" }
      } },
      { label: "unregistered-feature", metadata: {} },
      { label: "excluded-feature", metadata: {} }
    ]
    const markers: Record<string, string> = {
      "eligible-feature": "ELIGIBLE_FEATURE_HISTORICAL_MARKER",
      "offline-feature": "OFFLINE_PROJECT_HISTORICAL_MARKER",
      "offline-project": "OFFLINE_PROJECT_HISTORICAL_MARKER",
      "unregistered-feature": "OFFLINE_PROJECT_HISTORICAL_MARKER",
      "excluded-feature": "EXCLUDED_FEATURE_HISTORICAL_MARKER"
    }
    const ids: Record<string, string> = {}
    for (const seed of seeds) {
      const created = await api.threads.create({
        title: "Fixture project scope " + seed.label,
        agentMode: seed.label === "offline-project" ? "workflow" : "normal",
        workspacePath: workspace,
        ...seed.metadata
      })
      const threadId = created.thread_id ?? created.id
      if (!threadId) throw new Error("Missing fixture thread ID")
      ids[seed.label] = threadId
      const messages = Array.from({ length: 180 }, (_, row) => ({
        id: seed.label + "-search-" + row,
        role: "assistant",
        created_at: new Date(1_700_000_000_000 + row),
        content: row === 5
          ? markers[seed.label] ?? marker
          : "A later message for " + seed.label + " " + row
      }))
      const result = await api.threads.appendMessages(threadId, messages)
      if (result.count !== messages.length) throw new Error("Incomplete project transcript")
    }
    for (let i = 0; i < 8; i += 1) {
      const created = await api.threads.create({ title: "Recent feature session " + i,
        agentMode: "normal", workspacePath: workspace })
      const threadId = created.thread_id ?? created.id
      if (!threadId) throw new Error("Missing newer Feature fixture")
      ids["newer-feature-" + i] = threadId
      await api.threads.create({ title: "Recent ordinary session " + i,
        agentMode: "normal", workspacePath: workspace })
    }

    return ids
  }, {
    workspace, projectId: PROBE_PROJECT_ID, otherProjectId: PROBE_OTHER_PROJECT_ID,
    offlineProjectId: PROBE_EMPTY_PROJECT_ID
  })
  // This session represents history from a previous installation. The current
  // create path correctly requires workspace configuration for a new Feature.
  await app.evaluate((_electron, { databasePath, features }) => {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
    const db = new sqlite.DatabaseSync(databasePath, { timeout: 4000 })
    try {
      const update = db.prepare("UPDATE threads SET metadata = json_set(metadata, '$.harnessFeature', json(?)) WHERE thread_id = ?")
      for (const { threadId, projectId, slug } of features) {
        if (update.run(JSON.stringify({ projectId, slug }), threadId).changes !== 1) {
          throw new Error("Missing historical Feature seed row")
        }
      }
    } finally {
      db.close()
    }
  }, {
    databasePath: join(dataRoot, "cmbcoworkagent.sqlite"),
    features: [
      { threadId: ids["unknown-feature"], projectId: PROBE_PROJECT_ID, slug: "unobserved" },
      { threadId: ids["eligible-feature"], projectId: PROBE_OTHER_PROJECT_ID, slug: PROBE_FEATURE_SLUG },
      { threadId: ids["offline-feature"], projectId: PROBE_EMPTY_PROJECT_ID, slug: "offline-feature" },
      { threadId: ids["unregistered-feature"], projectId: "unregistered-project", slug: "offline-feature" },
      { threadId: ids["excluded-feature"], projectId: PROBE_OTHER_PROJECT_ID, slug: "excluded-by-inspect" },
      ...Object.entries(ids).filter(([label]) => label.startsWith("newer-feature-")).map(([, threadId]) =>
        ({ threadId, projectId: PROBE_OTHER_PROJECT_ID, slug: PROBE_FEATURE_SLUG }))
    ]
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.evaluate("globalThis.__name = (value) => value")
  await page.addStyleTag({ content: "aside [data-radix-scroll-area-viewport] { max-height: 120px; }" })
  await searchButton.waitFor()
  const results = await page.evaluate(async (projectId) => {
    const api = (window as unknown as { api: FixtureApi }).api
    const marker = "PROJECT_SCOPE_SHARED_MARKER"
    const requests: ThreadSearchStartRequest[] = [
      { query: marker },
      { query: marker, scope: { kind: "project", projectId } },
      { query: marker, scope: { kind: "projects" } },
      { query: marker, scope: { kind: "all" } },
      { query: "ELIGIBLE_FEATURE_HISTORICAL_MARKER", scope: { kind: "projects" } }
    ]
    const results: Array<{ hits: string[]; coverage: string }> = []
    for (const request of requests) {
      let reply = await api.threads.searchStart(request)
      const sessionId = reply.sessionId
      const hits: string[] = []
      try {
        for (;;) {
          hits.push(...reply.results.map(({ threadId }) => threadId))
          if (!reply.nextCursor) break
          reply = await api.threads.searchContinue(reply.nextCursor)
        }
        results.push({ hits: hits.sort(), coverage: reply.coverage.completeness })
      } finally {
        await api.threads.searchCancel(sessionId)
      }
    }
    return results
  }, PROBE_PROJECT_ID)
  const grouped = { ids, results }
  assert.deepEqual(grouped.results.map(({ hits }) => hits), [
    [grouped.ids.regular],
    [grouped.ids.project, grouped.ids["unknown-feature"]].sort(),
    [grouped.ids.project, grouped.ids.other, grouped.ids["unknown-feature"]].sort(),
    [grouped.ids.regular, grouped.ids.project, grouped.ids.other, grouped.ids["unknown-feature"]].sort(),
    [grouped.ids["eligible-feature"]]
  ])
  assert.equal(grouped.results[1].coverage, "complete")
  assert.equal(grouped.results[4].coverage, "complete")
  assert.equal(existsSync(adapterLog), false, "queries on unknown Features never invoke adapters")
  pass("all four scopes isolate locally owned Feature history without inspecting adapters")

  const searchShortcut = process.platform === "darwin" ? "Meta+Shift+f" : "Control+Shift+f"
  const searchScope = dialog.getByLabel("搜索范围")
  const projectHeading = page.getByRole("heading", {
    name: "Fixture project scope project", exact: true
  })
  const otherProjectHeading = page.getByRole("heading", {
    name: "Fixture project scope other", exact: true
  })
  await page.getByRole("button", { name: "全部收起工作区", exact: true }).click()
  await page.getByRole("button", { name: "全部展开工作区", exact: true }).waitFor()
  await page.keyboard.press(searchShortcut)
  assert.equal(await searchScope.inputValue(), "ordinary")
  await searchScope.selectOption("projects")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.project + '"]').click()
  await dialog.waitFor({ state: "hidden" })
  await page.locator('[data-chat-thread-id="' + grouped.ids.project + '"]').waitFor()
  await projectHeading.waitFor()
  await projectSidebar.getByRole("button", { name: "项目列表", exact: true }).waitFor()
  assert.equal(await searchButton.count(), 1, "project mode exposes one search button")
  await expectSidebarAnchor(grouped.ids.project)
  await expectVisibleMatch(page, "PROJECT_SCOPE_SHARED_MARKER", "project-search-5")
  pass("global search opens an unloaded project after the first 64 and reveals its old message")

  await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  await page.keyboard.press(searchShortcut)
  assert.equal(await searchScope.inputValue(), "project")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.project + '"]').waitFor()
  assert.equal(await dialog.locator('[data-search-thread="' + grouped.ids.other + '"]').count(), 0)
  await searchScope.selectOption("projects")
  await dialog.locator('[data-search-thread="' + grouped.ids.other + '"]').click()
  await dialog.waitFor({ state: "hidden" })
  await page.locator('[data-chat-thread-id="' + grouped.ids.other + '"]').waitFor()
  await expectVisibleMatch(page, "PROJECT_SCOPE_SHARED_MARKER", "other-search-5")
  pass("search defaults to the mounted project and crosses projects after an explicit scope change")

  // The board still has an active copy of the first project. Update only the
  // underlying registry, then resolve the project again from a search hit.
  const archived = catalogFile.projects.find(({ projectId }) => projectId === PROBE_PROJECT_ID)!
  archived.lifecycle.status = "archived"
  writeFileSync(catalogPath, JSON.stringify(catalogFile))
  await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("projects")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.project + '"]').click()
  await dialog.waitFor({ state: "hidden" })
  const archivedChat = page.locator('[data-chat-thread-id="' + grouped.ids.project + '"]')
  const archivedComposer = archivedChat.getByPlaceholder("所属项目已归档，当前会话只读。", { exact: true })
  await archivedComposer.waitFor()
  assert(await archivedComposer.isDisabled(), "archiving disables the project composer")
  await expectVisibleMatch(page, "PROJECT_SCOPE_SHARED_MARKER", "project-search-5")
  pass("a cached active project reopens read-only after registry archive")

  const countAdapterInvocations = () => existsSync(adapterLog)
    ? readFileSync(adapterLog, "utf8").trim().split("\n").length : 0
  const adapterInvocationsBeforeRefresh = countAdapterInvocations()
  // Archiving invalidates prior catalog evidence. Refresh through the production
  // Board path so the successful full project snapshot authorizes the Feature.
  const detail = await page.evaluate(
    (id) => window.api.harnessBoard.getProjectDetail(id),
    PROBE_OTHER_PROJECT_ID
  )
  assert.equal(detail.error, null)
  assert(detail.runs.some(({ slug }) => slug === PROBE_FEATURE_SLUG))
  assert(countAdapterInvocations() > adapterInvocationsBeforeRefresh)
  const searchExcludedFeature = () => page.evaluate(async (projectId) => {
    const { threads } = (window as unknown as { api: FixtureApi }).api
    let reply = await threads.searchStart({ query: "EXCLUDED_FEATURE_HISTORICAL_MARKER",
      scope: { kind: "project", projectId } })
    const id = reply.sessionId
    try {
      for (;;) {
        if (reply.results.length) return { found: true, coverage: reply.coverage.completeness }
        if (!reply.nextCursor) return { found: false, coverage: reply.coverage.completeness }
        reply = await threads.searchContinue(reply.nextCursor)
      }
    } finally {
      await threads.searchCancel(id)
    }
  }, PROBE_OTHER_PROJECT_ID)
  const absentFeature = { found: false, coverage: "complete" }
  assert.deepEqual(await searchExcludedFeature(), absentFeature, "current authoritative absence excludes a Feature")
  const unrelatedProject = catalogFile.projects.find(({ projectId }) =>
    projectId === PROBE_EMPTY_PROJECT_ID)!
  unrelatedProject.description = "Unrelated project edit must preserve observed exclusions"
  writeFileSync(catalogPath, JSON.stringify(catalogFile))
  assert.deepEqual(await searchExcludedFeature(), absentFeature, "registry rewrite preserves persisted exclusion")
  const refreshedDetail = await page.evaluate(
    (id) => window.api.harnessBoard.getProjectDetail(id), PROBE_OTHER_PROJECT_ID
  )
  assert.equal(refreshedDetail.error, null)
  assert(refreshedDetail.runs.some(({ slug }) => slug === PROBE_FEATURE_SLUG))
  await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  const featureGroup = projectSidebar.locator(
    `[data-sidebar-group-key="feature:${PROBE_OTHER_PROJECT_ID}:${PROBE_FEATURE_SLUG}"]`
  )
  await featureGroup.waitFor()
  const targetSidebarRow = projectSidebar.locator(
    `[data-sidebar-thread-id="${grouped.ids["eligible-feature"]}"]`
  )
  assert.equal(await targetSidebarRow.count(), 0, "older hit starts outside the sidebar window")
  await projectSidebar.locator("[data-radix-scroll-area-viewport]").evaluate((viewport) => {
    viewport.scrollTop = 0
  })
  const groupBeforeSearch = projectSidebar.locator(
    `[data-sidebar-group-key="project:${PROBE_OTHER_PROJECT_ID}"]`
  )
  const expandedProject = groupBeforeSearch.getByTitle("收起项目会话", { exact: true })
  await featureGroup.getByTitle("收起特性会话", { exact: true }).click()
  await expandedProject.click()
  await groupBeforeSearch.getByTitle("展开项目会话", { exact: true }).waitFor()
  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("projects")
  await globalInput.fill("ELIGIBLE_FEATURE_HISTORICAL_MARKER")
  const featureHit = dialog.locator('[data-search-thread="' + grouped.ids["eligible-feature"] + '"]')
  await featureHit.click()
  await dialog.waitFor({ state: "hidden" })
  await page.locator('[data-chat-thread-id="' + grouped.ids["eligible-feature"] + '"]').waitFor()
  await expectSidebarAnchor(grouped.ids["eligible-feature"])
  await page.getByText(PROJECT_SEARCH_FIXTURE_FEATURE_TITLE, { exact: true }).first().waitFor()
  await expectVisibleMatch(page, "ELIGIBLE_FEATURE_HISTORICAL_MARKER", "eligible-feature-search-5")
  pass("a current Board observation opens the live Feature view with its exact sidebar anchor")

  await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  const delayedTarget = await armProjectSearchDelay(app, grouped.ids.other, "threads:search-target-window")
  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("projects")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator(`[data-search-thread="${grouped.ids.other}"]`).click()
  await dialog.waitFor({ state: "hidden" })
  await delayedTarget.waitUntilPending()
  const otherChat = page.locator(`[data-chat-thread-id="${grouped.ids.other}"]`)
  assert.equal(await otherChat.locator("textarea:enabled").count(), 0, "unconfirmed exact view cannot compose")
  const onlineDirectory = join(workspace, "feature-fixture")
  const renamedDirectory = join(workspace, "feature-fixture-unavailable")
  assert(existsSync(onlineDirectory) && !existsSync(renamedDirectory))
  renameSync(onlineDirectory, renamedDirectory)
  try {
    await delayedTarget.release()
    const composer = otherChat.getByPlaceholder("当前项目无法确认实时状态，仅可查看历史会话。", { exact: true })
    await composer.waitFor()
    assert(await composer.isDisabled())
    await expectSidebarAnchor(grouped.ids.other)
  } finally {
    renameSync(renamedDirectory, onlineDirectory)
  }
  pass("directory loss after confirmation keeps the exact destination read-only")

  await page.getByRole("navigation").getByRole("button", { name: "项目列表", exact: true }).click()
  const settings = page.getByRole("tab", { name: "工程与精益配置", exact: true })
  await settings.waitFor()
  const interruptedOpening = await armProjectSearchDelay(app, grouped.ids.other)
  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("projects")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.other + '"]').click()
  await dialog.waitFor({ state: "hidden" })
  await interruptedOpening.waitUntilPending()
  await settings.click()
  assert.equal(await settings.getAttribute("aria-selected"), "true")
  await interruptedOpening.release()
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ))
  assert.equal(await settings.getAttribute("aria-selected"), "true")
  assert.equal(await page.locator('[data-chat-thread-id="' + grouped.ids.other + '"]').count(), 0)
  pass("a manual switch to project settings cancels a delayed search route")
  await page.getByRole("tab", { name: "项目列表", exact: true }).click()

  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("all")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.regular + '"]').click()
  await dialog.waitFor({ state: "hidden" })
  await page.locator('[data-chat-thread-id="' + grouped.ids.regular + '"]').waitFor()
  await expectSidebarAnchor(grouped.ids.regular)
  await projectHeading.waitFor({ state: "detached" })
  await expectVisibleMatch(page, "PROJECT_SCOPE_SHARED_MARKER", "regular-search-5")
  pass("all scopes can navigate from project mode back to ordinary chat")

  const tickets = await page.evaluate(async ({ threadId, projectId }) => {
    const { threads } = (window as unknown as { api: FixtureApi }).api
    async function ticketFor(query: string) {
      let reply = await threads.searchStart({ query, scope: { kind: "project", projectId } })
      const sessionId = reply.sessionId
      try {
        for (;;) {
          const hit = reply.results.find((result) => result.threadId === threadId)
          if (hit) {
            const summary = await threads.searchSummary(hit)
            if (!summary?.navigationTicketId) throw new Error("Missing project navigation ticket")
            if (new TextEncoder().encode(JSON.stringify(summary)).byteLength > 32 * 1024) {
              throw new Error("Oversized project navigation summary")
            }
            return { ...hit, navigationTicketId: summary.navigationTicketId }
          }
          if (!reply.nextCursor) throw new Error("Missing project query target " + query)
          reply = await threads.searchContinue(reply.nextCursor)
        }
      } finally {
        await threads.searchCancel(sessionId)
      }
    }
    const old = await ticketFor("PROJECT_SCOPE_SHARED_MARKER")
    const current = await ticketFor("A later message for project 160")
    const stale = await threads.searchTargetWindow(old)
    const resolved = await threads.searchTargetWindow(current)
    if (new TextEncoder().encode(JSON.stringify(resolved)).byteLength > 4 * 1024 * 1024) {
      throw new Error("Oversized project target window")
    }
    const reused = await threads.searchTargetWindow(current)
    return {
      stale: stale.status,
      resolved: resolved.status,
      reused: reused.status,
      target: current.target?.kind === "durableMessage" ? current.target.messageId : null
    }
  }, { threadId: grouped.ids.project, projectId: PROBE_PROJECT_ID })
  assert.deepEqual(tickets, {
    stale: "staleIdentity", resolved: "resolved", reused: "staleIdentity", target: "project-search-160"
  })
  pass("same-thread stale project tickets cannot consume the newer exact result")
  const removedOpening = await armProjectSearchDelay(app, grouped.ids.other)
  await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("projects")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  await dialog.locator('[data-search-thread="' + grouped.ids.other + '"]').click()
  await removedOpening.waitUntilPending()
  catalogFile.projects = catalogFile.projects.filter(({ projectId }) =>
    projectId !== PROBE_OTHER_PROJECT_ID)
  writeFileSync(catalogPath, JSON.stringify(catalogFile))
  await removedOpening.release()
  await page.locator('[data-chat-thread-id="' + grouped.ids.regular + '"]').waitFor()
  assert.equal(await otherProjectHeading.count(), 0)
  assert.equal(await page.locator('[data-chat-thread-id="' + grouped.ids.other + '"]').count(), 0)
  pass("project removal between summary and Board confirmation restores the source conversation")

  await page.keyboard.press(searchShortcut)
  await searchScope.selectOption("all")
  await globalInput.fill("PROJECT_SCOPE_SHARED_MARKER")
  const deletedHit = dialog.locator('[data-search-thread="' + grouped.ids.project + '"]')
  const ordinaryHit = dialog.locator('[data-search-thread="' + grouped.ids.regular + '"]')
  await deletedHit.waitFor()
  await ordinaryHit.waitFor()
  await page.evaluate((id) => (window as unknown as { api: FixtureApi }).api.threads.delete(id), grouped.ids.project)
  await deletedHit.waitFor({ state: "detached" })
  assert(await ordinaryHit.isVisible(), "committed project deletion preserves verified ordinary results")
  await globalInput.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  pass("committed project session deletion retracts the published hit")

  assert.equal(existsSync(join(workspace, "missing-project-directory")), false)
  const offlineQueueKey = queueStorageKey(grouped.ids["offline-feature"])
  const handedOffDraft = JSON.stringify([
    "offline-history-handed-off-draft", "offline-feature-search-5"
  ].map((id) => ({
    id,
    text: "This draft must not be reconciled while reading history",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    handoffRequestedAt: "2026-01-01T00:00:00.000Z"
  })))
  await page.evaluate(({ storageKey, draft }) => localStorage.setItem(storageKey, draft), {
    storageKey: offlineQueueKey, draft: handedOffDraft
  })
  await app.evaluate(({ ipcMain }, { offlineProjectId, featureThreadId, workflowThreadId }) => {
    const runtime = globalThis as { offlineHistoryDetailCalls?: string[] }
    runtime.offlineHistoryDetailCalls = []
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
    })._invokeHandlers
    for (const channel of [
      "harnessBoard:getProjectDetail", "harnessBoard:getProjectDetails", "harnessBoard:getRunDetail",
      "agent:reconcileCurrentRunQueuedMessages", "workflow:hydrate", "agent:request-pending-notification",
      "threads:latest-checkpoint-runtime-state", "threads:getSubagentTranscripts"
    ]) {
      const original = handlers.get(channel)
      if (!original) throw new Error("Missing Board handler " + channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, payload, ...rest) => {
        const projectIds = Array.isArray(payload) ? payload : payload?.projectIds
        const affectedThread = typeof payload === "string" ? payload : payload?.threadId
        if ((typeof payload === "string" ? payload : payload?.projectId) === offlineProjectId ||
            projectIds?.includes(offlineProjectId) || affectedThread === featureThreadId ||
            affectedThread === workflowThreadId) {
          runtime.offlineHistoryDetailCalls!.push(channel)
        }
        if (channel === "workflow:hydrate" && payload?.threadId === workflowThreadId) {
          return { latestRun: null, hasPendingNotification: true }
        }
        return original(event, payload, ...rest)
      })
    }
  }, {
    offlineProjectId: PROBE_EMPTY_PROJECT_ID,
    featureThreadId: grouped.ids["offline-feature"],
    workflowThreadId: grouped.ids["offline-project"]
  })
  const invokesBeforeOfflineHistory = countAdapterInvocations()
  const offlineMarker = "OFFLINE_PROJECT_HISTORICAL_MARKER"
  for (const key of ["offline-project", "offline-feature"]) {
    const id = grouped.ids[key]
    await page.keyboard.press(searchShortcut)
    await searchScope.selectOption("all")
    await globalInput.fill(offlineMarker)
    const result = dialog.locator(`[data-search-thread="${id}"]`)
    await result.waitFor()
    assert.equal(await dialog.locator(
      `[data-search-thread="${grouped.ids["unregistered-feature"]}"]`
    ).count(), 0, "unregistered history must remain excluded")
    await result.click()
    await dialog.waitFor({ state: "hidden" })
    const chat = page.locator(`[data-chat-thread-id="${id}"]`)
    const composer = chat.getByPlaceholder("当前项目无法确认实时状态，仅可查看历史会话。", { exact: true })
    await composer.waitFor()
    assert(await composer.isDisabled(), "offline history is read-only")
    await expectSidebarAnchor(id)
    await expectVisibleMatch(page, offlineMarker, `${key}-search-5`)
    await page.getByPlaceholder("在当前会话中搜索").press("Escape")
  }
  assert.equal(countAdapterInvocations(), invokesBeforeOfflineHistory, "opening history starts no adapter")
  assert.deepEqual(await app.evaluate(() => (globalThis as {
    offlineHistoryDetailCalls?: string[]
  }).offlineHistoryDetailCalls), [])
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), offlineQueueKey), handedOffDraft)
  pass("missing project directory preserves owned project and Feature history with read-only anchors")

  writeFileSync(catalogPath, "{invalid registry")
  const degraded = await page.evaluate(async () => {
    const { threads } = (window as unknown as { api: FixtureApi }).api
    let reply = await threads.searchStart({
      query: "PROJECT_SCOPE_SHARED_MARKER", scope: { kind: "all" }
    })
    const sessionId = reply.sessionId
    const results: string[] = []
    try {
      for (;;) {
        results.push(...reply.results.map(({ threadId }) => threadId))
        if (!reply.nextCursor) return { results, coverage: reply.coverage.completeness }
        reply = await threads.searchContinue(reply.nextCursor)
      }
    } finally {
      await threads.searchCancel(sessionId)
    }
  })
  assert.deepEqual(degraded, { results: [grouped.ids.regular], coverage: "partial" })
  pass("an unreadable project registry retains only verified ordinary results with partial coverage")
}

async function main(): Promise<void> {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-chat-navigation-e2e-"))
  mkdirSync(artifacts, { recursive: true })
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "search-preview.md"), "# Search preview fixture\n")
  const env: Record<string, string> = {}
  const allowed =
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|display|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang)$/i
  for (const [key, value] of Object.entries(process.env))
    if (value && allowed.test(key)) env[key] = value
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
  const projectSearchFixture = prepareProjectSearchFixture(env.CMB_COWORK_AGENT_HOME, workspace)
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const pageErrors: string[] = []
  const diagnosticOutput: string[] = []
  const noteDiagnostic = (line: string): void => {
    diagnosticOutput.push(line.slice(0, 1200))
    if (diagnosticOutput.length > 40) diagnosticOutput.shift()
  }
  const timings: Array<{
    title: string
    milliseconds: number
    interactionMilliseconds: number
    mountedRows: number
  }> = []
  const checks: string[] = []
  const pass = (label: string): void => {
    checks.push(label)
    console.log(`PASS ${label}`)
  }
  try {
    app = await _electron.launch({
      // The default launcher installs Playwright's readiness hook before Electron opens a window.
      ...(process.platform === "win32"
        ? { executablePath: join(root, "tests/support/electron-launcher.cmd") }
        : {}),
      args: [
        process.platform === "darwin" && existsSync(join(applicationRoot, "package.json"))
          ? applicationRoot
          : join(applicationRoot, "out/main/index.js"),
        `--user-data-dir=${join(isolated, "electron")}`
      ],
      cwd: applicationRoot,
      env,
      timeout: 60_000
    })
    app.process().stderr?.on("data", (data) => noteDiagnostic(String(data)))
    page = await getAppPage(app)
    await page.addInitScript("window.__name = (value) => value")
    await page.bringToFront()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (entry) => {
      if (entry.type() === "error" || entry.type() === "warning") noteDiagnostic(entry.text())
    })
    if (process.env.CMB_PROJECT_THREAD_SEARCH_E2E_ONLY === "1") {
      await runProjectSearchScenarios(app, page, env.CMB_COWORK_AGENT_HOME, workspace, pass, projectSearchFixture)
      assert.deepEqual(pageErrors, [], "no renderer errors")
      return
    }
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners("agent:invoke")
      ipcMain.on("agent:invoke", (event, request) => {
        const channel = `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
        const layoutStream = request.threadId ===
          (globalThis as { layoutStreamThreadId?: string }).layoutStreamThreadId
        const run: ControlledRun = {
          senderId: event.sender.id,
          channel,
          count: 0,
          timer: setInterval(() => {
            if (event.sender.isDestroyed()) return
            run.count += 1
            event.sender.send(channel, {
              type: "stream",
              mode: "messages",
              data: [
                {
                  id: ["langchain_core", "messages", "AIMessageChunk"],
                  kwargs: { id: "navigation-live", content: layoutStream
                    ? `Progress line ${run.count} with details\n\n` : `LIVE_SEQUENCE_${run.count} ` }
                },
                { langgraph_node: "agent" }
              ]
            })
          }, layoutStream ? 32 : 40)
        }
        ;(globalThis as unknown as { navigationRun: ControlledRun }).navigationRun = run
      })
    })
    const threadIds = await page.evaluate(
      async ({ workspace, titles }) => {
        const api = (window as unknown as { api: FixtureApi }).api
        const ids: Record<string, string> = {}
        for (const [kind, title] of Object.entries(titles)) {
          const thread = await api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = thread.thread_id ?? thread.id
          if (!id) throw new Error("Missing fixture thread ID")
          ids[kind] = id
          await api.workspace.set(id, workspace)
          const count =
            kind === "history" ? 320 : kind === "cached" ? 80 : kind === "folded" ? 2 : 0
          const messages = Array.from({ length: count }, (_, index) => {
            let content =
              `Fixture ${kind} ${index}.\n\n` +
              "A paragraph with **formatted text**.\n\n".repeat(30)
            let role = "assistant"
            let reasoning: string | undefined
            if (kind === "cached" && index === count - 1) {
              content = [
                "ANCHOR_TARGET",
                ...Array.from({ length: 90 }, (_, n) => `Line ${n}`),
                "ANCHOR_TARGET"
              ].join("\n\n")
            }
            if (kind === "folded" && index === count - 1)
              content = `${"x".repeat(20_000)}\n\nFOLDED_TARGET\n\n${"y".repeat(80_000)}`
            if (kind === "history" && index === 5)
              content = "A historical HISTORICAL_TARGET message."
            if (kind === "history" && index > 54 && index < 155)
              content = "A tall history row with durable content. ".repeat(index % 3 === 0 ? 600 : 400)
            if (kind === "history" && index === 110)
              content = "A short row between tall rows. WIDE_WINDOW_EXACT_TARGET"
            if (kind === "history" && index === 6) {
              reasoning = "Separate reasoning"
              content = "<think>HIDDEN_E2E_REASONING</think> VISIBLE_E2E_REPLY"
            }
            if (kind === "history" && index === count - 1) {
              role = "user"
              content = `${"Long user body line\n".repeat(100)}USER_BODY_TARGET`
            }
            return {
              id: `${kind}-${index}`,
              role,
              content,
              reasoning,
              created_at: new Date(2025, 11, 31, 23, 59, 45 + index),
              start_at: new Date(2025, 11, 31, 23, 59, 45 + index),
              end_at: new Date(2025, 11, 31, 23, 59, 46 + index)
            }
          })
          if (messages.length) {
            const result = await api.threads.appendMessages(id, messages)
            if (result.count !== messages.length) throw new Error("Incomplete fixture persistence")
          }
        }
        return ids
      },
      { workspace, titles }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    const clickThread = async (title: string): Promise<void> => {
      const target = page!.getByText(title, { exact: true }).first()
      const showMore = page!.getByRole("button", { name: /^展开显示/ }).first()
      await until(async () => {
        if (await target.isVisible()) return true
        if (await showMore.isVisible()) await showMore.click()
        return false
      }, `sidebar shows ${title}`)
      await target.evaluate((element) => {
        element.addEventListener(
          "click",
          () => {
            performance.clearMarks("chat-navigation-click")
            performance.mark("chat-navigation-click")
          },
          { once: true, capture: true }
        )
      })
      await target.click({ timeout: 30_000 })
      const kind = Object.entries(titles).find(([, value]) => value === title)![0]
      await page!.locator(`[data-chat-thread-id="${threadIds[kind]}"]`).waitFor()
    }
    // Warm the same cached snapshots that were expensive on every thread remount.
    for (const [kind, last] of [
      ["cached", 79],
      ["folded", 1],
      ["history", 319]
    ] as const) {
      await clickThread(titles[kind])
      await page.locator(`[data-chat-message-id="${kind}-${last}"]`).waitFor()
    }
    await page.mouse.move(0, 0)
    await expectMessageTime(page, "history-319", "2026-01-01 00:05")
    await page.reload({ waitUntil: "domcontentloaded" })
    await clickThread(titles.history)
    await expectMessageTime(page, "history-319", "2026-01-01 00:05")
    pass("full user date survives SQLite persistence and renderer reload across a year boundary")
    await clickThread(titles.running)
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("Start navigation regression stream")
    await until(async () => {
      if (
        await app!.evaluate(() =>
          Boolean((globalThis as unknown as { navigationRun?: unknown }).navigationRun)
        )
      )
        return true
      if ((await composer.inputValue()) === "Start navigation regression stream") {
        const submit = composer.locator("xpath=ancestor::form").locator('button[type="submit"]')
        if (await submit.isEnabled()) await submit.click()
      }
      return false
    }, "real UI submit reaches controlled producer")
    await page
      .locator("[data-chat-message-id]")
      .filter({ hasText: "LIVE_SEQUENCE_" })
      .first()
      .waitFor()
    pass("real transport streams after UI submission")
    const liveRow = page
      .locator("[data-chat-message-id]")
      .filter({ hasText: "LIVE_SEQUENCE_" })
      .first()
    const liveStartLabel = (await liveRow.locator("time").innerText()).trim()
    assert.match(liveStartLabel, /^开始于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    const liveMessageId = await liveRow.getAttribute("data-chat-message-id")
    assert(liveMessageId)
    const submittedUserRow = page.locator('[data-message-role="user"]').filter({
      hasText: "Start navigation regression stream"
    })
    assert.match(
      (await submittedUserRow.locator("time").innerText()).trim(),
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    )
    pass("real UI submission and streaming replies both show a full date")

    const iterations = Math.max(10, Number(process.env.CHAT_NAVIGATION_ITERATIONS) || 10)
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const kind of ["cached", "running"] as const) {
        // Locator polling can return long after a row appears. Measure readiness in the
        // renderer itself so automation backoff is not attributed to the application.
        await page.evaluate(
          ({ threadId, kind }) => {
            performance.clearMarks("chat-navigation-ready")
            let frame = 0
            let finished = false
            const check = (): void => {
              frame = 0
              if (finished) return
              const root = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
              const row =
                kind === "cached"
                  ? root?.querySelector<HTMLElement>('[data-chat-message-id="cached-79"]')
                  : Array.from(
                      root?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? []
                    ).find((candidate) => candidate.textContent?.includes("LIVE_SEQUENCE_"))
              if (
                !row ||
                row.getBoundingClientRect().height === 0 ||
                getComputedStyle(row).visibility === "hidden"
              ) {
                frame = requestAnimationFrame(check)
                return
              }
              finished = true
              observer.disconnect()
              performance.mark("chat-navigation-ready")
            }
            const observer = new MutationObserver(() => {
              if (!finished && !frame) frame = requestAnimationFrame(check)
            })
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true
            })
            frame = requestAnimationFrame(check)
            window.setTimeout(() => {
              finished = true
              observer.disconnect()
              cancelAnimationFrame(frame)
            }, 30_000)
          },
          { threadId: threadIds[kind], kind }
        )
        const started = await page.evaluate(() => performance.now())
        await clickThread(titles[kind])
        const target =
          kind === "cached"
            ? page.locator('[data-chat-message-id="cached-79"]')
            : page.locator("[data-chat-message-id]").filter({ hasText: "LIVE_SEQUENCE_" }).first()
        await target.waitFor()
        await page
          .waitForFunction(() => performance.getEntriesByName("chat-navigation-ready").length > 0)
          .catch(async (error) => {
            console.error(
              await page!.evaluate(() => ({
                now: performance.now(),
                marks: performance
                  .getEntriesByType("mark")
                  .map((mark) => ({ name: mark.name, time: mark.startTime })),
                roots: Array.from(
                  document.querySelectorAll<HTMLElement>("[data-chat-thread-id]")
                ).map((root) => ({
                  id: root.dataset.chatThreadId,
                  rows: Array.from(
                    root.querySelectorAll<HTMLElement>("[data-chat-message-id]")
                  ).map((row) => ({
                    id: row.dataset.chatMessageId,
                    height: row.getBoundingClientRect().height,
                    visibility: getComputedStyle(row).visibility
                  }))
                }))
              }))
            )
            throw error
          })
        const measurement = await page.evaluate(
          (start) => ({
            milliseconds:
              performance.getEntriesByName("chat-navigation-ready")[0].startTime -
              performance.getEntriesByName("chat-navigation-click")[0].startTime,
            interactionMilliseconds: performance.now() - start,
            mountedRows: document.querySelectorAll("[data-chat-message-id]").length
          }),
          started
        )
        timings.push({ title: titles[kind], ...measurement })
        assert(measurement.mountedRows < 40, "bounded row mounts during a running thread switch")
      }
    }
    if (process.env.CHAT_NAVIGATION_PERF_ONLY === "1") return
    const sorted = timings.map((timing) => timing.milliseconds).sort((a, b) => a - b)
    assert(
      sorted[Math.floor(sorted.length / 2)] < 1000,
      `cached switch median must stay below 1s: ${JSON.stringify(timings)}`
    )
    pass("twenty cached switches remain responsive while tokens continue")
    await expectMessageTime(page, liveMessageId, liveStartLabel)
    pass("assistant start time remains stable through streaming and twenty cached switches")
    await clickThread(titles.cached)
    await search(page, "ANCHOR_TARGET")
    await expectVisibleMatch(page, "ANCHOR_TARGET", "cached-79")
    const first = await matchSnapshot(page)
    await page.getByRole("button", { name: "下一个匹配" }).click()
    await expectVisibleMatch(page, "ANCHOR_TARGET", "cached-79")
    const second = await matchSnapshot(page)
    assert(
      (second.scrollTop ?? 0) - (first.scrollTop ?? 0) > 500,
      "next occurrence moves inside the same message"
    )
    await page.getByRole("button", { name: "上一个匹配" }).click()
    await expectVisibleMatch(page, "ANCHOR_TARGET", "cached-79")
    await until(
      async () =>
        Math.abs(((await matchSnapshot(page)).scrollTop ?? 0) - (first.scrollTop ?? 0)) < 4,
      "previous occurrence restores its exact position"
    )
    await page.screenshot({ path: join(artifacts, "specific-occurrence.png") })
    pass("search next/previous centers the exact occurrence in a tall virtual row")

    await clickThread(titles.folded)
    await search(page, "FOLDED_TARGET")
    await expectVisibleMatch(page, "FOLDED_TARGET", "folded-1")
    assert.equal(await page.getByRole("button", { name: "展开全文", exact: true }).count(), 1)
    assert.equal(await page.locator("[data-chat-search-context-key]").count(), 1)
    await page.screenshot({ path: join(artifacts, "expanded-assistant.png") })
    pass("completed folded assistant content anchors through a bounded context")

    for (const name of ["文件预览", "Git 面板", "工作目录"]) {
      const toggle = page.getByRole("button", { name, exact: true })
      await toggle.click()
      await until(
        async () => (await toggle.getAttribute("aria-pressed")) === "true",
        `${name} opens`
      )
      assert.equal((await matchSnapshot(page)).text, "FOLDED_TARGET")
    }
    pass("file preview and Git panel switches preserve the active search during streaming")

    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => {
          ;(window as unknown as { navigationCopiedText: string }).navigationCopiedText = text
        }
      })
    })
    const foldedRow = page.locator('[data-chat-message-id="folded-1"]')
    await foldedRow.hover()
    await foldedRow.getByRole("button", { name: "复制消息", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { navigationCopiedText: string }).navigationCopiedText
      ),
      `${"x".repeat(20_000)}\n\nFOLDED_TARGET\n\n${"y".repeat(80_000)}`
    )
    pass("copy uses the full original answer without inserting search context")

    await clickThread(titles.history)
    assert.equal(await page.locator('[data-chat-message-id="history-5"]').count(), 0)
    await search(page, "HIDDEN_E2E_REASONING")
    await until(async () => (await matchSnapshot(page)).status?.includes("无结果") ?? false,
      "hidden reasoning is absent from durable results")
    await search(page, "VISIBLE_E2E_REPLY")
    await expectVisibleMatch(page, "VISIBLE_E2E_REPLY", "history-6")
    pass("durable search omits hidden reasoning while revealing its visible reply")
    await search(page, "HISTORICAL_TARGET")
    await expectVisibleMatch(page, "HISTORICAL_TARGET", "history-5")
    await page.screenshot({ path: join(artifacts, "durable-history.png") })
    pass("durable search loads an absent historical page through IPC and Worker")
    await search(page, "Fixture history 0.")
    await expectVisibleMatch(page, "Fixture history 0.", "history-0")
    await expectMessageTime(page, "history-0", "开始于 2025-12-31 23:59")
    pass("assistant date survives durable history search through IPC and hydration Worker")
    await search(page, "USER_BODY_TARGET")
    await expectVisibleMatch(page, "USER_BODY_TARGET", "history-319")
    pass("collapsed user message expands before highlighting")
    await expectMessageTime(page, "history-319", "2026-01-01 00:05")
    const userRow = page.locator('[data-chat-message-id="history-319"]')
    await userRow.hover()
    await userRow.getByRole("button", { name: "编辑后重新发送", exact: true }).click()
    assert.equal(
      await page.locator("textarea.composer-textarea").inputValue(),
      `${"Long user body line\n".repeat(100)}USER_BODY_TARGET`
    )
    await page.locator("textarea.composer-textarea").fill("")
    pass("editing a search result restores the original user message")

    await search(page, "HISTORICAL_TARGET")
    await clickThread(titles.cached)
    await page.locator('[data-chat-message-id="cached-79"]').waitFor()
    assert.equal(await page.getByPlaceholder("在当前会话中搜索").count(), 0)
    await page.waitForTimeout(500)
    assert.equal(await page.locator('[data-chat-message-id="history-5"]').count(), 0)
    pass("switching tasks cancels the previous search UI without foreign rows")

    const dialog = page.getByRole("dialog", { name: "搜索会话" })
    const globalInput = dialog.getByRole("combobox", { name: "搜索会话" })
    const beforeGlobalSearch = await app.evaluate(() =>
      (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun.count
    )
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("HISTORICAL_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    assert(
      (await app.evaluate(() =>
        (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun.count
      )) > beforeGlobalSearch,
      "the background stream advances while the cross-conversation search runs"
    )
    pass("global search returns saved history while a background chat streams")

    const emitted = await app.evaluate(({ webContents }) => {
      const run = (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun
      clearInterval(run.timer)
      webContents.fromId(run.senderId)?.send(run.channel, {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id: "navigation-live",
              content: `\n\n${"x".repeat(10_000)}\n\nCOMPLETED_MIDDLE_TARGET\n\n${"y".repeat(60_000)}\n\nNAVIGATION_STREAM_COMPLETE`
            }
          },
          { langgraph_node: "agent" }
        ]
      })
      return run.count
    })
    assert(emitted > 20, "background producer continued throughout navigation")
    await clickThread(titles.running)
    await page
      .locator("[data-chat-message-id]")
      .filter({ hasText: "NAVIGATION_STREAM_COMPLETE" })
      .first()
      .waitFor()
    pass("background stream continues and remains visible after returning")
    const completedMessageId = await page
      .locator("[data-chat-message-id]")
      .filter({ hasText: "NAVIGATION_STREAM_COMPLETE" })
      .first()
      .getAttribute("data-chat-message-id")
    assert(completedMessageId)
    await search(page, "COMPLETED_MIDDLE_TARGET")
    await expectVisibleMatch(page, "COMPLETED_MIDDLE_TARGET", completedMessageId)
    await app.evaluate(({ webContents }) => {
      const run = (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun
      webContents.fromId(run.senderId)?.send(run.channel, { type: "done" })
    })
    await expectVisibleMatch(page, "COMPLETED_MIDDLE_TARGET", completedMessageId)
    pass("stream completion preserves the bounded search context and active match")
    await expectMessageTime(page, completedMessageId, liveStartLabel)
    pass("stream completion preserves the original assistant start time")
    await app.evaluate(({ ipcMain }, delayedThreadId) => {
      const name = "threads:search-summary"
      const routes = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, result: { threadId: string }) => unknown>
      })._invokeHandlers
      const original = routes.get(name)!
      let armed = true
      ipcMain.removeHandler(name)
      ipcMain.handle(name, async (event, result) => {
        if (armed && result.threadId === delayedThreadId) {
          armed = false
          await new Promise<void>((resolve) => {
            ;(globalThis as { releaseSearchSummary?: () => void }).releaseSearchSummary = resolve
          })
        }
        return original(event, result)
      })
    }, threadIds.history)
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("HISTORICAL_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).click()
    await until(() => app!.evaluate(() =>
      Boolean((globalThis as { releaseSearchSummary?: () => void }).releaseSearchSummary)
    ), "older summary request in flight")
    await globalInput.fill("navigation e2e folded")
    await dialog.locator(`[data-search-thread="${threadIds.folded}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "detached" })
    await page.locator(`[data-chat-thread-id="${threadIds.folded}"]`).waitFor()
    await app.evaluate(() => {
      const test = globalThis as { releaseSearchSummary?: () => void }
      test.releaseSearchSummary?.()
      delete test.releaseSearchSummary
    })
    await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement)
    assert.equal(await page.getByPlaceholder("在当前会话中搜索").count(), 0)
    pass("a slow obsolete summary does not block the next search or steal the chat input focus")
    const testThreads = await page.evaluate(async () => {
      const api = (window as unknown as { api: FixtureApi }).api
      const title = await api.threads.create({ title: "PAGE_SELECTION_MARKER", agentMode: "normal" })
      const body = await api.threads.create({ title: "Later result", agentMode: "normal" })
      const titleId = title.thread_id ?? title.id!
      const bodyId = body.thread_id ?? body.id!
      await api.threads.appendMessages(bodyId, [{
        id: "later-body", role: "assistant", content: "PAGE_SELECTION_MARKER",
        created_at: new Date()
      }])
      return { titleId, bodyId }
    })
    await app.evaluate(({ ipcMain }, { dbPath, ...ids }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(dbPath, { timeout: 4000 })
      try {
        db.prepare("UPDATE threads SET updated_at = 1 WHERE thread_id = ?").run(ids.titleId)
      } finally {
        db.close()
      }
      const name = "threads:search-continue"
      const original = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, cursor: string) => unknown>
      })._invokeHandlers.get(name)!
      ipcMain.removeHandler(name)
      let armed = true
      ipcMain.handle(name, async (event, cursor) => {
        if (armed) {
          armed = false
          await new Promise<void>((resolve) => {
            ;(globalThis as { continueSearchPage?: () => void }).continueSearchPage = resolve
          })
        }
        return original(event, cursor)
      })
    }, { ...testThreads, dbPath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite") })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("PAGE_SELECTION_MARKER")
    const stableResult = dialog.locator(`[data-search-thread="${testThreads.titleId}"]`)
    await stableResult.waitFor()
    assert.match((await stableResult.getAttribute("class")) ?? "", /\sbg-muted(?:\s|$)/)
    await until(() => app!.evaluate(() =>
      Boolean((globalThis as { continueSearchPage?: () => void }).continueSearchPage)
    ), "delayed body result page")
    await app.evaluate(() =>
      (globalThis as { continueSearchPage?: () => void }).continueSearchPage?.()
    )
    await dialog.locator(`[data-search-thread="${testThreads.bodyId}"]`).waitFor()
    assert.match((await stableResult.getAttribute("class")) ?? "", /\sbg-muted(?:\s|$)/)
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "detached" })
    await page.locator(`[data-chat-thread-id="${testThreads.titleId}"]`).waitFor()
    pass("a newer body result arriving after a title result preserves the selected conversation")
    await app.evaluate(({ ipcMain }, { dbPath, threadId }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(dbPath, { timeout: 4000 })
      try {
        db.prepare("UPDATE thread_messages SET ordinal = 1 WHERE thread_id = ? AND message_id = 'later-body'")
          .run(threadId)
        db.prepare(`INSERT INTO thread_messages
          (thread_id,message_id,role,content_json,created_at,ordinal,goal_id)
          VALUES (?,'delayed-goal','assistant',?,2,0,'delayed-goal')`)
          .run(threadId, JSON.stringify("Alternate durable anchor"))
        db.prepare(`INSERT INTO thread_goal_events(thread_id,goal_id,message,created_at)
          VALUES (?,'delayed-goal','__cmb_goal_user_message__:/goal DELAYED_GOAL_VISIBLE',2)`)
          .run(threadId)
      } finally {
        db.close()
      }
      const name = "threads:goalEvents"
      const original = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, id: string, options: unknown) => unknown>
      })._invokeHandlers.get(name)!
      ipcMain.removeHandler(name)
      let armed = true
      let failedOnce = false
      ipcMain.handle(name, async (event, id, options) => {
        if (!failedOnce && id === threadId) {
          failedOnce = true
          throw new Error("Retryable Goal restoration fixture")
        }
        if (armed && id === threadId) {
          armed = false
          await new Promise<void>((resolve) => {
            ;(globalThis as { releaseGoalHistory?: () => void }).releaseGoalHistory = resolve
          })
        }
        return original(event, id, options)
      })
    }, { threadId: testThreads.bodyId, dbPath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite") })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("PAGE_SELECTION_MARKER")
    await dialog.locator(`[data-search-thread="${testThreads.bodyId}"]`).click()
    await dialog.waitFor({ state: "detached" })
    await page.locator('[data-chat-message-id="later-body"]').waitFor()
    await until(() => app!.evaluate(() =>
      Boolean((globalThis as { releaseGoalHistory?: () => void }).releaseGoalHistory)
    ), "Goal restoration in flight after durable first paint")
    assert.equal(await page.getByPlaceholder("在当前会话中搜索").count(), 0)
    await app.evaluate(() =>
      (globalThis as { releaseGoalHistory?: () => void }).releaseGoalHistory?.()
    )
    await expectVisibleMatch(page, "PAGE_SELECTION_MARKER", "later-body")
    await page.getByText("DELAYED_GOAL_VISIBLE", { exact: false }).last().waitFor()
    await page.getByPlaceholder("在当前会话中搜索").press("Escape")
    pass("exact global navigation waits while a failed Goal history read retries after first paint")
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+f" : "Control+Shift+f")
    await globalInput.fill("HISTORICAL_TARGET")
    const historyHit = dialog.locator(`[data-search-thread="${threadIds.history}"]`)
    await historyHit.waitFor()
    const resultBounds = await historyHit.boundingBox()
    const kindBounds = await historyHit.getByText("正文", { exact: true }).boundingBox()
    assert(
      resultBounds &&
        kindBounds &&
        kindBounds.x + kindBounds.width <= resultBounds.x + resultBounds.width,
      "a long workspace path does not clip the match kind"
    )
    await page.screenshot({ path: join(artifacts, "thread-search.png") })
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "HISTORICAL_TARGET", "history-5")
    await page.screenshot({ path: join(artifacts, "thread-search-reveal.png") })
    pass("global body search opens and highlights an unloaded historical message")
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("WIDE_WINDOW_EXACT_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "WIDE_WINDOW_EXACT_TARGET", "history-110", 350)
    pass("global exact highlight survives layout changes in a tall virtual window")
    await page.evaluate(async (threadId) => {
      const api = (window as unknown as { api: FixtureApi }).api
      await api.threads.appendMessages(threadId, [{ id: "rendered-markdown-target", role: "assistant",
        content: "Release is **very *ready*** for rollout.\n\nBuild &copy; 2026 after review.",
        created_at: new Date("2026-01-02T00:00:00Z") }])
    }, testThreads.bodyId)
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("very ready for rollout")
    await dialog.locator(`[data-search-thread="${testThreads.bodyId}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "very ready for rollout", "rendered-markdown-target")
    assert.equal(await page.locator('[data-chat-message-id="rendered-markdown-target"] strong em').textContent(), "ready")
    await page.getByPlaceholder("在当前会话中搜索").press("Escape")
    await search(page, "Build © 2026")
    await expectVisibleMatch(page, "Build © 2026", "rendered-markdown-target")
    pass("global and in-thread search locate the text produced by the real Markdown renderer")
    await page.evaluate(async (threadId) => {
      const api = (window as unknown as { api: FixtureApi }).api
      await api.threads.appendMessages(threadId, [{
        id: "horizontal-code-target", role: "assistant", created_at: new Date(),
        content: "```text\n" + "x".repeat(2_000) + " HORIZONTAL_CODE_EXACT_TARGET\n```"
      }])
    }, testThreads.bodyId)
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("HORIZONTAL_CODE_EXACT_TARGET")
    await dialog.locator(`[data-search-thread="${testThreads.bodyId}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "HORIZONTAL_CODE_EXACT_TARGET", "horizontal-code-target")
    assert(await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
      const range = [...(registry.get("chat-search-active") ?? [])][0]
      const code = range?.startContainer.parentElement?.closest("pre")
      if (!range || !code) return false
      const rect = range.getBoundingClientRect()
      const left = code.getBoundingClientRect().left + code.clientLeft
      return code.scrollLeft > 0 && rect.left >= left - 1 && rect.right <= left + code.clientWidth + 1
    }), "the exact code text must be visible inside its own horizontal scrollport")
    pass("global exact search scrolls a long code line horizontally into view")
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("FOLDED_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.folded}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "FOLDED_TARGET", "folded-1")
    pass("global search highlights the middle of a folded assistant reply")
    await app.evaluate((_electron, { databasePath, threadId }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(databasePath, { timeout: 4000 })
      try {
        db.prepare("UPDATE thread_messages SET goal_id = ?, role = 'user', content_json = ? WHERE thread_id = ? AND message_id = ?")
          .run("goal-search", JSON.stringify("[Starting active goal]\n<untrusted_objective>Legacy seed</untrusted_objective>"),
            threadId, "history-6")
        db.prepare("UPDATE thread_messages SET goal_id = ?, role = 'user', content_json = ? WHERE thread_id = ? AND message_id = ?")
          .run("other-goal-search", JSON.stringify("[Starting active goal]\n<untrusted_objective>Other seed</untrusted_objective>"),
            threadId, "history-7")
        db.prepare("UPDATE thread_messages SET role = 'user', content_json = ? WHERE thread_id = ? AND message_id = ?")
          .run(JSON.stringify("[Starting active goal]\n<untrusted_objective>GOAL_DURABLE_ONLY_PROMPT</untrusted_objective>"),
            threadId, "history-8")
        const insert = db.prepare(`INSERT INTO thread_goal_events
          (thread_id, goal_id, message, created_at, transcript_message_id) VALUES (?, ?, ?, ?, ?)`)
        insert.run(threadId, "goal-search", "__cmb_goal_user_message__:/goal GOAL_EXACT_TARGET GOAL_LOCAL_DISTINCT",
          1, "history-6")
        insert.run(threadId, "other-goal-search", "__cmb_goal_user_message__:/goal OTHER_EXACT_GOAL", 2, "history-7")
        for (let index = 0; index < 205; index += 1) {
          insert.run(threadId, null, "__cmb_goal_user_message__:/goal status", index + 2, null)
        }
        const anchorTime = db.prepare("SELECT created_at FROM thread_messages WHERE thread_id = ? AND message_id = 'history-6'")
          .get(threadId)?.created_at
        const nextTime = db.prepare("SELECT created_at FROM thread_messages WHERE thread_id = ? AND message_id = 'history-7'")
          .get(threadId)?.created_at
        if (typeof anchorTime !== "number" || typeof nextTime !== "number" || nextTime <= anchorTime + 1)
          throw new Error("Invalid durable Goal fixture timing")
        insert.run(threadId, null, "__cmb_goal_user_message__:/goal GOAL_BETWEEN_DURABLE_ROWS",
          Math.floor((anchorTime + nextTime) / 2), null)
      } finally { db.close() }
    }, { databasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"), threadId: threadIds.history })
    const hiddenPromptMatches = await globalSearchHits(page, "GOAL_DURABLE_ONLY_PROMPT")
    assert.deepEqual(hiddenPromptMatches, [], "a hidden Goal prompt without a visible event must not match")
    pass("global search excludes hidden durable Goal prompts without a visible event")
    await clickThread(titles.cached)
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("GOAL_EXACT_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await until(async () => (await matchSnapshot(page)).text === "GOAL_EXACT_TARGET", "revealed old Goal bubble")
    const pinnedGoalId = (await matchSnapshot(page)).messageId!
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("OTHER_EXACT_GOAL")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await until(async () => (await matchSnapshot(page)).text === "OTHER_EXACT_GOAL", "revealed second old Goal bubble")
    await page.getByRole("button", { name: "返回最新消息" }).click()
    await page.getByPlaceholder("在当前会话中搜索").press("Escape")
    await search(page, "GOAL_EXACT_TARGET")
    await expectVisibleMatch(page, "GOAL_EXACT_TARGET", pinnedGoalId)
    pass("returning to the latest transcript retains a Goal anchored inside that window")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("GOAL_EXACT_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "GOAL_EXACT_TARGET", pinnedGoalId)
    await search(page, "GOAL_LOCAL_DISTINCT")
    await expectVisibleMatch(page, "GOAL_LOCAL_DISTINCT", pinnedGoalId)
    pass("in-thread search finds a detached Goal bubble opened from global search")
    const readGap = page.getByRole("button", { name: "继续读取中间消息" })
    await readGap.waitFor()
    assert.equal(await readGap.isEnabled(), true)
    await readGap.click()
    await page.getByText("GOAL_BETWEEN_DURABLE_ROWS", { exact: true }).waitFor()
    await search(page, "GOAL_BETWEEN_DURABLE_ROWS")
    await until(async () => (await matchSnapshot(page)).text === "GOAL_BETWEEN_DURABLE_ROWS",
      "unanchored Goal event between two raw forward page rows")
    pass("forward paging uses the hidden durable anchor time for unanchored Goal events")
    const olderHistory = page.locator('[data-chat-history-boundary="older"]')
    await olderHistory.waitFor()
    await olderHistory.click()
    await until(() => page.locator('[data-chat-message-id="history-5"]').isVisible(),
      "older history is reachable after continuing from the hidden Goal anchor")
    pass("global Goal reveal allows forward and backward paging from a hidden durable anchor")

    const goalPagingTitle = "Goal command across a history boundary"
    const goalPagingId = await page.evaluate(async ({ title, base }) => {
      const { threads } = (window as unknown as { api: FixtureApi }).api
      const thread = await threads.create({ title, agentMode: "normal" })
      const id = thread.thread_id ?? thread.id!
      const rows = Array.from({ length: 135 }, (_, index) => ({
        id: `goal-paging-${index}`, role: index === 7 ? "user" : "assistant",
        content: index === 7 ? "/goal review report\n启动附件：DURABLE_PAGING_REPORT.md"
          : `Goal history another message ${index}`,
        created_at: new Date(base + index * 1_000)
      }))
      const persisted = await threads.appendMessages(id, rows)
      if (persisted.count !== rows.length) throw new Error("Incomplete cross-page Goal transcript")
      return id
    }, { title: goalPagingTitle, base: Date.UTC(2026, 0, 1) })
    await app.evaluate((_electron, { databasePath, threadId, time }) => {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new DatabaseSync(databasePath, { timeout: 4000 })
      try {
        db.prepare("INSERT INTO thread_goal_events (thread_id, message, created_at) VALUES (?, ?, ?)")
          .run(threadId, "__cmb_goal_user_message__:/goal review report\n启动附件：SIDECAR_PAGING_REPORT.md", time)
      } finally {
        db.close()
      }
    }, { databasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"), threadId: goalPagingId,
      time: Date.UTC(2026, 0, 1) + 6999 })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(goalPagingTitle, { exact: true }).first().click()
    await olderHistory.waitFor()
    await olderHistory.click()
    await olderHistory.waitFor({ state: "hidden" })
    await search(page, "DURABLE_PAGING_REPORT")
    await expectVisibleMatch(page, "DURABLE_PAGING_REPORT", "goal-paging-7")
    await search(page, "SIDECAR_PAGING_REPORT")
    await until(async () => (await matchSnapshot(page)).status?.includes("无结果") ?? false,
      "suppressed cross-page Goal sidecar is absent from in-thread search")
    const crossPageHits = await globalSearchHits(page, "SIDECAR_PAGING_REPORT")
    assert.deepEqual(crossPageHits, [])
    pass("unanchored Goal commands deduplicate across the page boundary and both search scopes")

    for (const tailKind of ["tool", "hidden"] as const) {
      const marker = `OLDER_VISIBLE_GAP_${tailKind}`
      const gapThreadId = await page.evaluate(async ({ tailKind, marker }) => {
        const { threads } = (window as unknown as { api: FixtureApi }).api
        const thread = await threads.create({ title: `Invisible history tail ${tailKind}`, agentMode: "normal" })
        const id = thread.thread_id ?? thread.id!
        const rows = Array.from({ length: 640 }, (_, index) => {
          const invisible = index >= 630
          const largeBody = invisible ? "z".repeat(119_900) : ""
          return {
            id: `gap-${tailKind}-${index}`,
            role: index === 6 && tailKind === "tool" ? "user"
              : invisible ? tailKind === "tool" ? "tool" : "user" : "assistant",
            content: index === 5 ? marker
              : index === 6 && tailKind === "tool"
                ? "[Starting active goal]\n<untrusted_objective>internal goal</untrusted_objective>"
              : !invisible ? `Visible history row ${index}`
              : tailKind === "tool" ? largeBody
              : `[Starting active goal]\n<untrusted_objective>${largeBody}</untrusted_objective>`,
            created_at: new Date(Date.UTC(2026, 0, 1) + index * 1_000)
          }
        })
        const persisted = await threads.appendMessages(id, rows)
        if (persisted.count !== rows.length) throw new Error("Incomplete invisible-tail transcript")
        return id
      }, { marker, tailKind })
      const firstForwardId = tailKind === "tool"
        ? await app.evaluate((_electron, { databasePath, threadId }) => {
            const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
            const db = new DatabaseSync(databasePath, { timeout: 4000 })
            try {
              const inserted = db.prepare(`INSERT INTO thread_goal_events
                (thread_id, message, created_at, transcript_message_id) VALUES (?, ?, ?, 'gap-tool-6')`)
                .run(threadId, "__cmb_goal_user_message__:/goal GOAL_AFTER_FULL_FORWARD_PAGE",
                  Date.UTC(2026, 0, 1) + 6000)
              return `goal-user-event-${inserted.lastInsertRowid}`
            } finally {
              db.close()
            }
          }, { databasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"), threadId: gapThreadId })
        : "gap-hidden-6"
      await page.getByRole("button", { name: "搜索会话", exact: true }).click()
      await globalInput.fill(marker)
      await dialog.locator(`[data-search-thread="${gapThreadId}"]`).waitFor()
      await globalInput.press("Enter")
      await dialog.waitFor({ state: "hidden" })
      await expectVisibleMatch(page, marker, `gap-${tailKind}-5`)
      const nextRow = page.locator(`[data-chat-message-id="${firstForwardId}"]`)
      assert.equal(await nextRow.isVisible(), false)
      await readGap.click()
      await until(() => nextRow.isVisible(), `initial forward page with a ${tailKind} tail`)
      if (tailKind === "tool") {
        await search(page, "GOAL_AFTER_FULL_FORWARD_PAGE")
        await expectVisibleMatch(page, "GOAL_AFTER_FULL_FORWARD_PAGE", firstForwardId)
        pass("in-thread search retains a Goal bubble beyond the local row cutoff")
      }
      await readGap.scrollIntoViewIfNeeded()
      await until(() => readGap.isEnabled(), `ready for the next ${tailKind} history page`)
      await readGap.click()
      await until(() => page.locator(`[data-chat-message-id="gap-${tailKind}-506"]`).isVisible(),
        `next forward page with a ${tailKind} tail`)
      await readGap.waitFor({ state: "hidden" })
      pass(`forward history remains reachable with a ${tailKind}-only raw tail`)
    }

    const mixedHistoryId = await page.evaluate(async () => {
      const { threads } = (window as unknown as { api: FixtureApi }).api
      const thread = await threads.create({ title: "Mixed directions past the history cap", agentMode: "normal" })
      const id = thread.thread_id ?? thread.id!
      const base = Date.UTC(2026, 0, 1)
      for (let first = 0; first < 3600; first += 400) {
        const rows = Array.from({ length: 400 }, (_, offset) => {
          const index = first + offset
          return {
            id: `mixed-history-${index}`, role: "assistant",
            content: index === 2000 ? "MIXED_HISTORY_EXACT_TARGET"
              : index === 3472 ? "MIXED_HISTORY_LATEST_TAIL"
              : `Mixed history row ${index}`,
            created_at: new Date(base + index * 1000)
          }
        })
        const persisted = await threads.appendMessages(id, rows)
        if (persisted.count !== rows.length) throw new Error("Incomplete mixed history transcript")
      }
      return id
    })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("MIXED_HISTORY_EXACT_TARGET")
    await dialog.locator(`[data-search-thread="${mixedHistoryId}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "MIXED_HISTORY_EXACT_TARGET", "mixed-history-2000")
    const mixedViewport = page.locator(
      `[data-chat-thread-id="${mixedHistoryId}"] [data-radix-scroll-area-viewport]`
    ).first()
    for (const oldest of [1437, 937, 437]) {
      await olderHistory.click()
      const firstRow = page.locator(`[data-chat-message-id="mixed-history-${oldest}"]`)
      await until(async () => {
        await mixedViewport.evaluate((element) => { element.scrollTop = 0 })
        return firstRow.isVisible()
      }, `older page beginning with row ${oldest}`)
    }
    for (const first of [1809, 2309, 2809]) {
      await search(page, "MIXED_HISTORY_LATEST_TAIL")
      await expectVisibleMatch(page, "MIXED_HISTORY_LATEST_TAIL", "mixed-history-3472")
      await page.getByPlaceholder("在当前会话中搜索").press("Escape")
      await readGap.click()
      await until(() => page.locator(`[data-chat-message-id="mixed-history-${first}"]`).isVisible(),
        `forward page beginning with row ${first}`)
    }
    pass("earlier history beyond the resident cap preserves the original forward interval")

    const legacyId = await page.evaluate(async () => {
      const api = (window as unknown as { api: FixtureApi }).api
      const item = await api.threads.create({ title: "Legacy search fixture", agentMode: "normal" })
      const id = item.thread_id ?? item.id
      if (!id) throw new Error("Missing legacy thread ID")
      await api.threads.appendMessages(id, [{ id: "legacy-tail", role: "assistant", content: "Saved tail",
        created_at: new Date("2026-01-02T00:00:00Z") }])
      return id
    })
    const checkpointDirectory = join(env.CMB_COWORK_AGENT_HOME, "threads")
    mkdirSync(checkpointDirectory, { recursive: true })
    await app.evaluate((_electron, { path, id, mainDatabasePath }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const main = new sqlite.DatabaseSync(mainDatabasePath, { timeout: 4000 })
      try {
        main.prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?").run(id)
      } finally {
        main.close()
      }
      const db = new sqlite.DatabaseSync(path)
      try {
        db.exec(`CREATE TABLE checkpoints (
          thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, parent_checkpoint_id TEXT,
          type TEXT, checkpoint TEXT, metadata TEXT, checkpoint_ts TEXT,
          PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
        ); CREATE TABLE writes (
          thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, task_id TEXT, idx INTEGER,
          channel TEXT, type TEXT, value TEXT,
          PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
        );`)
        const ts = "2026-01-01T00:00:00Z"
        const checkpoint = { v: 1, id: "legacy-cp", ts, channel_values: { messages: [
          { id: "legacy-prefix", type: "human", content: "LEGACY_PREFIX_TARGET" }
        ] }, channel_versions: { messages: 1 }, versions_seen: {} }
        db.prepare("INSERT INTO checkpoints VALUES (?, '', ?, NULL, 'json', ?, ?, ?)").run(
          id, checkpoint.id, JSON.stringify(checkpoint), JSON.stringify({ source: "loop", step: 1 }), ts)
      } finally { db.close() }
    }, { path: join(checkpointDirectory, `${legacyId}.sqlite.bak`), id: legacyId,
      mainDatabasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite")
    })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("LEGACY_PREFIX_TARGET")
    const legacyResult = dialog.locator(`[data-search-thread="${legacyId}"]`)
    await until(async () => {
      if (await legacyResult.isVisible()) return true
      const label = await dialog.getByRole("status").textContent()
      if (label?.includes("部分历史")) await dialog.getByRole("button", { name: "刷新", exact: true }).click()
      return false
    }, "searchable legacy checkpoint prefix", 30_000)
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "LEGACY_PREFIX_TARGET", "legacy-prefix")
    pass("global search backfills a recoverable legacy checkpoint alongside saved messages")
    const originalLegacyTimestamp = Date.UTC(2025, 11, 31, 12)
    await app.evaluate((_electron, { path, id, mainDatabasePath, originalLegacyTimestamp }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(path)
      try {
        const ts = "2026-01-03T00:00:00Z"
        const checkpoint = { v: 1, id: "later-cp", ts, channel_values: { messages: [
          { id: "legacy-tail", type: "ai", content: "Saved tail" },
          { id: "later-checkpoint-only", type: "human", content: "NEW_CHECKPOINT_ONLY_TARGET" }
        ] }, channel_versions: { messages: 2 }, versions_seen: {} }
        db.prepare("INSERT INTO checkpoints VALUES (?, '', ?, NULL, 'json', ?, ?, ?)").run(
          id, checkpoint.id, JSON.stringify(checkpoint), JSON.stringify({ source: "loop", step: 2 }), ts)
      } finally { db.close() }
      const mainDb = new sqlite.DatabaseSync(mainDatabasePath, { timeout: 4000 })
      try {
        mainDb.prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?").run(
          JSON.stringify({ messageTimes: { "legacy-prefix": { start_at: originalLegacyTimestamp } } }), id
        )
      } finally {
        mainDb.close()
      }
    }, { path: join(checkpointDirectory, `${legacyId}.sqlite.bak`), id: legacyId,
      mainDatabasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"), originalLegacyTimestamp
    })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("NEW_CHECKPOINT_ONLY_TARGET")
    await until(async () => {
      if (await legacyResult.isVisible()) return true
      const label = await dialog.getByRole("status").textContent()
      if (label?.includes("部分历史")) await dialog.getByRole("button", { name: "刷新", exact: true }).click()
      return false
    }, "changed checkpoint is revalidated and the newly saved row becomes searchable", 30_000)
    await globalInput.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("Legacy search fixture")
    await dialog.locator(`[data-search-thread="${legacyId}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await page.locator('[data-chat-message-id="legacy-prefix"]').waitFor()
    const legacyOrder = await app.evaluate((_electron, { path, threadId }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(path, { readOnly: true })
      try {
        return db.prepare("SELECT message_id, start_at FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
          .all(threadId)
      } finally { db.close() }
    }, { path: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"), threadId: legacyId })
    assert.deepEqual(legacyOrder.map((row) => row.message_id), ["legacy-prefix", "legacy-tail", "later-checkpoint-only"])
    assert.equal(legacyOrder[0].start_at, originalLegacyTimestamp)
    pass("opening a newer checkpoint restores legacy timing without reordering the completed transcript")

    const oversizedLegacyId = await page.evaluate(async () => {
      const api = (window as unknown as { api: FixtureApi }).api
      const item = await api.threads.create({ title: "Oversized backup recovery fixture", agentMode: "normal" })
      return item.thread_id ?? item.id
    })
    assert(oversizedLegacyId)
    await app.evaluate((_electron, { original, path, id, mainDatabasePath }) => {
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs")
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const main = new sqlite.DatabaseSync(mainDatabasePath, { timeout: 4000 })
      try {
        main.prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?").run(id)
      } finally {
        main.close()
      }
      fs.copyFileSync(original, path)
      const db = new sqlite.DatabaseSync(path)
      try {
        db.exec("DELETE FROM checkpoints; CREATE TABLE padding (data BLOB); INSERT INTO padding VALUES (zeroblob(9437184))")
        const ts = "2026-01-04T00:00:00Z"
        const checkpoint = { v: 1, id: "large-backup", ts, channel_values: { messages: [
          { id: "large-backup-message", type: "human", content: "LARGE_BACKUP_VISIBLE_QUESTION" }
        ] }, channel_versions: { messages: 1 }, versions_seen: {} }
        db.prepare("INSERT INTO checkpoints VALUES (?, '', ?, NULL, 'json', ?, ?, ?)").run(
          id, checkpoint.id, JSON.stringify(checkpoint), JSON.stringify({ source: "loop", step: 1 }), ts)
      } finally { db.close() }
    }, {
      original: join(checkpointDirectory, `${legacyId}.sqlite.bak`),
      path: join(checkpointDirectory, `${oversizedLegacyId}.sqlite.bak`),
      mainDatabasePath: join(env.CMB_COWORK_AGENT_HOME, "cmbcoworkagent.sqlite"),
      id: oversizedLegacyId
    })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("Oversized backup recovery fixture")
    await dialog.locator(`[data-search-thread="${oversizedLegacyId}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await page.locator('[data-chat-message-id="large-backup-message"]').waitFor()
    pass("opening a backup-only conversation through the application recovers an over-budget source")

    await clickThread(titles.history)
    const workspaceButton = page.getByRole("button", { name: "工作目录", exact: true })
    if (await workspaceButton.getAttribute("aria-pressed") !== "true") await workspaceButton.click()
    const filesHeader = page.getByRole("button", { name: /^文件(?:\s*\d+)?$/ }).first()
    if (await filesHeader.getAttribute("aria-expanded") !== "true") await filesHeader.click()
    await page.getByText("search-preview.md", { exact: true }).last().click()
    const returnToChat = page.getByRole("button", { name: "返回对话", exact: true })
    await returnToChat.waitFor()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+f" : "Control+Shift+f")
    await globalInput.fill("HISTORICAL_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await returnToChat.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "HISTORICAL_TARGET", "history-5")
    await page.screenshot({ path: join(artifacts, "thread-search-file-tab.png") })
    pass("global search switches a file tab to chat and highlights the chosen message")
    await page.evaluate((threadId) => {
      window.dispatchEvent(new CustomEvent("resource-preview:open", {
        detail: { threadId, filePath: "search-preview.md" }
      }))
    }, threadIds.history)
    const fullPreview = page.getByRole("button", { name: "全屏预览", exact: true })
    await fullPreview.waitFor()
    await fullPreview.click()
    await page.locator(`[data-chat-thread-id="${threadIds.history}"]`).waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("HISTORICAL_TARGET")
    await dialog.locator(`[data-search-thread="${threadIds.history}"]`).waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "HISTORICAL_TARGET", "history-5")
    pass("a same-conversation search hit restores chat from fullscreen file preview")

    const largeSearchThreadId = await page.evaluate(async () => {
      const api = (window as unknown as { api: FixtureApi }).api
      const thread = await api.threads.create({ title: "Large Markdown search fixture", agentMode: "normal" })
      const id = thread.thread_id ?? thread.id
      if (!id) throw new Error("Missing large-search fixture ID")
      const content = "Critical **OFFLOADED_NEEDLE**: " + "plain paragraph text ".repeat(5900)
      await api.threads.appendMessages(id, Array.from({ length: 4 }, (_, index) => ({
        id: `large-search-${index}`, role: "assistant", content, created_at: new Date(index + 1)
      })))
      return id
    })
    await app.evaluate(() => {
      const state = { ticks: 0, timer: setInterval(() => { state.ticks += 1 }, 10) }
      ;(globalThis as { durableSearchTicker?: typeof state }).durableSearchTicker = state
    })
    const heavySearch = await page.evaluate(async (id) => {
      const api = (window as unknown as { api: FixtureApi }).api
      const started = performance.now()
      const page = await api.threads.searchMessages(id, "OFFLOADED_NEEDLE")
      return { matches: page.matches.length, elapsed: performance.now() - started }
    }, largeSearchThreadId)
    const searchTicks = await app.evaluate(() => {
      const state = (globalThis as { durableSearchTicker?: {
        ticks: number; timer: ReturnType<typeof setInterval>
      } }).durableSearchTicker!
      clearInterval(state.timer)
      return state.ticks
    })
    assert.equal(heavySearch.matches, 4)
    assert(heavySearch.elapsed < 100 || searchTicks >= 3, "the main process remains responsive during Markdown projection")
    pass("four large persisted Markdown rows are searched while the Electron main ticker continues")
    const layoutStreamTitle = "Navigation E2E live layout"
    const layoutStreamThreadId = await page.evaluate(async ({ title, workspace }) => {
      const api = (window as unknown as { api: FixtureApi }).api
      const thread = await api.threads.create({ title, workspacePath: workspace, agentMode: "normal" })
      const id = thread.thread_id ?? thread.id
      if (!id) throw new Error("Missing streaming layout fixture ID")
      await api.workspace.set(id, workspace)
      await api.threads.appendMessages(id, Array.from({ length: 45 }, (_, index) => ({
        id: `layoutStream-${index}`, role: "assistant", created_at: new Date(index + 1),
        content: index === 44 ? "Saved LAYOUT_STREAM_EXACT_TARGET" : `Saved layout message ${index}`
      })))
      return id
    }, { title: layoutStreamTitle, workspace })
    await app.evaluate((_electron, threadId) => {
      ;(globalThis as { layoutStreamThreadId?: string }).layoutStreamThreadId = threadId
    }, layoutStreamThreadId)
    const layoutStreamResult = dialog.locator(`[data-search-thread="${layoutStreamThreadId}"]`)
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill(layoutStreamTitle)
    await layoutStreamResult.click()
    await dialog.waitFor({ state: "hidden" })
    await page.locator('[data-chat-message-id="layoutStream-44"]').waitFor()
    const streamComposer = page.locator("textarea.composer-textarea")
    await streamComposer.fill("Start the viewport growth fixture")
    await streamComposer.locator("xpath=ancestor::form").locator('button[type="submit"]').click()
    await page.getByText("Progress line 1 with details", { exact: true }).waitFor()
    const streamEvents = () => app!.evaluate(() =>
      (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun.count
    )
    const beforeReveal = await streamEvents()
    await page.getByRole("button", { name: "搜索会话", exact: true }).click()
    await globalInput.fill("LAYOUT_STREAM_EXACT_TARGET")
    await layoutStreamResult.waitFor()
    await globalInput.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await expectVisibleMatch(page, "LAYOUT_STREAM_EXACT_TARGET", "layoutStream-44", 350)
    assert((await streamEvents()) > beforeReveal + 8, "the same transcript must grow while revealing a match")
    assert.equal(await page.getByText("命中内容已变化，或无法定位。请重新搜索").count(), 0)
    await app.evaluate(({ webContents }) => {
      const run = (globalThis as unknown as { navigationRun: ControlledRun }).navigationRun
      clearInterval(run.timer)
      webContents.fromId(run.senderId)?.send(run.channel, { type: "done" })
    })
    pass("global exact highlight completes while the same transcript keeps growing")

    await runProjectSearchScenarios(app, page, env.CMB_COWORK_AGENT_HOME, workspace, pass, projectSearchFixture)

    assert.deepEqual(pageErrors, [], "no renderer errors")
    assert.equal(Object.keys(threadIds).length, 4)
    console.log(JSON.stringify({ timings, emitted, checks }, null, 2))
  } catch (error) {
    if (page) {
      const snapshot = await matchSnapshot(page).catch(() => null)
      const layout = await page
        .evaluate(() => {
          const row = document.querySelector<HTMLElement>('[data-chat-message-id="folded-1"]')
          const viewport = row?.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
          const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
          const range = [...(registry.get("chat-search-active") ?? [])][0]
          return {
            mounted: Boolean(row),
            containsTarget: row?.textContent?.includes("FOLDED_TARGET"),
            foldedButtons: row?.querySelectorAll("[data-chat-search-expand-markdown]").length,
            range: range?.getBoundingClientRect().toJSON(),
            row: row?.getBoundingClientRect().toJSON(),
            viewport: viewport?.getBoundingClientRect().toJSON(),
            scrollTop: viewport?.scrollTop,
            scrollHeight: viewport?.scrollHeight
          }
        })
        .catch(() => null)
      writeFileSync(
        join(artifacts, "failure-details.json"),
        JSON.stringify({ snapshot, layout, diagnosticOutput }, null, 2)
      )
      console.error(JSON.stringify({ snapshot, layout }))
    }
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    writeFileSync(
      join(artifacts, "results.json"),
      JSON.stringify({ checks, timings, pageErrors }, null, 2)
    )
    if (app) {
      await app
        .evaluate(() => {
          const run = (globalThis as unknown as { navigationRun?: ControlledRun }).navigationRun
          if (run) clearInterval(run.timer)
        })
        .catch(() => {})
      await app.close()
    }
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

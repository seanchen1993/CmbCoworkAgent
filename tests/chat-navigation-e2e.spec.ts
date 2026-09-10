/** Real Electron / React / preload / SQLite / hydration Worker navigation regression.
 * Only the model producer is replaced at agent:invoke with a controlled continuous stream.
 * Run: npm run test:chat-navigation:e2e
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright"

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
      visible: Boolean(rect && box && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
      scrollTop: viewport?.scrollTop,
      status: document.querySelector("[data-chat-search-overlay] [aria-live]")?.textContent
    }
  })
}

async function expectVisibleMatch(page: Page, text: string, messageId: string): Promise<void> {
  let stableChecks = 0
  await until(async () => {
    const snapshot = await matchSnapshot(page)
    stableChecks =
      snapshot.visible && snapshot.text === text && snapshot.messageId === messageId
        ? stableChecks + 1
        : 0
    return stableChecks >= 3
  }, `visible ${text} in ${messageId}`)
}

async function expectMessageTime(page: Page, messageId: string, expected: string): Promise<void> {
  const timestamp = page.locator(`[data-chat-message-id="${messageId}"] time`)
  await timestamp.waitFor({ state: "attached" })
  assert.equal((await timestamp.innerText()).trim(), expected)
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

async function main(): Promise<void> {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-chat-navigation-e2e-"))
  mkdirSync(artifacts, { recursive: true })
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
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
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const pageErrors: string[] = []
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
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [
        join(applicationRoot, "out/main/index.js"),
        `--user-data-dir=${join(isolated, "electron")}`
      ],
      cwd: applicationRoot,
      env,
      timeout: 60_000
    })
    page = await getAppPage(app)
    await page.addInitScript("window.__name = (value) => value")
    await page.bringToFront()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners("agent:invoke")
      ipcMain.on("agent:invoke", (event, request) => {
        const channel = `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
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
                  kwargs: { id: "navigation-live", content: `LIVE_SEQUENCE_${run.count} ` }
                },
                { langgraph_node: "agent" }
              ]
            })
          }, 40)
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
            if (kind === "history" && index === count - 1) {
              role = "user"
              content = `${"Long user body line\n".repeat(100)}USER_BODY_TARGET`
            }
            return {
              id: `${kind}-${index}`,
              role,
              content,
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
        JSON.stringify({ snapshot, layout }, null, 2)
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

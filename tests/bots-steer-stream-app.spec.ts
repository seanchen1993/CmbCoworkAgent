/** Actual Electron/IPC/runtime/SQLite with a controlled streaming model.
 * Holds both sides of a steer boundary so transient duplicate bubbles cannot
 * disappear before assertions. No real model, gateway or user profile is used. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type Page } from "playwright"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"

async function main() {
  const out = botTestAppOutput()
  const profile = await mkdtemp(join(tmpdir(), "bot-steer-profile-"))
  const evidence = await mkdtemp(join(out, "artifacts/steer-stream-"))
  const gates = new Map<string, () => void>()
  const requests: string[] = [],
    errors: string[] = [],
    results: unknown[] = []
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, page: Page | undefined
  let passed = false
  const model = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const user = [...body.messages].reverse().find((m: any) => m.role === "user")
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content)
      // Work-result reporting includes the original request inside its JSON.
      // It is a new notification, not another held user execution.
      const match = text?.trimStart().startsWith('{"workId":')
        ? null
        : /STEER_(START|SECOND)_(bot-main|bot-work)/.exec(text ?? "")
      const stage = match?.[1],
        kind = match?.[2]
      const marker = match ? `${stage === "START" ? "BEFORE" : "AFTER"}_${kind}` : "READY"
      requests.push(match?.[0] ?? "other")
      const reply = {
        id: match ? "reused-provider-id" : `ready-${requests.length}`,
        object: "chat.completion.chunk"
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const frame = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ ...reply, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      frame({ content: marker })
      if (match) await new Promise<void>((done) => gates.set(`${stage}_${kind}`, done))
      frame({}, "stop")
      res.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      res.end()
    }
  })
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done))
  const binary = createRequire(import.meta.url)("electron") as string
  const env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP"
  ]) {
    env[key] = join(profile, key)
    await mkdir(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(profile, "agent"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  try {
    app = await _electron.launch({
      executablePath: binary,
      cwd: resolve("."),
      env,
      args: [join(out, "main/index.js"), `--user-data-dir=${join(profile, "electron")}`],
      timeout: 60000
    })
    await app.context().addInitScript("globalThis.__name = (value) => value")
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on(
        "data",
        (chunk) => void writeFile(join(profile, "electron.log"), chunk, { flag: "a" })
      )
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
        window.setSize(1280, 900)
      }
    })
    await page.evaluate(
      async (baseUrl) => {
        ;(globalThis as any).__name = (x: any) => x
        const api = (window as any).api
        await api.models.setCustomConfig({
          id: "steer-test",
          name: "Local streaming fixture",
          baseUrl,
          model: "local-fixture",
          apiKey: "synthetic-only",
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await api.models.setDefault("custom:steer-test")
      },
      `http://127.0.0.1:${(model.address() as any).port}/v1`
    )
    const idle = () =>
      waitForBotAppState(
        page!,
        async () =>
          !(await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
            ["queued", "running", "waiting_user"].includes(t.state)
          )
      )
    const settle = () =>
      page!.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    await page.getByText("Bots", { exact: true }).first().click()
    for (const kind of ["bot-main", "bot-work"]) {
      const bot = await page.evaluate(
        async (name) =>
          (window as any).api.bots.create({
            name,
            instructions: "按要求回答，并接收同一运行中的补充。",
            color: "#168e87",
            modelRef: "custom:steer-test"
          }),
        `补充交互验收-${kind}`
      )
      await idle()
      await page.getByText(bot.name, { exact: true }).first().click()
      let threadId = bot.threadId
      if (kind === "bot-work") {
        const result = await page.evaluate(
          async (botId) =>
            (window as any).api.bots.works.create({
              botId,
              operationId: crypto.randomUUID(),
              title: "流式补充验收任务",
              goal: "STEER_START_bot-work"
            }),
          bot.id
        )
        threadId = result.work.threadId
        await page.locator(".bot-work-row").filter({ hasText: "流式补充验收任务" }).click()
      }
      const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
      const input = chat.locator('textarea, [role="textbox"][contenteditable="true"]').last()
      const fill = async (text: string) => {
        await input.fill(text)
        await settle()
      }
      // Observe every DOM update, not just the settled/final transcript.
      await chat.evaluate((element, kind) => {
        const state = { samples: 0, maxBefore: 0, maxAfter: 0, duplicates: [] as unknown[] }
        const sample = () => {
          const rows = [...element.querySelectorAll('[data-message-bubble="assistant"]')]
          state.samples++
          state.maxBefore = Math.max(
            state.maxBefore,
            rows.filter((row) => row.textContent?.includes(`BEFORE_${kind}`)).length
          )
          state.maxAfter = Math.max(
            state.maxAfter,
            rows.filter((row) => row.textContent?.includes(`AFTER_${kind}`)).length
          )
          const beforeRows = rows.filter((row) => row.textContent?.includes(`BEFORE_${kind}`))
          if (beforeRows.length > 1 && state.duplicates.length < 5)
            state.duplicates.push(
              beforeRows.map((row) => ({
                id: row.closest("[data-chat-message-id]")?.getAttribute("data-chat-message-id"),
                text: row.textContent
              }))
            )
        }
        const observer = new MutationObserver(sample)
        observer.observe(element, { childList: true, subtree: true, characterData: true })
        ;(window as any).__steerObservation = {
          state,
          stop: () => {
            sample()
            observer.disconnect()
          }
        }
        sample()
      }, kind)
      if (kind === "bot-main") {
        await fill(`STEER_START_${kind}`)
        await chat.locator('button[type="submit"]').last().click()
      }
      await chat.getByText(`BEFORE_${kind}`, { exact: true }).waitFor()
      await fill(`WITHDRAW_${kind}`)
      await input.press("Enter")
      const notice = chat.locator(".bot-composer-queue")
      await notice.getByText("1 条补充待接收", { exact: true }).waitFor()
      const bounds = await notice.boundingBox(),
        inputBounds = await input.boundingBox()
      assert.ok(
        bounds && inputBounds && bounds.y > 400 && bounds.y + bounds.height <= inputBounds.y,
        "pending guidance is visible immediately above the composer"
      )
      assert.ok(
        inputBounds.y - bounds.y - bounds.height < 100,
        "notice stays close to the composer"
      )
      await notice.getByRole("button", { name: "撤回", exact: true }).click()
      await notice.waitFor({ state: "hidden" })
      for (const marker of ["FIRST", "SECOND"]) {
        await fill(`STEER_${marker}_${kind}`)
        await input.press("Enter")
      }
      await notice.getByText("2 条补充待接收", { exact: true }).waitFor()
      await page.screenshot({ path: join(evidence, `${kind}-pending.png`) })
      gates.get(`START_${kind}`)!()
      await chat.getByText(`AFTER_${kind}`, { exact: true }).waitFor()
      await notice.waitFor({ state: "hidden" })
      await settle()
      const expected = [
        `BEFORE_${kind}`,
        `STEER_FIRST_${kind}`,
        `STEER_SECOND_${kind}`,
        `AFTER_${kind}`
      ]
      for (const value of expected)
        assert.equal(await chat.getByText(value, { exact: true }).count(), 1)
      const liveOrder = await chat.evaluate((element, expected) => {
        const rows = [...element.querySelectorAll("[data-chat-message-id]")]
        return expected.map((text) => rows.findIndex((row) => row.textContent?.includes(text)))
      }, expected)
      assert.ok(
        liveOrder.every((index, position) => index >= 0 && (!position || index > liveOrder[position - 1])),
        "steer messages appear in order while the second reply is still streaming"
      )
      await page.screenshot({ path: join(evidence, `${kind}-streaming.png`) })
      gates.get(`SECOND_${kind}`)!()
      await idle()
      const observed = await page.evaluate(() => {
        const observation = (window as any).__steerObservation
        observation.stop()
        return observation.state
      })
      results.push({ kind, ...observed })
      assert.equal(observed.maxBefore, 1, "no transient duplicate before steer")
      assert.equal(observed.maxAfter, 1, "no transient duplicate after steer")
      assert.equal(
        requests.filter((r) => r === `STEER_START_${kind}`).length,
        1,
        "same run is not restarted"
      )
      await waitForBotAppState(
        page,
        async ({ threadId, expected }) => {
          const rows = await (window as any).api.threads.getMessages(threadId)
          const contents = rows.map((row: any) => row.content)
          return (
            expected.every(
              (value) => contents.filter((item: any) => item === value).length === 1
            ) &&
            expected.every(
              (value, index) =>
                !index || contents.indexOf(expected[index - 1]) < contents.indexOf(value)
            ) &&
            !contents.some((value: any) => typeof value === "string" && value.includes("WITHDRAW_"))
          )
        },
        { threadId, expected }
      )
      await page.reload()
      await page.getByText("Bots", { exact: true }).first().click()
      await page.getByText(bot.name, { exact: true }).first().click()
      if (kind === "bot-work")
        await page.locator(".bot-work-row").filter({ hasText: "流式补充验收任务" }).click()
      await chat.getByText(`AFTER_${kind}`, { exact: true }).waitFor()
      for (const value of expected)
        assert.equal(await chat.getByText(value, { exact: true }).count(), 1)
      results[results.length - 1] = {
        kind,
        ...observed,
        pendingNearComposer: true,
        withdrawal: true,
        sameRun: true,
        liveOrder: true,
        durableOrder: true,
        reload: true
      }
      console.log("PASS", kind, observed)
    }
    assert.deepEqual(errors, [])
    passed = true
  } finally {
    for (const release of gates.values()) release()
    if (!passed && page)
      await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {})
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        { model: "controlled-local-stream", passed, results, requests, errors },
        null,
        2
      )
    )
    console.log("Steer UI evidence:", evidence)
    await app?.close().catch(() => {})
    model.closeAllConnections()
    await new Promise<void>((done) => model.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

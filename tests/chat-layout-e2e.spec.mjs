import { _electron } from "playwright"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join, relative, isAbsolute } from "node:path"

// Actual composer/IPC/React integration, with an isolated profile and a deterministic producer.
// Build first. CHAT_LAYOUT_PACKAGED_EXECUTABLE optionally runs a local diagnostic ASAR instead.
const project = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const packaged = process.env.CHAT_LAYOUT_PACKAGED_EXECUTABLE
const root = resolve(process.env.CHAT_LAYOUT_APP_ROOT || project)
const artifacts = resolve(process.env.CHAT_LAYOUT_E2E_ARTIFACT_DIR || "output/chat-layout/e2e")
mkdirSync(artifacts, { recursive: true })
const profile = join(artifacts, "profile-" + Date.now())
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*)$/i.test(
      key
    )
  )
)
for (const key of [
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CMB_COWORK_AGENT_HOME",
  "TEMP",
  "TMP"
]) {
  env[key] = join(profile, key)
  mkdirSync(env[key], { recursive: true })
}
// 只修改子进程环境，确保直接使用 os.homedir() 的服务也写入本次测试目录。
env.HOME = env.USERPROFILE
Object.assign(env, {
  CMB_TASK_CARDS_MOCK: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NODE_USE_ENV_PROXY: "1",
  NO_PROXY: "localhost,127.0.0.1"
})
env.CMB_E2E_ELECTRON_BIN = require("electron")
env.CMB_E2E_DISABLE_GPU = "1"
const app = await _electron.launch({
  executablePath:
    packaged ||
    (process.platform === "win32"
      ? join(project, "tests/support/electron-launcher.cmd")
      : require("electron")),
  args: packaged
    ? ["--disable-gpu", "--in-process-gpu", `--user-data-dir=${join(profile, "electron")}`]
    : [join(root, "out/main/index.js"), `--user-data-dir=${join(profile, "electron")}`],
  cwd: root,
  env,
  timeout: 60000
})
const errors = []
let page
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api?.threads))
  const runtime = await app.evaluate(({ app, session, ipcMain }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => callback({ cancel: true })
    )
    ipcMain.removeAllListeners("agent:invoke")
    ipcMain.on("agent:invoke", (event, request) => {
      globalThis.layoutRun = {
        sender: event.sender,
        channel: `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
      }
    })
    const { homedir, tmpdir } = process.getBuiltinModule("os")
    return {
      versions: process.versions,
      packaged: app.isPackaged,
      paths: { home: homedir(), temp: tmpdir(), userData: app.getPath("userData") }
    }
  })
  for (const [name, directory] of Object.entries(runtime.paths)) {
    const withinProfile = relative(profile, directory)
    assert.ok(
      withinProfile && !withinProfile.startsWith("..") && !isAbsolute(withinProfile),
      `${name} must be isolated inside the test profile: ${directory}`
    )
  }
  const workspace = join(artifacts, "workspace")
  mkdirSync(workspace, { recursive: true })
  const threadId = await page.evaluate(
    async ({ workspace }) => {
      const thread = await window.api.threads.create({
        title: "长思考闪屏诊断",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = thread.thread_id ?? thread.id
      await window.api.workspace.set(id, workspace)
      await window.api.threads.appendMessages(
        id,
        Array.from({ length: 200 }, (_, i) => ({
          id: `layout-${i}`,
          role: i % 2 ? "assistant" : "user",
          content: `消息 ${i}：用于检查滚动位置与实际行高。\n\n第二段内容。`,
          reasoning:
            i === 199 ? "思考内容用于排查消息展开和收起的高度变化。\n\n".repeat(150) : undefined,
          created_at: new Date(),
          start_at: new Date(),
          end_at: new Date()
        }))
      )
      return id
    },
    { workspace }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("长思考闪屏诊断", { exact: true }).first().click()
  await page.locator(`[data-chat-thread-id="${threadId}"]`).waitFor()
  const final = page.locator('[data-chat-message-id="layout-199"]')
  await final.waitFor()
  await page.waitForTimeout(1000)
  const rows = await page.locator("[data-item-index]").evaluateAll((elements) =>
    elements.map((el) => ({
      index: el.dataset.itemIndex,
      height: el.getBoundingClientRect().height,
      known: Number(el.dataset.knownSize),
      margin:
        parseFloat(getComputedStyle(el).marginTop) + parseFloat(getComputedStyle(el).marginBottom)
    }))
  )
  const button = final.locator("button[aria-expanded]")
  await button.click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(artifacts, "expanded.png") })
  const viewport = page.locator("[data-chat-thread-id] [data-radix-scroll-area-viewport]").first()
  await viewport.evaluate((el) => {
    el.scrollTop = 0
  })
  await final.waitFor({ state: "detached" })
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await final.waitFor()
  await page.waitForTimeout(800)
  const restoredExpansion = await button.getAttribute("aria-expanded")
  await page.screenshot({ path: join(artifacts, "restored.png") })
  console.log(
    JSON.stringify({
      runtime,
      mountedRows: rows.length,
      maxUnmeasuredMargin: Math.max(...rows.map((row) => row.margin)),
      restoredExpansion
    })
  )
  assert.ok(rows.length > 1 && rows.length < 40)
  assert.ok(
    rows.every((row) => row.margin === 0 && Math.abs(row.height - row.known) <= 1),
    "All spacing must be included in measured boxes"
  )
  assert.equal(restoredExpansion, "true", "Expanded reasoning must survive virtual unmount")

  // Use the real composer, IPC stream adapter, ChatContainer, virtual list, and Markdown renderer.
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("开始长思考流式布局诊断")
  const submit = composer.locator("xpath=ancestor::form").locator('button[type="submit"]')
  await submit.click()
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => Boolean(globalThis.layoutRun))) break
    await page.waitForTimeout(100)
  }
  if (!(await app.evaluate(() => Boolean(globalThis.layoutRun))))
    throw new Error("Composer did not reach diagnostic stream")
  await page.evaluate(() => {
    const viewport = document.querySelector(
      "[data-chat-thread-id] [data-radix-scroll-area-viewport]"
    )
    window.layoutSamples = []
    window.layoutSampling = true
    const sample = () => {
      if (!window.layoutSampling) return
      const rect = viewport.getBoundingClientRect()
      window.layoutSamples.push({
        top: viewport.scrollTop,
        height: viewport.scrollHeight,
        viewport: viewport.clientHeight,
        visible: [...viewport.querySelectorAll("[data-chat-message-row]")].some((row) => {
          const r = row.getBoundingClientRect()
          return r.bottom > rect.top && r.top < rect.bottom
        })
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const sendReasoning = async (tick, id = "layout-live") => {
    await app.evaluate(
      (_electron, { tick, id }) => {
        const run = globalThis.layoutRun
        run.sender.send(run.channel, {
          type: "stream",
          mode: "messages",
          data: [
            {
              id: ["langchain_core", "messages", "AIMessageChunk"],
              kwargs: {
                id,
                content: "",
                additional_kwargs: {
                  reasoning_content:
                    "继续分析消息高度和滚动变化，需要保证当前显示的内容稳定。\n\n".repeat(
                      (tick + 1) * 5
                    )
                }
              }
            },
            { langgraph_node: "agent" }
          ]
        })
      },
      { tick, id }
    )
  }
  for (let tick = 0; tick < 90; tick++) {
    await sendReasoning(tick)
    await page.waitForTimeout(70)
  }
  await page.waitForTimeout(1600)
  const samples = await page.evaluate(() => {
    window.layoutSampling = false
    return window.layoutSamples
  })
  await page.screenshot({ path: join(artifacts, "streaming.png") })
  const reversals = samples.filter(
    (s, i) => i && s.top < samples[i - 1].top - 2 && s.height >= samples[i - 1].height
  ).length
  const reasoningLength = await page
    .locator('[data-chat-message-id="layout-live"] .streaming-markdown')
    .evaluate((el) => el.textContent.length)
  if (reasoningLength < 10000)
    throw new Error("Long reasoning fixture was not accumulated: " + reasoningLength)
  const result = {
    runtime,
    rows,
    restoredExpansion,
    errors,
    reasoningLength,
    frames: samples.length,
    blankFrames: samples.filter((s) => !s.visible).length,
    reversals,
    bottomGap: samples.at(-1).height - samples.at(-1).top - samples.at(-1).viewport
  }
  writeFileSync(join(artifacts, "samples.json"), JSON.stringify(samples))
  writeFileSync(join(artifacts, "results.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      frames: result.frames,
      blankFrames: result.blankFrames,
      reversals,
      bottomGap: result.bottomGap,
      errors
    })
  )
  assert.equal(result.blankFrames, 0)
  assert.equal(reversals, 0)
  assert.ok(result.bottomGap <= 32)

  // An actual upward wheel gesture detaches following; tokens must not pull the reader back.
  const viewportBox = await viewport.boundingBox()
  await page.mouse.move(
    viewportBox.x + viewportBox.width / 2,
    viewportBox.y + viewportBox.height / 2
  )
  await page.mouse.wheel(0, -500)
  await page.getByRole("button", { name: "回到会话底部", exact: true }).waitFor()
  await page.waitForTimeout(400)
  const detachedTop = await viewport.evaluate((el) => el.scrollTop)
  for (let tick = 90; tick < 100; tick++) {
    await sendReasoning(tick)
    await page.waitForTimeout(70)
  }
  await page.waitForTimeout(600)
  const detachedDelta = (await viewport.evaluate((el) => el.scrollTop)) - detachedTop
  assert.ok(Math.abs(detachedDelta) <= 2, `Detached reader moved ${detachedDelta}px`)
  await page.getByRole("button", { name: "回到会话底部", exact: true }).click()
  await page.waitForTimeout(600)
  assert.ok(
    (await viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) <= 32
  )

  // Reasoning reaching 64 Ki characters uses the existing bounded preview; following must settle.
  await sendReasoning(500)
  await page.waitForTimeout(1800)
  const live = page.locator('[data-chat-message-id="layout-live"]')
  assert.ok((await live.innerText()).includes("折叠中间"))
  assert.ok(
    (await live.locator(".streaming-markdown").evaluate((el) => el.textContent.length)) < 66000
  )
  assert.ok(
    (await viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) <= 32
  )

  // A new body must collapse reasoning once. Explicit expansion afterwards survives more output.
  const sendBody = async (text, id = "layout-live") =>
    app.evaluate(
      (_electron, { text, id }) => {
        const run = globalThis.layoutRun
        run.sender.send(run.channel, {
          type: "stream",
          mode: "messages",
          data: [
            {
              id: ["langchain_core", "messages", "AIMessageChunk"],
              kwargs: { id, content: text }
            },
            { langgraph_node: "agent" }
          ]
        })
      },
      { text, id }
    )
  await sendBody("开始输出最终回答。")
  await page.waitForTimeout(500)
  const liveToggle = live.locator("button[aria-expanded]")
  assert.equal(await liveToggle.getAttribute("aria-expanded"), "false")
  await liveToggle.click()
  await sendBody("继续补充正文。")
  await page.waitForTimeout(600)
  assert.equal(await liveToggle.getAttribute("aria-expanded"), "true")
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(artifacts, "answer-expanded.png") })

  // 覆盖真实 IPC 完成事件：思考区离屏后收到正文并结束，返回时只自动收起一次。
  await app.evaluate(() => {
    const run = globalThis.layoutRun
    run.sender.send(run.channel, { type: "done" })
    globalThis.layoutRun = null
  })
  await page.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "detached" })
  await composer.fill("验证思考消息离屏期间完成回答")
  await submit.click()
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => Boolean(globalThis.layoutRun))) break
    await page.waitForTimeout(100)
  }
  assert.ok(await app.evaluate(() => Boolean(globalThis.layoutRun)), "Second request must start")
  await sendReasoning(10, "layout-offscreen")
  const offscreen = page.locator('[data-chat-message-id="layout-offscreen"]')
  const offscreenToggle = offscreen.locator("button[aria-expanded]")
  await offscreenToggle.waitFor()
  assert.equal(await offscreenToggle.getAttribute("aria-expanded"), "true")
  await page.mouse.move(
    viewportBox.x + viewportBox.width / 2,
    viewportBox.y + viewportBox.height / 2
  )
  await page.mouse.wheel(0, -10000)
  await page.getByRole("button", { name: "回到会话底部", exact: true }).waitFor()
  await offscreen.waitFor({ state: "detached" })
  await sendBody("离屏期间已完成的回答。", "layout-offscreen")
  await app.evaluate(() => {
    const run = globalThis.layoutRun
    run.sender.send(run.channel, { type: "done" })
  })
  await page.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "detached" })
  assert.equal(await offscreen.count(), 0, "Completion must happen while the row is unmounted")
  await page.getByRole("button", { name: "回到会话底部", exact: true }).click()
  await offscreenToggle.waitFor()
  assert.equal(await offscreenToggle.getAttribute("aria-expanded"), "false")
  await offscreenToggle.click()
  assert.equal(await offscreenToggle.getAttribute("aria-expanded"), "true")
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(artifacts, "offscreen-completed.png") })
  writeFileSync(
    join(artifacts, "results.json"),
    JSON.stringify(
      {
        ...result,
        detachedDelta,
        checks: [
          "isolated runtime paths",
          "measured spacing",
          "restored expansion",
          "long streaming follow",
          "detached reader",
          "return to bottom",
          "64 Ki preview",
          "one-shot automatic collapse",
          "manual expansion after answer",
          "offscreen answer completion"
        ]
      },
      null,
      2
    )
  )
  console.log(
    "PASS detached reading, return-to-bottom, bounded 64 Ki preview and reasoning/body transitions"
  )
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
  writeFileSync(join(artifacts, "failure.txt"), String(error) + "\n" + errors.join("\n"))
  throw error
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
}

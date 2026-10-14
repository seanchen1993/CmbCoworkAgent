/** Production source-revision replacement, original creator tool and explicit user approvals. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import type { AuthoringDocument, AuthoringSource } from "../src/shared/mods/authoring"
import type { DevelopmentTrialStatus } from "../src/shared/mods/development"

interface Packet {
  ok: boolean
  result: AuthoringDocument | AuthoringSource
  error?: string
}
interface ModelMessage {
  role: string
  content: string | Array<{ type: string; text?: string }> | null
  tool_call_id?: string
}
interface ModelRequest {
  model: string
  messages: ModelMessage[]
  tools: Array<{ function: { name: string } }>
}
interface FrameSample {
  time: number
  wallTime: number
  visible: { first: number; second: number; weather: number; loading: number; staleHint: number }
  old: boolean
  next: boolean
  draft: string | undefined
  first: number
  second: number
  weather: boolean
  staleHint: boolean
}
interface HotObservation {
  token: string
  samples: FrameSample[]
  notifications: Array<{ time: number; scope?: string }>
  stopped: boolean
  capture(): FrameSample
  stop(): void
}
declare global {
  interface Window {
    __hotObservation: HotObservation
  }
}

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "Real production ASAR required")
const artifacts = resolve(
  process.env.CMB_MODS_CORE_E2E_ARTIFACTS ??
    "output/project-platform-20261012/ui-hot-update-final-v3"
)
assert(!existsSync(artifacts), "Preserve previous acceptance evidence")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const observations: Array<{ action: string; packet: Packet }> = []
const requests: unknown[] = []
const errors: string[] = []
const evidence: Record<string, unknown> = { isolated, workspace }
const asar = join(resolve(process.env.CMB_MODS_PACKAGED_DIR!), "resources/app.asar")
async function hashAsar() {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(asar)) hash.update(chunk)
  return hash.digest("hex")
}
let app: ElectronApplication | undefined
let page: Page
let phase = 1
const minimizeDuringUpdate = process.env.CMB_HOT_UPDATE_MINIMIZE === "1"
let phaseTwoWaiting = false
let releasePhaseTwo!: () => void
const phaseTwoGate = new Promise<void>((resolve) => {
  releasePhaseTwo = resolve
})
let source: Array<{ path: string; text: string }> = []
let revision = 0
const sent = new Map<string, string>()
const seen = new Set<string>()
const id = "hot-panel"
const name = "源码热更新面板"
const pause = () => new Promise((resolve) => setTimeout(resolve, 150))
const candidates: DevelopmentTrialStatus[] = []
const statusChanges: unknown[] = []
const timing: Array<{ event: string; time: number }> = []
evidence.timing = timing
const textOf = (content: ModelMessage["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert(Buffer.concat(chunks).length < 4 * 1024 * 1024)
    const body: ModelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (minimizeDuringUpdate && phase === 2) {
      phaseTwoWaiting = true
      await phaseTwoGate
    }
    assert(requests.length < 12, "Bound actual provider calls")
    requests.push({
      phase,
      messages: body.messages,
      tools: body.tools?.map((t) => t.function.name)
    })
    assert(body.tools.some((t) => t.function.name === "mod_authoring"))
    for (const message of body.messages) {
      const callId = message.tool_call_id
      if (message.role !== "tool" || !callId || !sent.has(callId) || seen.has(callId)) continue
      const packet: Packet = JSON.parse(textOf(message.content))
      assert.equal(packet.ok, true, JSON.stringify(packet))
      const action = sent.get(callId)!
      observations.push({ action, packet })
      seen.add(callId)
      if (action === "scaffold") {
        assert("files" in packet.result)
        source = packet.result.files
      }
      if (action === "save") {
        assert("revision" in packet.result)
        revision = packet.result.revision
        source = packet.result.source.files
      }
    }
    let args: Record<string, unknown> | undefined
    const at = observations.length
    if (at === 0)
      args = { action: "scaffold", id, name, kind: "panel", instruction: "HOT_SOURCE_REVISION_ONE" }
    if (at === 1) args = { action: "save", id, name, revision: 0, files: source }
    if (at === 2 || at === 4) args = { action: "request_trial", id, revision }
    if (phase === 2 && at === 3)
      args = {
        action: "save",
        id,
        name,
        revision,
        files: source.map((file) => ({
          ...file,
          text: file.text.replaceAll("HOT_SOURCE_REVISION_ONE", "HOT_SOURCE_REVISION_TWO")
        }))
      }
    let delta: unknown = { role: "assistant", content: `HOT_UPDATE_READY_${phase}` }
    if (args) {
      const callId = `hot-source-${at}`
      sent.set(callId, String(args.action))
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: { name: "mod_authoring", arguments: JSON.stringify(args) }
          }
        ]
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const [part, finish] of [
      [delta, null],
      [{}, args ? "tool_calls" : "stop"]
    ])
      res.write(
        `data: ${JSON.stringify({
          id: `hot-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: part, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
            : {})
        })}\n\n`
      )
    res.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!res.headersSent) res.writeHead(500)
    res.end("Owned hot-update fixture failed")
  }
})
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    assert.equal(errors.length, 0, errors.join("\n"))
    if (await check()) return
    await pause()
  }
  throw Error(label)
}
async function main() {
  evidence.passed = false
  evidence.asarBefore = await hashAsar()
  if (process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
    assert.equal(evidence.asarBefore, process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const watchdog = setTimeout(() => void app?.close(), 240000)
  try {
    app = await launch(60000)
    evidence.pid = app.process().pid
    app
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    app
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const setup = await page.evaluate(
      async ({ url, workspace }) => {
        await window.api.models.setCustomConfig({
          id: "hot-model",
          name: "受控热更新模型",
          baseUrl: url,
          model: "hot-model",
          apiKey: "isolated-loopback-only",
          maxTokens: 64000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:hot-model")
        await window.api.mods.configureGlobal(true)
        const thread = await window.api.threads.create({
          title: "真实源码热更新验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const threadId = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(threadId, workspace)
        await window.api.mods.configure(threadId, true, true)
        const install = await window.api.mods.communityExamples.install({
          exampleId: "token-weather"
        })
        const status = await window.api.mods.status(threadId)
        const weather = status.functionMods!.find((row) => row.pluginId === install.pluginId)!
        if (!weather?.digest) throw Error("Official Weather digest missing")
        await window.api.mods.approveFunction(threadId, weather.pluginId, weather.digest)
        let view = await window.api.mods.clawView(threadId)
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          revision: view.revision,
          workspace: view.workspace,
          profile: {
            id: "hot-weather",
            name: "官方天气与源码开发",
            capabilities: [
              { pluginId: weather.pluginId, name: weather.name, digest: weather.digest }
            ],
            builtins: { contextMeter: true }
          }
        })
        await window.api.mods.clawChange(threadId, {
          kind: "apply",
          revision: view.revision,
          bindingRevision: view.bindingRevision,
          workspace: view.workspace,
          id: "hot-weather"
        })
        await window.api.mods.development.setEnabled({
          threadId,
          expectedWorkspace: status.workspace,
          enabled: true
        })
        return {
          threadId,
          workspace: status.workspace,
          weather,
          catalog: await window.api.mods.builtinCatalog()
        }
      },
      { url: `http://127.0.0.1:${address.port}/v1`, workspace }
    )
    evidence.setup = setup
    assert.equal(setup.catalog.length, 6)
    assert.equal(new Set(setup.catalog.map((row) => row.id)).size, 6)
    // Setup hydration only; source-replacement observation begins after this sole reload.
    await page.reload()
    await page.getByText("真实源码热更新验收", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("制作一个源码热更新面板，保存并请求本会话试用；不要自动授权。")
    await composer.press("Enter")
    await page.getByText("HOT_UPDATE_READY_1", { exact: true }).waitFor({ timeout: 90000 })
    const status = () =>
      page.evaluate((threadId) => window.api.mods.development.status({ threadId }), setup.threadId)
    async function approve(expectedRevision: number) {
      timing.push({ event: `approve-${expectedRevision}-entered`, time: Date.now() })
      const trial = (await status()).trials.find((row) => row.componentId === id)!
      assert.equal(trial.revision, expectedRevision)
      candidates.push(trial)
      evidence[`candidate-${expectedRevision}`] = trial
      // A same-capability source revision may reuse the original explicit development consent.
      // Never re-approve an applying/active candidate and accidentally schedule a second activation.
      if (expectedRevision === 1) assert.equal(trial.phase, "needs-approval")
      if (trial.phase === "needs-approval")
        await page.evaluate((input) => window.api.mods.development.approve(input), {
          threadId: setup.threadId,
          expectedWorkspace: setup.workspace,
          id: trial.componentId,
          revision: trial.revision,
          digest: trial.compiledDigest
        })
      await until(async () => {
        const current = (await status()).trials.find((row) => row.componentId === id)!
        if (JSON.stringify(statusChanges.at(-1)) !== JSON.stringify(current)) {
          statusChanges.push(current)
          timing.push({ event: `revision-${current.revision}-${current.phase}`, time: Date.now() })
          console.log("SOURCE_STATUS", JSON.stringify(current))
        }
        assert(!["failed", "unknown", "stopped"].includes(current.phase), JSON.stringify(current))
        return current.activeRevision === expectedRevision && current.phase === "active"
      }, "Approved source did not activate")
      timing.push({ event: `active-${expectedRevision}-observed`, time: Date.now() })
    }
    async function openPanel() {
      timing.push({ event: `command-${phase}-enqueue`, time: Date.now() })
      const job = await page.evaluate(
        async ({ threadId, command }) => {
          const descriptor = (await window.api.mods.commands(threadId)).find(
            (row) => row.command === command
          )
          if (!descriptor) throw Error("Real development command missing")
          return window.api.mods.enqueue(threadId, descriptor, { text: "" })
        },
        { threadId: setup.threadId, command: id }
      )
      await until(async () => {
        const result = await page.evaluate(
          async ({ threadId, jobId }) =>
            (await window.api.mods.jobs(threadId)).find((row) => row.id === jobId),
          { threadId: setup.threadId, jobId: job.id }
        )
        assert(result?.state !== "failed", result?.error)
        return result?.state === "succeeded"
      }, "Development pane command did not settle")
      timing.push({ event: `command-${phase}-settled`, time: Date.now() })
    }
    await approve(1)
    await openPanel()
    await page.getByText("HOT_SOURCE_REVISION_ONE", { exact: true }).waitFor()
    await page.getByText(/☀\s*Clear/).waitFor()
    await page.getByText(/last turns/).waitFor()
    const initialHistory = await page.evaluate(
      (threadId) => window.api.threads.getMessages(threadId),
      setup.threadId
    )
    evidence.initialHistory = initialHistory
    await page.screenshot({ path: join(artifacts, "source-r1.png") })
    const documentToken = await page.evaluate((threadId) => {
      const capture = (): FrameSample => {
        const text = document.body.innerText
        const visible = { first: 0, second: 0, weather: 0, loading: 0, staleHint: 0 }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node: Node | null
        let visited = 0
        while ((node = walker.nextNode()) && visited++ < 10000) {
          const value = node.textContent ?? ""
          const key = value.includes("HOT_UPDATE_READY_1")
            ? "first"
            : value.includes("HOT_UPDATE_READY_2")
              ? "second"
              : /☀\s*Clear/.test(value)
                ? "weather"
                : value.includes("内容加载较慢，请稍候")
                  ? "loading"
                  : /正在重新读取安全界面|刷新显示|更新显示/.test(value)
                    ? "staleHint"
                    : null
          if (!key || !node.parentElement) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          const rect = range.getBoundingClientRect()
          let left = Math.max(0, rect.left),
            right = Math.min(innerWidth, rect.right)
          let top = Math.max(0, rect.top),
            bottom = Math.min(innerHeight, rect.bottom)
          for (
            let element: Element | null = node.parentElement;
            element;
            element = element.parentElement
          ) {
            const style = getComputedStyle(element)
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity) === 0
            ) {
              right = left
              break
            }
            const bounds = element.getBoundingClientRect()
            if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
              left = Math.max(left, bounds.left)
              right = Math.min(right, bounds.right)
            }
            if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
              top = Math.max(top, bounds.top)
              bottom = Math.min(bottom, bounds.bottom)
            }
          }
          if (right > left && bottom > top) visible[key]++
        }
        return {
          time: performance.now(),
          wallTime: Date.now(),
          visible,
          old: text.includes("HOT_SOURCE_REVISION_ONE"),
          next: text.includes("HOT_SOURCE_REVISION_TWO"),
          draft: (document.querySelector("textarea.composer-textarea") as HTMLTextAreaElement)
            ?.value,
          first: text.split("HOT_UPDATE_READY_1").length - 1,
          second: text.split("HOT_UPDATE_READY_2").length - 1,
          weather: text.includes("last turns"),
          staleHint: /正在重新读取安全界面|刷新显示|更新显示/.test(text)
        }
      }
      const state: HotObservation = {
        token: crypto.randomUUID(),
        samples: [],
        notifications: [],
        stopped: false,
        capture,
        stop: () => {
          state.stopped = true
          stopNotifications()
        }
      }
      const stopNotifications = window.api.mods.onCardsChanged((event) => {
        if (event.threadId === threadId && state.notifications.length < 2000)
          state.notifications.push({ time: Date.now(), scope: event.scope })
      })
      window.__hotObservation = state
      const deadline = performance.now() + 120000
      const sample = () => {
        if (state.stopped || state.samples.length >= 4500 || performance.now() >= deadline) return
        if (!state.samples.length || performance.now() - state.samples.at(-1)!.time >= 30)
          state.samples.push(capture())
        requestAnimationFrame(sample)
      }
      sample()
      return state.token
    }, setup.threadId)
    phase = 2
    await composer.fill(
      "把同一面板源码文字更新为第二版，保存并请求更新试用；保留原会话和官方天气。"
    )
    await composer.press("Enter")
    timing.push({ event: "revision-2-send", time: Date.now() })
    await composer.fill("HOT_DRAFT_MUST_SURVIVE_中文")
    if (minimizeDuringUpdate) {
      await until(async () => phaseTwoWaiting, "Second request did not reach the local model")
      const nativeWindow = await app.browserWindow(page)
      await nativeWindow.evaluate((window) => window.minimize())
      await until(
        () => nativeWindow.evaluate((window) => window.isMinimized()),
        "Window did not minimize"
      )
      timing.push({ event: "minimized-before-source-save", time: Date.now() })
      releasePhaseTwo()
      await until(
        async () => observations.length >= 5,
        "Source revision was not saved and trial requested while minimized"
      )
      const minimized = await nativeWindow.evaluate((window) => window.isMinimized())
      assert.equal(minimized, true, "Window must remain minimized throughout source replacement")
      evidence.minimizedUpdate = {
        minimized,
        revision,
        status: await status(),
        observedActions: observations.length
      }
      assert.equal(revision, 2)
      await nativeWindow.evaluate((window) => {
        window.restore()
        window.show()
        window.focus()
      })
      assert.equal(await nativeWindow.evaluate((window) => window.isMinimized()), false)
      timing.push({ event: "restored-after-source-trial-request", time: Date.now() })
    }
    await page.getByText("HOT_UPDATE_READY_2", { exact: true }).waitFor({ timeout: 90000 })
    await approve(2)
    const activeAt = Date.now()
    await openPanel()
    await page.getByText("HOT_SOURCE_REVISION_TWO", { exact: true }).waitFor()
    timing.push({ event: "pane-2-visible", time: Date.now() })
    await page.getByText(/☀\s*Clear/).waitFor()
    await page.getByText(/last turns/).waitFor()
    assert.equal(await page.getByText("HOT_SOURCE_REVISION_ONE", { exact: true }).count(), 0)
    assert.equal(await composer.inputValue(), "HOT_DRAFT_MUST_SURVIVE_中文")
    timing.push({ event: "weather-2-visible", time: Date.now() })
    const recoverySamples: unknown[] = []
    timing.push({ event: "history-recovery-start", time: Date.now() })
    const recoveryDeadline = Date.now() + 15000
    let recovered = false
    while (Date.now() < recoveryDeadline) {
      const sample = await page.evaluate(() => ({
        time: Date.now(),
        first: document.body.innerText.split("HOT_UPDATE_READY_1").length - 1,
        second: document.body.innerText.split("HOT_UPDATE_READY_2").length - 1,
        loading: document.body.innerText.split("内容加载较慢，请稍候").length - 1
      }))
      recoverySamples.push(sample)
      if (sample.first === 1 && sample.second === 1 && sample.loading === 0) {
        recovered = true
        break
      }
      await pause()
    }
    timing.push({ event: "history-recovery-end", time: Date.now() })
    evidence.historyRecovery = {
      recovered,
      elapsedSinceActiveMs: Date.now() - activeAt,
      samples: recoverySamples
    }
    assert(
      recovered,
      "Original history did not naturally recover within 15s after source activation"
    )
    const history = await page.evaluate(
      (threadId) => window.api.threads.getMessages(threadId),
      setup.threadId
    )
    evidence.finalHistory = history
    const firstId = initialHistory.find(
      (message) =>
        message.role === "assistant" && textOf(message.content).trim() === "HOT_UPDATE_READY_1"
    )?.id
    assert(firstId, "Initial persisted final identity required")
    assert.equal(
      history.find(
        (message) =>
          message.role === "assistant" && textOf(message.content).trim() === "HOT_UPDATE_READY_1"
      )?.id,
      firstId
    )
    for (const marker of ["HOT_UPDATE_READY_1", "HOT_UPDATE_READY_2"]) {
      assert.equal(await page.getByText(marker, { exact: true }).count(), 1)
      assert.equal(
        history.filter(
          (message) => message.role === "assistant" && textOf(message.content).trim() === marker
        ).length,
        1
      )
    }
    const stableFrames = await page.evaluate(async () => {
      const samples: FrameSample[] = []
      const deadline = performance.now() + 8000
      while (samples.length < 120 || samples.at(-1)!.time - samples[0].time < 3000) {
        if (performance.now() >= deadline) throw Error("Stable frame absolute deadline")
        if (samples.length >= 2000) throw Error("Stable frame sample limit exceeded")
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Stable frame absolute deadline")),
            Math.max(1, deadline - performance.now())
          )
          requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        samples.push(window.__hotObservation.capture())
      }
      return samples
    })
    evidence.stableFrames = stableFrames
    assert(stableFrames.length >= 120 && stableFrames.length <= 2000)
    assert(stableFrames.at(-1)!.time - stableFrames[0].time >= 3000)
    assert(
      stableFrames.every(
        (frame) =>
          !frame.old &&
          frame.next &&
          frame.weather &&
          !frame.staleHint &&
          frame.first === 1 &&
          frame.second === 1 &&
          frame.draft === "HOT_DRAFT_MUST_SURVIVE_中文"
      )
    )
    const after = await page.evaluate(
      async ({ setup, documentToken }) => {
        const state = window.__hotObservation
        if (state.token !== documentToken)
          throw Error("Document reloaded during source replacement")
        state.stop()
        return {
          samples: state.samples,
          notifications: state.notifications,
          status: await window.api.mods.development.status({ threadId: setup.threadId }),
          catalog: await window.api.mods.builtinCatalog(),
          overview: await window.api.mods.builtinOverview(setup.threadId, setup.workspace),
          claw: await window.api.mods.clawView(setup.threadId),
          panes: await window.api.mods.panes(setup.threadId)
        }
      },
      { setup: { threadId: setup.threadId, workspace: setup.workspace }, documentToken }
    )
    evidence.after = after
    assert(after.samples.length > 0 && after.samples.length <= 2000)
    const replacement = after.notifications.findLast((event) =>
      event.scope?.startsWith("source-replaced:")
    )
    assert(replacement, "The committed source replacement must be observed")
    assert(
      after.notifications
        .filter((event) => event.time > replacement.time)
        .every((event) => event.scope !== undefined),
      "Opening the new pane must not globally revoke the protected conversation"
    )
    const weatherRestored = after.samples.findIndex(
      (frame) => frame.wallTime > replacement.time && frame.visible.weather > 0
    )
    assert(weatherRestored >= 0, "Weather must return after the actual source replacement")
    assert(
      after.samples.slice(weatherRestored).every((frame) => frame.visible.weather > 0),
      "Opening the new pane must not make the restored Weather disappear a second time"
    )
    assert.deepEqual(after.catalog, setup.catalog)
    assert(after.claw.active?.capabilities.some((row) => row.pluginId === setup.weather.pluginId))
    assert.equal(after.overview.threadId, setup.threadId)
    assert.notEqual(candidates[0].compiledDigest, candidates[1].compiledDigest)
    assert.equal(observations.length, 5)
    assert.equal(requests.length, 7)
    await page.screenshot({ path: join(artifacts, "source-r2-coexist.png") })
    await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
    await page.getByRole("tab", { name: "运行过程", exact: true }).click()
    await page.getByRole("region", { name: "本次规范与运行概况" }).waitFor()
    assert.equal(await composer.inputValue(), "HOT_DRAFT_MUST_SURVIVE_中文")
    await page.screenshot({ path: join(artifacts, "builtin-overview-coexist.png") })
    evidence.passed = true
    console.log(
      "PASS real creator save/trial/consent → source r1/r2 activated in the same document and reopened through the original command; six builtin catalog/overview, visible official Weather, draft and unique history retained"
    )
  } catch (error) {
    evidence.failure = String(error)
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    releasePhaseTwo()
    clearTimeout(watchdog)
    await app?.close()
    evidence.asarAfter = await hashAsar()
    if (evidence.asarAfter !== evidence.asarBefore) {
      evidence.passed = false
      evidence.failure = "ASAR changed during acceptance"
    }
    writeFileSync(
      join(artifacts, "evidence.json"),
      JSON.stringify(
        { ...evidence, candidates, statusChanges, observations, requests, errors },
        null,
        2
      )
    )
    await new Promise<void>((resolve) => server.close(() => resolve()))
    assert.equal(evidence.asarAfter, evidence.asarBefore)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

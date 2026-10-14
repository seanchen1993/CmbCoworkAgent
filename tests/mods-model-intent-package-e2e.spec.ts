/** A real late cross-model route after a new manual intent; independent of the old 8/12 suites. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { RoutingTrace } from "../src/main/agent/trace/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import { modelIntentFileHash, selectModelIntentPackage } from "./support/model-intent-package-pins"

interface ProviderBody {
  model: string
  messages: Array<{ role: string; content: unknown }>
  stream?: boolean
}
interface ProviderRequest {
  marker: string
  model: string
  status: number | null
  receivedAtMs: number
  respondedAtMs: number | null
  answer: string
  messageCount: number
  userMessage: string
  classifier: boolean
}
interface TraceDetail {
  traceId: string
  outcome: string
  nodes?: Array<{
    type: string
    parentId: string | null
    metadata?: { routingTrace?: RoutingTrace }
  }>
}
interface ThreadMetadata {
  model?: string
  routingState?: {
    lastResolvedModelId?: string
    failoverStickyModelId?: string
    failoverStickyUntil?: number
  }
}

const root = resolve(__dirname, "..")
const release = selectModelIntentPackage(root)
const validationRoot = resolve(root, "output/mods-v2-validation")
mkdirSync(validationRoot, { recursive: true })
const artifacts = resolve(
  root,
  process.env.CMB_MODEL_INTENT_PACKAGE_ARTIFACTS ??
    `output/mods-v2-validation/stage43-model-intent-${release.selected}-${randomUUID()}`
)
assert(/^[^./\\][^/\\]*$/.test(relative(validationRoot, artifacts)), "Use one owned fresh leaf")
assert.equal(realpathSync(dirname(artifacts)), realpathSync(validationRoot))
assert(!existsSync(artifacts), "Preserve every earlier result")
mkdirSync(artifacts)
const sourceHashes = [
  __filename,
  join(root, "tests/support/model-intent-package-pins.ts"),
  join(root, "tests/support/mods-core-packaged-launch.ts"),
  join(root, "tests/support/mods-composition-fixtures.ts"),
  join(root, "output/stage43-late-routing-package-witness-design.md")
].map((path) => ({ path, sha256: modelIntentFileHash(path) }))
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const refs = { a: "custom:stage43-a", b: "custom:stage43-b", d: "custom:stage43-d" }
const names = { a: "Stage43 A", b: "Stage43 B", d: "Stage43 D" }
const providerModels = { a: "stage43-a", b: "stage43-b", d: "stage43-d" }
const nonce = randomUUID().replace(/-/g, "")
const oldMarker = `LATE-${nonce}`
const newMarker = `NEXT-${nonce}`
const title = "Stage43 真实迟到路由"
const requests: ProviderRequest[] = []
const providerErrors: string[] = []
const pageErrors: string[] = []
const dialogErrors: string[] = []
const checks: string[] = []
const controls: string[] = []
const screenshots: string[] = []
const waits: Array<{ label: string; elapsedMs: number; succeeded: boolean }> = []
const readBack: Record<string, unknown> = {}
const times: Record<string, number> = {}
const startedAt = performance.now()
let application: ElectronApplication | undefined
let page: Page | undefined
let threadId = ""
let phase = "bootstrap"
let completed = false
let watchdogExpired = false
let gateState: "idle" | "held" | "released" | "responded" = "idle"
let gateTimer: ReturnType<typeof setTimeout> | undefined
let releaseGate!: () => void
const gateRelease = new Promise<void>((resolveRelease) => {
  releaseGate = resolveRelease
})
let finishGate!: () => void
const gateFinished = new Promise<void>((resolveFinished) => {
  finishGate = resolveFinished
})

function releaseHeldResponse(): void {
  if (gateState !== "held") return
  times.gateReleasedAtMs = performance.now()
  gateState = "released"
  if (gateTimer) clearTimeout(gateTimer)
  releaseGate()
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "")
const answerFor = (marker: string, model: string): string => `Stage43 普通答复[${marker}][${model}]`

const server = createServer(async (request, response) => {
  let isHeldRequest = false
  try {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      assert(length <= 1024 * 1024, "Bound the real local provider request")
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderBody
    assert(Object.values(providerModels).includes(body.model))
    assert(Array.isArray(body.messages))
    const classifier = body.messages.some(
      (message) =>
        message.role === "system" &&
        textOf(message.content).startsWith("You are a routing classifier for an AI coding agent")
    )
    const userMessage = textOf(
      body.messages.filter((message) => message.role === "user").at(-1)?.content
    )
    const marker = /\[STAGE43-([^\]]+)\]/.exec(userMessage)?.[1]
    assert(
      marker === oldMarker || marker === newMarker,
      "Every model call has an owned public marker"
    )
    assert.equal(classifier, false, "The strict L2 witness must not use the classifier")
    const observed: ProviderRequest = {
      marker,
      model: body.model,
      status: null,
      receivedAtMs: performance.now(),
      respondedAtMs: null,
      answer: answerFor(marker, body.model),
      messageCount: body.messages.length,
      userMessage,
      classifier
    }
    requests.push(observed)
    assert(requests.length <= 3, "No extra inference or same-model retry is allowed")
    if (requests.length === 1) {
      assert.equal(marker, oldMarker)
      assert.equal(body.model, providerModels.b)
      assert.equal(gateState, "idle")
      isHeldRequest = true
      times.gateEnteredAtMs = observed.receivedAtMs
      gateState = "held"
      gateTimer = setTimeout(() => {
        providerErrors.push("The owned B response gate exceeded its unchanged 30 second budget")
        releaseHeldResponse()
      }, 30_000)
      await gateRelease
      observed.status = 404
      observed.respondedAtMs = performance.now()
      response.writeHead(404, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          error: {
            message: "Stage43 controlled B model unavailable",
            type: "invalid_request_error",
            code: "model_not_found"
          }
        })
      )
      gateState = "responded"
      return
    }
    // Known A/B/D requests receive valid replies before target model assertions.
    // This lets the old package complete a genuine polluted D follow-up instead of a protocol failure.
    const common = { id: `stage43-${requests.length}`, created: 1, model: body.model }
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    observed.status = 200
    observed.respondedAtMs = performance.now()
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({
          ...common,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: observed.answer },
              finish_reason: "stop"
            }
          ]
        })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [], usage })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: observed.answer },
              finish_reason: "stop"
            }
          ],
          usage
        })
      )
    }
  } catch (error) {
    providerErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    if (!response.headersSent) response.writeHead(400)
    response.end("Stage43 local provider protocol failed")
  } finally {
    if (isHeldRequest) {
      if (gateTimer) clearTimeout(gateTimer)
      finishGate()
    }
  }
})

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  budget = 30_000
): Promise<T> {
  const began = performance.now()
  let succeeded = false
  try {
    while (performance.now() - began < budget) {
      const value = await read()
      if (accept(value)) {
        succeeded = true
        return value
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30))
    }
    throw Error(`Timed out: ${label}`)
  } finally {
    waits.push({ label, elapsedMs: performance.now() - began, succeeded })
  }
}
function activePage(): Page {
  assert(page)
  return page
}
async function metadata(): Promise<ThreadMetadata> {
  return JSON.parse(
    await activePage().evaluate(
      async (id) => JSON.stringify((await window.api.threads.get(id))?.metadata ?? {}),
      threadId
    )
  ) as ThreadMetadata
}
function modelTrigger(): Locator {
  return activePage()
    .locator('[data-slot="popover-trigger"]')
    .filter({ hasText: /Stage43 [ABD]|智能路由|选择模型/ })
}
async function basePopover(): Promise<Locator> {
  const content = activePage().locator('[data-slot="popover-content"]')
  if (!(await content.isVisible())) {
    assert.equal(await modelTrigger().count(), 1)
    await modelTrigger().click()
  }
  await content.waitFor({ state: "visible" })
  return content
}
async function selectManualA(): Promise<void> {
  const popover = await basePopover()
  const choice = popover
    .getByRole("button")
    .filter({ has: activePage().getByText(names.a, { exact: true }) })
  assert.equal(await choice.count(), 1)
  await until(
    () => choice.isEnabled(),
    (value) => value,
    "manual A choice ready",
    15_000
  )
  await choice.click()
  await until(metadata, (value) => value.model === refs.a, "manual A metadata acknowledgement")
  await until(
    () => modelTrigger().innerText(),
    (value) => value.trim() === names.a,
    "visible manual A"
  )
}
async function routingMode(next: "auto" | "pinned"): Promise<void> {
  const popover = await basePopover()
  const toggle = popover.getByRole("switch", { name: "智能路由", exact: true })
  await until(
    () => toggle.isEnabled(),
    (value) => value,
    "routing mode control hydration",
    15_000
  )
  assert.equal(await toggle.getAttribute("aria-checked"), next === "auto" ? "false" : "true")
  await toggle.click()
  await until(
    () => activePage().evaluate(() => window.api.routing.getMode()),
    (value) => value === next,
    "backend routing mode " + next
  )
  await until(
    () => toggle.getAttribute("aria-checked"),
    (value) => value === String(next === "auto"),
    "visible routing mode " + next
  )
  await activePage().keyboard.press("Escape")
}
async function screenshot(name: string): Promise<void> {
  await activePage().screenshot({ path: join(artifacts, name), fullPage: true })
  screenshots.push(name)
}
async function send(marker: string): Promise<void> {
  const composer = activePage().locator("textarea.composer-textarea")
  await composer.waitFor({ state: "visible" })
  assert(await composer.evaluate((input) => !input.closest('[inert], [aria-hidden="true"]')))
  await composer.fill(`你好。[STAGE43-${marker}]`)
  const button = activePage().getByRole("button", { name: "发送消息", exact: true })
  await until(
    () => button.isEnabled(),
    (value) => value,
    "public send ready",
    15_000
  )
  await button.click()
}
async function traceFor(marker: string): Promise<TraceDetail> {
  const rows = await until(
    async () =>
      JSON.parse(
        await activePage().evaluate(
          async (id) =>
            JSON.stringify(
              (await window.api.optimizer.getTraces({ threadId: id, limit: 30 })).map((row) => ({
                traceId: row.traceId,
                userMessage: row.userMessage,
                outcome: row.outcome
              }))
            ),
          threadId
        )
      ) as Array<{ traceId: string; userMessage: string; outcome: string }>,
    (values) => values.some((row) => row.userMessage.includes(marker) && row.outcome === "success"),
    "completed trace " + marker,
    45_000
  )
  const row = rows.find(
    (value) => value.userMessage.includes(marker) && value.outcome === "success"
  )!
  const result = JSON.parse(
    await activePage().evaluate(
      async (id) => JSON.stringify(await window.api.optimizer.getTraceDetail(id)),
      row.traceId
    )
  ) as TraceDetail | null
  assert(result)
  assert.equal(result.outcome, "success")
  return result
}
async function completedTurn(marker: string, model: string): Promise<TraceDetail> {
  await activePage()
    .getByText(answerFor(marker, model), { exact: true })
    .waitFor({ timeout: 45_000 })
  const trace = await traceFor(marker)
  await until(
    () => activePage().getByRole("button", { name: "停止生成", exact: true }).count(),
    (count) => count === 0,
    "ordinary stream completed " + marker,
    45_000
  )
  const transcript = JSON.parse(
    await activePage().evaluate(
      async (id) => JSON.stringify(await window.api.threads.getMessagesPage(id, { limit: 50 })),
      threadId
    )
  ) as {
    messages: Array<{ role: string; content: unknown }>
  }
  assert(
    transcript.messages.some(
      (message) =>
        message.role === "assistant" && textOf(message.content).includes(answerFor(marker, model))
    )
  )
  readBack["transcript-" + marker] = transcript
  return trace
}
function routingOf(trace: TraceDetail): RoutingTrace {
  const routing = trace.nodes?.find((node) => node.type === "trace" && node.parentId === null)
    ?.metadata?.routingTrace
  assert(routing, "The finished real trace retains the production routing funnel")
  return routing
}

async function run(failures: unknown[]): Promise<void> {
  const cleanupFailures: unknown[] = []
  const watchdog = setTimeout(() => {
    watchdogExpired = true
    failures.push(Error("The independent late-route package witness exceeded 180 seconds"))
    releaseHeldResponse()
    void attemptModsE2eCleanup(failures, () => application?.close())
  }, 180_000)
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolveListen)
    })
    const address = server.address()
    assert(address && typeof address !== "string")
    application = await launch(60_000)
    readBack.packageIdentity = await release.verifyBoot(application)
    application
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    application
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("dialog", async (dialog) => {
      dialogErrors.push(`Unexpected ${dialog.type()}: ${dialog.message()}`)
      await dialog.dismiss().catch((error) => dialogErrors.push(String(error)))
    })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.models?.getCatalog))
    threadId = await page.evaluate(
      async ({ workspace, url, title }) => {
        for (const id of ["stage43-d", "stage43-a", "stage43-b"])
          await window.api.models.setCustomConfig({
            id,
            name: `Stage43 ${id.slice(-1).toUpperCase()}`,
            baseUrl: url,
            model: id,
            apiKey: "stage43-owned-local-fixture",
            maxTokens: 32000,
            maxOutputTokens: 4096,
            tier: id === "stage43-b" ? "economy" : "premium"
          })
        await window.api.models.setDefault("custom:stage43-d")
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1`, title }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await page.locator("textarea.composer-textarea").waitFor({ state: "visible" })
    const catalog = await page.evaluate(async () => {
      const value = await window.api.models.getCatalog()
      return {
        defaultModelId: value.defaultModelId,
        models: value.models.map(({ id, name, available, tier }) => ({ id, name, available, tier }))
      }
    })
    assert.equal(catalog.defaultModelId, refs.d)
    assert.deepEqual(
      catalog.models
        .filter((model) => model.available && model.tier === "economy")
        .map((model) => model.id),
      [refs.b]
    )
    assert(
      catalog.models.some(
        (model) => model.id === refs.d && model.available && model.tier === "premium"
      )
    )
    const initial = await page.evaluate(
      async (id) => ({
        globalMods: await window.api.mods.globalEnabled(),
        claw: await window.api.mods.clawView(id),
        plugins: (await window.api.plugins.list()).length
      }),
      threadId
    )
    assert.equal(initial.globalMods, false)
    assert.equal(initial.claw.enabled, false)
    assert.equal(initial.claw.active, null)
    assert.equal(initial.plugins, 0)
    assert(!existsSync(join(env.CMB_COWORK_AGENT_HOME, "hooks.json")))
    await selectManualA()
    await routingMode("auto")
    const initialMetadata = await metadata()
    assert.equal(initialMetadata.model, refs.a)
    assert.equal(initialMetadata.routingState?.lastResolvedModelId, undefined)
    assert.equal(requests.length, 0)
    readBack.bootstrap = { catalog, initial, metadata: initialMetadata }
    await screenshot("01-private-auto-manual-A.png")
    controls.push("Private Mods OFF, no Claw/Hook/plugin; default D and explicit manual A")

    phase = "held-auto-B"
    await send(oldMarker)
    await until(
      async () => gateState,
      (value) => value === "held",
      "real economy B response gate",
      15_000
    )
    const held = await until(
      metadata,
      (value) => value.routingState?.lastResolvedModelId === refs.b,
      "initial B routing decision persisted"
    )
    assert.equal(await page.evaluate(() => window.api.routing.getMode()), "auto")
    assert.equal(held.model, refs.a)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].status, null)
    readBack.held = {
      metadata: held,
      gateState,
      requests: requests.map((request) => ({ ...request }))
    }
    controls.push("A genuine old auto B request is held before its HTTP headers return")

    phase = "new-pinned-manual-A"
    await routingMode("pinned")
    times.pinnedConfirmedAtMs = performance.now()
    await selectManualA()
    times.manualAConfirmedAtMs = performance.now()
    assert.equal(gateState, "held")
    assert.equal(requests.length, 1)
    readBack.newIntentBeforeRelease = {
      metadata: await metadata(),
      modelText: await modelTrigger().innerText()
    }
    await screenshot("02-new-pinned-A-old-B-held.png")
    releaseHeldResponse()
    await gateFinished
    controls.push("Public pinned toggle and manual A are acknowledged before releasing old B404")

    phase = "late-D-completes"
    await until(
      async () => requests.length,
      (length) => length === 2,
      "real fallback D inference",
      45_000
    )
    assert.equal(requests[1].marker, oldMarker)
    assert.equal(requests[1].model, providerModels.d)
    const oldTrace = await completedTurn(oldMarker, providerModels.d)
    const oldRouting = routingOf(oldTrace)
    assert.equal(oldRouting.routingMode, "auto")
    assert.equal(oldRouting.decidedByLayer, "layer2")
    assert.equal(oldRouting.resolvedModelId, refs.b)
    assert.equal(oldRouting.resolvedTier, "economy")
    assert(!oldRouting.layers.some((layer) => layer.layer === "layer3"))
    const afterOld = await until(
      metadata,
      (value) =>
        value.routingState?.lastResolvedModelId === refs.d &&
        value.routingState?.failoverStickyModelId === refs.d,
      "real failover D routing facts"
    )
    assert.equal(afterOld.model, refs.a)
    assert.equal(requests[0].status, 404)
    assert.equal(requests[1].status, 200)
    assert(times.gateEnteredAtMs < times.pinnedConfirmedAtMs)
    assert(times.pinnedConfirmedAtMs <= times.manualAConfirmedAtMs)
    assert(times.manualAConfirmedAtMs < times.gateReleasedAtMs)
    assert(times.gateReleasedAtMs <= requests[0].respondedAtMs!)
    assert(requests[1].receivedAtMs >= times.gateReleasedAtMs)
    times.oldRunCompletedAtMs = performance.now()
    readBack.afterOld = {
      metadata: afterOld,
      modelText: (await modelTrigger().innerText()).trim(),
      oldTrace
    }
    await screenshot("03-late-D-after-new-manual-A.png")
    controls.push(
      "Old auto/L2 B404 really fails over to D200 and completes before target assertions"
    )

    // Do not assert the target model here: the old package must be allowed to send
    // and finish a polluted D follow-up so its complete behavioral RED is preserved.
    phase = "new-pinned-follow-up"
    assert.equal(await page.evaluate(() => window.api.routing.getMode()), "pinned")
    await send(newMarker)
    await until(
      async () => requests.length,
      (length) => length === 3,
      "new ordinary pinned inference",
      45_000
    )
    const actualNewModel = requests[2].model
    const newTrace = await completedTurn(newMarker, actualNewModel)
    const newRouting = routingOf(newTrace)
    assert.equal(newRouting.routingMode, "pinned")
    assert.equal(newRouting.decidedByLayer, "pinned")
    const finalMetadata = await metadata()
    readBack.afterNext = {
      metadata: finalMetadata,
      modelText: (await modelTrigger().innerText()).trim(),
      newTrace
    }
    times.newRunCompletedAtMs = performance.now()
    await screenshot("04-next-pinned-model-actual.png")
    assert.equal(requests.length, 3)
    assert.deepEqual(
      requests.map((request) => request.marker),
      [oldMarker, oldMarker, newMarker]
    )
    assert.deepEqual(
      requests.map((request) => request.status),
      [404, 200, 200]
    )
    assert.deepEqual(providerErrors, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(dialogErrors, [])
    controls.push(
      "The next ordinary request completes with its actual observed model; all controls complete"
    )

    phase = "target-assertions"
    const observedAfterOld = readBack.afterOld as { modelText: string }
    const observedAfterNext = readBack.afterNext as { modelText: string }
    assert.equal(
      observedAfterOld.modelText,
      names.a,
      "A late old D route must not overwrite the newer A"
    )
    assert.equal(observedAfterNext.modelText, names.a)
    assert.equal(finalMetadata.model, refs.a)
    assert.equal(newRouting.resolvedModelId, refs.a)
    assert.deepEqual(
      requests.map((request) => request.model),
      [providerModels.b, providerModels.d, providerModels.a]
    )
    checks.push("Real old auto B404/D200 cannot overwrite the public newer pinned/manual A intent")
    checks.push(
      "The next ordinary pinned request really uses A and succeeds without clearing sticky D"
    )
    completed = true
  } catch (error) {
    failures.push(error)
    await attemptModsE2eCleanup(cleanupFailures, () =>
      page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
    )
    await attemptModsE2eCleanup(cleanupFailures, () =>
      writeFileSync(
        join(artifacts, "failure.json"),
        JSON.stringify(
          {
            phase,
            error: error instanceof Error ? error.stack : String(error),
            controls,
            checks,
            times,
            gateState,
            requests,
            readBack,
            pageErrors,
            providerErrors,
            dialogErrors
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  } finally {
    clearTimeout(watchdog)
    releaseHeldResponse()
    if (times.gateEnteredAtMs !== undefined)
      await attemptModsE2eCleanup(cleanupFailures, () => gateFinished)
    const appClosed = await attemptModsE2eCleanup(cleanupFailures, () => application?.close())
    const serverClosed = await attemptModsE2eCleanup(cleanupFailures, async () => {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose()))
        )
    })
    await attemptModsE2eCleanup(cleanupFailures, () => {
      release.verify()
      for (const source of sourceHashes)
        assert.equal(modelIntentFileHash(source.path), source.sha256)
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(providerErrors, [])
      assert.deepEqual(dialogErrors, [])
      assert.equal(watchdogExpired, false)
      if (times.gateEnteredAtMs !== undefined) assert.equal(gateState, "responded")
      if (completed) assert.equal(requests.length, 3)
    })
    failures.push(...cleanupFailures)
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "report.json"),
        JSON.stringify(
          {
            passed: completed && failures.length === 0,
            controlsComplete: controls.length === 5,
            phase,
            version: release.version,
            release: release.selected,
            freezeManifest: { path: release.manifestPath, sha256: release.manifestSha256 },
            packageFiles: release.files,
            sourceHashes,
            isolated,
            workspace,
            threadId,
            controls,
            checks,
            screenshots,
            waits,
            requests,
            readBack,
            times,
            gateState,
            pageErrors,
            providerErrors,
            dialogErrors,
            watchdogExpired,
            appClosed,
            serverClosed,
            cleanupFailures: cleanupFailures.map((error) =>
              error instanceof Error ? error.stack : String(error)
            ),
            failures: failures.map((error) =>
              error instanceof Error ? error.stack : String(error)
            ),
            elapsedMs: performance.now() - startedAt,
            mutationBoundary:
              "Model/thread/workspace bootstrap only; manual choices, global routing toggle and sends use public UI",
            transportBoundary:
              "Model/routing/stream handlers, factory, preload, transport and SDK are unchanged; the shared launcher only replaces open-login-page for offline SSO, and the owned real HTTP response is held",
            launchBoundary: { cwd: root, privateCwd: false, offlineLoginPageStub: true },
            scope:
              "Real packaged old auto failover after a newer manual pinned intent; exact Claw OFF is a separate controlled Provider case",
            limits: {
              exactClawOffPackaged: false,
              allMainSuites: false,
              fullNpm: false,
              originalNativeFatalClosed: false,
              customerInstallation: false,
              customerModelQuality: false,
              formalStable: false,
              fullRestart: false,
              sso: false
            }
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  }
}

runModsE2eWithFailures(run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

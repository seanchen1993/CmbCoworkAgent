import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { formatComposerAttachments } from "../../src/shared/mods/v2/composer-mentions"
import { queueStorageKey } from "../../src/renderer/src/lib/queued-message-content"
import { readNativeAppendEchoConflicts } from "./mods-native-append-e2e"

type Mode = "normal" | "multi" | "coordinator" | "workflow"
type Probe = Pick<typeof import("./mods-e2e-entry"), "observeNativeAppendTerminals" |
  "readNativeAppendTerminals" | "stopNativeAppendTerminalObserver" | "readNativeAppendCheckpoints" |
  "readNativeAppendThreadBusy">
type Request = { mode: Mode; messages: Array<{ role: string; content: unknown }>
  raw: Record<string, unknown>; kind: string }
type Draft = { id: string; text: string; created_at: string; updated_at: string
  pendingMentions?: unknown[]; [key: string]: unknown }
type Gate = { entered: ReturnType<typeof Promise.withResolvers<void>>
  release: ReturnType<typeof Promise.withResolvers<void>>
  finished: ReturnType<typeof Promise.withResolvers<void>> }

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  assert(Array.isArray(value), "The actual provider must receive text or text blocks")
  return value.map(block => {
    const data = object(block)
    assert.equal(data.type, "text")
    assert.equal(typeof data.text, "string")
    return data.text as string
  }).join("")
}

function gate(): Gate {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(),
    finished: Promise.withResolvers<void>() }
}

/** Real queue cards and guide buttons; no direct queue IPC submission or invented message IDs. */
export async function verifyGuideBoundaries(app: ElectronApplication, page: Page,
  workspace: string, artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void, logPath: string): Promise<void> {
  const project = join(workspace, "guide-boundary-project")
  mkdirSync(project, { recursive: true })
  const fileBody = "ACTUAL_GUIDED_FILE_FIRST\nACTUAL_GUIDED_FILE_LAST\n"
  const filePath = join(project, "guide.txt")
  writeFileSync(filePath, fileBody)
  const modes: Mode[] = ["normal", "multi", "coordinator", "workflow"]
  const nonce = randomUUID()
  const pluginName = `guide-boundary-${nonce}`
  const requests: Request[] = [], labels: string[] = [], failures: unknown[] = []
  const handlers = new Set<Promise<void>>()
  const held = new Map<Mode, Gate>()
  const allGates: Gate[] = []
  const threadIds: string[] = []
  const evidence: Record<string, unknown> = { complete: false, labels, requests,
    foreground: {}, osReadOnce: "not-observed", backgroundPriority: "existing queue regressions" }
  let observed = false, activeThread: string | undefined, listening = false
  let installedPlugin = false, workerStarted = false
  const persisted = new Map<string, { rows: Awaited<ReturnType<typeof rows>>; history: unknown[];
    rawCheckpoints?: unknown[] }>()
  const persistedWorkers = new Map<string, { latest: unknown; rawCheckpoints: unknown[] }>()
  let requestBaseline: string | undefined
  let primaryFailed = false, primaryReason: unknown

  const record = (label: string) => { labels.push(label); pass(label) }
  const readTerminals = () => app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __guideBoundaryProbe?: Probe }
    assertProbe(state.__guideBoundaryProbe)
    return state.__guideBoundaryProbe.readNativeAppendTerminals()
    function assertProbe(value: Probe | undefined): asserts value is Probe {
      if (!value) throw Error("Actual guide terminal observer missing")
    }
  })
  const stopObserver = async () => {
    if (!observed) return
    await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { __guideBoundaryProbe?: Probe }
      state.__guideBoundaryProbe?.stopNativeAppendTerminalObserver()
      delete state.__guideBoundaryProbe
    })
    observed = false
  }
  const installObserver = async (id: string) => {
    await stopObserver()
    const browserWindow = await app.browserWindow(page)
    await app.evaluate((_, { window, id, entry }) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      const probe = createRequire(entry)(entry) as Probe
      probe.observeNativeAppendTerminals(window, id)
      const state = globalThis as typeof globalThis & { __guideBoundaryProbe?: Probe }
      state.__guideBoundaryProbe = probe
    }, { window: browserWindow, id,
      entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
    observed = true
  }
  const terminalsFinished = async (cursor: number) => {
    const entries = (await readTerminals()).slice(cursor)
    for (const entry of entries) assert(!entry.terminals.includes("error"), JSON.stringify(entry))
    return entries.length > 0 && entries.every(entry => entry.terminals.length === 1 &&
      entry.terminals[0] === "done")
  }
  const input = () => page.locator("textarea.composer-textarea")
  const idle = async () => await page.getByRole("button", { name: "停止生成", exact: true }).count() === 0 &&
    await input().count() === 1 && await input().isEnabled()
  const submit = async (value: string) => {
    await input().fill(value)
    await input().press("Escape")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
  }
  const approveVisibleRequest = async () => {
    // A fixture tool still goes through the real approval card when the policy asks.
    const approve = page.getByRole("button", { name: "运行", exact: true })
    if (await approve.count() === 1 && await approve.isVisible()) await approve.click()
  }
  const rows = (id: string) => page.evaluate(threadId => window.api.threads.getMessages(threadId), id)
  const history = (id: string) => page.evaluate(threadId => window.api.threads.getHistory(threadId), id)
  const workerCheckpoint = (id: string) => page.evaluate(threadId =>
    window.api.threads.getLatestCheckpoint(threadId), id)
  const rawCheckpoints = (id: string) => app.evaluate(async (_, { id, entry }) => {
    const { createRequire } = process.getBuiltinModule("node:module")
    const probe = createRequire(entry)(entry) as Probe
    return probe.readNativeAppendCheckpoints(id)
  }, { id, entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
  const physicalBusy = (id: string) => app.evaluate((_, { id, entry }) => {
    const { createRequire } = process.getBuiltinModule("node:module")
    const probe = createRequire(entry)(entry) as Probe
    return probe.readNativeAppendThreadBusy(id)
  }, { id, entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
  const queue = async (id: string): Promise<Draft[]> => {
    const source = await page.evaluate(key => localStorage.getItem(key), queueStorageKey(id))
    if (source === null) return []
    const parsed: unknown = JSON.parse(source)
    assert(Array.isArray(parsed))
    return parsed.map(value => {
      const data = object(value)
      assert.equal(typeof data.id, "string")
      assert.equal(typeof data.text, "string")
      assert.equal(typeof data.created_at, "string")
      assert.equal(typeof data.updated_at, "string")
      return data as Draft
    })
  }
  const answer = async (response: ServerResponse, id: string, first: string,
    last: string, selectedGate?: Gate) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(frame({ role: "assistant", content: first }, null))
    if (selectedGate) {
      selectedGate.entered.resolve()
      const closed = Promise.withResolvers<void>()
      const disconnected = () => closed.resolve()
      response.once("close", disconnected)
      try { await Promise.race([selectedGate.release.promise, closed.promise]) }
      finally { response.off("close", disconnected) }
    }
    if (response.destroyed) return
    response.write(frame({ content: last }, null))
    response.end(frame({}, "stop") + `data: ${JSON.stringify({ id,
      object: "chat.completion.chunk", model: "gpt-4", choices: [],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } })}\n\ndata: [DONE]\n\n`)
  }
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    let selectedGate: Gate | undefined
    try {
      const mode = request.url?.split("/")[1]
      assert(modes.includes(mode as Mode), "No fixture request may leave its configured endpoint")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      assert(Array.isArray(body.messages))
      const messages = body.messages.map(value => {
        const data = object(value)
        assert.equal(typeof data.role, "string")
        return { role: data.role as string, content: data.content }
      })
      const lastUser = messages.filter(message => message.role === "user").at(-1)
      const latestText = lastUser ? text(lastUser.content) : ""
      const prefix = `GUIDE_${mode.toUpperCase()}`
      const toolNames = Array.isArray(body.tools) ? body.tools.map(value => {
        const data = object(value)
        return object(data.function).name
      }) : []
      let kind = "notification"
      if (latestText.startsWith(`${prefix}_FIRST`)) kind = "first"
      else if (latestText.startsWith(`${prefix}_NEXT`)) kind = "guided"
      else if (latestText.startsWith(`${prefix}_STOP`)) kind = "stop"
      else if (latestText.includes("GUIDE_WORKER_TASK") && !toolNames.includes("start_worker")) kind = "worker"
      else if (latestText.startsWith("GUIDE_COORDINATOR_BOOTSTRAP")) kind = "bootstrap"
      requests.push({ mode: mode as Mode, messages, raw: body, kind })
      const providerId = `guide-${nonce}-${requests.length}`
      if (kind === "bootstrap" && !workerStarted) {
        assert(toolNames.includes("start_worker"), "Coordinator must expose its real worker tool")
        workerStarted = true
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(`data: ${JSON.stringify({ id: providerId, object: "chat.completion.chunk",
          model: "gpt-4", choices: [{ index: 0, delta: { role: "assistant", content: "",
            tool_calls: [{ index: 0, id: `actual-guide-worker-${nonce}`, type: "function",
              function: { name: "start_worker", arguments: JSON.stringify({ subagent_type: "worker",
                role: "implementer", workload: "read_only", description: "Actual guide boundary worker",
                prompt: "GUIDE_WORKER_TASK: Reply GUIDE_WORKER_COMPLETE without calling tools or changing files." }) } }] },
            finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      if (kind === "first" || kind === "stop") {
        selectedGate = held.get(mode as Mode)
        assert(selectedGate, "The real held model request must have a registered cleanup gate")
        held.delete(mode as Mode)
      }
      const result = kind === "worker" ? "GUIDE_WORKER_COMPLETE" :
        kind === "bootstrap" || kind === "notification" ? "GUIDE_COORDINATOR_BOOTSTRAP_COMPLETE" :
        kind === "guided" ? `${prefix}_AFTER COMPLETE` : `${prefix}_BEFORE COMPLETE`
      const cut = result.lastIndexOf(" ") + 1
      await answer(response, providerId, result.slice(0, cut), result.slice(cut), selectedGate)
    } catch (reason) {
      failures.push(reason)
      if (!response.headersSent) response.writeHead(500)
      response.end("Actual guide provider failed")
    } finally { selectedGate?.finished.resolve() }
  }
  const server = createServer((request, response) => {
    const operation = serve(request, response)
    handlers.add(operation)
    void operation.then(() => handlers.delete(operation), reason => {
      failures.push(reason)
      handlers.delete(operation)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { listening = true; resolve() })
    })
    const address = server.address()
    assert(address && typeof address === "object")
    const source = String.raw`export function register(on){
      on("prompt.submit",($,e,next)=>/^GUIDE_(MULTI|COORDINATOR|WORKFLOW)_NEXT$/.test(e.text)
        ?next({...e,text:e.text+"_ACCEPTED",context:["GUIDE_HIDDEN_CONTEXT"]}):next(e));
      on("prompt.mention",async($,e,next)=>({...await next(e),context:["GUIDE_FILE_CONTEXT"]}));
      on("prompt.attachment",($,e,next)=>next(e));
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: pluginName, version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile("hooks/register.ts", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "guide-boundary.zip"), bytes)
    const installation = await page.evaluate(bytes => window.api.plugins.install(new Uint8Array(bytes).buffer,
      "guide-boundary.zip", "local"), [...bytes])
    assert(installation.success, installation.error)
    const snapshots: Record<string, unknown> = {}
    evidence.foreground = snapshots
    for (const mode of modes) {
      const prefix = `GUIDE_${mode.toUpperCase()}`
      const title = `Current run guide ${mode} ${nonce}`
      const modelId = `guide-${mode}-${nonce}`
      const id = await page.evaluate(async ({ project, title, modelId, mode, baseURL }) => {
        await window.api.routing.setMode("pinned")
        await window.api.models.setCustomConfig({ id: modelId, name: modelId, model: "gpt-4",
          baseUrl: baseURL, apiKey: "local-fixture-key", maxTokens: 64000, maxOutputTokens: 1024 })
        await window.api.models.setDefault(`custom:${modelId}`)
        const catalog = await window.api.models.getCatalog()
        if (catalog.routingMode !== "pinned" || catalog.defaultModelId !== `custom:${modelId}` ||
          !catalog.models.some(model => model.id === `custom:${modelId}` && model.available))
          throw Error("Actual pinned guide model must be available and current")
        const thread = await window.api.threads.create({ title, workspacePath: project,
          agentMode: mode === "multi" ? "normal" : mode })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, { set: {
          model: `custom:${modelId}`, subagentsEnabled: mode === "multi" } })
        await window.api.mods.configure(id, true, true)
        return id
      }, { project, title, modelId, mode,
        baseURL: `http://127.0.0.1:${address.port}/${mode}/v1` })
      threadIds.push(id)
      activeThread = id
      const plugin = (await page.evaluate(id => window.api.mods.status(id), id)).functionMods
        ?.find(row => row.name === pluginName)
      assert(plugin?.digest)
      installedPlugin = true
      await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
        { id, pluginId: plugin.pluginId, digest: plugin.digest })
      assert.equal((await page.evaluate(id => window.api.mods.status(id), id)).functionMods
        ?.find(row => row.name === pluginName)?.state, "ready")
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByText(title, { exact: true }).first().click()
      await until(idle, `actual ${mode} composer ready`)
      await installObserver(id)
      if (mode === "coordinator") {
        await submit("GUIDE_COORDINATOR_BOOTSTRAP")
        await until(async () => {
          await approveVisibleRequest()
          const workers = await page.evaluate(id => window.api.agent.getCoordinatorWorkers(id,
            { subscribeUpdates: false }), id)
          for (const worker of workers) assert(!["failed", "cancelled", "killed"].includes(worker.status),
            JSON.stringify(worker))
          return workers.length === 1 && workers[0].status === "completed" &&
            workers[0].notification_acknowledged === true && await idle() &&
            await terminalsFinished(0) && !await page.evaluate(id =>
              window.api.agent.hasCoordinatorWorkerNotifications(id), id) && !await physicalBusy(id)
        }, "actual coordinator worker and parent notification finish")
        const workers = await page.evaluate(id => window.api.agent.getCoordinatorWorkers(id,
          { subscribeUpdates: false }), id)
        assert.equal(workers.length, 1)
        assert.equal(workers[0].parent_thread_id, id)
        assert.notEqual(workers[0].worker_thread_id, id)
        const bootstrapCheckpoints = await rawCheckpoints(id)
        assert(bootstrapCheckpoints.some(tuple => {
          const channels = object(object(object(tuple).checkpoint).channel_values)
          if (!Array.isArray(channels.messages)) return false
          const messages = channels.messages.map(object)
          const notificationIndex = messages.findIndex(message =>
            object(message.additional_kwargs).cmb_internal_coordinator_notification === true &&
            text(message.content).includes(workers[0].worker_id))
          return notificationIndex >= 0 && messages.slice(notificationIndex + 1).some(message =>
            text(message.content) === "GUIDE_COORDINATOR_BOOTSTRAP_COMPLETE" &&
            typeof message.id === "string" && message.id.length > 0)
        }), "The actual parent checkpoint must contain the handled notification and full reply")
        evidence.coordinatorBootstrapRawCheckpoints = bootstrapCheckpoints
        const workerId = workers[0].worker_thread_id
        const workerLatest = await workerCheckpoint(workerId)
        const workerConfig = object(object(object(workerLatest).config).configurable)
        assert.equal(workerConfig.thread_id, workerId)
        assert.equal(workerConfig.checkpoint_ns ?? "", "")
        const workerChannels = object(object(object(workerLatest).checkpoint).channel_values)
        assert(Array.isArray(workerChannels.messages))
        const replies = workerChannels.messages.map(object).filter(message =>
          message.type === "ai" && text(message.content) === "GUIDE_WORKER_COMPLETE")
        assert.equal(replies.length, 1)
        assert.equal(typeof replies[0].id, "string")
        assert((replies[0].id as string).length > 0)
        const workerHistory = await rawCheckpoints(workerId)
        for (const tuple of workerHistory) {
          const configurable = object(object(object(tuple).config).configurable)
          assert.equal(configurable.thread_id, workerId)
          assert.equal(configurable.checkpoint_ns ?? "", "")
        }
        assert(workerHistory.some(tuple => {
          const channels = object(object(object(tuple).checkpoint).channel_values)
          return Array.isArray(channels.messages) && channels.messages.map(object).filter(message =>
            message.id === replies[0].id && text(message.content) === "GUIDE_WORKER_COMPLETE").length === 1
        }), "The actual worker checkpoint must preserve its own reply ID and complete body")
        evidence.coordinatorWorker = { workers, latestCheckpoint: workerLatest,
          rawCheckpoints: workerHistory }
        persistedWorkers.set(workerId, { latest: workerLatest, rawCheckpoints: workerHistory })
        const workerRequests = JSON.stringify(requests)
        for (const phase of ["completed", "reloaded"]) {
          if (phase === "reloaded") {
            await page.reload({ waitUntil: "domcontentloaded" })
            await page.getByText(title, { exact: true }).first().click()
            await until(idle, "actual coordinator worker parent reload remains idle")
            assert.deepEqual(await workerCheckpoint(workerId), workerLatest)
            assert.deepEqual(await rawCheckpoints(workerId), workerHistory)
          }
          const agentsSection = page.getByRole("button", { name: /^代理\s*1\s*$/ })
          await until(async () => await agentsSection.count() === 1 && await agentsSection.isVisible(),
            `actual ${phase} worker section`)
          const expanded = await agentsSection.getAttribute("aria-expanded")
          assert(["true", "false"].includes(expanded ?? ""))
          if (expanded === "false") await agentsSection.click()
          await until(async () => await agentsSection.getAttribute("aria-expanded") === "true",
            `actual ${phase} worker section expanded`)
          const openWorker = page.getByRole("button", { name: /^打开工具流/ })
          await until(async () => await openWorker.count() === 1 && await openWorker.isVisible(),
            `actual ${phase} worker result entry`)
          await openWorker.click()
          const workerReply = page.locator('[data-worker-message-row="true"]')
            .filter({ has: page.getByText("GUIDE_WORKER_COMPLETE", { exact: true }) })
          await until(async () => await workerReply.count() === 1,
            `actual ${phase} worker result body`)
          assert((await workerReply.innerText()).includes("GUIDE_WORKER_COMPLETE"))
          assert(!(await workerReply.innerText()).includes("GUIDE_HIDDEN_CONTEXT"))
          await page.screenshot({ path: join(artifacts, `guide-worker-${phase}.png`), fullPage: true })
          await page.getByRole("button", { name: "返回", exact: true }).click()
          await until(idle, `actual ${phase} worker result returns to parent`)
          assert.equal(JSON.stringify(requests), workerRequests)
        }
        record("Coordinator has one real completed read-only worker before foreground guidance")
      }

      const cursor = (await readTerminals()).length
      const beforeRunRows = await rows(id)
      const modelGate = gate()
      allGates.push(modelGate)
      held.set(mode, modelGate)
      let entered = false
      void modelGate.entered.promise.then(() => { entered = true })
      await submit(`${prefix}_FIRST`)
      await until(async () => entered && await page.getByRole("button", {
        name: "停止生成", exact: true }).count() === 1, `actual ${mode} model held`)
      assert.equal(await physicalBusy(id), true, "The held actual model must own its physical lease")
      const draftText = mode === "normal" ? `${prefix}_NEXT @guide.txt` : `${prefix}_NEXT`
      await input().fill(draftText)
      await input().press("Escape")
      await input().press("Enter")
      await until(async () => (await queue(id)).length === 1 &&
        await page.getByRole("button", { name: "追加到本轮", exact: true }).count() === 1,
      `actual ${mode} UI parked guide draft`)
      const [draft] = await queue(id)
      assert.equal(draft.text, draftText)
      if (mode === "normal") {
        assert.equal(draft.pendingMentions?.length, 1)
        assert.equal(draft.attachmentDisplayPrefix, "📎 guide.txt")
      }
      const requestsBeforeGuide = requests.length
      await page.getByRole("button", { name: "追加到本轮", exact: true }).click()
      await until(async () => await page.getByRole("button", { name: "已追加", exact: true }).count() === 1,
        `actual ${mode} button accepted current-run draft`)
      assert.equal(requests.length, requestsBeforeGuide, "Guidance must not start a second foreground run")
      modelGate.release.resolve()
      await until(async () => await idle() && await terminalsFinished(cursor) &&
        (await rows(id)).some(row => row.role === "assistant" && text(row.content) === `${prefix}_AFTER COMPLETE`),
      `actual ${mode} guided boundary finished`)
      await modelGate.finished.promise
      await until(async () => !await physicalBusy(id), `actual ${mode} physical run finished`)
      const observed = (await readTerminals()).slice(cursor)
      assert.equal(observed.length, 1, "Two model boundaries share the original one foreground request")
      assert.deepEqual(observed[0].terminals, ["done"])
      const firstRequests = requests.filter(row => row.mode === mode && row.kind === "first")
      const guidedRequests = requests.filter(row => row.mode === mode && row.kind === "guided")
      assert.equal(firstRequests.length, 1)
      assert.equal(guidedRequests.length, 1)
      const actualInput = guidedRequests[0].messages.filter(row => row.role === "user")
        .map(row => text(row.content)).filter(value => value.startsWith(`${prefix}_NEXT`))
      assert.equal(actualInput.length, 1)
      const accepted = mode === "normal" ? draftText : `${draftText}_ACCEPTED`
      const expectedDisplay = mode === "normal" ? `📎 guide.txt\n\n${draftText}` : accepted
      const preparedInput = mode === "normal" ? draftText + formatComposerAttachments([{
        filename: "guide.txt", filePath: realpathSync(filePath), content: fileBody,
        mimeType: "text/plain", size: Buffer.byteLength(fileBody), truncated: false }]) : accepted
      const context = mode === "normal" ? "GUIDE_FILE_CONTEXT" : "GUIDE_HIDDEN_CONTEXT"
      const expectedInput = `${preparedInput}\n\n${context}`
      assert.equal(actualInput[0], expectedInput)
      assert(JSON.stringify(guidedRequests[0].messages).includes(context))
      const saved = await rows(id)
      if (mode === "coordinator") {
        const beforeCandidates = saved.filter(
          (row) => row.role === "assistant" && text(row.content) === `${prefix}_BEFORE COMPLETE`
        )
        const guidedCandidates = saved.filter((row) => row.id === draft.id && row.role === "user")
        const afterCandidates = saved.filter(
          (row) => row.role === "assistant" && text(row.content) === `${prefix}_AFTER COMPLETE`
        )
        assert.equal(beforeCandidates.length, 1)
        assert.equal(guidedCandidates.length, 1)
        assert.equal(afterCandidates.length, 1)
        const precheck: Array<Record<string, unknown>> = []
        evidence.coordinatorPrecheck = {
          bubbles: precheck,
          screenshot: "guide-boundary-coordinator-precheck.png"
        }
        for (const [row, expectedBody] of [
          [beforeCandidates[0], `${prefix}_BEFORE COMPLETE`],
          [guidedCandidates[0], expectedDisplay],
          [afterCandidates[0], `${prefix}_AFTER COMPLETE`]
        ] as const) {
          const bubble = page.locator(
            `[data-chat-message-id=${JSON.stringify(row.id)}][data-message-role=${JSON.stringify(row.role)}]`
          )
          await until(
            async () =>
              (await bubble.count()) === 1 &&
              (await bubble.isVisible()) &&
              (await bubble.innerText()).includes(expectedBody),
            `actual coordinator pre-cleanup ${row.role} body`
          )
          await bubble.scrollIntoViewIfNeeded()
          const body = await bubble.innerText()
          assert(body.includes(expectedBody))
          assert(!body.includes(context))
          precheck.push({
            id: row.id,
            role: row.role,
            fullBodyVisible: true,
            hiddenContextVisible: false,
            alertCount: await bubble.getByRole("alert").count(),
            functionSites: await bubble.locator("[data-function-site]").evaluateAll((elements) =>
              elements.map((element) => ({
                component: element.getAttribute("data-function-site"),
                ariaBusy: element.getAttribute("aria-busy")
              }))
            )
          })
        }
        await page.screenshot({
          path: join(artifacts, "guide-boundary-coordinator-precheck.png"),
          fullPage: true
        })
      }
      assert.deepEqual(saved.slice(0, beforeRunRows.length), beforeRunRows)
      const newRows = saved.slice(beforeRunRows.length)
      assert.deepEqual(newRows.map(row => row.role), ["user", "assistant", "user", "assistant"])
      assert.equal(text(newRows[0].content), `${prefix}_FIRST`)
      assert.equal(new Set(newRows.map(row => row.id)).size, 4)
      const before = saved.filter(row => row.role === "assistant" && text(row.content) === `${prefix}_BEFORE COMPLETE`)
      const guided = saved.filter(row => row.id === draft.id)
      const after = saved.filter(row => row.role === "assistant" && text(row.content) === `${prefix}_AFTER COMPLETE`)
      assert.equal(before.length, 1)
      assert.equal(guided.length, 1)
      assert.equal(after.length, 1)
      assert.equal(guided[0].role, "user")
      assert.equal(text(guided[0].content), expectedDisplay)
      assert.equal(new Set([before[0].id, guided[0].id, after[0].id]).size, 3)
      assert(saved.indexOf(before[0]) < saved.indexOf(guided[0]))
      assert(saved.indexOf(guided[0]) < saved.indexOf(after[0]))
      const checkpoint = await history(id)
      snapshots[mode] = { threadId: id, draft, rows: saved, publicHistory: checkpoint,
        terminals: observed }
      const checkpointMessages = checkpoint.map(tuple => {
        const value = object(tuple)
        const state = object(object(value.checkpoint).channel_values)
        assert(Array.isArray(state.messages))
        return state.messages.map(message => object(message))
      })
      assert(checkpointMessages.some(messages => {
        const beforeIndex = messages.findIndex(message => message.id === before[0].id)
        const guideIndex = messages.findIndex(message => message.id === draft.id)
        const afterIndex = messages.findIndex(message => message.id === after[0].id)
        return beforeIndex >= 0 && guideIndex > beforeIndex && afterIndex > guideIndex &&
          text(messages[beforeIndex].content) === `${prefix}_BEFORE COMPLETE` &&
          text(messages[guideIndex].content) === expectedDisplay &&
          text(messages[afterIndex].content) === `${prefix}_AFTER COMPLETE`
      }), "Public history must preserve all three actual boundary IDs and complete display contents")
      assert(!JSON.stringify(checkpoint).includes(context), "Public history must not expose hidden context")
      const nativeCheckpoints = await rawCheckpoints(id)
      snapshots[mode] = { ...object(snapshots[mode]), rawCheckpoints: nativeCheckpoints }
      const nativeCheckpointMessages = nativeCheckpoints.map(tuple => {
        const value = object(tuple)
        const state = object(object(value.checkpoint).channel_values)
        assert(Array.isArray(state.messages))
        return state.messages.map(message => object(message))
      })
      assert(nativeCheckpointMessages.some(messages => {
        const beforeIndex = messages.findIndex(message => message.id === before[0].id)
        const guideIndex = messages.findIndex(message => message.id === draft.id)
        const afterIndex = messages.findIndex(message => message.id === after[0].id)
        return beforeIndex >= 0 && guideIndex > beforeIndex && afterIndex > guideIndex &&
          text(messages[beforeIndex].content) === `${prefix}_BEFORE COMPLETE` &&
          text(messages[guideIndex].content) === expectedInput &&
          text(messages[afterIndex].content) === `${prefix}_AFTER COMPLETE`
      }), "Actual Saver checkpoints must preserve all three IDs, full model input, XML and hidden context")
      for (const row of [before[0], guided[0], after[0]]) {
        const bubble = page.locator(`[data-chat-message-id=${JSON.stringify(row.id)}][data-message-role=${JSON.stringify(row.role)}]`)
        await until(async () => await bubble.count() === 1, `actual ${mode} live bubble ${row.role}`)
        await bubble.scrollIntoViewIfNeeded()
        assert((await bubble.innerText()).includes(text(row.content)))
        assert(!(await bubble.innerText()).includes(context))
        if (row.role === "assistant") assert(!(await bubble.innerText()).includes(`${prefix}_NEXT`))
      }
      assert.equal((await queue(id)).length, 0)
      const requestSnapshot = JSON.stringify(requests)
      await page.screenshot({ path: join(artifacts, `guide-boundary-${mode}.png`), fullPage: true })
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByText(title, { exact: true }).first().click()
      await until(async () => await idle() && (await rows(id)).length === saved.length,
        `actual ${mode} guided history reload`)
      assert.deepEqual(await rows(id), saved)
      assert.deepEqual(await history(id), checkpoint)
      assert.deepEqual(await rawCheckpoints(id), nativeCheckpoints)
      assert.equal(JSON.stringify(requests), requestSnapshot)
      assert.equal((await queue(id)).length, 0)
      snapshots[mode] = { threadId: id, draft, rows: saved, publicHistory: checkpoint,
        rawCheckpoints: nativeCheckpoints, terminals: observed }
      persisted.set(id, { rows: saved, history: checkpoint, rawCheckpoints: nativeCheckpoints })
      record(`${mode} guide button keeps three separate live IDs and full persisted boundaries without replay`)

      if (mode === "normal") {
        const stopCursor = (await readTerminals()).length
        const stopGate = gate()
        allGates.push(stopGate)
        held.set(mode, stopGate)
        let stopEntered = false
        void stopGate.entered.promise.then(() => { stopEntered = true })
        await submit(`${prefix}_STOP`)
        await until(async () => stopEntered && await page.getByRole("button", {
          name: "停止生成", exact: true }).count() === 1, "actual normal Stop is available")
        await page.getByRole("button", { name: "停止生成", exact: true }).click()
        await until(async () => await idle() && await terminalsFinished(stopCursor), "actual normal Stop done")
        await stopGate.finished.promise
        assert.deepEqual((await readTerminals()).slice(stopCursor).map(row => row.terminals), [["done"]])
        const stoppedRows = await rows(id), stoppedHistory = await history(id)
        const stoppedRawCheckpoints = await rawCheckpoints(id)
        assert.deepEqual(stoppedRows.filter(row => saved.some(original => original.id === row.id)), saved)
        assert.equal(stoppedRows.filter(row => row.id === draft.id).length, 1)
        const stoppedRequests = JSON.stringify(requests)
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.getByText(title, { exact: true }).first().click()
        await until(idle, "actual normal Stop reload remains idle")
        assert.deepEqual(await rows(id), stoppedRows)
        assert.deepEqual(await history(id), stoppedHistory)
        assert.deepEqual(await rawCheckpoints(id), stoppedRawCheckpoints)
        assert.equal(JSON.stringify(requests), stoppedRequests)
        evidence.stop = { rows: stoppedRows, publicHistory: stoppedHistory,
          rawCheckpoints: stoppedRawCheckpoints,
          terminals: (await readTerminals()).slice(stopCursor) }
        persisted.set(id, { rows: stoppedRows, history: stoppedHistory,
          rawCheckpoints: stoppedRawCheckpoints })
        record("Normal file guidance and real Stop retain the accepted draft once after reload")
      }
      const completeTerminals = await readTerminals()
      assert.equal(new Set(completeTerminals.map(row => row.requestId)).size, completeTerminals.length)
      for (const row of completeTerminals) assert.deepEqual(row.terminals, ["done"])
      await stopObserver()
      activeThread = undefined
    }
    assert.equal(requests.filter(row => row.kind === "first").length, 4)
    assert.equal(requests.filter(row => row.kind === "guided").length, 4)
    assert.equal(requests.filter(row => row.kind === "stop").length, 1)
    assert.equal(requests.filter(row => row.kind === "worker").length, 1)
    requestBaseline = JSON.stringify(requests)
    evidence.echoConflictsBeforeCleanup = readNativeAppendEchoConflicts(logPath)
    assert.equal(evidence.echoConflictsBeforeCleanup, 0)
  } catch (reason) { primaryFailed = true; primaryReason = reason }
  finally {
    const attempt = async (operation: () => unknown | Promise<unknown>) => {
      try { await operation() } catch (reason) { failures.push(reason) }
    }
    // Cut actual runs before releasing provider gates; do not confuse a supplied final reply with Stop.
    for (const id of threadIds) await attempt(() => page.evaluate(id =>
      window.api.agent.cancel(id, { cancelWorkers: true }), id))
    for (const selected of allGates) selected.release.resolve()
    await attempt(() => server.closeAllConnections())
    await attempt(async () => {
      const results = await Promise.allSettled([...handlers])
      for (const result of results) if (result.status === "rejected") failures.push(result.reason)
    })
    if (listening) await attempt(() => new Promise<void>((resolve, reject) =>
      server.close(reason => reason ? reject(reason) : resolve())))
    if (observed && activeThread) await attempt(async () => {
      await until(async () => await terminalsFinished(0), "actual guide failure cleanup terminals")
      evidence.failureTerminals = await readTerminals()
    })
    await attempt(stopObserver)
    if (installedPlugin) for (const id of threadIds) await attempt(() => page.evaluate(
      ({ id, name }) => window.api.mods.revokeFunction(id, name), { id, name: pluginName }))
    for (const [id, snapshot] of persisted) await attempt(async () => {
      assert.deepEqual(await rows(id), snapshot.rows)
      assert.deepEqual(await history(id), snapshot.history)
      if (snapshot.rawCheckpoints) assert.deepEqual(await rawCheckpoints(id), snapshot.rawCheckpoints)
    })
    for (const [id, snapshot] of persistedWorkers) await attempt(async () => {
      assert.deepEqual(await workerCheckpoint(id), snapshot.latest)
      assert.deepEqual(await rawCheckpoints(id), snapshot.rawCheckpoints)
    })
    await attempt(() => {
      if (requestBaseline !== undefined) assert.equal(JSON.stringify(requests), requestBaseline)
      evidence.echoConflictsAfterGuestAndServerCleanup = readNativeAppendEchoConflicts(logPath)
      assert.equal(evidence.echoConflictsAfterGuestAndServerCleanup, 0)
    })
    evidence.complete = !primaryFailed && failures.length === 0
    evidence.failures = failures.map(reason => reason instanceof Error ? reason.message : String(reason))
    if (primaryFailed) evidence.primaryFailure = primaryReason instanceof Error
      ? primaryReason.message : String(primaryReason)
    await attempt(() => writeFileSync(join(artifacts, "guide-current-run-results.json"), JSON.stringify(evidence, null, 2)))
  }
  if (primaryFailed && failures.length) throw new AggregateError([primaryReason, ...failures], "Guide and cleanup failed")
  if (primaryFailed) throw primaryReason
  if (failures.length) throw new AggregateError(failures, "Guide cleanup failed")
}

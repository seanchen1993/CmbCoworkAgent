import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  formatComposerAttachments,
  type ComposerFileAttachment
} from "../../src/shared/mods/v2/composer-mentions"
import { queueStorageKey } from "../../src/renderer/src/lib/queued-message-content"
import { readNativeAppendEchoConflicts } from "./mods-native-append-e2e"

type Probe = Pick<typeof import("./mods-e2e-entry"), "observeNativeAppendTerminals" |
  "readNativeAppendTerminals" | "stopNativeAppendTerminalObserver">
type ProviderRequest = {
  messages: Array<{ role: string; content: unknown }>
  raw: Record<string, unknown>
}
type QueueSnapshot = { raw: string; entry: Record<string, unknown> }

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}

function attachment(value: unknown): ComposerFileAttachment {
  const item = object(value)
  assert.equal(typeof item.filename, "string")
  assert.equal(typeof item.filePath, "string")
  assert.equal(typeof item.content, "string")
  assert.equal(typeof item.mimeType, "string")
  assert.equal(typeof item.size, "number")
  assert.equal(typeof item.truncated, "boolean")
  return item as unknown as ComposerFileAttachment
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  assert(Array.isArray(content), "The actual provider input must contain text")
  return content.map(value => {
    const block = object(value)
    assert.equal(block.type, "text")
    assert.equal(typeof block.text, "string")
    return block.text as string
  }).join("")
}

/** Actual UI park/reload/edit, followed by the existing native OFF preparation and auto-drain. */
export async function verifyPendingMentionReload(app: ElectronApplication, page: Page,
  workspace: string, artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void, logPath: string): Promise<void> {
  const project = join(workspace, "pending-mention-reload-project")
  const fixtureId = "pending-mention-reload-local", modelRef = `custom:${fixtureId}`
  const title = "Pending mention reload E2E", key = "local-pending-fixture-key"
  const uploadBody = "UPLOAD_BEFORE_RELOAD\n", chipBody = "CHIP_AT_ACCEPT\n"
  const typedBody = "TYPED_B_AT_ACCEPT\n", acceptedText = "PENDING_NATIVE_ACCEPT typed-b.txt"
  const answer = "PENDING_REPLY_COMPLETE"
  mkdirSync(project, { recursive: true })
  const initialFiles = {
    "chip.txt": "CHIP_BEFORE_RELOAD\n",
    "typed-a.txt": "TYPED_A_MUST_NOT_READ\n",
    "typed-b.txt": "TYPED_B_BEFORE_ACCEPT\n"
  }
  for (const [name, body] of Object.entries(initialFiles)) writeFileSync(join(project, name), body)
  const failures: unknown[] = [], requests: ProviderRequest[] = [], labels: string[] = []
  const handlers = new Set<Promise<void>>()
  const allHandlers: Promise<void>[] = []
  const holding = Promise.withResolvers<void>(), shutdown = Promise.withResolvers<void>()
  const evidence: Record<string, unknown> = { complete: false, requests, labels,
    osReadOnce: "not-observed", genuineDesktopControls: true }
  let threadId: string | undefined = undefined, baseUrl = ""
  let observerInstalled = false, listening = false, finishedHandlers = 0
  let requestsBeforeClose: string | undefined = undefined
  let rowsBeforeClose: unknown = undefined, checkpointsBeforeClose: unknown = undefined
  let guestInstance: string | undefined = undefined
  const record = (label: string) => { labels.push(label); pass(label) }

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const disconnected = Promise.withResolvers<void>()
    response.once("close", () => disconnected.resolve())
    try {
      const chunks: Buffer[] = []
      for await (const piece of request) chunks.push(Buffer.from(piece))
      const raw = object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      assert(Array.isArray(raw.messages))
      const messages = raw.messages.map(value => {
        const message = object(value)
        assert.equal(typeof message.role, "string")
        assert(Object.hasOwn(message, "content"))
        return { role: message.role as string, content: message.content }
      })
      requests.push({ raw, messages })
      if (requests.length === 1) {
        assert.equal(contentText(messages.filter(message => message.role === "user").at(-1)?.content),
          "PENDING_HOLD")
        holding.resolve()
        await Promise.race([disconnected.promise, shutdown.promise])
        assert(response.destroyed, "The held provider must be disconnected by actual cancellation")
        return
      }
      assert.equal(requests.length, 2, "A restored draft may enter the actual provider only once")
      const id = "pending-reload-provider"
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
        choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      })}\n\ndata: [DONE]\n\n`)
    } catch (reason) {
      failures.push(reason)
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500)
        response.end("Actual pending mention provider failed")
      }
    } finally { finishedHandlers++ }
  }
  const server = createServer((request, response) => {
    const actual = serve(request, response)
    handlers.add(actual)
    allHandlers.push(actual)
    void actual.then(() => handlers.delete(actual), reason => {
      failures.push(reason)
      handlers.delete(actual)
    })
  })
  const input = () => page.locator("textarea.composer-textarea")
  const idle = async () => await page.getByRole("button", { name: "停止生成", exact: true }).count() === 0
  const rows = () => {
    assert(threadId)
    return page.evaluate(id => window.api.threads.getMessages(id), threadId)
  }
  const history = () => {
    assert(threadId)
    return page.evaluate(id => window.api.threads.getHistory(id), threadId)
  }
  const readTerminals = () => app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __pendingMentionProbe?: Probe }
    if (!state.__pendingMentionProbe) throw Error("The actual terminal observer must be installed")
    return state.__pendingMentionProbe.readNativeAppendTerminals()
  })
  const assertTerminals = (observed: Awaited<ReturnType<typeof readTerminals>>, count: number) => {
    assert.equal(observed.length, count)
    assert.equal(new Set(observed.map(item => item.requestId)).size, count)
    assert.equal(new Set(observed.map(item => item.channel)).size, count)
    for (const item of observed) {
      assert.equal(item.operation, "agent:invoke")
      assert.deepEqual(item.terminals, ["done"], "An error cannot be hidden by a subsequent done")
    }
  }
  const snapshot = async (): Promise<QueueSnapshot> => {
    assert(threadId)
    const raw = await page.evaluate(storageKey => localStorage.getItem(storageKey), queueStorageKey(threadId))
    assert(raw, "The actual parked queue must be persisted")
    const parsed: unknown = JSON.parse(raw)
    assert(Array.isArray(parsed) && parsed.length === 1)
    const entry = object(parsed[0])
    assert.equal(typeof entry.id, "string")
    assert.equal(typeof entry.created_at, "string")
    assert.equal(typeof entry.updated_at, "string")
    assert.equal(entry.modelId, modelRef)
    assert(Array.isArray(entry.pendingMentions) && Array.isArray(entry.existingUploads))
    return { raw, entry }
  }
  const submit = async (text: string) => {
    await input().fill(text)
    await input().press("Escape")
    await input().press("Enter")
  }
  const assertModel = async (available: boolean) => {
    await until(async () => {
      assert(threadId)
      const actual = await page.evaluate(async ({ id, thread }) => ({
        catalog: await window.api.models.getCatalog(),
        config: await window.api.models.getCustomConfig(id),
        thread: await window.api.threads.get(thread)
      }), { id: fixtureId, thread: threadId })
      const model = actual.catalog.models.find(item => item.id === modelRef)
      assert(model, "The same model ref must remain present; a fallback is not this fixture")
      assert(actual.config && actual.config.id === fixtureId)
      assert(actual.thread, "The actual current thread must still exist")
      assert.equal(actual.thread.metadata?.model, modelRef)
      assert.equal(actual.thread.metadata?.workspacePath, project)
      return model.available === available && actual.config.hasApiKey === available &&
        actual.catalog.defaultModelId === modelRef && actual.catalog.routingMode === "pinned"
    }, `actual same-ref model ${available ? "available" : "unavailable"}`)
  }
  const audit = async () => {
    assert(threadId)
    const id = threadId
    const command = (await page.evaluate(id => window.api.mods.commands(id), id))
      .find(item => item.command === "pending-mention-audit")
    assert(command, "The actual Guest must register its immediate audit command")
    const job = await page.evaluate(({ id, command }) => window.api.mods.enqueue(id, command, { text: "" }),
      { id, command })
    await until(async () => {
      const actual = (await page.evaluate(id => window.api.mods.jobs(id), id)).find(item => item.id === job.id)
      assert(actual && !["failed", "cancelled", "unknown"].includes(actual.state), JSON.stringify(actual))
      return actual.state === "succeeded"
    }, "actual pending mention Guest audit finally")
    const actual = (await page.evaluate(id => window.api.mods.jobs(id), id)).find(item => item.id === job.id)
    assert(actual?.result)
    const value = object(JSON.parse(actual.result.text))
    assert.equal(typeof value.instance, "string")
    assert(Array.isArray(value.mentions))
    if (guestInstance === undefined) guestInstance = value.instance as string
    assert.equal(value.instance, guestInstance, "Guest observations must come from the same actual instance")
    assert.deepEqual(value.mentions, [], "Parked references must remain unread before OFF")
    return value
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { listening = true; resolve() })
    })
    const address = server.address()
    assert(address && typeof address === "object")
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    threadId = await page.evaluate(async ({ project, baseUrl, fixtureId, modelRef, title, key }) => {
      await window.api.routing.setMode("pinned")
      await window.api.models.setCustomConfig({ id: fixtureId, name: "Pending reload local",
        baseUrl, model: "gpt-4", apiKey: key, maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault(modelRef)
      const created = await window.api.threads.create({ title, workspacePath: project, agentMode: "normal" })
      const id = (created as unknown as { thread_id?: unknown }).thread_id
      if (typeof id !== "string" || !id) throw Error("The real fixture thread ID is required")
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, { set: { model: modelRef, subagentsEnabled: false } })
      await window.api.mods.configure(id, true, true)
      return id
    }, { project, baseUrl, fixtureId, modelRef, title, key })
    // The callback above uses only browser APIs; no Host helper is serialized into it.
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
    await assertModel(true)
    evidence.threadId = threadId
    const source = String.raw`export function register(on){
      const mentions=[],instance=String(Math.random())+":"+String(Date.now());
      on("session.start",async($,e,next)=>{await $.command.register({name:"pending-mention-audit",
        description:"Observe the actual unread pending fixture",immediate:true});return next(e)});
      on("command.run",{command:"pending-mention-audit"},()=>({text:JSON.stringify({instance,mentions})}));
      on("prompt.mention",async($,e,next)=>{mentions.push(JSON.parse(JSON.stringify(e)));
        return {...await next(e),context:["PENDING_MENTION_ON_HOOK"]}});
      on("prompt.attachment",($,e,next)=>next(e));
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "pending-mention-reload", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile("hooks/register.ts", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "pending-mention-reload.zip"), bytes)
    const installed = await page.evaluate(bytes => window.api.plugins.install(new Uint8Array(bytes).buffer,
      "pending-mention-reload.zip", "local"), [...bytes])
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(item => item.name === "pending-mention-reload")
    assert(plugin?.digest)
    await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest })
    assert.equal((await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(item => item.name === "pending-mention-reload")?.state, "ready")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const browserWindow = await app.browserWindow(page)
    await app.evaluate((_, { window, id, entry }) => {
      const probe = process.getBuiltinModule("node:module").createRequire(entry)(entry) as Probe
      probe.observeNativeAppendTerminals(window, id)
      const state = globalThis as typeof globalThis & { __pendingMentionProbe?: Probe }
      state.__pendingMentionProbe = probe
    }, { window: browserWindow, id: threadId,
      entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
    observerInstalled = true
    await until(async () => await input().isEnabled(), "actual initialized pending composer")
    await submit("PENDING_HOLD")
    let providerHeld = false
    void holding.promise.then(() => { providerHeld = true })
    await until(async () => providerHeld && requests.length === 1 &&
      await page.getByRole("button", { name: "停止生成", exact: true }).count() === 1,
    "actual HTTP held before output and the real Stop button")

    const transfer = await page.evaluateHandle(text => {
      const data = new DataTransfer()
      data.items.add(new File([text], "upload.txt", { type: "text/plain" }))
      return data
    }, uploadBody)
    try { await input().dispatchEvent("drop", { dataTransfer: transfer }) }
    finally { await transfer.dispose() }
    await until(async () => await page.getByRole("button", { name: "移除附件 upload.txt", exact: true }).count() === 1,
      "actual upload parser before parking")
    await input().fill("@chip.txt")
    await until(async () => await page.getByRole("option", { name: /chip\.txt/ }).count() === 1,
      "actual chip suggestion before parking")
    await page.getByRole("option", { name: /chip\.txt/ }).click()
    assert.equal(await page.getByRole("button", { name: "移除文件标签", exact: true }).count(), 1)
    await submit("PENDING_QUEUED @typed-a.txt")
    await until(async () => (await page.locator("body").innerText()).includes("排队中 1 条"),
      "actual structured unread parked card")
    const parked = await snapshot()
    const refs = (parked.entry.pendingMentions as unknown[]).map(object)
    assert.deepEqual(refs.map(item => [item.relativePath, item.source]), [["/chip.txt", "chip"], ["typed-a.txt", "typed"]])
    assert(refs.every(item => item.workspacePath === project && item.offset === undefined && item.limit === undefined))
    const uploads = (parked.entry.existingUploads as unknown[]).map(attachment)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].filename, "upload.txt")
    assert.equal(uploads[0].content, uploadBody)
    assert.equal(uploads[0].size, Buffer.byteLength(uploadBody))
    assert.equal(parked.entry.fileOnly, false)
    evidence.parked = parked
    evidence.auditBeforeOff = await audit()
    assert.equal(requests.length, 1)
    assert.equal((await readTerminals()).length, 1)
    assert(!(await rows()).some(row => row.id === parked.entry.id))

    await page.getByRole("button", { name: "停止生成", exact: true }).click()
    await until(async () => await idle() && finishedHandlers === 1 && handlers.size === 0 &&
      (await readTerminals()).length === 1 && (await readTerminals())[0].terminals.includes("done"),
    "actual Stop, request done and the disconnected provider finally")
    assertTerminals(await readTerminals(), 1)
    assert.deepEqual((await snapshot()).entry, parked.entry)
    assert.equal(requests.length, 1)
    const stoppedRows = await rows(), stoppedHistory = await history()
    assert(!(stoppedRows.some(row => row.id === parked.entry.id)))
    evidence.stoppedRows = stoppedRows
    evidence.stoppedCheckpoints = stoppedHistory
    record("real Stop retires the held turn while preserving the complete unread draft")

    await page.evaluate(async ({ fixtureId, modelRef, baseUrl }) => {
      await window.api.models.deleteCustomConfig(fixtureId)
      await window.api.models.setCustomConfig({ id: fixtureId, name: "Pending reload local",
        baseUrl, model: "gpt-4", maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault(modelRef)
    }, { fixtureId, modelRef, baseUrl })
    await assertModel(false)
    await page.evaluate(id => window.api.mods.configure(id, false, false), threadId)
    await until(async () => {
      assert(threadId)
      const route = await page.evaluate(id => window.api.mods.composerEnabled(id), threadId)
      assert.equal(route.workspace, project)
      assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
      return route.enabled === false && await idle()
    }, "actual workspace OFF while global Mods remain ON")
    const beforeReload = await snapshot()
    assert.deepEqual(beforeReload.entry, parked.entry)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await until(async () => (await page.locator("body").innerText()).includes("排队中 1 条") &&
      (await page.locator("body").innerText()).includes("当前模型不可用"),
    "actual restored parked draft behind the real unavailable-model gate")
    await assertModel(false)
    const restored = await snapshot()
    assert.deepEqual(restored.entry, beforeReload.entry)
    assert.equal(requests.length, 1)
    assertTerminals(await readTerminals(), 1)
    assert.deepEqual(await rows(), stoppedRows)
    evidence.beforeReload = beforeReload
    evidence.restored = restored
    record("true reload preserves the original id, version, upload bytes and unread references")

    await page.locator("form").locator("button[title='更多']").first().click()
    await page.getByRole("button", { name: "编辑消息", exact: true }).click()
    await page.locator("form textarea:not(.composer-textarea)").fill("PENDING_NATIVE_ACCEPT @typed-b.txt")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await until(async () => await page.locator("form textarea:not(.composer-textarea)").count() === 0 &&
      (await page.locator("body").innerText()).includes("PENDING_NATIVE_ACCEPT"), "real pending draft edit")
    const edited = await snapshot(), editedRefs = (edited.entry.pendingMentions as unknown[]).map(object)
    assert.equal(edited.entry.id, parked.entry.id)
    assert.equal(edited.entry.created_at, parked.entry.created_at)
    assert.notEqual(edited.entry.updated_at, parked.entry.updated_at)
    assert.deepEqual(edited.entry.existingUploads, parked.entry.existingUploads)
    assert.deepEqual(editedRefs.map(item => [item.relativePath, item.source]), [["/chip.txt", "chip"], ["typed-b.txt", "typed"]])
    assert.deepEqual(editedRefs[0], refs[0])
    assert(editedRefs.every(item => item.workspacePath === project))
    writeFileSync(join(project, "chip.txt"), chipBody)
    writeFileSync(join(project, "typed-b.txt"), typedBody)
    evidence.edited = edited
    assert.equal(requests.length, 1)
    assertTerminals(await readTerminals(), 1)

    await page.evaluate(async ({ fixtureId, modelRef, baseUrl, key }) => {
      await window.api.models.setCustomConfig({ id: fixtureId, name: "Pending reload local",
        baseUrl, model: "gpt-4", apiKey: key, maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault(modelRef)
    }, { fixtureId, modelRef, baseUrl, key })
    await assertModel(true)
    await until(async () => requests.length === 2 && await idle() && finishedHandlers === 2 &&
      (await rows()).some(row => row.role === "assistant" && contentText(row.content) === answer),
    "original auto-drain sends the edited draft and completes its real reply")
    assertTerminals(await readTerminals(), 2)
    const currentInputs = requests[1].messages.filter(item => item.role === "user")
      .map(item => contentText(item.content)).filter(text => text.includes("PENDING_NATIVE_ACCEPT"))
    const logicalRoot = project.replaceAll("\\", "/")
    const expected = acceptedText + formatComposerAttachments([...uploads,
      { filename: "chip.txt", filePath: `${logicalRoot}/chip.txt`, content: chipBody,
        mimeType: "text/plain", size: Buffer.byteLength(chipBody), truncated: false },
      { filename: "typed-b.txt", filePath: `${logicalRoot}/typed-b.txt`, content: typedBody,
        mimeType: "text/plain", size: Buffer.byteLength(typedBody), truncated: false }])
    assert.deepEqual(currentInputs, [expected], "Native OFF input must preserve the entire latest attachment payload")
    assert(!JSON.stringify(requests[1]).includes("PENDING_MENTION_ON_HOOK"))
    assert(!expected.includes("@typed-b.txt") && !expected.includes("typed-a.txt"))
    const finalRows = await rows(), finalHistory: unknown = await history()
    const accepted = finalRows.filter(row => row.id === parked.entry.id)
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].role, "user")
    assert.equal(contentText(accepted[0].content), expected)
    const replies = finalRows.filter(row => row.role === "assistant" && contentText(row.content) === answer)
    assert.equal(replies.length, 1)
    assert.notEqual(replies[0].id, accepted[0].id)
    assert(finalRows.indexOf(replies[0]) > finalRows.indexOf(accepted[0]))
    for (const row of stoppedRows) assert.deepEqual(finalRows.find(item => item.id === row.id), row)
    assert(Array.isArray(finalHistory))
    const completeCheckpoint = finalHistory.some(value => {
      const checkpoint = object(object(value).checkpoint), channels = object(checkpoint.channel_values)
      if (!Array.isArray(channels.messages)) return false
      const messages = channels.messages.map(object)
      return messages.filter(item => item.id === accepted[0].id && contentText(item.content) === expected).length === 1 &&
        messages.filter(item => item.id === replies[0].id && contentText(item.content) === answer).length === 1
    })
    assert(completeCheckpoint, "The real checkpoint must preserve both durable IDs and complete contents")
    assert.equal(await page.evaluate(storageKey => localStorage.getItem(storageKey), queueStorageKey(threadId)), null)
    evidence.nativeInput = expected
    evidence.acceptedId = accepted[0].id
    evidence.replyId = replies[0].id
    evidence.rows = finalRows
    evidence.checkpoints = finalHistory
    record("the original auto-drain reads current files after OFF and keeps full native XML and the queued ID")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await until(async () => await input().isEnabled() && await idle() &&
      (await page.locator("body").innerText()).includes(answer), "actual accepted transcript reload")
    assert.deepEqual(await rows(), finalRows)
    assert.deepEqual(await history(), finalHistory)
    assert.equal(await page.evaluate(storageKey => localStorage.getItem(storageKey), queueStorageKey(threadId)), null)
    assert.equal(requests.length, 2)
    assertTerminals(await readTerminals(), 2)
    requestsBeforeClose = JSON.stringify(requests)
    rowsBeforeClose = finalRows
    checkpointsBeforeClose = finalHistory
    evidence.terminals = await readTerminals()
    evidence.echoConflictsBeforeClose = readNativeAppendEchoConflicts(logPath)
    assert.equal(evidence.echoConflictsBeforeClose, 0)
    await page.screenshot({ path: join(artifacts, "pending-mention-reload.png"), fullPage: true })
    record("a second real reload does not replay either request or recreate the removed queue entry")
    evidence.complete = true
  } catch (reason) { failures.push(reason) }
  finally {
    const attempt = async (work: () => unknown | Promise<unknown>) => {
      try { await work() } catch (reason) { failures.push(reason) }
    }
    if (threadId) {
      await attempt(async () => {
        const stop = page.getByRole("button", { name: "停止生成", exact: true })
        if (await stop.count()) await stop.click()
      })
      const id = threadId
      await attempt(() => page.evaluate(id => window.api.agent.cancel(id), id))
    }
    let close: Promise<void> | undefined = undefined
    try {
      if (listening) {
        close = new Promise<void>((resolve, reject) => server.close(reason => reason ? reject(reason) : resolve()))
        void close.catch(() => undefined)
      }
    } catch (reason) { failures.push(reason) }
    try { server.closeAllConnections() } catch (reason) { failures.push(reason) }
    shutdown.resolve()
    if (close) {
      try { await close } catch (reason) { failures.push(reason) }
    }
    const settled = await Promise.allSettled(allHandlers)
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason)
    if (observerInstalled) {
      await attempt(async () => { evidence.terminalsBeforeCleanupWait = await readTerminals() })
      await attempt(async () => {
        await until(async () => (await readTerminals()).every(item => item.terminals.includes("done")),
          "every actual pending request terminal after cleanup")
        const observed = await readTerminals()
        evidence.finalTerminals = observed
        assert(observed.every(item => !item.terminals.includes("error")), JSON.stringify(observed))
        if (requestsBeforeClose !== undefined) assertTerminals(observed, 2)
      })
      await attempt(async () => { evidence.finalTerminals = await readTerminals() })
      await attempt(async () => {
        await app.evaluate(() => {
          const state = globalThis as typeof globalThis & { __pendingMentionProbe?: Probe }
          try { state.__pendingMentionProbe?.stopNativeAppendTerminalObserver() }
          finally { delete state.__pendingMentionProbe }
        })
      })
    }
    await attempt(async () => {
      if (requestsBeforeClose !== undefined) assert.equal(JSON.stringify(requests), requestsBeforeClose,
        "Actual HTTP input changed after every provider handler and server settled")
    })
    await attempt(async () => {
      if (threadId && rowsBeforeClose !== undefined) assert.deepEqual(await rows(), rowsBeforeClose)
    })
    await attempt(async () => {
      if (threadId && checkpointsBeforeClose !== undefined) assert.deepEqual(await history(), checkpointsBeforeClose)
    })
    await attempt(async () => {
      evidence.echoConflictsAfterGuestAndServerCleanup = readNativeAppendEchoConflicts(logPath)
      assert.equal(evidence.echoConflictsAfterGuestAndServerCleanup, 0)
    })
    evidence.finishedHandlers = finishedHandlers
    evidence.complete = evidence.complete === true && failures.length === 0
    evidence.failures = failures.map(reason => reason instanceof Error
      ? { name: reason.name, message: reason.message }
      : { kind: reason === undefined ? "undefined" : reason === null ? "null" : typeof reason })
    try { writeFileSync(join(artifacts, "pending-mention-reload-results.json"), JSON.stringify(evidence, null, 2)) }
    catch (reason) { failures.push(reason) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Actual pending mention reload failed")
}

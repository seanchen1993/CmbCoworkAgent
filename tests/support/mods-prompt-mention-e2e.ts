import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { readNativeAppendEchoConflicts } from "./mods-native-append-e2e"
import { formatComposerAttachments } from "../../src/shared/mods/v2/composer-mentions"
import { queueStorageKey } from "../../src/renderer/src/lib/queued-message-content"

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; raw: Record<string, unknown> }
type Audit = { phase: string; mention: string; instance: string; question?: Record<string, unknown> }
type CancelDomSample = { atMs: number; label: string; stops: number; disabled: boolean[] }
type CancelDomProbe = { observer: MutationObserver; samples: CancelDomSample[];
  sample(label: string): void }
type TerminalProbe = Pick<typeof import("./mods-e2e-entry"), "observeNativeAppendTerminals" |
  "readNativeAppendTerminals" | "stopNativeAppendTerminalObserver">

/** Actual desktop controls, installed guest, native provider and durable transcript. */
export async function verifyPromptMention(app: ElectronApplication, page: Page, workspace: string,
  artifacts: string, until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void, logPath: string,
  offScope: "global" | "workspace" = "global"): Promise<void> {
  const project = join(workspace, "prompt-mention-project")
  mkdirSync(project, { recursive: true })
  const fixtureFiles: Record<string, string> = {
    "normal.txt": "NORMAL_SOURCE_MUST_NOT_LEAK\n",
    "replacement.txt": "REWRITE_FIRST\nREWRITE_SECOND\nREWRITE_THIRD\nREWRITE_LAST\n",
    "deny.txt": "DENIED_BODY_MUST_NOT_LEAK\n",
    "old.txt": "OLD_QUEUE_MUST_NOT_READ\n",
    "new.txt": "NEW_QUEUE_BEFORE_ACCEPT\n",
    "cancel.txt": "CANCEL_BODY_MUST_NOT_COMMIT\n",
    "legacy.txt": "LEGACY_OFF_BODY\n"
  }
  for (const [name, text] of Object.entries(fixtureFiles)) writeFileSync(join(project, name), text)
  const requests: ProviderRequest[] = [], labels: string[] = [], failures: unknown[] = []
  const evidence: Record<string, unknown> = { complete: false, requests, labels,
    osReadOnce: "not-observed", guideUiEnabled: false, genuineDesktopControls: true, offScope }
  const record = (label: string) => { labels.push(label); pass(label) }
  const handlers = new Set<Promise<void>>()
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  let hold: { entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  let observerInstalled = false, threadId: string | undefined
  let cancelDomObserverInstalled = false
  let guestInstance: string | undefined, listening = false
  let requestsBeforeClose: string | undefined
  let globalEnabledBeforeOff: boolean | undefined
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages))
      const messages = body.messages.map((message: unknown) => {
        assert(message && typeof message === "object" && "role" in message &&
          typeof message.role === "string" && "content" in message)
        return { role: message.role, content: message.content }
      })
      requests.push({ messages, raw: body as Record<string, unknown> })
      const ordinal = requests.length, held = hold
      hold = undefined
      if (held) { held.entered.resolve(); await held.release.promise }
      if (response.destroyed) return
      const id = `mention-provider-${ordinal}`, content = `MENTION_DONE_${ordinal}`
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      failures.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end("Actual mention provider failed")
    }
  }
  const server = createServer((request, response) => {
    const actual = serve(request, response)
    handlers.add(actual)
    void actual.then(() => handlers.delete(actual), error => { failures.push(error); handlers.delete(actual) })
  })
  const readTerminals = () => app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __mentionTerminalProbe?: TerminalProbe }
    if (!state.__mentionTerminalProbe) throw Error("Actual mention terminal observer missing")
    return state.__mentionTerminalProbe.readNativeAppendTerminals()
  })
  const rows = () => {
    assert(threadId)
    return page.evaluate(id => window.api.threads.getMessages(id), threadId)
  }
  const idle = async () => await page.getByRole("button", { name: "停止生成", exact: true }).count() === 0
  const input = () => page.locator("textarea.composer-textarea")
  const cancelDomSample = (label: string) => page.evaluate(actualLabel => {
    const state = window as typeof window & { __modsMentionCancelDom?: CancelDomProbe }
    if (!state.__modsMentionCancelDom) throw Error("Actual cancellation DOM observer missing")
    state.__modsMentionCancelDom.sample(actualLabel)
  }, label)
  const assertCompleteTerminals = (observed: Awaited<ReturnType<typeof readTerminals>>) => {
    assert.equal(observed.length, 8, "Actual UI must send six admitted requests, one drop and one Stop request")
    assert.equal(new Set(observed.map(row => row.requestId)).size, observed.length)
    assert.equal(new Set(observed.map(row => row.channel)).size, observed.length)
    for (const row of observed) {
      assert.equal(row.operation, "agent:invoke")
      assert.deepEqual(row.terminals, ["done"], "No actual request may hide an error before done")
    }
  }
  const providerInput = (ordinal: number, marker: string): string => {
    const candidates = requests[ordinal - 1].messages.filter(message => message.role === "user")
      .map(message => {
        if (typeof message.content === "string") return message.content
        assert(Array.isArray(message.content), "Actual fixture input must be string or text blocks")
        return message.content.map(block => {
          assert(block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
          return block.text
        }).join("")
      }).filter(content => content.includes(marker))
    assert.equal(candidates.length, 1, "Actual HTTP must contain the exact admitted user input once")
    return candidates[0]
  }
  const parkedSnapshot = async (): Promise<string> => {
    assert(threadId)
    const snapshot = await page.evaluate(key => localStorage.getItem(key), queueStorageKey(threadId))
    assert(snapshot, "Actual UI queue did not persist its draft")
    const parsed: unknown = JSON.parse(snapshot)
    assert(Array.isArray(parsed) && parsed.length > 0)
    return snapshot
  }
  const submit = async (text: string) => {
    await input().fill(text)
    await input().press("Escape")
    await input().press("Enter")
  }
  const finished = async (requestCount: number, cursor: number) => {
    await until(async () => requests.length === requestCount && await idle() &&
      JSON.stringify(await rows()).includes(`MENTION_DONE_${requestCount}`),
    `actual mention provider reply ${requestCount}`)
    await until(async () => {
      const observed = (await readTerminals()).slice(cursor)
      assert(observed.every(row => !row.terminals.includes("error")), JSON.stringify(observed))
      return observed.length > 0 && observed[observed.length - 1].terminals.includes("done")
    }, `actual mention request ${requestCount} done`)
  }
  const checkpointInput = async (marker: string, requiredBody: string) => {
    assert(threadId)
    const saved = (await rows()).filter(row => row.role === "user" &&
      JSON.stringify(row.content).includes(marker))
    assert.equal(saved.length, 1, "Actual input must have one durable ID")
    const history: unknown = await page.evaluate(id => window.api.threads.getHistory(id), threadId)
    assert(Array.isArray(history))
    const matching = history.some(tuple => {
      if (!tuple || typeof tuple !== "object" || !tuple.checkpoint?.channel_values?.messages) return false
      const messages: unknown = tuple.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) return false
      return messages.filter(message => message && typeof message === "object" &&
        message.id === saved[0].id &&
        JSON.stringify(message.content).includes(JSON.stringify(requiredBody).slice(1, -1))).length === 1
    })
    assert(matching, "The actual checkpoint must preserve the admitted input ID and full body")
    return saved[0].id
  }
  const audit = async (): Promise<Audit[]> => {
    assert(threadId)
    const id = threadId
    const descriptor = (await page.evaluate(id => window.api.mods.commands(id), id))
      .find(row => row.command === "mention-e2e-audit")
    assert(descriptor, "Actual guest audit command was not registered")
    const job = await page.evaluate(({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
      { id, descriptor })
    await until(async () => {
      const current = (await page.evaluate(id => window.api.mods.jobs(id), id)).find(row => row.id === job.id)
      assert(current && current.state !== "failed" && current.state !== "cancelled" && current.state !== "unknown",
        JSON.stringify(current))
      return current.state === "succeeded"
    }, "actual guest audit command finally")
    const current = (await page.evaluate(id => window.api.mods.jobs(id), id)).find(row => row.id === job.id)
    assert(current?.result)
    const value: unknown = JSON.parse(current.result.text)
    assert(value && typeof value === "object" && "instance" in value && typeof value.instance === "string" &&
      "audits" in value && Array.isArray(value.audits))
    if (guestInstance === undefined) guestInstance = value.instance
    assert.equal(value.instance, guestInstance, "Actual audit came from another guest instance")
    return value.audits.map(row => {
      assert(row && typeof row === "object" && typeof row.phase === "string" && typeof row.mention === "string" &&
        row.instance === guestInstance)
      return row as Audit
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { listening = true; resolve() })
    })
    const address = server.address()
    assert(address && typeof address === "object")
    const threadIds = await page.evaluate(async ({ project, url }) => {
      await window.api.models.setCustomConfig({ id: "mention-local", name: "Mention local",
        baseUrl: url, model: "gpt-4", apiKey: "local-fixture-key", maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault("custom:mention-local")
      const thread = await window.api.threads.create({ title: "Prompt mention E2E", workspacePath: project,
        agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, { set: { model: "custom:mention-local", subagentsEnabled: false } })
      await window.api.mods.configure(id, true, true)
      const parked = await window.api.threads.create({ title: "Prompt mention other thread",
        workspacePath: project, agentMode: "normal" })
      return { id, other: (parked as unknown as { thread_id: string }).thread_id }
    }, { project, url: `http://127.0.0.1:${address.port}/v1` })
    threadId = threadIds.id
    evidence.threadId = threadId
    evidence.otherThreadId = threadIds.other
    const source = String.raw`export function register(on){
      const audits=[],instance=String(Math.random())+":"+String(Date.now());
      on("session.start",async($,e,next)=>{await $.command.register({name:"mention-e2e-audit",
        description:"Read actual mention fixture observations",immediate:true});return next(e)});
      on("command.run",{command:"mention-e2e-audit"},()=>({text:JSON.stringify({instance,audits})}));
      on("prompt.mention",async($,e,next)=>{
        audits.push({phase:"entered",mention:e.mention,instance,question:JSON.parse(JSON.stringify(e))});
        const selected=e.mention.startsWith("normal.txt")?{...e,path:e.path.replace(/normal\.txt$/,"replacement.txt"),offset:2,limit:2}:e;
        const result=await next(selected),again=await next(selected);
        if(JSON.stringify(result)!==JSON.stringify(again))throw Error("actual next result changed");
        audits.push({phase:"read-returned",mention:e.mention,instance});
        if(e.mention==="deny.txt")return {deny:"FIXTURE_DENY"};
        if(e.mention==="cancel.txt"){
          audits.push({phase:"sleep-entered",mention:e.mention,instance});
          try{await $.clock.sleep(5000)}finally{audits.push({phase:"sleep-finally",mention:e.mention,instance})}
        }
        return {...result,context:["MENTION_EVENT:"+e.mention,"MENTION_HIDDEN_CONTEXT","MENTION_HIDDEN_CONTEXT"]};
      });
      on("prompt.attachment",($,e,next)=>next(e));
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "prompt-mention-q", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile("hooks/register.ts", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "prompt-mention-q.zip"), bytes)
    const installed = await page.evaluate(bytes => window.api.plugins.install(new Uint8Array(bytes).buffer,
      "prompt-mention-q.zip", "local"), [...bytes])
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(row => row.name === "prompt-mention-q")
    assert(plugin?.digest)
    await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest })
    assert.equal((await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(row => row.name === "prompt-mention-q")?.state, "ready")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Prompt mention E2E", { exact: true }).first().click()
    const browserWindow = await app.browserWindow(page)
    await app.evaluate((_, { window, id, entry }) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      const probe = createRequire(entry)(entry) as TerminalProbe
      probe.observeNativeAppendTerminals(window, id)
      const state = globalThis as typeof globalThis & { __mentionTerminalProbe?: TerminalProbe }
      state.__mentionTerminalProbe = probe
    }, { window: browserWindow, id: threadId, entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
    observerInstalled = true
    let cursor = (await readTerminals()).length
    await submit("MENTION_NORMAL @normal.txt#L2-3")
    await finished(1, cursor)
    const first = providerInput(1, "MENTION_NORMAL")
    assert(first.includes("REWRITE_SECOND\nREWRITE_THIRD\n"))
    assert(!first.includes("NORMAL_SOURCE_MUST_NOT_LEAK") && !first.includes("REWRITE_FIRST") && !first.includes("REWRITE_LAST"))
    assert(first.includes("replacement.txt"))
    assert.equal((JSON.stringify(requests[0].messages).match(/MENTION_HIDDEN_CONTEXT/g) ?? []).length, 2)
    assert(!(await page.locator("body").innerText()).includes("MENTION_HIDDEN_CONTEXT"))
    const firstAudit = await audit()
    assert.equal(firstAudit.filter(row => row.phase === "entered" && row.mention === "normal.txt#L2-3").length, 1)
    const actualQuestion = firstAudit.find(row => row.phase === "entered")?.question
    assert(actualQuestion && actualQuestion.mention === "normal.txt#L2-3" && actualQuestion.offset === 2 && actualQuestion.limit === 2)
    assert(!Object.hasOwn(actualQuestion, "agentId"))
    evidence.normalInputId = await checkpointInput("MENTION_NORMAL", "REWRITE_SECOND\nREWRITE_THIRD\n")
    record("real typed mention rewrites before HTTP, preserves duplicate context and omits internal composer agentId")
    await page.screenshot({ path: join(artifacts, "prompt-mention-normal.png"), fullPage: true })

    const upload = "UPLOAD_BODY_LITERAL"
    const transfer = await page.evaluateHandle(text => {
      const data = new DataTransfer()
      data.items.add(new File([text], "upload.txt", { type: "text/plain" }))
      return data
    }, upload)
    try { await input().dispatchEvent("drop", { dataTransfer: transfer }) }
    finally { await transfer.dispose() }
    await until(async () => await page.getByRole("button", { name: "移除附件 upload.txt", exact: true }).count() === 1,
      "actual browser attachment parser")
    cursor = (await readTerminals()).length
    await submit("MENTION_MIXED @deny.txt")
    await finished(2, cursor)
    const mixed = providerInput(2, "MENTION_MIXED")
    assert(mixed.includes(upload) && mixed.includes("upload.txt") && mixed.includes("MENTION_MIXED"))
    assert(!mixed.includes("DENIED_BODY_MUST_NOT_LEAK") && !mixed.includes("MENTION_EVENT:deny.txt"))
    assert.equal((await audit()).filter(row => row.phase === "read-returned" && row.mention === "deny.txt").length, 1)
    evidence.mixedInputId = await checkpointInput("MENTION_MIXED", upload)
    record("actual upload bytes remain complete while a real after-next deny removes its file and context")

    cursor = (await readTerminals()).length
    const beforeDrop = await rows(), callsBeforeDrop = requests.length
    await input().fill("@deny.txt")
    await until(async () => await page.getByRole("option", { name: /deny\.txt/ }).count() === 1,
      "real file-only selected chip")
    await page.getByRole("option", { name: /deny\.txt/ }).click()
    await input().press("Escape")
    await input().press("Enter")
    await until(async () => {
      const observed = (await readTerminals()).slice(cursor)
      assert(observed.every(row => !row.terminals.includes("error")), JSON.stringify(observed))
      return await idle() && observed.some(row => row.terminals.includes("done"))
    }, "actual file-only deny terminal")
    assert.equal(requests.length, callsBeforeDrop)
    assert.deepEqual(await rows(), beforeDrop)
    const restoredChip = page.getByRole("button", { name: "移除文件标签", exact: true })
    assert(await restoredChip.count() <= 1, "File-only deny restored an unexpected attachment set")
    if (await restoredChip.count()) await restoredChip.click()
    record("the actual selected file-only chip is dropped after deny without a provider or durable admission")

    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    gates.push(release)
    hold = { entered, release }
    cursor = (await readTerminals()).length
    let providerHeld = false
    void entered.promise.then(() => { providerHeld = true })
    await submit("MENTION_HOLD")
    await until(async () => providerHeld && requests.length === 3, "actual provider has entered its held response")
    await submit("MENTION_QUEUE @old.txt")
    await until(async () => (await page.locator("body").innerText()).includes("排队中 1 条"), "real parked unread draft")
    assert.equal((await audit()).filter(row => row.mention === "old.txt").length, 0)
    const parkedBeforeSwitch = await parkedSnapshot()
    await page.getByText("Prompt mention other thread", { exact: true }).first().click()
    await until(async () => await input().count() === 1 &&
      !(await page.locator("body").innerText()).includes("MENTION_QUEUE @old.txt"), "real other thread view")
    await page.getByText("Prompt mention E2E", { exact: true }).first().click()
    await until(async () => (await page.locator("body").innerText()).includes("排队中 1 条") &&
      (await page.locator("body").innerText()).includes("MENTION_QUEUE @old.txt"), "real pending draft sidebar restoration")
    assert.equal(await parkedSnapshot(), parkedBeforeSwitch)
    evidence.parkedBeforeSwitch = JSON.parse(parkedBeforeSwitch)
    const queueCard = page.locator("form").locator("button[title='更多']").first()
    await queueCard.click()
    await page.getByRole("button", { name: "编辑消息", exact: true }).click()
    // The queue editor is the form's only textarea without the composer class.
    await page.locator("form textarea:not(.composer-textarea)").fill("MENTION_QUEUE_EDIT @new.txt")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    assert((await page.locator("body").innerText()).includes("MENTION_QUEUE_EDIT"))
    assert.equal(await page.locator("form textarea:not(.composer-textarea)").count(), 0)
    await submit("MENTION_QUEUE_SECOND")
    await until(async () => (await page.locator("body").innerText()).includes("排队中 2 条"), "real second FIFO draft")
    writeFileSync(join(project, "new.txt"), "NEW_QUEUE_AT_ACCEPT\n")
    release.resolve()
    await finished(5, cursor)
    const queued = providerInput(4, "MENTION_QUEUE_EDIT")
    assert(queued.includes("NEW_QUEUE_AT_ACCEPT") && queued.includes("new.txt"))
    assert(!queued.includes("OLD_QUEUE_MUST_NOT_READ") && !queued.includes("NEW_QUEUE_BEFORE_ACCEPT"))
    assert(providerInput(3, "MENTION_HOLD"))
    assert(providerInput(5, "MENTION_QUEUE_SECOND"))
    const queueAudit = await audit()
    assert.equal(queueAudit.filter(row => row.phase === "entered" && row.mention === "new.txt").length, 1)
    assert.equal(queueAudit.filter(row => row.mention === "old.txt").length, 0)
    evidence.queuedInputId = await checkpointInput("MENTION_QUEUE_EDIT", "NEW_QUEUE_AT_ACCEPT")
    evidence.secondQueuedInputId = await checkpointInput("MENTION_QUEUE_SECOND", "MENTION_QUEUE_SECOND")
    const fifoInputs = (await rows()).filter(row => row.role === "user")
      .map(row => JSON.stringify(row.content))
    assert(fifoInputs.findIndex(content => content.includes("MENTION_HOLD")) <
      fifoInputs.findIndex(content => content.includes("MENTION_QUEUE_EDIT")))
    assert(fifoInputs.findIndex(content => content.includes("MENTION_QUEUE_EDIT")) <
      fifoInputs.findIndex(content => content.includes("MENTION_QUEUE_SECOND")))
    record("real busy FIFO draft editing replaces typed references and reads the fresh file only when accepted")

    const beforeReload = await rows(), requestCount = requests.length
    const historyBeforeReload = await page.evaluate(id => window.api.threads.getHistory(id), threadId)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Prompt mention E2E", { exact: true }).first().click()
    await until(async () => (await page.locator("body").innerText()).includes("MENTION_DONE_5"), "real persisted mention reload")
    assert.deepEqual(await rows(), beforeReload)
    assert.deepEqual(await page.evaluate(id => window.api.threads.getHistory(id), threadId), historyBeforeReload)
    assert.equal(requests.length, requestCount)
    assert.equal(new Set(beforeReload.map(row => row.id)).size, beforeReload.length)
    record("real reload preserves complete input and assistant IDs, checkpoint and FIFO ordering without replay")

    cursor = (await readTerminals()).length
    const beforeCancel = await rows(), beforeCancelRequests = requests.length
    await page.evaluate(() => {
      const state = window as typeof window & { __modsMentionCancelDom?: CancelDomProbe }
      if (state.__modsMentionCancelDom) throw Error("Cancellation DOM observer already exists")
      const samples: CancelDomSample[] = []
      const sample = (label: string): void => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="停止生成"]')]
        const stops = buttons.length, disabled = buttons.map(button => button.disabled)
        const previous = samples[samples.length - 1]
        if (label === "dom-change" && previous?.stops === stops &&
          JSON.stringify(previous.disabled) === JSON.stringify(disabled)) return
        samples.push({ atMs: Date.now(), label, stops, disabled })
      }
      const observer = new MutationObserver(() => sample("dom-change"))
      state.__modsMentionCancelDom = { observer, samples, sample }
      observer.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["aria-label", "disabled"] })
      sample("before-submit")
    })
    cancelDomObserverInstalled = true
    await submit("MENTION_CANCEL @cancel.txt")
    await cancelDomSample("after-submit")
    await until(async () => {
      await cancelDomSample("before-audit")
      const actual = await audit()
      await cancelDomSample("after-audit")
      assert(!actual.some(row => row.phase === "sleep-finally" && row.mention === "cancel.txt"),
        "Actual finite sleep completed before the Stop click")
      return actual.some(row => row.phase === "sleep-entered" && row.mention === "cancel.txt")
    }, "actual finite sleep entered after the real Core")
    await cancelDomSample("before-stop-click")
    await page.getByRole("button", { name: "停止生成", exact: true }).click()
    await cancelDomSample("after-stop-click")
    await until(async () => {
      const observed = (await readTerminals()).slice(cursor)
      assert(observed.every(row => !row.terminals.includes("error")), JSON.stringify(observed))
      return await idle() && observed.some(row => row.terminals.includes("done"))
    }, "real cancelled mention terminal")
    await until(async () => (await audit()).some(row => row.phase === "sleep-finally" && row.mention === "cancel.txt"),
      "actual guest sleep finally")
    assert.equal(requests.length, beforeCancelRequests)
    assert.deepEqual(await rows(), beforeCancel)
    evidence.cancelAudit = await audit()
    record("real Stop observes Guest finally and the actual terminal without a cancelled durable input or model request")

    await page.evaluate(id => window.api.mods.configure(id, false, false), threadId)
    if (offScope === "workspace") {
      assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
      await until(async () => {
        const route = await page.evaluate(id => window.api.mods.composerEnabled(id), threadId!)
        assert.equal(route.workspace, project)
        assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
        return route.enabled === false && await input().isEnabled() && await idle()
      }, "actual workspace OFF with global ON and the original idle composer")
    } else {
      globalEnabledBeforeOff = await page.evaluate(() => window.api.mods.globalEnabled())
      assert.equal(await page.evaluate(() => window.api.mods.configureGlobal(false)), false)
      await until(async () => await page.evaluate(() => window.api.mods.globalEnabled()) === false &&
        await input().getAttribute("placeholder") ===
          "向 CMBDevClaw 提问，/ 输入命令；@ 引用文件；Shift + Enter 换行",
      "actual global OFF and the original idle composer")
    }
    cursor = (await readTerminals()).length
    await submit("MENTION_OFF @legacy.txt")
    await finished(6, cursor)
    const off = providerInput(6, "MENTION_OFF")
    assert(off.includes("LEGACY_OFF_BODY") && off.includes("legacy.txt"))
    assert(!off.includes("MENTION_EVENT:legacy.txt") && !off.includes("@legacy.txt"))
    const legacyGolden = formatComposerAttachments([{ filename: "legacy.txt",
      filePath: join(project, "legacy.txt").replaceAll("\\", "/"), content: fixtureFiles["legacy.txt"],
      mimeType: "text/plain", size: Buffer.byteLength(fixtureFiles["legacy.txt"]), truncated: false }])
    assert.equal(off, `MENTION_OFF legacy.txt${legacyGolden}`,
      "Original OFF input differs from the complete legacy text and attachment bytes")
    evidence.legacyInputId = await checkpointInput("MENTION_OFF", "LEGACY_OFF_BODY")
    const finalRows = await rows()
    for (const row of beforeCancel) assert.deepEqual(finalRows.find(value => value.id === row.id), row)
    const history = await page.evaluate(id => window.api.threads.getHistory(id), threadId)
    evidence.rows = finalRows
    evidence.checkpoints = history
    evidence.audit = queueAudit
    evidence.terminals = await readTerminals()
    assertCompleteTerminals(await readTerminals())
    assert.equal(requests.length, 6)
    requestsBeforeClose = JSON.stringify(requests)
    evidence.echoConflictsBeforeClose = readNativeAppendEchoConflicts(logPath)
    assert.equal(evidence.echoConflictsBeforeClose, 0)
    await page.screenshot({ path: join(artifacts, "prompt-mention-off.png"), fullPage: true })
    record("Mods OFF keeps the original renderer preview and exact legacy attachment path without mention replay")
    record("OS read counter is explicitly not observed by a second bundle; actual guest, HTTP and durable evidence are retained")
    evidence.complete = true
  } catch (error) { failures.push(error) }
  finally {
    for (const gate of gates) gate.resolve()
    if (threadId) {
      try {
        const stop = page.getByRole("button", { name: "停止生成", exact: true })
        if (await stop.count()) await stop.click()
        await until(idle, "mention final UI settlement")
      } catch (error) { failures.push(error) }
    }
    try { server.closeAllConnections() } catch (error) { failures.push(error) }
    const pending = await Promise.allSettled([...handlers])
    for (const result of pending) if (result.status === "rejected") failures.push(result.reason)
    try { if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    catch (error) { failures.push(error) }
    if (observerInstalled) {
      try {
        const observed = await readTerminals()
        evidence.finalTerminals = observed
        if (requestsBeforeClose !== undefined) assertCompleteTerminals(observed)
      } catch (error) { failures.push(error) }
      try {
        await app.evaluate(() => {
          const state = globalThis as typeof globalThis & { __mentionTerminalProbe?: TerminalProbe }
          try { state.__mentionTerminalProbe?.stopNativeAppendTerminalObserver() }
          finally { delete state.__mentionTerminalProbe }
        })
      } catch (error) { failures.push(error) }
    }
    if (globalEnabledBeforeOff !== undefined) {
      try {
        assert.equal(await page.evaluate(enabled => window.api.mods.configureGlobal(enabled),
          globalEnabledBeforeOff), globalEnabledBeforeOff)
      } catch (error) { failures.push(error) }
    }
    try {
      if (requestsBeforeClose !== undefined)
        assert.equal(JSON.stringify(requests), requestsBeforeClose,
          "Actual provider requests changed after all cleanup and real HTTP handlers settled")
      evidence.echoConflictsAfterGuestAndServerCleanup = readNativeAppendEchoConflicts(logPath)
      assert.equal(evidence.echoConflictsAfterGuestAndServerCleanup, 0)
      if (threadId) {
        evidence.rowsAfterGuestAndServerCleanup = await rows()
        if (Array.isArray(evidence.rows)) assert.deepEqual(evidence.rowsAfterGuestAndServerCleanup, evidence.rows)
      }
    } catch (error) { failures.push(error) }
    if (cancelDomObserverInstalled) {
      try {
        evidence.cancelDomTimeline = await page.evaluate(() => {
          const state = window as typeof window & { __modsMentionCancelDom?: CancelDomProbe }
          const probe = state.__modsMentionCancelDom
          if (!probe) throw Error("Actual cancellation DOM observer missing at cleanup")
          try { probe.sample("cleanup"); return probe.samples }
          finally { probe.observer.disconnect(); delete state.__modsMentionCancelDom }
        })
      } catch (error) { failures.push(error) }
    }
    evidence.complete = evidence.complete === true && failures.length === 0
    evidence.failures = failures.map(error => error instanceof Error ? { name: error.name, message: error.message } :
      { kind: error === undefined ? "undefined" : error === null ? "null" : typeof error })
    try {
      const evidenceFile = offScope === "workspace"
        ? "prompt-mention-workspace-off-results.json" : "prompt-mention-results.json"
      writeFileSync(join(artifacts, evidenceFile), JSON.stringify(evidence, null, 2))
    }
    catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Actual prompt mention E2E failed")
}

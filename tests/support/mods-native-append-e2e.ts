import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { FUNCTION_HOST_REVISION } from "../../src/shared/mods/v2/contracts"

/** Read the real isolated application's diagnostic log; never infer zero from missing evidence. */
export function readNativeAppendEchoConflicts(logPath: string): number {
  return (readFileSync(logPath, "utf8").match(
    /CanonicalTranscriptEcho\.(?:canonical_id|role|provider_source_id|provider_occurrence)\b/g
  ) ?? []).length
}

/** Exercises the original composer, main runtime, natural tool call and SQLite history. */
export async function verifyNativeAppend(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  logPath: string
): Promise<void> {
  type Probe = Pick<typeof import("./mods-e2e-entry"), "observeNativeAppendTerminals" |
    "readNativeAppendTerminals" | "stopNativeAppendTerminalObserver">
  const project = join(workspace, "native-append-project")
  mkdirSync(project, { recursive: true })
  const output = join(project, "native-tool-result.txt").replaceAll("\\", "/")
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = []
  const labels: string[] = []
  const evidence: Record<string, unknown> = {
    revision: FUNCTION_HOST_REVISION, requests, labels, complete: false
  }
  const record = (label: string) => { labels.push(label); pass(label) }
  let observerInstalled = false
  const readTerminals = () => app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __nativeAppendTerminalProbe?: Probe }
    if (!state.__nativeAppendTerminalProbe) throw Error("Native append probe is absent")
    return state.__nativeAppendTerminalProbe.readNativeAppendTerminals()
  })
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert(Array.isArray(body.messages))
      requests.push(body)
      response.writeHead(200, { "content-type": "text/event-stream" })
      const first = requests.length === 1
      const deltas = first ? [
        { role: "assistant", content: "ORIGINAL_NATIVE_FIRST" },
        { tool_calls: [{ index: 0, id: "actual-native-file-call", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({
            file_path: output, content: "actual original native tool effect" }) } }] }
      ] : [{ role: "assistant", content: `ORIGINAL_NATIVE_FINAL_${requests.length}` }]
      for (const delta of deltas) response.write(`data: ${JSON.stringify({
        id: "reused-native-e2e-provider", object: "chat.completion.chunk", created: 1,
        model: "gpt-4", choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: "reused-native-e2e-provider",
        object: "chat.completion.chunk", created: 1, model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 }
      })}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch (error) {
      evidence.providerError = String(error)
      if (!response.headersSent) response.writeHead(500)
      response.end("Local native append fixture failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const failures: unknown[] = []
  try {
    const base = `http://127.0.0.1:${address.port}/v1`
    const threadId = await page.evaluate(async ({ project, base }) => {
      await window.api.models.setCustomConfig({ id: "native-append-local", name: "Native append local",
        baseUrl: base, model: "gpt-4", apiKey: "local-fixture-key", maxTokens: 32000,
        maxOutputTokens: 512 })
      await window.api.models.setDefault("custom:native-append-local")
      const thread = await window.api.threads.create({ title: "Native append E2E",
        workspacePath: project, agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:native-append-local", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, { project, base })
    evidence.threadId = threadId
    const source = String.raw`export function register(on){
      on("session.append",($,e,next)=>{
        if(e.door==="prompt")return next({...e,message:{...e.message,
          content:e.message.content.map(b=>b.type==="text"?{...b,text:"DIY INPUT "+b.text}:b)}});
        if(e.door==="response")return next({...e,message:{...e.message,
          content:e.message.content.map(b=>b.type==="text"?{...b,text:"REVIEWED "+b.text}:b)}});
        if(e.door==="tool-result")return next({...e,message:{...e.message,
          content:e.message.content.map(b=>b.type==="tool_result"?{...b,
            content:[{type:"text",text:"REVIEWED ACTUAL TOOL RESULT"}]}:b)}});
        return next(e);
      });
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "native-append-q", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile("hooks/register.ts", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "native-append-q.zip"), bytes)
    const installed = await page.evaluate(bytes => window.api.plugins.install(
      new Uint8Array(bytes).buffer, "native-append-q.zip", "local"), [...bytes])
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(value => value.name === "native-append-q")
    assert(plugin?.digest)
    await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest })
    const ready = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(value => value.name === "native-append-q")
    assert.equal(ready?.state, "ready", JSON.stringify(ready))
    record("actual installed message Hook receives current source approval")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Native append E2E", { exact: true }).first().click()
    const actualWindow = await app.browserWindow(page)
    await app.evaluate((_, { window, id, entry }) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      const probe = createRequire(entry)(entry) as Probe
      probe.observeNativeAppendTerminals(window, id)
      const state = globalThis as typeof globalThis & { __nativeAppendTerminalProbe?: Probe }
      state.__nativeAppendTerminalProbe = probe
    }, { window: actualWindow, id: threadId,
      entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)) })
    observerInstalled = true
    const saved = () => page.evaluate(id => window.api.threads.getMessages(id), threadId)
    const send = async (text: string, count: number, expected: string, approveTool = false) => {
      const cursor = (await readTerminals()).length
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill(text)
      await composer.press("Enter")
      if (approveTool) {
        const allow = page.getByRole("button", { name: "允许", exact: true })
        await until(async () => requests.length === 1 && await allow.count() === 1,
          "original file permission question")
        await page.screenshot({ path: join(artifacts, "native-append-write-approval.png"),
          fullPage: true })
        await allow.click()
        record("original file approval remains required and resumes the same natural tool call")
      }
      await until(async () => requests.length === count &&
        JSON.stringify(await saved()).includes(expected) &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      `original native main chat ${count}`)
      await until(async () => {
        const rows = (await readTerminals()).slice(cursor)
        assert(rows.every(row => !row.terminals.includes("error")),
          `Actual native request failed: ${JSON.stringify(rows)}`)
        return rows.length > 0 && rows.at(-1)!.terminals.includes("done")
      }, `actual native request ${count} done without error`)
      const rows = (await readTerminals()).slice(cursor)
      assert(rows.length > 0)
      assert(rows.every(row => !row.terminals.includes("error")))
      assert(rows.at(-1)!.terminals.includes("done"))
      evidence.terminals = await readTerminals()
    }
    await send("NATIVE_APPEND_FIRST_USER", 2, "REVIEWED ORIGINAL_NATIVE_FINAL_2", true)
    const firstRows = await saved()
    evidence.firstRows = firstRows
    const kept = firstRows.filter(message => message.function_row)
    assert.equal(kept.filter(message => message.function_row?.door === "prompt").length, 1)
    assert.equal(kept.filter(message => message.function_row?.door === "response").length, 2)
    assert.equal(kept.filter(message => message.function_row?.door === "tool-result").length, 1)
    assert.equal(new Set(kept.map(message => message.id)).size, 4)
    for (const message of kept) assert.equal(message.function_row?.uuid, message.id)
    assert.equal(readFileSync(output, "utf8"), "actual original native tool effect")
    const next = requests[1].messages
    assert(requests[0].messages.some(message => message.role === "user" &&
      JSON.stringify(message.content).includes("DIY INPUT NATIVE_APPEND_FIRST_USER")))
    const originalVisibleInput = firstRows.find(message => message.role === "user" &&
      message.function_row?.door === "prompt")
    // Composer input carries additional native context. Its private visible-input receipt
    // preserves the actual user's text while the complete rewritten body reaches the model.
    assert.equal(originalVisibleInput?.content, "NATIVE_APPEND_FIRST_USER")
    record("the installed prompt Hook rewrites the actual composer input before the first HTTP request")
    assert(next.some(message => message.role === "assistant" &&
      JSON.stringify(message.content).includes("REVIEWED ORIGINAL_NATIVE_FIRST")))
    assert(next.some(message => message.role === "tool" &&
      JSON.stringify(message.content).includes("REVIEWED ACTUAL TOOL RESULT")))
    assert.equal(next.filter(message => message.role === "tool").length, 1)
    record("natural file tool executes with original arguments and the next HTTP request uses both rewritten outputs")
    await until(async () => (await page.locator("body").innerText())
      .includes("REVIEWED ORIGINAL_NATIVE_FINAL_2"), "canonical final replaces the provisional chat text")
    await page.screenshot({ path: join(artifacts, "native-append-final.png"), fullPage: true })
    evidence.firstRows = firstRows
    record("original chat and durable history show one canonical result for each model and tool occurrence")
    await send("NATIVE_APPEND_SECOND_USER", 3, "REVIEWED ORIGINAL_NATIVE_FINAL_3")
    assert.equal(requests[2].messages.filter(message => message.role === "assistant" &&
      JSON.stringify(message.content).includes("REVIEWED ORIGINAL_NATIVE_FINAL_2")).length, 1)
    const beforeOff = (await saved()).filter(message => message.function_row)
    assert.equal(beforeOff.length, 6)
    assert.equal(requests[2].messages.filter(message => message.role === "user" &&
      JSON.stringify(message.content).includes("DIY INPUT NATIVE_APPEND_FIRST_USER")).length, 1)
    assert.equal(requests[2].messages.filter(message => message.role === "user" &&
      JSON.stringify(message.content).includes("DIY INPUT NATIVE_APPEND_SECOND_USER")).length, 1)
    record("second composer turn restores the complete rewritten history without repeating prior rows")
    await page.evaluate(id => window.api.mods.configure(id, false, false), threadId)
    await send("NATIVE_APPEND_CORE_USER", 4, "ORIGINAL_NATIVE_FINAL_4")
    const afterOff = await saved()
    const core = afterOff.find(message => JSON.stringify(message.content)
      .includes("ORIGINAL_NATIVE_FINAL_4"))
    assert(core)
    assert(!JSON.stringify(core.content).includes("REVIEWED"))
    for (const message of beforeOff) assert.deepEqual(afterOff.find(row => row.id === message.id), message)
    evidence.finalRows = afterOff
    record("workspace Mods off preserves existing canonical history and the next ordinary model call succeeds")
    await page.evaluate(id => new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error("Actual ID-less input did not finish")), 30_000)
      const stop = window.api.agent.invoke(id, "ACTUAL_INPUT_WITHOUT_ID", event => {
        if (event.type !== "done" && event.type !== "error") return
        clearTimeout(deadline)
        stop()
        if (event.type === "error") reject(Error(event.error ?? "Actual ID-less input failed"))
        else resolve()
      }, "custom:native-append-local", "normal")
    }), threadId)
    assert.equal(requests.length, 5)
    const idlessRows = (await saved()).filter(message => message.role === "user" &&
      message.content === "ACTUAL_INPUT_WITHOUT_ID")
    assert.equal(idlessRows.length, 1)
    const idless = idlessRows[0]
    assert(idless.id)
    const checkpoints = await page.evaluate(id => window.api.threads.getHistory(id), threadId)
    type Checkpoint = { checkpoint?: { channel_values?: {
      messages?: Array<{ id?: string; content?: unknown }> } } }
    const latest = (checkpoints as Checkpoint[]).find(tuple =>
      tuple.checkpoint?.channel_values?.messages?.some(message =>
        JSON.stringify(message.content).includes("ORIGINAL_NATIVE_FINAL_5")))
    assert(latest)
    assert.equal(latest.checkpoint?.channel_values?.messages?.filter(message =>
      message.id === idless.id && message.content === "ACTUAL_INPUT_WITHOUT_ID").length, 1)
    evidence.idlessMessageId = idless.id
    record("an original caller without a user ID keeps the same single ID in transcript and actual checkpoint")
    const providedId = randomUUID()
    await page.evaluate(({ id, providedId }) => new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error("Actual padded input ID did not finish")), 30_000)
      const stop = window.api.agent.invoke(id, "ACTUAL_INPUT_WITH_PADDED_ID", event => {
        if (event.type !== "done" && event.type !== "error") return
        clearTimeout(deadline)
        stop()
        if (event.type === "error") reject(Error(event.error ?? "Actual padded input ID failed"))
        else resolve()
      }, "custom:native-append-local", "normal", false, `  ${providedId}  `)
    }), { id: threadId, providedId })
    assert.equal(requests.length, 6)
    const paddedRows = (await saved()).filter(message => message.role === "user" &&
      message.content === "ACTUAL_INPUT_WITH_PADDED_ID")
    assert.equal(paddedRows.length, 1)
    assert.equal(paddedRows[0].id, providedId)
    const paddedHistory = await page.evaluate(id => window.api.threads.getHistory(id), threadId)
    const paddedLatest = (paddedHistory as Checkpoint[]).find(tuple =>
      tuple.checkpoint?.channel_values?.messages?.some(message =>
        JSON.stringify(message.content).includes("ORIGINAL_NATIVE_FINAL_6")))
    assert(paddedLatest)
    assert.equal(paddedLatest.checkpoint?.channel_values?.messages?.filter(message =>
      message.id === providedId && message.content === "ACTUAL_INPUT_WITH_PADDED_ID").length, 1)
    evidence.paddedMessageId = providedId
    record("an original padded user ID is normalized once and shared by the transcript and real checkpoint")
    evidence.echoConflicts = readNativeAppendEchoConflicts(logPath)
    assert.equal(evidence.echoConflicts, 0, "renderer echoes must retain the real stored message IDs")
    record("all six native replies retain their stored IDs without renderer echo conflicts")
    evidence.complete = true
  } catch (error) {
    failures.push(error)
    evidence.complete = false
  } finally {
    if (observerInstalled) {
      try { evidence.terminals = await readTerminals() }
      catch (error) {
        evidence.observerReadError = String(error)
        failures.push(error)
      } finally {
        try {
          await app.evaluate(() => {
            const state = globalThis as typeof globalThis & { __nativeAppendTerminalProbe?: Probe }
            try { state.__nativeAppendTerminalProbe?.stopNativeAppendTerminalObserver() }
            finally { delete state.__nativeAppendTerminalProbe }
          })
        } catch (error) {
          evidence.observerCleanupError = String(error)
          failures.push(error)
        }
      }
    }
    try { server.closeAllConnections() }
    catch (error) { failures.push(error) }
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } catch (error) { failures.push(error) }
    if (failures.length) evidence.complete = false
    try {
      writeFileSync(join(artifacts, "native-append-results.json"), JSON.stringify(evidence, null, 2))
    } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Native append verification failed")
}

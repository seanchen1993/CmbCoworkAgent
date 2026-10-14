import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { FUNCTION_HOST_REVISION } from "../../src/shared/mods/v2/contracts"
import type { FunctionUiElement, FunctionUiNode } from "../../src/shared/mods/v2/ui"
import { openModsResults } from "./mods-sidebar-navigation"

/** Actual installed source, native callback/command, app SQLite and the next real HTTP turn. */
export async function verifySessionAppend(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "session-append-project")
  mkdirSync(project, { recursive: true })
  const note = "SESSION_APPEND_IDLE_NOTE /goal is literal @not-a-file"
  const ownNote = "SESSION_APPEND_OWN_NOTE"
  const fakeNote = "SESSION_APPEND_FAKE_ACK_NOTE"
  const deniedNote = "SESSION_APPEND_DENIED_NOTE"
  const notice = "SESSION_APPEND_SYSTEM_NOTICE"
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const labels: string[] = []
  const evidence: Record<string, unknown> = {
    revision: FUNCTION_HOST_REVISION, requests, labels, complete: false,
    scope: "Actual main SDK notes/notices, exact caller skip, protected receipt, read formats, next native HTTP, close/revoke and original Button; child/fork/native producer coverage is separate"
  }
  const record = (label: string) => { labels.push(label); pass(label) }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert(Array.isArray(body.messages))
      requests.push(body)
      response.writeHead(200, { "content-type": "text/event-stream" })
      const id = `session-append-response-${requests.length}`
      const frame = (choices: unknown[], usage?: Record<string, number>) => response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
          model: "gpt-4", choices, ...(usage ? { usage } : {}) })}\n\n`)
      frame([{ index: 0, delta: { role: "assistant", content: `SESSION_APPEND_CHAT_OK_${requests.length}` },
        finish_reason: "stop" }])
      frame([], { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      evidence.providerError = String(error)
      if (!response.headersSent) response.writeHead(500)
      response.end("Local session.append fixture failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/v1`
  try {
    const threadId = await page.evaluate(async ({ project, base }) => {
      await window.api.models.setCustomConfig({ id: "session-append-local", name: "Session append local",
        baseUrl: base, model: "gpt-4", apiKey: "local-fixture-key",
        maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault("custom:session-append-local")
      const thread = await window.api.threads.create({ title: "Session append E2E",
        workspacePath: project, agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:session-append-local", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, { project, base })
    evidence.threadId = threadId
    const source = String.raw`export function register(on){
      let receipts=[],ownAppend=0,neighborAppend=0,buttons=0,errors=[];
      const save=async($,text,type="user")=>{
        const value=await $.session.append({message:{type,content:[{type:"text",text}]}});
        receipts.push(value);await $.ui.invalidate("ui.render");return value;
      };
      on("session.start",async($,e,next)=>{
        for(const name of ["append-open","append-close","append-read","append-state","append-own"])
          await $.command.register({name,description:name,immediate:true});return next(e);
      });
      on("*",async($,e,next)=>{
        if(next.event==="command.run"&&e.command==="append-own"){
          const before=ownAppend,value=await save($,"${ownNote}");
          return {text:JSON.stringify({value,before,after:ownAppend,neighborAppend})};
        }
        if(next.event==="session.append")ownAppend++;
        return next(e);
      });
      on("session.append",async($,e,next)=>{
        neighborAppend++;
        const text=e.message.content.map(x=>x.text||"").join("");
        if(text==="${deniedNote}")return {deny:"APPEND_DECLINED"};
        if(text==="${fakeNote}")return {uuid:"GUEST_FAKE_UUID",message:e.message};
        const value=e.message.type==="user"?{...e,message:{...e.message,
          content:[{type:"text",text:text+" :: REVIEWED"}]}}:e;
        const first=await next(value),again=await next(e);
        if(first.uuid!==again.uuid)throw Error("DUPLICATE_NATIVE_COMMIT");return first;
      });
      on("command.run",{command:"append-open"},async($)=>{
        await $.ui.open({id:"append-board",title:"Session append"});return {};
      });
      on("command.run",{command:"append-close"},async($)=>{
        await $.ui.close({id:"append-board"});return {};
      });
      on("command.run",{command:"append-state"},()=>({text:JSON.stringify({
        receipts,ownAppend,neighborAppend,buttons,errors
      })}));
      on("command.run",{command:"append-read"},async($)=>({text:JSON.stringify({
        summary:await $.session.messages(),api:await $.session.messages({as:"api"})
      })}));
      on("ui.render",{component:"Pane",requestId:"append-board"},($,e)=>{
        const {Box,Text,Button}=$.ui.resolve(e);
        return <Box flexDirection="column"><Text>{"Stored ACKs:"+receipts.length}</Text>
          <Button key="idle-note" label="Append idle note" onPress={()=>save($,"${note}")}/>
          <Button key="fake-ack" label="Append fake ACK candidate" onPress={()=>save($,"${fakeNote}")}/>
          <Button key="deny" label="Append declined note" onPress={()=>save($,"${deniedNote}")}/>
          <Button key="notice" label="Append system notice" onPress={()=>save($,"${notice}","system")}/>
          <Button key="forge" label="Reject forged source" onPress={async()=>{
            try{await $.session.append({message:{type:"user",content:[{type:"text",text:"FORGED_SOURCE_NOTE"}]},
              origin:{kind:"plugin",name:"another-plugin",asUser:true}});throw Error("FAKE_SOURCE_ACCEPTED")}
            catch(error){errors.push({code:error.code,message:error.message})}
            try{await $.session.append({message:{type:"user",content:[{type:"text",text:"WRONG_TARGET_NOTE"}]},
              agentId:"unregistered-child"});throw Error("FAKE_TARGET_ACCEPTED")}
            catch(error){errors.push({code:error.code,message:error.message})}
            await $.ui.invalidate("ui.render");
          }}/><Button key="original" label={"Original button:"+buttons}
            onPress={async()=>{buttons++;await $.ui.invalidate("ui.render")}}/>
        </Box>;
      });
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "session-append-q", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
    zip.addFile("hooks/register.tsx", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "session-append-q.zip"), bytes)
    const installed = await page.evaluate(bytes => window.api.plugins.install(
      new Uint8Array(bytes).buffer, "session-append-q.zip", "local"), [...bytes])
    assert(installed.success, installed.error)
    const row = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(value => value.name === "session-append-q")
    assert(row?.digest)
    await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: row.pluginId, digest: row.digest })
    const status = (await page.evaluate(id => window.api.mods.status(id), threadId))
      .functionMods?.find(value => value.name === "session-append-q")
    assert.equal(status?.state, "ready", JSON.stringify(status))
    evidence.source = { pluginId: row.pluginId, digest: row.digest }
    record(`actual ${FUNCTION_HOST_REVISION} ZIP source compiles and receives current-digest approval`)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Session append E2E", { exact: true }).first().click()
    await openModsResults(page)
    const run = async (command: string) => {
      const descriptor = (await page.evaluate(id => window.api.mods.commands(id), threadId))
        .find(value => value.command === command)
      assert(descriptor, `Actual command missing: ${command}`)
      const job = await page.evaluate(({ id, descriptor }) => window.api.mods.enqueue(id, descriptor,
        { text: "" }), { id: threadId, descriptor })
      await until(async () => (await page.evaluate(id => window.api.mods.jobs(id), threadId))
        .some(value => value.id === job.id && !["queued", "running"].includes(value.state)), command)
      const settled = (await page.evaluate(id => window.api.mods.jobs(id), threadId))
        .find(value => value.id === job.id)
      assert.equal(settled?.state, "succeeded", JSON.stringify(settled))
      return settled?.result?.text ?? ""
    }
    const state = async () => JSON.parse(await run("append-state")) as {
      receipts: Array<{ uuid?: string; message?: unknown; deny?: string }>
      buttons: number; ownAppend: number; neighborAppend: number
      errors: Array<{ code?: string; message: string }>
    }
    const saved = () => page.evaluate(id => window.api.threads.getMessages(id), threadId)
    const notes = async () => (await saved()).filter(value => value.function_row?.door === "note" &&
      value.function_row.origin.kind === "plugin" && value.function_row.origin.name === "session-append-q")
    const pane = page.locator('[data-function-pane="append-board"]')
    await run("append-open")
    await until(async () => (await pane.innerText()).includes("Stored ACKs:0"), "actual append controls")
    await pane.getByRole("button", { name: "Append idle note", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Stored ACKs:1"), "native note ACK")
    const idle = (await state()).receipts[0]
    assert.equal((await notes()).length, 1)
    const idleRow = (await notes())[0]
    assert.equal(idle.uuid, idleRow.id)
    assert.equal(idleRow.function_row?.uuid, idleRow.id)
    assert.equal(idleRow.function_row?.isMeta, true)
    assert.deepEqual(idleRow.content, [{ type: "text", text: `${note} :: REVIEWED` }])
    assert.equal(requests.length, 0)
    assert.equal(await page.getByText(`${note} :: REVIEWED`, { exact: true }).count(), 0)
    record("real idle button saves one hidden SQLite note and scalar actual UUID ACK without launching a model")
    const own = JSON.parse(await run("append-own"))
    assert.equal(own.before, own.after)
    assert.equal(own.neighborAppend, 2)
    assert.equal((await notes()).length, 2)
    assert.equal(own.value.message.content[0].text, `${ownNote} :: REVIEWED`)
    record("SDK skips only its calling wildcard registration; same-plugin neighbor runs and duplicate next commits once")
    await pane.getByRole("button", { name: "Append fake ACK candidate", exact: true }).click()
    await until(async () => (await state()).receipts.length === 3, "invalid guest ACK fallback")
    const actualFake = (await state()).receipts[2]
    assert(actualFake.uuid && actualFake.uuid !== "GUEST_FAKE_UUID")
    assert.equal((await notes()).length, 3)
    assert.equal((await notes()).filter(value => value.id === actualFake.uuid).length, 1)
    record("forged Hook success does not become a save ACK; optional fallback saves exactly one real row")
    await pane.getByRole("button", { name: "Append declined note", exact: true }).click()
    await until(async () => (await state()).receipts.length === 4, "native precommit deny")
    assert.deepEqual((await state()).receipts[3], { deny: "APPEND_DECLINED" })
    assert.equal((await notes()).length, 3)
    const immediateNotice = page.locator("[data-function-conversation-notice]")
      .filter({ hasText: notice })
    assert.equal(await immediateNotice.count(), 0)
    const noticePageUrl = page.url()
    await pane.getByRole("button", { name: "Append system notice", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Stored ACKs:5"), "notice ACK")
    // Check the initialized chat before any transcript read, thread switch or reload can hydrate it.
    await until(async () => (await immediateNotice.count()) === 1 &&
      await immediateNotice.isVisible(), "notice appears immediately in the same initialized chat")
    assert.equal(await immediateNotice.getAttribute("role"), "status")
    assert.equal(await immediateNotice.locator(".liquid-glass-notice__body").innerText(), notice)
    assert.equal(page.url(), noticePageUrl)
    assert.equal(await pane.count(), 1)
    assert.equal(requests.length, 0)
    const noticeAck = (await state()).receipts[4]
    const noticeRow = (await notes()).find(value => value.id === noticeAck.uuid)
    assert(noticeRow)
    assert.equal(noticeRow.role, "system")
    assert.equal(noticeRow.function_row?.messageType, "system")
    assert.deepEqual(noticeRow.content, [{ type: "text", text: notice }])
    evidence.immediateNotice = { uuid: noticeAck.uuid, text: await immediateNotice.innerText(),
      samePageUrl: noticePageUrl, paneStillOpen: true, requests: requests.length }
    record("system notice ACK updates the same initialized chat DOM through the real notice event without reopening the thread")
    assert.equal((await notes()).length, 4)
    await until(async () => (await page.getByText(notice, { exact: true }).count()) === 1, "actual notice UI")
    record("SDK precommit deny writes zero rows and an accepted system notice is rendered as a native notice")
    await pane.getByRole("button", { name: "Reject forged source", exact: true }).click()
    await until(async () => (await state()).errors.length === 2, "actual invalid source/target rejection")
    const errors = (await state()).errors
    assert.equal(errors[0].code, "MODS_SESSION_APPEND_INVALID", JSON.stringify(errors))
    assert.equal(errors[1].code, "MODS_CONVERSATION_UNAVAILABLE", JSON.stringify(errors))
    assert.equal((await notes()).length, 4)
    assert(!JSON.stringify(await saved()).includes("FORGED_SOURCE_NOTE"))
    assert(!JSON.stringify(await saved()).includes("WRONG_TARGET_NOTE"))
    record("public forged origin and unknown child selector cannot create source/target authority or rows")
    const read = JSON.parse(await run("append-read"))
    for (const marker of [note, ownNote, fakeNote]) {
      assert(JSON.stringify(read.api).includes(marker))
      assert(JSON.stringify(read.summary).includes(marker))
    }
    assert(read.summary.every((value: { role: unknown; text: unknown; toolUses: unknown }) =>
      ["user", "assistant"].includes(String(value.role)) && typeof value.text === "string" &&
      Array.isArray(value.toolUses)))
    assert(!JSON.stringify(read.api).includes(notice))
    assert(!JSON.stringify(read.summary).includes(notice))
    assert.equal(requests.length, 0)
    evidence.idleRead = read
    record("actual messages API keeps full note blocks and the original summary shape is retained; both exclude system notices")
    const send = async (text: string, number: number) => {
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill(text)
      await composer.press("Enter")
      await until(async () => requests.length === number &&
        JSON.stringify(await saved()).includes(`SESSION_APPEND_CHAT_OK_${number}`) &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      `real normal turn ${number}`)
    }
    await send("SESSION_APPEND_FIRST_USER", 1)
    const first = requests[0].messages.map(value => JSON.stringify(value.content))
    const userIndex = first.findIndex(value => value.includes("SESSION_APPEND_FIRST_USER"))
    assert(userIndex >= 0)
    for (const marker of [note, ownNote, fakeNote]) {
      const found = first.map((value, index) => value.includes(marker) ? index : -1)
        .filter(index => index >= 0)
      assert.equal(found.length, 1)
      assert(found[0] < userIndex)
    }
    assert(!JSON.stringify(requests[0]).includes(notice))
    assert(!JSON.stringify(requests[0]).includes(deniedNote))
    record("next native ordinary chat consumes accepted notes once before the submitted user and excludes notice/deny")
    await send("SESSION_APPEND_SECOND_USER", 2)
    for (const marker of [note, ownNote, fakeNote])
      assert.equal(requests[1].messages.filter(value => JSON.stringify(value.content).includes(marker)).length, 1)
    assert.equal((await notes()).length, 4)
    record("second real HTTP turn retains each consumed note once with no second SQLite append or duplicate intake")
    await pane.getByRole("button", { name: "Original button:0", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Original button:1"), "original callback")
    record("existing Button action and intentional redraw continue after note intake")
    const snapshots = await page.evaluate(id => window.api.mods.panes(id), threadId)
    const current = snapshots.find(value => value.id === "append-board")
    assert(current)
    const find = (tree: FunctionUiElement): FunctionUiNode | undefined => {
      if (tree.type === "Button" && tree.props.key === "idle-note") return tree
      if ("children" in tree) for (const child of tree.children ?? []) {
        if (typeof child !== "string") { const found = find(child); if (found) return found }
      }
      return undefined
    }
    const oldButton = find(current.tree)
    assert(oldButton?.press)
    const oldAction = { pane: current.key, generation: current.generation, plugin: oldButton.press.plugin,
      handle: oldButton.press.handle, kind: "press" as const, intentId: randomUUID() }
    const rejectOld = async () => page.evaluate(async ({ id, action }) => {
      try { await window.api.mods.paneAct(id, action); return "ACCEPTED" }
      catch (error) { return String(error) }
    }, { id: threadId, action: { ...oldAction, intentId: randomUUID() } })
    await run("append-close")
    await until(async () => (await pane.count()) === 0, "actual Pane close")
    assert((await rejectOld()).includes("MODS_UI_STALE_ACTION"))
    assert.equal((await notes()).length, 4)
    await run("append-open")
    await until(async () => (await pane.count()) === 1, "actual Pane reopen")
    assert((await rejectOld()).includes("MODS_UI_STALE_ACTION"))
    assert.equal((await notes()).length, 4)
    record("native Pane close/reopen retires the old callback receipt without replaying its note")
    await page.evaluate(({ id, name }) => window.api.mods.revokeFunction(id, name),
      { id: threadId, name: "session-append-q" })
    await until(async () => (await pane.count()) === 0, "actual source revoke")
    assert.notEqual(await rejectOld(), "ACCEPTED")
    assert.equal((await notes()).length, 4)
    await send("SESSION_APPEND_AFTER_REVOKE", 3)
    assert.equal((await notes()).length, 4)
    assert(JSON.stringify(requests[2]).includes("SESSION_APPEND_AFTER_REVOKE"))
    evidence.finalRows = await saved()
    evidence.closedCallbackPane = current
    await page.screenshot({ path: join(artifacts, "session-append-final.png") })
    record("source revoke rejects old callbacks and ordinary native chat remains usable without replaying notes")
    evidence.complete = true
  } catch (error) {
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    const id = evidence.threadId
    if (typeof id === "string") {
      try {
        evidence.failureDiagnostics = await page.evaluate(async threadId => {
          const results = await Promise.allSettled([
            window.api.mods.panes(threadId), window.api.mods.jobs(threadId),
            window.api.mods.status(threadId)
          ])
          return results.map(result => result.status === "fulfilled"
            ? { status: result.status, value: result.value }
            : { status: result.status, reason: String(result.reason) })
        }, id)
      } catch (diagnosticError) {
        evidence.failureDiagnosticsError = String(diagnosticError)
      }
    }
    throw error
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    writeFileSync(join(artifacts, "session-append-evidence.json"), JSON.stringify(evidence, null, 2))
  }
}

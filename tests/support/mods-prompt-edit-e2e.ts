import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Actual native edit IPC, utility guest, composer submission, provider and persistent history. */
export async function verifyPromptEdit(page: Page, workspace: string, artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>, pass: (label: string) => void) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  let held: ServerResponse | undefined
  const finish = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ id: "edit-response", object: "chat.completion.chunk", model: "gpt-4",
      choices: [{ index: 0, delta: { role: "assistant", content: "EDIT_DONE" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
  }
  const server = createServer(async (request, response) => {
    const bytes: Buffer[] = []
    for await (const chunk of request) bytes.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8"))
    requests.push(body)
    if (JSON.stringify(body.messages.at(-1)).includes("[HOLD]")) held = response
    else finish(response)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    const id = await page.evaluate(async ({ workspace, url }) => {
      await window.api.models.setCustomConfig({ id: "edit", name: "Input rule fixture", model: "gpt-4",
        apiKey: "fixture-key", baseUrl: url, maxTokens: 32000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:edit")
      const row = await window.api.threads.create({ title: "输入规则与下一步建议", workspacePath: workspace,
        agentMode: "normal" })
      const id = (row as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      await window.api.threads.patchMetadata(id, { set: { model: "custom:edit" } })
      await window.api.mods.configure(id, true, true)
      return id
    }, { workspace, url: `http://127.0.0.1:${address.port}/v1` })
    for (const [name, hooks] of [
      ["edit-rules", `
        on("session.start",async($,e,next)=>{await $.command.register({name:"edit-demo",description:"Suggestion demo",immediate:true});return next(e)});
        on("command.run",{command:"edit-demo"},async($,e)=>{
          if(e.args==="suggest")return {text:JSON.stringify(await $.prompt.suggest({text:"review next change"}))};
          return {text:"edit demo"}
        });
        on("prompt.edit",async($,e,next)=>{
          if(e.inputText.includes("forbidden"))return {text:e.text,cursor:e.cursor};
          if(e.inputText==="review this") {
            const start=await $.clock.now();
            const fill=await $.prompt.fill({text:"unsafe append",mode:"append"});
            if(fill.isFilled || (await $.clock.now())-start>2000)throw Error("reentrant append must refuse immediately");
          }
          await $.clock.sleep(80);
          const result=await next({...e,inputText:e.inputText.toUpperCase()});
          return {...result,decorations:[{start:0,end:Math.min(5,result.text.length),color:"warning",underline:true}]}
        });`],
      ["edit-neighbor", `on("prompt.edit",async($,e,next)=>next(e));
        on("prompt.suggest",async($,e,next)=>next({...e,text:e.text+" with tests"}));`]
    ]) {
      const zip = new AdmZip()
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
      zip.addFile("hooks/register.ts", Buffer.from(`export function register(on){${hooks}}`))
      const installed = await page.evaluate(bytes => window.api.plugins.install(new Uint8Array(bytes).buffer,
        "editor.zip", "local"), [...zip.toBuffer()])
      assert(installed.success, installed.error)
      const mod = (await page.evaluate(id => window.api.mods.status(id), id)).functionMods!
        .find(row => row.name === name)!
      await page.evaluate(({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!), { id, mod })
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("输入规则与下一步建议", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    const idle = async () => await page.getByRole("button", { name: "停止生成", exact: true }).count() === 0
    const suggest = async () => {
      const descriptor = (await page.evaluate(id => window.api.mods.commands(id), id))
        .find(row => row.command === "edit-demo")!
      const job = await page.evaluate(({ id, descriptor }) => window.api.mods.enqueue(id, descriptor,
        { text: "suggest" }), { id, descriptor })
      await until(async () => (await page.evaluate(id => window.api.mods.jobs(id), id))
        .some(row => row.id === job.id && row.state === "succeeded"), "suggest SDK job")
      return job
    }
    await suggest()
    await until(async () => await page.locator("[data-prompt-suggestion]").count() === 1, "cold command suggestion")
    assert.equal(requests.length, 0)
    assert.equal(await composer.inputValue(), "")
    pass("A cold UI command displays a real suggestion before any model run or resident main exists")
    await composer.fill("review this")
    await composer.press("Enter")
    await until(async () => requests.length === 1 && await idle(), "validated actual submit")
    assert(JSON.stringify(requests[0].messages.at(-1)).includes("REVIEW THIS"))
    pass("Real typing is rewritten by two approved guests before native submission and provider send")
    pass("A real edit hook's SDK append refuses immediately without self-wait or promoting unchecked text")
    const history = await page.evaluate(id => window.api.threads.getMessages(id), id)
    assert(JSON.stringify(history).includes("REVIEW THIS") && !JSON.stringify(history).includes("review this"))
    pass("Only the actually validated text is persisted in SQLite history")
    await composer.fill("forbidden")
    await composer.press("Enter")
    await until(async () => await composer.inputValue() === "", "rejected actual edit")
    assert.equal(requests.length, 1)
    pass("A rejected edit cannot race Enter into the actual provider")
    await suggest()
    await until(async () => await page.locator("[data-prompt-suggestion]").count() === 1, "actual suggestion")
    assert.equal(await composer.inputValue(), "")
    assert.equal(await page.locator("[data-prompt-suggestion]").textContent(), "review next change with tests")
    pass("SDK suggestion is actually displayed after the neighboring plugin rewrites it; no draft is filled")
    await page.screenshot({ path: join(artifacts, "prompt-suggestion.png"), fullPage: true })
    await composer.focus()
    await composer.press("Tab")
    await until(async () => await composer.inputValue() === "REVIEW NEXT CHANGE WITH TESTS", "accepted suggestion passes edit rules")
    assert.equal(requests.length, 1)
    assert.equal(await page.locator("[data-prompt-suggestion]").count(), 0)
    assert.equal(await page.locator("[data-prompt-decorations]").count(), 1)
    await page.screenshot({ path: join(artifacts, "prompt-edit-decorations.png"), fullPage: true })
    pass("Accepting with Tab uses the actual editing rules, paints returned decoration and never auto-sends")
    await composer.press("Enter")
    await until(async () => requests.length === 2 && await idle(), "accepted suggestion sent")
    await composer.fill("[hold] running")
    await composer.press("Enter")
    await until(async () => Boolean(held), "busy actual task")
    await composer.fill("queue this")
    await composer.press("Enter")
    await until(async () => await composer.inputValue() === "", "busy draft accepted")
    assert.equal(requests.length, 3)
    await suggest()
    assert.equal(await page.locator("[data-prompt-suggestion]").count(), 0)
    finish(held!)
    held = undefined
    await until(async () => requests.length === 4 && await idle(), "queued draft drained")
    assert(JSON.stringify(requests[3].messages.at(-1)).includes("QUEUE THIS"))
    pass("Input rules preserve the original busy draft queue, and the running task refuses ghost suggestions")
    await page.evaluate(id => window.api.mods.configure(id, false, false), id)
    await composer.fill("plain unchanged")
    await composer.press("Enter")
    await until(async () => requests.length === 5 && await idle(), "original Mods-off send")
    assert(JSON.stringify(requests[4].messages.at(-1)).includes("plain unchanged"))
    pass("Mods disabled restores the original composer and provider text")
    writeFileSync(join(artifacts, "prompt-edit-provider.json"), JSON.stringify(requests, null, 2))
  } finally {
    held?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

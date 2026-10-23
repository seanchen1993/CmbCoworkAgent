import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { FUNCTION_HOST_REVISION } from "../../src/shared/mods/v2/contracts"
import type { FunctionPaneSnapshot, FunctionUiElement } from "../../src/shared/mods/v2/ui"
import { openModsResults } from "./mods-sidebar-navigation"

/** Actual installed P/R/Q source, native IPC, utility VMs, DOM gestures and local provider. */
export async function verifyMarkdown(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  assert.equal(FUNCTION_HOST_REVISION, "claude-295-tools-v92")
  const project = join(workspace, "markdown-project")
  mkdirSync(project, { recursive: true })
  const guide = join(project, "guide.md")
  const guideText = "MARKDOWN_WORKSPACE_GUIDE\nRead-only actual workspace file.\n<context>literal</context>"
  writeFileSync(guide, guideText)
  const fileHref = pathToFileURL(guide).href
  const originalHref = "https://markdown-original.test/review"
  const finalHref = "https://markdown-final.test/review"
  const requests: Array<Record<string, unknown>> = []
  const labels: string[] = []
  const installed: Array<{ name: string; pluginId: string; digest: string }> = []
  const evidence: Record<string, unknown> = {
    hostRevision: FUNCTION_HOST_REVISION, requests, labels, installed, complete: false,
    scope: "Actual source/approval/utility/DOM/file preview/local HTTP; no public network or OS opener success claim"
  }
  const record = (label: string) => { labels.push(label); pass(label) }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST")
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      res.writeHead(200, { "content-type": "text/event-stream" })
      const frame = (choices: unknown[], usage?: Record<string, unknown>) => res.write(
        `data: ${JSON.stringify({ id: `markdown-response-${requests.length}`,
          object: "chat.completion.chunk", created: 1, model: "gpt-4", choices,
          ...(usage ? { usage } : {}) })}\n\n`)
      frame([{ index: 0, delta: { role: "assistant", content: "MARKDOWN_CHAT_OK" },
        finish_reason: "stop" }])
      frame([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      res.end("data: [DONE]\n\n")
    } catch (error) {
      evidence.providerError = String(error)
      if (!res.headersSent) res.writeHead(500)
      res.end("Local Markdown fixture failed")
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
    await page.addInitScript(() => {
      const facts: unknown[] = []
      Object.defineProperty(window, "__markdownPreviewFacts", { value: facts })
      window.addEventListener("mods:protected-preview-open", event => {
        const value = (event as CustomEvent).detail
        facts.push({ kind: "open", threadId: value?.threadId,
          receipt: value?.preview?.receipt, address: value?.address })
      })
      window.addEventListener("mods:protected-preview-owner-closed", event => {
        const value = (event as CustomEvent).detail
        facts.push({ kind: "closed", threadId: value?.threadId, owner: value?.owner })
      })
    })
    const id = await page.evaluate(async ({ project, base }) => {
      await window.api.models.setCustomConfig({ id: "markdown-local", name: "Markdown local fixture",
        baseUrl: base, model: "gpt-4", apiKey: "local-fixture-key",
        maxTokens: 32000, maxOutputTokens: 512 })
      await window.api.models.setDefault("custom:markdown-local")
      const thread = await window.api.threads.create({ title: "Markdown E2E",
        workspacePath: project, agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:markdown-local", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, { project, base })
    evidence.threadId = id
    const install = async (name: string, source: string, client?: string) => {
      const zip = new AdmZip()
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
      zip.addFile("hooks/register.tsx", Buffer.from(source))
      if (client) zip.addFile("hooks/surface.tsx", Buffer.from(client))
      const bytes = zip.toBuffer()
      writeFileSync(join(artifacts, `${name}.zip`), bytes)
      const result = await page.evaluate(({ bytes, name }) => window.api.plugins.install(
        new Uint8Array(bytes).buffer, `${name}.zip`, "local"), { bytes: [...bytes], name })
      assert(result.success, result.error)
      const row = (await page.evaluate(id => window.api.mods.status(id), id))
        .functionMods?.find(row => row.name === name)
      assert(row?.digest, `Actual installed source missing: ${name}`)
      await page.evaluate(({ id, pluginId, digest }) =>
        window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: row.pluginId, digest: row.digest })
      const current = (await page.evaluate(id => window.api.mods.status(id), id))
        .functionMods?.find(row => row.name === name)
      assert.equal(current?.state, "ready", JSON.stringify(current))
      installed.push({ name, pluginId: row.pluginId, digest: row.digest })
    }
    await install("markdown-q", String.raw`export function register(on){
      let count=0,buttons=0,last=null;
      on("session.start",async($,e,next)=>{
        for(const name of ["markdown-open","markdown-close","markdown-q-state"])
          await $.command.register({name,description:name,immediate:true});return next(e)
      });
      on("command.run",{command:"markdown-open"},async($)=>{
        await $.ui.open({id:"markdown-board",title:"Original Markdown"});return {}
      });
      on("command.run",{command:"markdown-close"},async($)=>{
        await $.ui.close({id:"markdown-board"});return {}
      });
      on("command.run",{command:"markdown-q-state"},async($)=>({text:JSON.stringify({
        count,buttons,last,ctor:await $.store.get("ctor-owner")??null,
        clicked:await $.store.get("clicked")??null
      })}));
      on("ui.render",{component:"Pane",requestId:"markdown-board"},($,e)=>{
        const {Box,Markdown,Button,Client}=$.ui.resolve(e);
        return <Box flexDirection="column"><Markdown key="report"
          text={"# Q Markdown count:"+count+"\n\n| A | B |\n| - | - |\n| left | right |\n\n"+
            String.fromCharCode(96).repeat(3)+"ts\nconst literal = 1\n"+
            String.fromCharCode(96).repeat(3)+"\n<context>literal</context>\n\n"+
            "[Review](${originalHref}) [Workspace guide](${fileHref})"}
          pressableLinks={["${originalHref}"]}
          onLinkPress={async(link,event)=>{
            count++;last={link,event:event.link,plugin:event.plugin,element:event.element,
              component:event.component,requestId:event.requestId};
            await $.store.set("clicked",last);await $.ui.invalidate("ui.render")
          }}/><Button key="original-button" label={"Original button:"+buttons}
          onPress={async()=>{buttons++;await $.ui.invalidate("ui.render")}}/>
          <Client key="local-client" module="./surface.tsx"/></Box>
      })
    }`, `export default function Surface(_,s){
      if(s.state===undefined){s.setState(0);s.onPointer(e=>{if(e.type==="down")s.setState(s.state+1)})}
      const {Box,Markdown,Button}=s.elements;
      return <Box><Markdown text={"Client Markdown count:"+s.state}/>
        <Button key="old" label="Client old button" onPress={()=>s.setState(s.state+1)}/></Box>
    }`)
    for (const name of ["markdown-p", "markdown-r"]) {
      const prefix = name === "markdown-p" ? "P_MARKDOWN" : "R_MARKDOWN"
      await install(name, String.raw`export function register(on){
        on("session.start",async($,e,next)=>{
          await $.command.register({name:"${name}-state",description:"Actual namespace",immediate:true});
          return next(e)
        });
        on("command.run",{command:"${name}-state"},async($)=>({text:JSON.stringify({
          owner:await $.store.get("ctor-owner")??null,clicked:await $.store.get("clicked")??null
        })}));
        on("ui.resolve",{component:"Pane"},async($,e,next)=>{
          const lower=await next(e);return {...lower,Markdown:props=>{
            if(props.onLinkPress!==undefined)throw Error("Q callback leaked");
            void $.store.set("ctor-owner","${prefix}");
            return lower.Box({flexDirection:"column",children:[lower.Markdown({...props,
              text:"${prefix}\n"+props.text.replaceAll("${originalHref}","${finalHref}"),
              pressableLinks:["${finalHref}"]})]})
          }}
        });
        ${name === "markdown-p" ? `on("ui.press",($,e,next)=>e.link
          ?next({...e,link:{href:"MARKDOWN_BUSINESS_REWRITE"}}):next(e));` : ""}
      }`)
    }
    record("actual v89 Q/P/R ZIPs and Client source install with current digest approval")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Markdown E2E", { exact: true }).first().click()
    await openModsResults(page)
    const jobs = () => page.evaluate(id => window.api.mods.jobs(id), id)
    const run = async (command: string) => {
      const descriptor = (await page.evaluate(id => window.api.mods.commands(id), id))
        .find(row => row.command === command)
      assert(descriptor, `Actual command missing: ${command}`)
      const job = await page.evaluate(({ id, descriptor }) =>
        window.api.mods.enqueue(id, descriptor, { text: "" }), { id, descriptor })
      await until(async () => (await jobs()).some(row => row.id === job.id &&
        !["queued", "running"].includes(row.state)), `actual ${command}`)
      const settled = (await jobs()).find(row => row.id === job.id)!
      assert.equal(settled.state, "succeeded", JSON.stringify(settled))
      return settled.result?.text ?? ""
    }
    const snapshots = () => page.evaluate(id => window.api.mods.panes(id), id)
    const pane = page.locator('[data-function-pane="markdown-board"]')
    await run("markdown-open")
    await until(async () => (await pane.innerText()).includes("Q Markdown count:0") &&
      (await pane.innerText()).includes("P_MARKDOWN") &&
      (await pane.innerText()).includes("R_MARKDOWN"), "actual Markdown foreign constructors")
    const initial = (await snapshots()).find(row => row.id === "markdown-board")!
    evidence.initialPane = initial
    const leaves: Array<Extract<FunctionUiElement, { type: "Markdown" }>> = []
    const collect = (node: FunctionUiElement | string): void => {
      if (typeof node === "string" || node.type === "engine") return
      if (node.type === "Markdown") { leaves.push(node); return }
      for (const child of node.children ?? []) collect(child)
    }
    collect(initial.tree)
    assert.equal(leaves.length, 1)
    assert.equal(leaves[0].press?.kind, "onLinkPress")
    assert.equal(leaves[0].press?.plugin, "markdown-q")
    assert.deepEqual(leaves[0].props.pressableLinks, [finalHref])
    assert.equal(Object.hasOwn(leaves[0], "children"), false)
    assert.equal(initial.markdownLinks?.length, 1)
    assert.equal(await pane.getByRole("link", { name: "Review", exact: true }).getAttribute("href"), finalHref)
    assert.equal(await pane.locator("table").count(), 1)
    assert((await pane.innerText()).includes("<context>literal</context>"))
    assert((await pane.locator("pre").innerText()).includes("const literal = 1"))
    assert.equal(requests.length, 0)
    await page.screenshot({ path: join(artifacts, "markdown-composed.png") })
    record("native Markdown/TSX formats table/code/literal tags and P/R final targets retain one Q callback")

    const pState = JSON.parse(await run("markdown-p-state"))
    const rState = JSON.parse(await run("markdown-r-state"))
    const qBefore = JSON.parse(await run("markdown-q-state"))
    assert.deepEqual(pState, { owner: "P_MARKDOWN", clicked: null })
    assert.deepEqual(rState, { owner: "R_MARKDOWN", clicked: null })
    assert.equal(qBefore.ctor, null)
    assert.equal(qBefore.count, 0)
    record("constructor store writes belong to actual P/R while Q has no borrowed constructor state")
    await pane.getByRole("link", { name: "Review", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Q Markdown count:1"),
      "real Q Markdown click and redraw")
    const qAfter = JSON.parse(await run("markdown-q-state"))
    assert.deepEqual(qAfter.last, { link: { href: "MARKDOWN_BUSINESS_REWRITE" },
      event: { href: "MARKDOWN_BUSINESS_REWRITE" }, plugin: "markdown-q", element: "report",
      component: "Pane", requestId: "markdown-board" })
    assert.deepEqual(qAfter.clicked, qAfter.last)
    assert.equal(qAfter.count, 1)
    assert.equal(requests.length, 0)
    evidence.afterClick = qAfter
    record("actual anchor dispatches ui.press once, rewrites business href and invokes original Q closure")
    assert(initial.markdownLinks?.[0])
    await assert.rejects(page.evaluate(({ id, pane, href }) => window.api.mods.markdownLink(id, {
      address: { kind: "pane", pane: pane.key, generation: pane.generation },
      nonce: pane.markdownLinks![0].nonce, href, intentId: crypto.randomUUID()
    }), { id, pane: initial, href: finalHref }))
    const current = (await snapshots()).find(row => row.id === "markdown-board")!
    const leaf = markdownLeaf(current)
    assert(leaf.press)
    await assert.rejects(page.evaluate(({ id, pane, press, href }) => window.api.mods.paneAct(id, {
      pane: pane.key, generation: pane.generation, plugin: press.plugin, handle: press.handle,
      kind: "press", link: { href }, intentId: crypto.randomUUID()
    }), { id, pane: current, press: leaf.press, href: finalHref }))
    assert.equal(JSON.parse(await run("markdown-q-state")).count, 1)
    record("old native nonce and fabricated public paneAct link cannot replay the Q callback")

    const client = pane.locator("[data-function-client-instance]")
    await until(async () => (await client.innerText()).includes("Client Markdown count:0"), "actual Client leaf")
    await client.getByText("Client Markdown count:0", { exact: true }).click()
    await until(async () => (await client.innerText()).includes("Client Markdown count:1"), "actual Client pointer")
    await client.getByRole("button", { name: "Client old button", exact: true }).click()
    await until(async () => (await client.innerText()).includes("Client Markdown count:2"), "existing Client button")
    await pane.getByRole("button", { name: "Original button:0", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Original button:1"), "ordinary Q button")
    assert.equal(JSON.parse(await run("markdown-q-state")).count, 1)
    assert.equal(requests.length, 0)
    record("independent Client Markdown pointer/state and original Client/Q Buttons still execute")

    await pane.getByRole("link", { name: "Workspace guide", exact: true }).click()
    const preview = page.locator("[data-function-protected-preview-content]")
    try {
      await until(async () => (await preview.count()) === 1 &&
        (await preview.innerText()).includes("MARKDOWN_WORKSPACE_GUIDE"), "actual workspace snapshot")
    } catch (error) {
      // Read-only failure evidence distinguishes native rejection from actual panel lifecycle loss.
      evidence.previewEvents = await page.evaluate(() =>
        Reflect.get(window, "__markdownPreviewFacts"))
      const current = (await snapshots()).find(row => row.id === "markdown-board")!
      evidence.previewPane = current
      evidence.previewAlerts = await page.getByRole("alert").allTextContents()
      evidence.previewDiagnostic = await page.evaluate(async ({ id, current, fileHref }) => {
        try {
          const outcome = await window.api.mods.markdownLink(id, {
            address: { kind: "pane", pane: current.key, generation: current.generation },
            nonce: current.markdownLinks![0].nonce, href: fileHref, intentId: crypto.randomUUID()
          })
          return { outcome, snapshot: outcome.state === "preview"
            ? await window.api.mods.markdownPreview(id, outcome.preview.receipt) : null }
        } catch (cause) { return { error: String(cause) } }
      }, { id, current, fileHref })
      throw error
    }
    assert.equal(await preview.innerText(), guideText)
    assert.equal(readFileSync(guide, "utf8"), guideText)
    assert.equal(requests.length, 0)
    await page.screenshot({ path: join(artifacts, "markdown-workspace-preview.png") })
    record("actual file link uses the workspace read-only protected snapshot without model or external opener")
    const beforeReload = (await snapshots()).find(row => row.id === "markdown-board")!
    const beforeReloadState = JSON.parse(await run("markdown-q-state"))
    assert.equal(beforeReloadState.count, 1)
    assert.equal(beforeReloadState.buttons, 1)
    const oldReceipt = await page.evaluate(() => {
      const facts = Reflect.get(window, "__markdownPreviewFacts") as
        Array<{ kind: string; receipt?: string }>
      return facts.filter(row => row.kind === "open").at(-1)?.receipt
    })
    assert.equal(typeof oldReceipt, "string")
    assert(beforeReload.markdownLinks?.[0])
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Markdown E2E", { exact: true }).first().click()
    await openModsResults(page)
    assert.equal(await page.evaluate(({ id, receipt }) => window.api.mods.markdownPreview(
      id, receipt!), { id, receipt: oldReceipt }), null)
    await assert.rejects(page.evaluate(({ id, previous, href }) => window.api.mods.markdownLink(id, {
      address: { kind: "pane", pane: previous.key, generation: previous.generation },
      nonce: previous.markdownLinks![0].nonce, href, intentId: crypto.randomUUID()
    }), { id, previous: beforeReload, href: fileHref }))
    assert.equal(await preview.count(), 0)
    assert.equal(JSON.parse(await run("markdown-q-state")).count, 1)
    assert.equal(requests.length, 0)
    const afterReload = (await snapshots()).find(row => row.id === "markdown-board")!
    assert(afterReload.markdownLinks?.[0])
    assert.notEqual(afterReload.markdownLinks[0].nonce, beforeReload.markdownLinks[0].nonce)
    await pane.getByRole("link", { name: "Workspace guide", exact: true }).click()
    await until(async () => (await preview.count()) === 1 &&
      (await preview.innerText()) === guideText, "new actual preview after main-frame reload")
    const newReceipt = await page.evaluate(() => {
      const facts = Reflect.get(window, "__markdownPreviewFacts") as
        Array<{ kind: string; receipt?: string }>
      return facts.filter(row => row.kind === "open").at(-1)?.receipt
    })
    assert.equal(typeof newReceipt, "string")
    assert.notEqual(newReceipt, oldReceipt)
    assert.equal(readFileSync(guide, "utf8"), guideText)
    assert.equal(requests.length, 0)
    assert.deepEqual(JSON.parse(await run("markdown-q-state")), beforeReloadState)
    evidence.reload = { oldReceipt, newReceipt, before: beforeReload, after: afterReload,
      beforeState: beforeReloadState }
    await page.screenshot({ path: join(artifacts, "markdown-frame-reloaded.png") })
    record("actual main-frame reload rejects its old nonce and preview receipt; a new published link opens a fresh protected snapshot")
    await run("markdown-close")
    await until(async () => (await pane.count()) === 0 && (await preview.count()) === 0,
      "native close retires actual Markdown preview")
    record("native drawing close actually clears the file preview and old published actions")

    await run("markdown-open")
    await until(async () => (await pane.innerText()).includes("P_MARKDOWN"), "reopened composed Markdown")
    for (const name of ["markdown-p", "markdown-r"])
      await page.evaluate(({ id, name }) => window.api.mods.revokeFunction(id, name), { id, name })
    await run("markdown-open")
    await until(async () => (await pane.count()) === 1 &&
      (await pane.innerText()).includes("Q Markdown count:0") &&
      !(await pane.innerText()).includes("P_MARKDOWN") &&
      !(await pane.innerText()).includes("R_MARKDOWN"), "original native Markdown after source revoke")
    assert.equal(await pane.getByRole("link", { name: "Review", exact: true }).getAttribute("href"), originalHref)
    await pane.getByRole("link", { name: "Review", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Q Markdown count:1"), "Q action after revoke")
    assert.equal(JSON.parse(await run("markdown-q-state")).last.link.href, originalHref)
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("MARKDOWN_AFTER_REVOKE ordinary chat")
    await composer.press("Enter")
    await until(async () => {
      const stored = JSON.stringify(await page.evaluate(id => window.api.threads.getMessages(id), id))
      return stored.includes("MARKDOWN_AFTER_REVOKE") && stored.includes("MARKDOWN_CHAT_OK") &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
    }, "ordinary real HTTP chat after source revoke")
    assert.equal(requests.length, 1)
    assert(JSON.stringify(requests[0]).includes("MARKDOWN_AFTER_REVOKE"))
    assert.equal(readFileSync(guide, "utf8"), guideText)
    evidence.finalPane = (await snapshots()).find(row => row.id === "markdown-board")
    await page.screenshot({ path: join(artifacts, "markdown-revoked-chat.png") })
    record("revoking foreign sources restores native Q Markdown and ordinary chat sends one real local HTTP request")
    evidence.complete = true
  } catch (error) {
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    throw error
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    writeFileSync(join(artifacts, "markdown-evidence.json"), JSON.stringify(evidence, null, 2))
  }
}

function markdownLeaf(pane: FunctionPaneSnapshot): Extract<FunctionUiElement, { type: "Markdown" }> {
  const find = (node: FunctionUiElement): Extract<FunctionUiElement, { type: "Markdown" }> | undefined => {
    if (node.type === "Markdown") return node
    if (node.type !== "engine") for (const child of node.children ?? []) {
      if (typeof child !== "string") { const found = find(child); if (found) return found }
    }
    return undefined
  }
  const leaf = find(pane.tree)
  assert(leaf, "Actual published Markdown required")
  return leaf
}

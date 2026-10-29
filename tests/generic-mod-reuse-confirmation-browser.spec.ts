import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/generic-mod-reuse-confirmation", `run-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React from "react";import{createRoot}from"react-dom/client";
import{ModsDevelopmentPanel}from"./src/renderer/src/components/customize/ModsDevelopmentPanel";
let listeners=new Set(),calls=[],requests=[],reads=0;
let current={threadId:"chat",workspace:"c:/fixture",enabled:true,mode:"creator",drafts:[],trials:[]};
const api={status:async()=>{reads++;return structuredClone(current)},onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
requestReuse:async input=>{requests.push(input);window.fixture.pending(1);return structuredClone(current)},
approveReuse:async input=>{calls.push(input);current.reuse={...current.reuse,phase:"active"};return structuredClone(current)}};
window.electron={process:{platform:"win32"}};window.api={mods:{development:api}};
const emit=()=>listeners.forEach(fn=>fn({threadId:"chat"}));
window.fixture={get:()=>({reads,calls,requests}),refresh:emit,active:()=>{
current.drafts=[{id:"plain-mod",name:"文本处理",revision:1,digest:"1".repeat(64)}];
current.trials=[{componentId:"plain-mod",name:"文本处理",phase:"active",revision:1,activeRevision:1,
bundleDigest:"1".repeat(64),compiledDigest:"f".repeat(64),capabilities:["ui.render"]}];emit()},pending:version=>{
const digest=String(version).repeat(64);current.drafts=[{id:"plain-mod",name:"文本处理",revision:version,digest}];
current.reuse={phase:"needs-approval",planId:"plan-"+version,name:"文本处理",draftId:"plain-mod",revision:version,
sourceDigest:digest,compiledDigest:"f".repeat(64),targetProfileDigest:"9".repeat(64),capabilities:["platform.act"]};emit()}};
createRoot(document.getElementById("root")).render(<ModsDevelopmentPanel threadId="chat" workspaceHint="c:/fixture" mode="chat" api={api}/>);
` }, bundle: true, plugins: [browserWorkerPlugin()], loader: { ".md": "text", ".png": "dataurl" },
    jsx: "automatic", write: false, platform: "browser", format: "iife", target: "chrome130",
    logLevel: "silent" })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://fixture.test/**", (route) => route.fulfill({ contentType: "text/html",
      body: `<html><meta charset="utf-8"><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>` }))
    await page.goto("http://fixture.test")
    await page.waitForFunction("window.fixture.get().reads > 0")
    const dialog = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    await page.evaluate("window.fixture.active()")
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    const save = dialog.getByRole("button", {
      name: "保存“文本处理”并在其他聊天复用…", exact: true
    })
    await save.waitFor()
    assert.equal(await dialog.locator('details[data-creator-section="create"]').evaluate(
      (element) => (element as HTMLDetailsElement).open), false)
    assert.equal(await page.evaluate("window.fixture.get().requests.length"), 0)
    await save.click()
    assert.deepEqual(await page.evaluate("window.fixture.get().requests"), [{
      threadId: "chat", expectedWorkspace: "c:/fixture", id: "plain-mod", revision: 1
    }])
    const details = dialog.locator('details[data-creator-section="create"]')
    const confirm = dialog.getByRole("button", { name: "确认保存并复用", exact: true })
    await confirm.waitFor({ timeout: 5000 }).catch(async (error) => {
      await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
      writeFileSync(join(output, "failure.txt"), JSON.stringify({ errors,
        text: await page.locator("body").innerText(),
        details: await page.locator("details").evaluateAll((elements) => elements.map((element) =>
          ({ open: element.open, section: element.dataset.creatorSection,
            summary: element.querySelector("summary")?.textContent }))) }, null, 2))
      throw error
    })
    assert(await details.evaluate((element) => (element as HTMLDetailsElement).open))
    assert.equal(await page.evaluate("window.fixture.get().calls.length"), 0)
    await details.locator(":scope > summary").click()
    const reads = await page.evaluate("window.fixture.get().reads")
    await page.evaluate("window.fixture.refresh()")
    await page.waitForFunction((before) =>
      (window as unknown as { fixture: { get(): { reads: number } } }).fixture.get().reads > before,
    reads)
    assert.equal(await details.evaluate((element) => (element as HTMLDetailsElement).open), false)
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "确认跨聊天复用", exact: true }).click()
    await confirm.waitFor()
    assert(await details.evaluate((element) => (element as HTMLDetailsElement).open),
      "Reopening the same pending plan creates a fresh visible confirmation")
    assert.equal(await page.evaluate("window.fixture.get().calls.length"), 0)
    await page.evaluate("window.fixture.pending(2)")
    await confirm.waitFor()
    await page.screenshot({ path: join(output, "pending-confirmation.png") })
    assert.equal(await page.evaluate("window.fixture.get().calls.length"), 0)
    await confirm.click()
    assert.deepEqual(await page.evaluate("window.fixture.get().calls"), [{ threadId: "chat",
      expectedWorkspace: "c:/fixture", planId: "plan-2", sourceDigest: "2".repeat(64),
      compiledDigest: "f".repeat(64), targetProfileDigest: "9".repeat(64) }])
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true,
      checks: ["Active trial exposes save without opening advanced settings or stopping the trial",
        "Save prepares the exact current draft without approving it",
        "New native reuse confirmation is visible", "Refresh preserves manual collapse",
        "New source confirmation opens once", "Only explicit confirmation approves exact native plan"] }))
    console.log(`PASS generic reuse confirmation: ${output}`)
  } finally { await browser.close() }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

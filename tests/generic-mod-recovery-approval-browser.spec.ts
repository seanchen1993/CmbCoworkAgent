import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/generic-mod-recovery-approval", `run-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React from "react";import{createRoot}from"react-dom/client";
import{ClawRecoveryApproval}from"./src/renderer/src/components/chat/ClawRecoveryApproval";
import{useAppStore}from"./src/renderer/src/lib/store";
const root=createRoot(document.getElementById("root"));let thread="chat",loads=0,calls=[],readHold=false,finishRead,grantHold=false,finishGrant;
const source=(id,digest="a".repeat(64))=>({pluginId:id,name:id,digest,state:"needs-approval",capabilities:["platform.act"]});
let binding;const reset=()=>{thread="chat";binding={workspace:"c:/fixture",bindingRevision:1,revision:1,enabled:true,applicable:true,issues:[],profiles:[],
active:{id:"selected",name:"组合",capabilities:[{pluginId:"provider",name:"provider",digest:"a".repeat(64)}]},
capabilities:[source("provider"),source("unselected","b".repeat(64))]};render()};
window.electron={process:{platform:"win32"}};
window.api={mods:{clawView:async()=>{const value=structuredClone(binding);return readHold?await new Promise(resolve=>finishRead=()=>{readHold=false;resolve(value)}):value},
approveFunction:async(...args)=>{calls.push(args);if(grantHold)await new Promise(resolve=>finishGrant=()=>{grantHold=false;resolve()})}}};
const render=()=>root.render(<ClawRecoveryApproval threadId={thread} binding={structuredClone(binding)} disabled={false} onReload={async()=>{loads++}}/>);
window.fixture={reset,get:()=>({calls,loads,readReady:!!finishRead,grantReady:!!finishGrant}),
deferRead:()=>readHold=true,releaseRead:()=>{const done=finishRead;finishRead=undefined;done()},
deferGrant:()=>grantHold=true,releaseGrant:()=>{const done=finishGrant;finishGrant=undefined;done()},
change:()=>{binding.capabilities[0].digest="c".repeat(64);render()},
different:()=>{thread="other";binding.workspace="c:/other";render()},account:()=>useAppStore.setState({accountRevision:useAppStore.getState().accountRevision+1}),
remove:()=>{binding.capabilities=[];render()}};reset();
` }, bundle: true, plugins: [browserWorkerPlugin()], loader: { ".md": "text", ".png": "dataurl" },
    jsx: "automatic", write: false, platform: "browser", format: "iife", target: "chrome130", logLevel: "silent" })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://fixture.test/**", (route) => route.fulfill({ contentType: "text/html",
      body: `<html><meta charset="utf-8"><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>` }))
    await page.goto("http://fixture.test")
    const card = page.locator('[data-claw-recovery-plugin="provider"]')
    const approve = card.getByRole("button", { name: "授权以上能力", exact: true })
    await approve.waitFor()
    assert.equal(await page.locator('[data-claw-recovery-plugin="unselected"]').count(), 0)
    assert.deepEqual(await page.evaluate("window.fixture.get().calls"), [])
    await page.evaluate("window.fixture.deferGrant()")
    await approve.click()
    await page.waitForFunction("window.fixture.get().grantReady")
    const approving = card.getByRole("button", { name: "正在授权…", exact: true })
    assert(await approving.isDisabled())
    await approving.evaluate((element) => (element as HTMLButtonElement).click())
    assert.equal(await page.evaluate("window.fixture.get().calls.length"), 1)
    await page.evaluate("window.fixture.releaseGrant()")
    await page.waitForFunction("window.fixture.get().loads === 1")
    assert.deepEqual(await page.evaluate("window.fixture.get().calls"),
      [["chat", "provider", "a".repeat(64), "c:/fixture"]])
    for (const mutation of ["different", "account", "change"]) {
      await page.evaluate("window.fixture.reset()")
      await approve.waitFor()
      await page.evaluate("window.fixture.deferRead()")
      await approve.click()
      await page.waitForFunction("window.fixture.get().readReady")
      await page.evaluate((name) => (window as unknown as { fixture: Record<string, () => void> }).fixture[name](), mutation)
      if (mutation === "different")
        await card.getByText("授权范围：c:/other，同目录聊天共用。", { exact: true }).waitFor()
      if (mutation === "change")
        await card.getByText("版本已变化或来源不可用，请从上方“插件”核对。", { exact: true }).waitFor()
      await page.evaluate("window.fixture.releaseRead()")
      await page.waitForTimeout(50)
      assert.equal(await page.evaluate("window.fixture.get().calls.length"), 1,
        `${mutation} while checking cannot approve the old source`)
      assert.equal(await page.evaluate("window.fixture.get().loads"), 1)
    }
    await page.evaluate("window.fixture.reset();window.fixture.change()")
    await card.getByText("版本已变化或来源不可用，请从上方“插件”核对。", { exact: true }).waitFor()
    assert.equal(await approve.count(), 0)
    await page.evaluate("window.fixture.reset();window.fixture.deferGrant()")
    await approve.waitFor()
    await approve.click()
    await page.waitForFunction("window.fixture.get().grantReady")
    await page.evaluate("window.fixture.different()")
    await card.getByText("授权范围：c:/other，同目录聊天共用。", { exact: true }).waitFor()
    await page.evaluate("window.fixture.releaseGrant()")
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate("window.fixture.get().calls.length"), 2)
    assert.equal(await page.evaluate("window.fixture.get().loads"), 1,
      "A native approval already admitted in the old scope cannot reload the new conversation")
    await page.evaluate("window.fixture.remove()")
    await card.getByText("版本已变化或来源不可用，请从上方“插件”核对。", { exact: true }).waitFor()
    assert.equal(await approve.count(), 0)
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true, checks: [
      "Only selected exact source is reviewable", "Native approval receives exact scope and digest",
      "Busy blocks duplicate approval", "Successful approval reloads binding",
      "Changed account/thread/workspace/source fences pending reads", "Changed or missing source cannot grant old selection"
    ] }))
    console.log(`PASS generic recovery approval: ${output}`)
  } finally { await browser.close() }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

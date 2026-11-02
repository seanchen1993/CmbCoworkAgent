/** Actual read-only consent hook; controlled IPC, no grants, Guest or model execution. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output", `project-use-consent-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "account-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: `
        import {useSyncExternalStore} from 'react';let revision=0;const listeners=new Set();
        window.changeAccount=()=>{revision++;for(const listener of listeners)listener()};
        export const useAppStore=selector=>useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback)},()=>selector({accountRevision:revision}));
      `
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{ProjectUseConsent}from'./src/renderer/src/components/harness-board/ProjectUseConsent';
      import{useProjectUseReview}from'./src/renderer/src/components/harness-board/use-project-use-review';
      const requests=[],submissions=[];let hold=true,fail=false,ttl=60000;
      const identity={pluginId:'main',name:'文档协作',version:'1.0.0',digest:'a'.repeat(64)};
      window.api={harnessBoard:{reviewProjectUse:input=>new Promise((resolve,reject)=>{
        const request={input,finish:()=>fail?reject(Error('read failed')):resolve({reviewId:'review-'+requests.indexOf(request),reviewDigest:'b'.repeat(64),projectId:'owner',workspace:input.workspacePath+'/'+input.projectDir,plugin:identity,packageDigest:'c'.repeat(64),
          sources:[{pluginId:'main',name:'文档协作',digest:'d'.repeat(64),capabilities:['process.run'],actionIds:[],configurationOnly:false},{pluginId:'checks',name:'通用检查',digest:'e'.repeat(64),capabilities:['fs.read'],actionIds:['check'],configurationOnly:false}],scopeNotice:'只用于本项目登记的目录。开启应用功能可能恢复此前已授权项。',requiresApplicationEnable:true,expiresAt:Date.now()+ttl})};
        requests.push(request);if(!hold)request.finish();
      })}};
      function Fixture(){const[target,setTarget]=useState('first'),[open,setOpen]=useState(true);
        const state=useProjectUseReview(open?{adapterId:'main',adapterType:'plugin',workspacePath:'C:/chosen',projectDir:target,expectedNativeTemplate:identity}:undefined);
        window.fixture={requests,submissions,target:setTarget,close:()=>setOpen(false),open:()=>setOpen(true),finish:index=>requests[index].finish(),auto:()=>hold=false,fail:value=>fail=value,ttl:value=>ttl=value};
        return <><ProjectUseConsent state={state}/><button disabled={!state.approval} onClick={()=>submissions.push(state.approval)}>创建并授权</button></>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const checks: string[] = []
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const submit = page.getByRole("button", { name: "创建并授权", exact: true })
    await page.waitForFunction("window.fixture.requests.length===1")
    assert(await submit.isDisabled())
    await page.evaluate(
      "(async()=>{for(let i=0;i<5;i++){window.fixture.target('typing-'+i);await new Promise(resolve=>setTimeout(resolve,40))}window.fixture.target('second')})()"
    )
    await page.waitForFunction("window.fixture.requests.length===2")
    await page.evaluate("window.fixture.finish(0)")
    assert(await submit.isDisabled(), "old directory review never enables the new target")
    await page.evaluate("window.fixture.finish(1)")
    await page
      .getByText("项目目录：C:/chosen/second", { exact: true })
      .waitFor({ state: "attached" })
    await page.waitForFunction(
      "Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='创建并授权'&&!button.disabled)"
    )
    assert.equal(await page.evaluate("window.fixture.submissions.length"), 0)
    await submit.click()
    assert.deepEqual(await page.evaluate("window.fixture.submissions"), [
      { reviewId: "review-1", reviewDigest: "b".repeat(64) }
    ])
    checks.push(
      "selection is read-only; typing is coalesced; late old-directory review ignored; one existing submit carries receipt"
    )
    await page.getByRole("button", { name: "重新核对", exact: true }).click()
    await page.waitForFunction("window.fixture.requests.length===3")
    assert(
      await submit.isDisabled(),
      "explicit recheck clears the old approval before resubmission"
    )
    await page.evaluate("window.fixture.finish(2)")
    await page.waitForFunction(
      "Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='创建并授权'&&!button.disabled)"
    )
    checks.push("a current review exposes read-only recheck and clears the prior submit receipt")
    await page.evaluate("window.fixture.target('cancelled')")
    await page.waitForFunction("window.fixture.requests.length===4")
    await page.evaluate("window.fixture.close();window.fixture.finish(3)")
    assert(await submit.isDisabled())
    checks.push("closing form discards a pending review without granting")
    await page.evaluate("window.fixture.open()")
    await page.waitForFunction("window.fixture.requests.length===5")
    await page.evaluate("window.fixture.fail(true);window.fixture.finish(4)")
    await page.getByRole("alert").waitFor()
    assert(await submit.isDisabled())
    await page.evaluate("window.fixture.fail(false);window.fixture.auto();window.fixture.ttl(1000)")
    await page.getByRole("button", { name: "重新核对", exact: true }).click()
    await page.getByText("开启应用功能可能恢复此前已授权项。", { exact: false }).waitFor()
    assert(await submit.isEnabled())
    await page.getByRole("alert").filter({ hasText: "核对已过期" }).waitFor()
    assert(await submit.isDisabled())
    checks.push(
      "read failure and expiration cannot submit; explicit refresh restores a current review"
    )
    await page.evaluate("window.fixture.ttl(60000);window.changeAccount()")
    await page.waitForFunction("window.fixture.requests.length===7")
    await page.waitForFunction(
      "Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='创建并授权'&&!button.disabled)"
    )
    assert.equal(await page.evaluate("window.fixture.submissions.length"), 1)
    checks.push("account change invalidates and rereads the scope without submitting")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "inline-consent.png"), fullPage: true })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual consent hook and summary with controlled IPC; integration submission is separately covered by the original form suite",
          checks,
          errors
        },
        null,
        2
      )
    )
    console.log(`PASS project-use consent ${checks.length} checks; evidence ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

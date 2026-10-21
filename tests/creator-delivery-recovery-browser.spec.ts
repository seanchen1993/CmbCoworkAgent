/** Real delivery controls; bounded IPC fixtures never install, export or grant permissions. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/creator-delivery-recovery-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const compiled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "bound-separately-tested-start-use",
        setup(builder) {
          builder.onLoad({ filter: /InstalledPluginStartUse\.tsx$/ }, () => ({
            loader: "tsx",
            contents: `import React from 'react';
          export function InstalledPluginStartUse(props){window.startUseProps=props;
            return <div aria-label='native start-use handoff'>precise installed package</div>}`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{CreatorProjectDeliveryCard}from'./src/renderer/src/components/customize/CreatorProjectDeliveryCard';
      import{BusinessCreatorReviewCard}from'./src/renderer/src/components/customize/BusinessCreatorReviewCard';
      window.electron={process:{platform:'win32'}};
      const root=createRoot(document.getElementById('root')),calls=[];
      const request={id:'request',draftId:'draft',name:'source',revision:1,digest:'a'.repeat(64),goal:'goal'};
      const base={id:'delivery',requestId:request.id,sourceDigest:request.digest,name:'saved-plugin',version:'1.0.0',digest:'b'.repeat(64),phase:'unknown',canInstall:false,canExport:false,canReconcile:true,operation:'export',pendingOutput:'C:/export/pending.zip'};
      let delivery={...base},historical=false,missingRequest=false,outcome='not-executed';
      const render=()=>root.render(<CreatorProjectDeliveryCard threadId='chat' workspace='C:/owned'
        request={missingRequest?undefined:historical?{...request,id:'new-request',digest:'c'.repeat(64)}:request}
        delivery={delivery}api={api}onStatus={next=>{delivery=next.projectDelivery;render()}}/>);
      const status=()=>({threadId:'chat',workspace:'c:/owned',enabled:true,drafts:[],trials:[],projectDelivery:delivery});
      const api={status:async input=>{calls.push(['status',input]);return status()},
        prepareProjectDelivery:async input=>{calls.push(['prepare',input]);delivery={...base,phase:'needs-confirmation',canInstall:true,canExport:true,canReconcile:false};return status()},
        installProjectDelivery:async input=>{calls.push(['install',input]);delivery={...base,operation:'install'};throw Error('PROJECT_DELIVERY_INSTALL_UNCONFIRMED')},
        exportProjectDelivery:async input=>{calls.push(['export',input]);throw Error('MUST_NOT_EXPORT')},
        reconcileProjectDelivery:async input=>{calls.push(['reconcile',input]);delivery={...base,phase:outcome==='installed'?'installed':'failed',canReconcile:false,reconciliation:{outcome,checkedAt:1},...(outcome==='installed'?{pluginId:'native-installed-id'}:{})};return status()}};
      window.fixture={calls,render,reset:()=>{delivery={...base};historical=false;render()},outcome:v=>outcome=v,
        history:()=>{delivery={...base};historical=true;render()},noRequest:()=>{delivery={...base};missingRequest=true;render()},business:()=>root.render(<BusinessCreatorReviewCard
          review={{planId:'plan',copyId:'copy',name:'business',version:'1.0.0',digest:'d'.repeat(64),contentDigest:'e'.repeat(64),phase:'installed',canConfirm:false,pluginId:'business-installed-id',steps:[],diagnostics:[],reconciliation:{outcome:'conflict',checkedAt:1}}}
          busy={false}startUseScope={{threadId:'chat',workspace:'C:/owned'}}onApprove={()=>calls.push(['forbidden-approve'])}onExport={()=>calls.push(['forbidden-export'])}onRead={()=>calls.push(['read'])}/>)};
      render();
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  const checks: string[] = []
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    const prepare = page.getByRole("button", { name: "准备保存为新插件", exact: true })
    await prepare.waitFor()
    assert.equal(await prepare.isDisabled(), true)
    await page.getByText("待核对导出目标：C:/export/pending.zip", { exact: true }).waitFor()
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
    await page.getByText(/已核实：未发现本次交付的执行结果/).waitFor()
    assert.equal(await prepare.isEnabled(), true)
    assert.equal(
      await page.evaluate<number>(
        "window.fixture.calls.filter(c=>c[0]==='install'||c[0]==='export').length"
      ),
      0
    )
    checks.push(
      "unknown requires native reconciliation; confirmed absence permits fresh preparation only"
    )

    await prepare.click()
    await page.getByRole("button", { name: "确认安装新插件", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "核对实际交付结果" }).waitFor()
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).waitFor()
    assert.equal(
      await page.evaluate<number>("window.fixture.calls.filter(c=>c[0]==='install').length"),
      1
    )
    assert.equal(
      await page.evaluate<number>("window.fixture.calls.filter(c=>c[0]==='status').length"),
      1
    )
    checks.push("lost installation reply reads native status once without resending installation")

    await page.evaluate("window.fixture.outcome('installed')")
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
    await page.getByLabel("native start-use handoff", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.startUseProps"), {
      threadId: "chat",
      workspace: "C:/owned",
      pluginId: "native-installed-id",
      expected: { name: "saved-plugin", version: "1.0.0", digest: "b".repeat(64) }
    })
    checks.push(
      "confirmed installed identity reaches the separately tested native start-use component"
    )

    await page.evaluate("window.fixture.history()")
    await page.getByText(/下方交付记录属于历史候选/).waitFor()
    assert.equal(await page.getByLabel("native start-use handoff", { exact: true }).count(), 0)
    assert.equal(await prepare.isDisabled(), true)
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
    assert.equal(await page.getByLabel("native start-use handoff", { exact: true }).count(), 0)
    checks.push(
      "historical effects remain inspectable without using the old package as the new candidate"
    )

    await page.evaluate("window.fixture.noRequest()")
    await page.getByRole("heading", { name: "核对历史插件交付", exact: true }).waitFor()
    assert.equal(await prepare.count(), 0)
    assert.equal(await page.getByRole("button", { name: "确认安装新插件", exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "导出新插件 ZIP…", exact: true }).count(),
      0
    )
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
    assert.equal(await page.getByLabel("native start-use handoff", { exact: true }).count(), 0)
    checks.push(
      "a removed current candidate still exposes native historical reconciliation without old approvals"
    )

    await page.evaluate("window.fixture.business()")
    await page.getByText(/发现安装或导出内容冲突/).waitFor()
    await page.getByLabel("native start-use handoff", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate<string>("window.startUseProps.expected.digest"),
      "e".repeat(64)
    )
    assert.equal(
      await page.evaluate<number>(
        "window.fixture.calls.filter(c=>c[0].startsWith('forbidden')).length"
      ),
      0
    )
    checks.push(
      "business delivery uses native content identity and never labels a conflicting export successful"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "delivery-recovery.png"), fullPage: true })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

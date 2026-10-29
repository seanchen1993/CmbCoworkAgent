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
      import{useAppStore}from'./src/renderer/src/lib/store';
      window.electron={process:{platform:'win32'}};
      const root=createRoot(document.getElementById('root')),calls=[];
      const request={id:'request',draftId:'draft',name:'source',revision:1,digest:'a'.repeat(64),goal:'goal'};
      const base={id:'delivery',requestId:request.id,sourceDigest:request.digest,name:'saved-plugin',version:'1.0.0',digest:'b'.repeat(64),phase:'unknown',canInstall:false,canExport:false,canReconcile:true,operation:'export',pendingOutput:'C:/export/pending.zip'};
      let delivery={...base},historical=false,missingRequest=false,outcome='not-executed',mode='lost',release;
      const render=()=>root.render(<CreatorProjectDeliveryCard threadId='chat' workspace='C:/owned'
        request={missingRequest?undefined:historical?{...request,id:'new-request',digest:'c'.repeat(64)}:request}
        delivery={delivery}api={api}onStatus={next=>{delivery=next.projectDelivery;render()}}/>);
      const status=()=>({threadId:'chat',workspace:'c:/owned',enabled:true,drafts:[],trials:[],projectDelivery:delivery});
      const api={status:async input=>{calls.push(['status',input]);return status()},
        prepareProjectDelivery:async input=>{calls.push(['prepare',input]);const pluginId=delivery?.pluginId;
          delivery={...base,name:input.name,version:input.version,phase:pluginId?'installed':'needs-confirmation',canInstall:!pluginId,canExport:true,canReconcile:false,...(pluginId?{pluginId}:{}),
          ...(mode==='wrong-source'||mode==='wrong-installed-source'?{sourceDigest:'f'.repeat(64)}:{}),
          ...(mode==='wrong-name'||mode==='wrong-installed-name'?{name:'unrelated-plugin'}:{}),
          ...(mode==='wrong-installed-package'?{digest:'f'.repeat(64)}:{}),
          ...(mode==='wrong-installed-plugin'?{pluginId:'unrelated-installed'}:{}),
          ...(mode==='unconfirmed-export'?{canExport:false}:{})};
          const next=status();if(mode==='delayed')await new Promise(resolve=>release=resolve);return next},
        installProjectDelivery:async input=>{calls.push(['install',input]);
          if(mode==='save'){delivery={...delivery,phase:'installed',pluginId:'fresh-installed',canInstall:false};return status()}
          delivery={...base,operation:'install'};throw Error('PROJECT_DELIVERY_INSTALL_UNCONFIRMED')},
        exportProjectDelivery:async input=>{calls.push(['export',input]);
          if(mode==='export'||mode==='recovered-export'){delivery={...delivery,phase:'exported',output:'C:/export/fresh.zip'};return status()}
          throw Error('MUST_NOT_EXPORT')},
        reconcileProjectDelivery:async input=>{calls.push(['reconcile',input]);delivery={...base,phase:outcome==='installed'?'installed':'failed',canReconcile:false,reconciliation:{outcome,checkedAt:1},...(outcome==='installed'?{pluginId:'native-installed-id'}:{})};return status()}};
      window.fixture={calls,render,reset:()=>{delivery={...base};historical=false;render()},outcome:v=>outcome=v,
        failed:()=>{delivery={...base,phase:'failed',canReconcile:false,error:'PROJECT_DELIVERY_NAME_ALREADY_INSTALLED'};render()},
        prepared:()=>{delivery={...base,phase:'needs-confirmation',canInstall:true,canExport:true,canReconcile:false};render()},
        fresh:next=>{mode=next;delivery=undefined;historical=false;missingRequest=false;render()},
        installed:next=>{mode=next;delivery={...base,phase:next==='unknown-installed'?'unknown':'installed',operation:'install',pluginId:'native-installed-id'};historical=false;missingRequest=false;render()},
        switchAccount:()=>useAppStore.setState({accountRevision:useAppStore.getState().accountRevision+1}),release:()=>release(),
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
    const prepare = page.getByRole("button", { name: "保存插件", exact: true })
    await prepare.waitFor()
    assert.equal(await prepare.isDisabled(), true)
    await page.getByRole("heading", { name: "核对保存结果", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button").first().innerText(),
      "核对实际交付结果",
      "The explicit native reconciliation action must precede disabled saving controls"
    )
    assert.equal(
      await page
        .getByText("保存详情", { exact: true })
        .locator("..")
        .evaluate((element) => (element as HTMLDetailsElement).open),
      false
    )
    await page.evaluate("window.fixture.failed()")
    await page.getByRole("alert").filter({ hasText: "此名称已被已安装插件使用" }).waitFor()
    await page.getByText("保存详情", { exact: true }).click()
    await page
      .getByText("诊断代码：PROJECT_DELIVERY_NAME_ALREADY_INSTALLED", { exact: true })
      .waitFor()
    await page.getByText("保存详情", { exact: true }).click()
    await page.evaluate("window.fixture.prepared()")
    assert.equal(await prepare.isEnabled(), true)
    assert.equal(
      await page.getByRole("button", { name: /导出 ZIP/ }).count(),
      1,
      "A prepared candidate must expose one export action rather than duplicate ZIP buttons"
    )
    await page.evaluate("window.fixture.reset()")
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
    checks.push(
      "reconciliation is the leading action; persisted failures remain visible and prepared export is singular"
    )

    await prepare.click()
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
      disabled: false,
      threadId: "chat",
      workspace: "C:/owned",
      pluginId: "native-installed-id",
      expected: { name: "saved-plugin", version: "1.0.0", digest: "b".repeat(64) }
    })
    checks.push(
      "confirmed installed identity reaches the separately tested native start-use component"
    )

    const count = (kind: string) =>
      page.evaluate(
        (kind) =>
          window.eval(
            "window.fixture.calls.filter(row=>row[0]===" + JSON.stringify(kind) + ").length"
          ),
        kind
      )
    await page.evaluate("window.fixture.installed('recovered-export')")
    const recheckExport = page.getByRole("button", { name: "核对并导出 ZIP…", exact: true })
    await recheckExport.waitFor()
    const beforeRecheck = await count("prepare")
    const beforeRecheckInstall = await count("install")
    const beforeRecheckExport = await count("export")
    await recheckExport.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await page.getByText("导出位置：C:/export/fresh.zip", { exact: true }).waitFor()
    assert.equal(await count("prepare"), beforeRecheck + 1)
    assert.equal(await count("export"), beforeRecheckExport + 1)
    assert.equal(await count("install"), beforeRecheckInstall)
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='prepare').at(-1)[1]"),
      {
        threadId: "chat",
        expectedWorkspace: "C:/owned",
        requestId: "request",
        digest: "a".repeat(64),
        name: "saved-plugin",
        version: "1.0.0"
      }
    )
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='export').at(-1)[1]"),
      {
        threadId: "chat",
        expectedWorkspace: "C:/owned",
        deliveryId: "delivery",
        digest: "b".repeat(64)
      }
    )
    checks.push(
      "installed delivery without live consent explicitly rechecks its frozen identity before export; double click never reinstalls"
    )
    for (const mode of [
      "wrong-installed-source",
      "wrong-installed-name",
      "wrong-installed-package",
      "wrong-installed-plugin",
      "unconfirmed-export"
    ]) {
      await page.evaluate(
        (mode) => window.eval("window.fixture.installed(" + JSON.stringify(mode) + ")"),
        mode
      )
      await recheckExport.waitFor()
      const before = await count("export")
      await recheckExport.click()
      await page.getByRole("alert").waitFor()
      assert.equal(await count("export"), before)
      assert.equal(await count("install"), beforeRecheckInstall)
      checks.push(
        `${mode}: rechecking cannot export another installation or reuse missing confirmation`
      )
    }
    await page.evaluate("window.fixture.installed('unknown-installed')")
    await page.getByRole("button", { name: "核对实际交付结果", exact: true }).waitFor()
    assert.equal(await page.evaluate("window.startUseProps.disabled"), true,
      "A retained installed identity cannot be used while its delivery result awaits reconciliation")
    assert.equal(await recheckExport.count(), 0)
    assert.equal(await page.getByRole("button", { name: "导出 ZIP…", exact: true }).count(), 0)
    checks.push(
      "unknown delivery with a retained installed identity still requires reconciliation before export"
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
    assert.equal(await page.getByRole("button", { name: "保存插件", exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "导出 ZIP…", exact: true }).count(),
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
    await page.evaluate("window.fixture.fresh('save')")
    const beforeSave = await count("install")
    assert.equal(await page.getByRole("textbox", { name: "新插件标识", exact: true }).inputValue(), "source-request")
    await prepare.evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await page.getByRole("heading", { name: "插件已保存", exact: true }).waitFor()
    assert.equal(
      await page.getByText("新插件已安装。", { exact: true }).count(),
      0,
      "The saved heading and native use action replace repeated installation success text"
    )
    assert.equal(await count("install"), beforeSave + 1)
    assert.deepEqual(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='install').at(-1)[1]"), {
      threadId: "chat", expectedWorkspace: "C:/owned", deliveryId: "delivery", digest: "b".repeat(64)
    })
    checks.push("one Save action prepares and installs the returned frozen identity exactly once")
    for (const mode of ["wrong-source", "wrong-name"]) {
      await page.evaluate(mode => window.eval("window.fixture.fresh(" + JSON.stringify(mode) + ")"), mode)
      const before = await count("install")
      await prepare.click()
      await page.getByRole("alert").waitFor()
      assert.equal(await count("install"), before)
      checks.push(`${mode}: inconsistent preparation cannot continue to installation`)
    }
    await page.evaluate("window.fixture.fresh('export')")
    const beforeExport = await count("install")
    await page.getByRole("button", { name: "仅导出 ZIP…", exact: true }).click()
    await page.getByText("导出位置：C:/export/fresh.zip", { exact: true }).waitFor()
    assert.equal(await count("install"), beforeExport)
    assert.equal(await page.getByRole("button", { name: /导出 ZIP/ }).count(), 1)
    checks.push("export-only prepares and exports without installing")
    await page.evaluate("window.fixture.fresh('delayed')")
    const beforeAccount = await count("install")
    const beforePreparation = await count("prepare")
    await prepare.click()
    await page.waitForFunction(before => window.eval("window.fixture.calls.filter(row=>row[0]==='prepare').length") === before + 1, beforePreparation)
    await page.evaluate("window.fixture.switchAccount();window.fixture.release()")
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => button.textContent === "正在保存…"))
    assert.equal(await count("install"), beforeAccount)
    checks.push("an account change during preparation cannot dispatch installation")
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

/** Actual React native consent; persistence/compiler/VM and IPC have independent real tests. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Browser } from "playwright"

async function dependencyConsent(browser: Browser) {
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    alias: { "@": resolve("src/renderer/src") },
    stdin: {
      loader: "tsx",
      resolveDir: resolve(__dirname, ".."),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectFunctionConsent} from './src/renderer/src/components/harness-board/ProjectFunctionConsent';
      import {useAppStore} from './src/renderer/src/lib/store';
      import {usePluginSettingsRequest} from './src/renderer/src/lib/plugin-settings-intent';
      if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-000000000001';
      const root=createRoot(document.getElementById('root')),calls=[],reads=[],ready=[],states={};
      let pending,malformed;
      const state=id=>states[id]??=( {configured:false,rules:'needs-approval',knowledge:'needs-approval'} );
      const review=id=>({projectId:id,projectVersion:3,packageDigest:'p'.repeat(64),workspace:'C:/native/'+id,
        workspaceEnabled:state(id).workspaceEnabled??true,globallyEnabled:state(id).globallyEnabled??true,
        ...(id==='legacy'?{}:{source:{name:'configuration-only',digest:'m'.repeat(64),state:'ready',
          capabilities:[],scannedMethods:[],scanIncomplete:false,configurationOnly:true},dependencies:[
          {pluginId:'rules-id',name:'generic-rules',digest:'r'.repeat(64),actionIds:['business.check'],
            state:state(id).rules,capabilities:['process.run'],hasConfiguration:true,configurationReady:state(id).configured},
          {pluginId:'knowledge-id',name:'generic-knowledge',digest:'k'.repeat(64),actionIds:['context.read'],
            state:state(id).knowledge,capabilities:['platform.read'],configurationReady:true}]})});
      const configView=id=>({pluginId:'rules-id',plugin:'generic-rules',digest:'r'.repeat(64),workspace:'C:/native/'+id,
        savedRevision:state(id).configured?1:0,state:'inactive',fields:[{key:'runner',label:'运行工具',description:'',
          type:'string',supported:true,required:true,value:state(id).configured?'python':''}]});
      const config={userConfig:async(id,pluginId,workspace)=>{reads.push({id,pluginId,workspace});return configView(id)},
        saveUserConfig:async(id,view,key,value)=>{calls.push({kind:'config',id,view,key,value});state(id).configured=true;return configView(id)}};
      const api={config,read:async id=>review(id),approve:async()=>{throw Error('MAIN_HAS_NO_VM')},
        approveDependency:input=>{calls.push({kind:'dependency',...input});return new Promise(resolve=>{
          pending=()=>{state(input.projectId)[input.pluginId==='rules-id'?'rules':'knowledge']='ready';state(input.projectId).workspaceEnabled=true;
            const result=review(input.projectId);if(malformed)delete result[malformed];resolve(result)}})}};
      window.api={harnessBoard:{localProjects:{mods:api}},mods:{onConfigurationChanged:()=>()=>{}}};
      function NavigationProbe(){window.pluginNavigation=usePluginSettingsRequest();return null}
      const show=id=>root.render(<React.StrictMode><ProjectFunctionConsent projectId={id} version={3}
        onReady={value=>ready.push([id,value])}/><NavigationProbe/></React.StrictMode>);
      useAppStore.setState({currentThreadId:'retained-project-thread'});
      window.fixture={calls,reads,ready,show,navigation:()=>{const s=useAppStore.getState();return {threadId:s.currentThreadId,tab:s.customizeInitialTab,pluginId:window.pluginNavigation?.pluginId}},resolve:()=>pending(),set:(id,key,value)=>{state(id)[key]=value},
        malformed:value=>{malformed=value},unsupported:()=>{delete api.approveDependency}};show('A');
    `
    }
  })
  const page = await browser.newPage(),
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const rules = page.getByRole("region", { name: "依赖功能：generic-rules", exact: true })
    const knowledge = page.getByRole("region", { name: "依赖功能：generic-knowledge", exact: true })
    await rules.waitFor()
    await page
      .getByText("主包仅需配置参数；请完成下列依赖的参数与授权。", { exact: false })
      .waitFor()
    assert.equal(
      await page.getByRole("button", { name: "允许本包在当前目录运行", exact: true }).count(),
      0
    )
    assert.equal(
      await page.evaluate("window.fixture.ready.some(([id,value])=>id==='A'&&value)"),
      false
    )
    const approveRules = rules.getByRole("button", {
      name: "允许依赖在当前目录运行：generic-rules",
      exact: true
    })
    assert(
      await approveRules.isDisabled(),
      "Missing required dependency config must block approval"
    )
    await rules.getByRole("textbox").fill("python")
    await rules.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(call=>call.kind==='config')")
    await approveRules.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(call=>call.kind==='dependency').length"),
      1
    )
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.find(call=>call.kind==='dependency')"),
      {
        kind: "dependency",
        projectId: "A",
        projectVersion: 3,
        packageDigest: "p".repeat(64),
        compiledDigest: "r".repeat(64),
        pluginId: "rules-id"
      }
    )
    assert.deepEqual(await page.evaluate("window.fixture.reads[0]"), {
      id: "A",
      pluginId: "rules-id",
      workspace: "C:/native/A"
    })
    // Do not remount externally: the actual component must fence an in-flight old project.
    await page.evaluate("window.fixture.show('B')")
    await rules.getByText("授权目录：C:/native/B", { exact: true }).waitFor()
    await page.evaluate("window.fixture.resolve()")
    assert.equal(
      await page.evaluate("window.fixture.ready.some(([id,value])=>id==='B'&&value)"),
      false
    )
    await page.evaluate("window.fixture.show('A')")
    await rules.getByText("此目录已授权当前源码版本。", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.ready.some(([id,value])=>id==='A'&&value)"),
      false
    )
    await knowledge
      .getByRole("button", { name: "允许依赖在当前目录运行：generic-knowledge", exact: true })
      .click()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForFunction("window.fixture.ready.some(([id,value])=>id==='A'&&value)")
    const settings = page.getByRole("region", { name: "本包功能权限", exact: true })
      .locator(":scope > details")
    if (!(await settings.evaluate((node) => (node as HTMLDetailsElement).open)))
      await settings.locator(":scope > summary").click()
    for (const flag of ["workspaceEnabled", "globallyEnabled"]) {
      await page.evaluate(
        (key) => window.eval(`window.fixture.set('A',${JSON.stringify(key)},false)`),
        flag
      )
      await page.getByRole("button", { name: "重新核对", exact: true }).click()
      await page.waitForFunction("window.fixture.ready.at(-1)[1]===false")
      await page
        .getByText(
          flag === "globallyEnabled"
            ? "应用插件功能已关闭。请在“插件”中开启应用功能后，返回此处重新核对。"
            : "当前目录尚未启用插件功能，请在下方确认后再执行。",
          { exact: true }
        )
        .waitFor()
      await page.evaluate(
        (key) => window.eval(`window.fixture.set('A',${JSON.stringify(key)},true)`),
        flag
      )
    }
    await page.evaluate("window.fixture.set('A','workspaceEnabled',false)")
    await page.getByRole("button", { name: "重新核对", exact: true }).click()
    await rules.getByRole("button", { name: "确认此版本并启用目录", exact: true }).click()
    await page.evaluate("window.fixture.resolve()")
    await page.getByText("项目设置 · 已就绪", { exact: true }).waitFor()
    assert.equal(
      await page
        .locator("details")
        .first()
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
      "A refreshed consent result preserves the open panel"
    )
    for (const state of ["missing", "source-changed", "invalid", "disabled"]) {
      await page.evaluate(
        (value) => window.eval(`window.fixture.set('A','rules',${JSON.stringify(value)})`),
        state
      )
      await page.getByRole("button", { name: "重新核对", exact: true }).click()
      await page.waitForFunction("window.fixture.ready.at(-1)[1]===false")
      assert.equal(await rules.getByRole("checkbox").count(), 0)
      assert.equal(
        await approveRules.count(),
        0,
        `${state} must not authorize a different or unavailable source`
      )
      const openPlugin = rules.getByRole("button", { name: "打开对应插件", exact: true })
      assert.equal(await openPlugin.count(), state === "missing" ? 0 : 1)
      if (state === "disabled") {
        await openPlugin.click()
        assert.deepEqual(
          await page.evaluate("window.fixture.navigation()"),
          {
            threadId: "retained-project-thread",
            tab: "plugins",
            pluginId: "rules-id"
          },
          "Recovery opens the exact plugin settings without changing the selected project thread"
        )
      }
    }
    for (const omitted of ["source", "dependencies"]) {
      const id = `omitted-${omitted}`
      await page.evaluate(
        ({ id, omitted }) =>
          window.eval(
            `window.fixture.set(${JSON.stringify(id)},'configured',true);window.fixture.malformed(${JSON.stringify(omitted)});window.fixture.show(${JSON.stringify(id)})`
          ),
        { id, omitted }
      )
      await rules.getByText(`授权目录：C:/native/${id}`, { exact: true }).waitFor()
      await approveRules.click()
      await page.evaluate("window.fixture.resolve()")
      await page.getByRole("alert").filter({ hasText: "授权未完成" }).waitFor()
      assert.equal(
        await page.evaluate(
          (id) =>
            window.eval(
              `window.fixture.ready.some(([projectId,value])=>projectId===${JSON.stringify(id)}&&value)`
            ),
          id
        ),
        false,
        `An approval response cannot omit ${omitted} and become legacy-ready`
      )
    }
    await page.evaluate(
      "window.fixture.malformed(undefined);window.fixture.unsupported();window.fixture.show('B')"
    )
    await rules
      .getByText("当前入口暂不支持依赖授权，请更新应用后重新核对。", { exact: true })
      .waitFor()
    assert(await approveRules.isDisabled())
    await page.evaluate("window.fixture.show('legacy')")
    await page.waitForFunction("window.fixture.ready.some(([id,value])=>id==='legacy'&&value)")
    assert.equal(await page.getByRole("region", { name: "本包功能权限", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

async function main() {
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    alias: { "@": resolve("src/renderer/src") },
    stdin: {
      loader: "tsx",
      resolveDir: resolve(__dirname, ".."),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectFunctionConsent} from './src/renderer/src/components/harness-board/ProjectFunctionConsent';
      const root=createRoot(document.getElementById('root'));let version=1,pending,epoch=0;
      const calls=[],ready=[];const review=projectId=>({projectId,projectVersion:version,packageDigest:'a'.repeat(64),workspace:'C:/private/'+projectId,
        source:{name:'actual-native-name',digest:'b'.repeat(64),state:'needs-approval',capabilities:['tool.call','fs.write'],scannedMethods:['tool.call'],scanIncomplete:false}});
      window.api={harnessBoard:{localProjects:{mods:{read:async projectId=>review(projectId),approve:input=>{calls.push(input);return new Promise(resolve=>pending=()=>resolve({...review(input.projectId),source:{...review(input.projectId).source,state:'ready'}}))}}}}};
      const show=id=>root.render(<React.StrictMode><ProjectFunctionConsent key={++epoch} projectId={id} version={version} onReady={value=>ready.push([id,value])}/></React.StrictMode>);
      window.fixture={calls,ready,show,bump:()=>{version++;show('A')},resolve:()=>pending()};show('A');
    `
    }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    const page = await browser.newPage(),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const approve = page.getByRole("button", { name: "允许本包在当前目录运行", exact: true })
    await approve.waitFor()
    assert(await approve.isEnabled())
    await page.getByText("本包插件：actual-native-name", { exact: true }).waitFor()
    assert.equal(await page.getByRole("checkbox").count(), 0)
    assert.equal(
      await page.evaluate("window.fixture.calls.length"),
      0,
      "Reading permissions does not authorize anything"
    )
    await approve.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(await page.evaluate("window.fixture.calls.length"), 1)
    await page.evaluate("window.fixture.bump()")
    await page.getByRole("button", { name: "允许本包在当前目录运行", exact: true }).waitFor()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForTimeout(80)
    assert.equal(
      await page.evaluate("window.fixture.ready.filter(([id,value])=>id==='A'&&value).length"),
      0,
      "An old version's in-flight approval cannot mark the new version ready"
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.length"),
      1,
      "A new version must wait for a new explicit approval click"
    )
    await approve.click()
    assert.deepEqual(await page.evaluate("window.fixture.calls[1]"), {
      projectId: "A",
      projectVersion: 2,
      packageDigest: "a".repeat(64),
      compiledDigest: "b".repeat(64)
    })
    await page.evaluate("window.fixture.show('B')")
    await page.getByText("授权目录：C:/private/B", { exact: true }).waitFor()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForTimeout(80)
    assert.equal(await page.getByText("此目录已授权当前源码版本。", { exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.fixture.ready.filter(([id,value])=>id==='B'&&value).length"),
      0
    )
    await approve.click()
    await page.evaluate("window.fixture.resolve()")
    await page.getByText("项目设置 · 已就绪", { exact: true }).waitFor()
    assert.equal(
      await page
        .locator("details")
        .first()
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
      "Completing consent preserves the open settings panel for further configuration"
    )
    assert.deepEqual(errors, [])
    await dependencyConsent(browser)
    console.log(
      "PASS exact native package and dependency consent, required configuration, all-ready aggregation, unavailable/source-changed denial, legacy compatibility, double-click and delayed cross-project fencing"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

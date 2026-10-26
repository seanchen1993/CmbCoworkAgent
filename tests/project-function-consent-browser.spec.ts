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
    stdin: {
      loader: "tsx",
      resolveDir: resolve(__dirname, ".."),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectFunctionConsent} from './src/renderer/src/components/harness-board/ProjectFunctionConsent';
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
          pending=()=>{state(input.projectId)[input.pluginId==='rules-id'?'rules':'knowledge']='ready';
            const result=review(input.projectId);if(malformed)delete result[malformed];resolve(result)}})}};
      window.api={harnessBoard:{localProjects:{mods:api}},mods:{onConfigurationChanged:()=>()=>{}}};
      const show=id=>root.render(<React.StrictMode><ProjectFunctionConsent projectId={id} version={3}
        onReady={value=>ready.push([id,value])}/></React.StrictMode>);
      window.fixture={calls,reads,ready,show,resolve:()=>pending(),set:(id,key,value)=>{state(id)[key]=value},
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
    await page.getByText("下列依赖功能仍需分别核对参数和授权", { exact: false }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "确认本包灵件权限", exact: true }).count(),
      0
    )
    assert.equal(
      await page.evaluate("window.fixture.ready.some(([id,value])=>id==='A'&&value)"),
      false
    )
    await rules.getByRole("checkbox").check()
    const approveRules = rules.getByRole("button", {
      name: "确认依赖权限：generic-rules",
      exact: true
    })
    assert(
      await approveRules.isDisabled(),
      "Missing required dependency config must block approval"
    )
    await rules.getByRole("textbox").fill("python")
    await rules.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(call=>call.kind==='config')")
    await rules.getByRole("checkbox").check()
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
    await knowledge.getByRole("checkbox").check()
    await knowledge
      .getByRole("button", { name: "确认依赖权限：generic-knowledge", exact: true })
      .click()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForFunction("window.fixture.ready.some(([id,value])=>id==='A'&&value)")
    for (const flag of ["workspaceEnabled", "globallyEnabled"]) {
      await page.evaluate(
        (key) => window.eval(`window.fixture.set('A',${JSON.stringify(key)},false)`),
        flag
      )
      await page.getByRole("button", { name: "重新核对本包及依赖权限", exact: true }).click()
      await page.waitForFunction("window.fixture.ready.at(-1)[1]===false")
      await page
        .getByText(
          flag === "globallyEnabled"
            ? "应用灵件功能已关闭，请在原设置中启用后重新核对。不会自动更改全局开关。"
            : "当前项目目录尚未启用灵件功能，请完成下方原生确认后再执行。",
          { exact: true }
        )
        .waitFor()
      await page.evaluate(
        (key) => window.eval(`window.fixture.set('A',${JSON.stringify(key)},true)`),
        flag
      )
    }
    for (const state of ["missing", "source-changed", "invalid", "disabled"]) {
      await page.evaluate(
        (value) => window.eval(`window.fixture.set('A','rules',${JSON.stringify(value)})`),
        state
      )
      await page.getByRole("button", { name: "重新核对本包及依赖权限", exact: true }).click()
      await page.waitForFunction("window.fixture.ready.at(-1)[1]===false")
      await page.waitForFunction(
        "!document.querySelector('[aria-label=\"依赖功能：generic-rules\"] input[type=checkbox]')"
      )
      assert.equal(
        await approveRules.count(),
        0,
        `${state} must not authorize a different or unavailable source`
      )
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
      await rules.getByRole("checkbox").check()
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
    await rules.getByRole("checkbox").check()
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
    const approve = page.getByRole("button", { name: "确认本包灵件权限", exact: true })
    await approve.waitFor()
    assert(await approve.isDisabled())
    await page.getByText("本包灵件：actual-native-name", { exact: true }).waitFor()
    await page.getByRole("checkbox").check()
    assert(await approve.isEnabled())
    await page.evaluate("window.fixture.bump()")
    await page.waitForFunction("!document.querySelector('input').checked")
    assert(
      await approve.isDisabled(),
      "New project version cannot inherit unchecked native consent"
    )
    await page.getByRole("checkbox").check()
    await approve.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(await page.evaluate("window.fixture.calls.length"), 1)
    assert.deepEqual(await page.evaluate("window.fixture.calls[0]"), {
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
    await page.getByRole("checkbox").check()
    await approve.click()
    await page.evaluate("window.fixture.resolve()")
    await page.getByText("此目录已授权当前源码版本。", { exact: true }).waitFor()
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

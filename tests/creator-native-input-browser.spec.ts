/** Real creator/native configuration cards; IPC is controlled, runtime storage has separate integration coverage. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/creator-native-input-20261017")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";import{createRoot}from"react-dom/client";
      import{ModsDevelopmentPanel}from"./src/renderer/src/components/customize/ModsDevelopmentPanel";
      const listeners=new Set(),configListeners=new Set(),calls=[];
      const request=(id,key)=>({id,workspace:"C:/creator",pluginId:"p",plugin:"知识插件",
        digest:"a".repeat(64),revision:0,key,label:key==="directory"?"知识目录":"服务密钥",
        sensitive:key==="token",type:key==="directory"?"directory":"string"});
      let configuration=request("first","directory"),sourceDigest="a".repeat(64),business,finishBusiness;
      let view={pluginId:"p",plugin:"知识插件",workspace:"C:/creator",digest:sourceDigest,
        savedRevision:0,state:"inactive",fields:[
          {key:"directory",label:"知识目录",description:"选择授权知识目录",type:"directory",supported:true,required:false,value:""},
          {key:"token",label:"服务密钥",description:"由原生表单填写，不发送给助手",type:"string",supported:true,required:false,sensitive:true,secretState:"unset"}
        ]};
      const clone=x=>structuredClone(x);
      const status=()=>({threadId:"chat",workspace:"C:/creator",enabled:true,mode:"creator",drafts:[],trials:[],configuration:clone(configuration),business:clone(business)});
      const emit=()=>listeners.forEach(fn=>fn({threadId:"chat"}));
      window.electron={process:{platform:"win32"}};
      window.api={mods:{development:{status:async()=>status(),onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        approveBusiness:async input=>{calls.push({kind:"business-install",...input});return new Promise(resolve=>finishBusiness=()=>{business.review={...business.review,phase:"installed",pluginId:"installed-id"};resolve(status())})},
        exportBusiness:async input=>{calls.push({kind:"business-export",...input});business.review={...business.review,phase:"exported",output:"C:/exports/warehouse.zip"};return status()}
      },
        userConfig:async()=>({...clone(view),digest:sourceDigest}),
        onConfigurationChanged:fn=>{configListeners.add(fn);return()=>configListeners.delete(fn)},
        pickUserConfigPath:async(thread,current,key)=>{calls.push({kind:"pick",thread,key,digest:current.digest});return "C:/authorized/knowledge"},
        saveUserConfig:async(thread,current,key,value)=>{calls.push({kind:"save",thread,key,value});view={...view,savedRevision:view.savedRevision+1,state:"pending",fields:view.fields.map(f=>f.key===key?{...f,value}:f)};return clone(view)},
        saveSensitiveUserConfig:async(thread,current,key,action)=>{calls.push({kind:"native-secret",thread,key,operation:action.operation});view={...view,savedRevision:view.savedRevision+1,state:"pending",fields:view.fields.map(f=>f.key===key?{...f,secretState:"saved"}:f)};return clone(view)}
      }};
      window.fixture={calls,secret:()=>{configuration=request("second","token");emit()},
        stale:()=>{sourceDigest="b".repeat(64);configuration=request("third","token");emit()},
        business:(phase,exportOnly=false)=>{configuration=undefined;business={drafts:[],review:{planId:"business-plan",phase,name:"数仓独立插件",version:"1.0.0",digest:"c".repeat(64),copyId:"warehouse-copy",steps:[{id:"model",title:"数仓建模",sourceName:"autobiz-model"}],extensions:[{id:"progress",title:"工作树进度",sourceName:"custom-progress"}],diagnostics:[],exportOnly,canConfirm:["needs-approval","installed","exported"].includes(phase)}};emit()},
        finishBusiness:()=>finishBusiness()};
      createRoot(document.getElementById("root")).render(<ModsDevelopmentPanel threadId="chat" workspaceHint="C:/creator" mode="chat"/>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    plugins: [browserWorkerPlugin()],
    alias: { "@": resolve(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".md": "text", ".png": "dataurl" }
  })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("article", { name: "插件参数填写请求" }).waitFor()
    await page.getByLabel("知识目录", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("服务密钥", { exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.fixture.calls.length"), 0)
    await page.getByRole("button", { name: "选择目录", exact: true }).click()
    assert.equal(await page.getByLabel("知识目录", { exact: true }).inputValue(), "C:/authorized/knowledge")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "已保存，等待应用到当前聊天" }).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(x=>x.kind==='save').length"), 1)
    await page.evaluate("window.fixture.secret()")
    const secret = page.getByLabel("服务密钥", { exact: true })
    await secret.waitFor()
    assert.equal(await secret.getAttribute("type"), "password")
    await secret.fill("only-the-native-editor-sees-this")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(x=>x.kind==='native-secret')")
    assert.equal(await page.evaluate("JSON.stringify(window.fixture.calls).includes('only-the-native-editor-sees-this')"), false)
    await page.evaluate("window.fixture.stale()")
    await page.getByRole("alert").filter({ hasText: "MODS_CONFIG_SOURCE_CHANGED" }).waitFor()
    assert.equal(await page.getByLabel("服务密钥", { exact: true }).count(), 0)
    await page.evaluate("window.fixture.business('needs-review')")
    await page.getByRole("button", { name: "3 · 保存插件", exact: true }).click()
    const install = page.getByRole("button", { name: "保存插件", exact: true })
    const exportButton = page.getByRole("button", { name: "导出插件包…", exact: true })
    await page.getByRole("article", { name: "业务插件组装确认" }).waitFor()
    assert.equal(await install.isEnabled(), false)
    await page.evaluate("window.fixture.business('needs-approval')")
    await page.waitForFunction("[...document.querySelectorAll('button')].some(b=>b.textContent==='保存插件'&&!b.disabled)")
    await install.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    assert.equal(await page.evaluate("window.fixture.calls.filter(x=>x.kind==='business-install').length"), 1)
    assert.deepEqual(await page.evaluate("window.fixture.calls.find(x=>x.kind==='business-install')"), {
      kind: "business-install", threadId: "chat", expectedWorkspace: "C:/creator",
      planId: "business-plan", digest: "c".repeat(64)
    })
    assert.equal(await exportButton.isEnabled(), false)
    await page.evaluate("window.fixture.finishBusiness()")
    await page.getByRole("status").filter({ hasText: "插件已保存" }).waitFor()
    await exportButton.click()
    await page.getByText("导出位置：C:/exports/warehouse.zip", { exact: true }).waitFor()
    await page.evaluate("window.fixture.business('unknown')")
    await page.getByRole("status").filter({ hasText: "操作结果未确认" }).waitFor()
    assert.equal(await install.isEnabled(), false)
    assert.equal(await exportButton.isEnabled(), false)
    await page.evaluate("window.fixture.business('needs-approval',true)")
    await page.getByText("导出后，在安装插件入口更新。", { exact: true }).waitFor()
    assert.equal(await install.count(), 0)
    const updateExport = page.getByRole("button", { name: "导出更新包…", exact: true })
    assert.equal(await updateExport.isEnabled(), true)
    await updateExport.click()
    assert.equal(await page.evaluate("window.fixture.calls.filter(x=>x.kind==='business-install').length"), 1)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "stale-source-refused.png"), fullPage: true })
    console.log("PASS creator native input card, focused path/secret flow, stale-source refusal and exact native business install/export with unknown/double-submit fencing")
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

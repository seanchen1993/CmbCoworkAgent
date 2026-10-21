/** Real Claw editor/creator entry/navigation; unrelated host APIs are controlled read fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/mods-claw-draft-retention", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ClawPanel} from '@/components/customize/ClawPanel';
      import {enterCreatorMode} from '@/components/customize/creator-mode-entry';
      import {goToConfigurationThread,captureConfigurationScope} from '@/lib/configuration-target';
      import {useAppStore} from '@/lib/store';
      const calls=[];let enabled=true,hold=false,finish;
      const current=()=>useAppStore.getState();
      const view=id=>({workspace:id,revision:0,bindingRevision:0,active:null,profiles:[],
        enabled,applicable:true,issues:[],capabilities:[]});
      window.api={mods:{globalEnabled:async()=>true,status:async id=>({workspace:id,enabled:true}),
        development:{setMode:async input=>{calls.push(['mode',input]);return {
          threadId:input.threadId,workspace:input.expectedWorkspace,enabled:true,mode:'creator'}}},
        clawView:async id=>{calls.push(['view',id,enabled]);if(hold){hold=false;await new Promise(done=>finish=done)}return view(id)},
        flowCatalog:async id=>{calls.push(['catalog',id]);return {available:true,hostAvailable:true,plugins:[],models:[],actions:[]}},
        flowList:async()=>[],clawSources:async()=>({skills:[],mcp:[]}),onConfigurationChanged:()=>()=>{},
        clawChange:async()=>{throw Error('Unexpected business mutation')},flowSave:async()=>{throw Error('Unexpected flow save')}}};
      function Fixture(){const visible=useAppStore(s=>s.showCustomizeView);const id=useAppStore(s=>s.currentThreadId);
        return <><textarea aria-label='原聊天草稿' defaultValue='原来的未发送任务'/>
          <button onClick={()=>current().setShowCustomizeView(true)}>打开配置</button>
          {visible&&<><button onClick={()=>goToConfigurationThread({threadId:id,workspace:id})}>关闭配置</button>
            <button onClick={async()=>{const scope={threadId:id,workspace:id};const isCurrent=captureConfigurationScope(scope);
              await enterCreatorMode(window.api.mods,window.api.mods.development,id,id,()=>{if(!isCurrent())throw Error('stale')});
              goToConfigurationThread(scope)}}>创造者交接</button>
            <ClawPanel threadId={id} workspaceHint={id}/></>}</>}
      window.drafts={calls,enabled:value=>enabled=value,hold:()=>hold=true,pending:()=>typeof finish==='function',finish:()=>finish(),
        patch:patch=>useAppStore.setState(patch)};
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": renderer },
    plugins: [
      {
        name: "unrelated-host-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "draft-fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "draft-fixture" }, () => ({
            resolveDir: process.cwd(),
            contents: `import {useSyncExternalStore} from 'react';const listeners=new Set();
          let state={accountRevision:0,currentThreadId:'a',showCustomizeView:true,
            threads:['a','b'].map(id=>({thread_id:id,metadata:{workspacePath:id,agentMode:'normal'}})),
            setShowCustomizeView:value=>useAppStore.setState({showCustomizeView:value})};
          export const useAppStore=selector=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>selector(state));
          useAppStore.getState=()=>state;useAppStore.setState=patch=>{const previous=state;state={...state,...patch};for(const listener of listeners)listener(state,previous)};
          useAppStore.subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
          export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
          }))
          builder.onResolve(
            { filter: /^\.\/(NativePluginCapabilities|BusinessModAssemblyPanel)$/ },
            (args) =>
              args.importer.endsWith("ClawPanel.tsx")
                ? { path: args.path.slice(2), namespace: "draft-panel" }
                : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "draft-panel" }, (args) => ({
            contents: `export const ${args.path}=()=>null`
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10_000)
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const name = page
      .getByRole("region", { name: "简单组合", exact: true })
      .getByLabel("组合名称", { exact: true })
    await name.fill("我的未保存搭配")
    await page.getByRole("button", { name: "创造者交接", exact: true }).click()
    await page.getByRole("button", { name: "关闭配置", exact: true }).waitFor({ state: "detached" })
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天草稿" }).inputValue(),
      "原来的未发送任务"
    )
    await page.getByRole("button", { name: "打开配置", exact: true }).click()
    await name.waitFor()
    assert.equal(await name.inputValue(), "我的未保存搭配")
    assert.deepEqual(
      await page.evaluate(() =>
        (
          window as unknown as {
            drafts: { calls: unknown[][] }
          }
        ).drafts.calls.filter(([kind]) => kind === "mode")
      ),
      [
        [
          "mode",
          {
            threadId: "a",
            expectedWorkspace: "a",
            mode: "creator"
          }
        ]
      ]
    )
    // A restored draft must wait for a new host read and obey that read's revoked permission.
    await page.getByRole("button", { name: "关闭配置", exact: true }).click()
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { drafts: { enabled(value: boolean): void; hold(): void } }
      ).drafts
      fixture.enabled(false)
      fixture.hold()
    })
    await page.getByRole("button", { name: "打开配置", exact: true }).click()
    assert.equal(await name.count(), 0)
    await page.waitForFunction(() =>
      (window as unknown as { drafts: { pending(): boolean } }).drafts.pending()
    )
    await page.evaluate(() => (window as unknown as { drafts: { finish(): void } }).drafts.finish())
    await name.waitFor()
    assert.equal(await name.inputValue(), "我的未保存搭配")
    assert.equal(await name.isDisabled(), true)
    await page.evaluate(() =>
      (window as unknown as { drafts: { patch(value: unknown): void } }).drafts.patch({
        currentThreadId: "b"
      })
    )
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('section[aria-label="简单组合"] input')?.value ===
        "我的研发助手"
    )
    assert.notEqual(await name.inputValue(), "我的未保存搭配")
    await page.evaluate(() =>
      (window as unknown as { drafts: { patch(value: unknown): void } }).drafts.patch({
        currentThreadId: "a",
        accountRevision: 1
      })
    )
    await page.waitForFunction(() =>
      document.querySelector("[data-claw-settings]")?.textContent?.includes("目录：a")
    )
    assert.notEqual(await name.inputValue(), "我的未保存搭配")
    const calls = await page.evaluate(
      () => (window as unknown as { drafts: { calls: unknown[][] } }).drafts.calls
    )
    assert.equal(calls.filter(([kind, id]) => kind === "view" && id === "a").length, 4)
    assert.equal(calls.filter(([kind, id]) => kind === "catalog" && id === "a").length, 4)
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          calls,
          errors,
          scope:
            "Real ClawPanel mount/unmount and creator entry; fixture host view/catalog reads and account/thread transitions; no production IPC or model"
        },
        null,
        2
      )
    )
    console.log(
      `PASS Claw draft retention, fresh permission reads and account/thread isolation: ${output}`
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

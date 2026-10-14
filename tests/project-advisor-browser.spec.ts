import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve } from "node:path"

interface AdvisorCancellationWindow {
  fixture: { calls: string[]; settle(): void; show(visible: boolean): void }
}
interface AdvisorRefreshWindow {
  fixture: { calls: string[]; hold(): void; finish(): void }
}

async function main() {
  const bundled = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' },
    stdin: { loader: "tsx", resolveDir: resolve(__dirname, ".."), contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BuiltinProjectAdvisor} from './src/renderer/src/components/chat/BuiltinProjectAdvisor';
      const root=createRoot(document.getElementById('root'));
      let enabled=false,running=false,pending,stop;const calls=[];
      const view=()=>({enabled,running,nextAllowedAt:0,dailyLimit:10,outputTokenLimit:512});
      window.api={mods:{builtinAdvisor:async(id,ws,kind)=>{
        calls.push(kind);
        if(kind==='enable')enabled=true;
        if(kind==='disable')enabled=false;
        if(kind==='analyze'){running=true;return new Promise(resolve=>pending=resolve)}
        if((kind==='cancel'||kind==='disable')&&running){return new Promise(resolve=>stop=()=>{
          running=false;pending({...view(),result:{text:'late ignored result',at:1}});resolve(view());
        })}
        return view();
      }}};
      window.fixture={calls,settle:()=>stop(),show:visible=>root.render(
        <BuiltinProjectAdvisor threadId='t' workspace='w' visible={visible}/>)};
      window.fixture.show(true);
    ` } })
  let browser
  try { browser = await chromium.launch({ headless: true }) }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge" }) }
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByText("智能建议 · 可选", { exact: true }).click()
    await page.getByRole("checkbox").check()
    const analyze = page.getByRole("button", { name: "分析已有记录", exact: true })
    await analyze.click()
    await page.getByRole("button", { name: "停止分析", exact: true }).dblclick()
    assert.equal(await page.getByRole("button", { name: "正在分析…", exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => (window as unknown as AdvisorCancellationWindow).fixture.calls.filter(x => x === "cancel").length), 1)
    await page.evaluate(() => (window as unknown as AdvisorCancellationWindow).fixture.settle())
    await analyze.waitFor()
    assert.equal(await analyze.isEnabled(), true)
    assert.equal(await page.getByText("late ignored result", { exact: true }).count(), 0)
    await analyze.click()
    await page.getByRole("checkbox").click()
    await page.evaluate(() => (window as unknown as AdvisorCancellationWindow).fixture.settle())
    await page.getByRole("checkbox").waitFor()
    assert.equal(await analyze.count(), 0)
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    assert.deepEqual(errors, [])
    console.log("PASS advisor browser: cancel waits for settlement, duplicate cancel blocked, late result ignored, disable stops active analysis")
    const parentBundle = await build({ write: false, bundle: true, platform: "browser", format: "iife",
      jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' },
      stdin: { loader: "tsx", resolveDir: resolve(__dirname, ".."), contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {BuiltinRunOverview} from './src/renderer/src/components/chat/BuiltinRunOverview';
        let revision=1,enabled=false,result,hold=false,finish;const calls=[];
        const view=()=>({enabled,running:false,nextAllowedAt:0,dailyLimit:10,outputTokenLimit:512,...(result?{result}:{})});
        window.api={mods:{builtinOverview:async()=>({threadId:'t',workspace:'w',capturedAt:revision++,
          instructions:{status:'unknown',message:'没有来源'},policy:{required:false,blockedTools:[],recordedBlocks:0,explanation:'原审批'},
          metrics:{sampled:0,succeeded:0,failed:0,running:0,unknown:0,inputTokens:null,outputTokens:null,limited:false,explanation:'已有记录'},suggestions:[]}),
          builtinAdvisor:async(id,ws,kind)=>{calls.push(kind);if(kind==='enable')enabled=true;
            if(kind==='analyze')result={text:'旧阶段建议',at:1};
            if(kind==='view'&&hold)return new Promise(resolve=>finish=()=>{result=undefined;resolve(view())});
            return view();}}};
        window.fixture={calls,hold:()=>hold=true,finish:()=>{hold=false;finish()}};
        createRoot(document.getElementById('root')).render(<BuiltinRunOverview threadId='t' workspace='w' visible={true}/>);
      ` } })
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: parentBundle.outputFiles[0].text })
    await page.getByText("智能建议 · 可选", { exact: true }).click()
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "分析已有记录", exact: true }).click()
    await page.getByText("旧阶段建议", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as AdvisorRefreshWindow).fixture.hold())
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.getByText("旧阶段建议", { exact: true }).waitFor({ state: "detached" })
    assert.equal(await page.getByRole("checkbox").isChecked(), true, "Refresh preserves enabled preference")
    await page.waitForFunction(() => (window as unknown as AdvisorRefreshWindow).fixture.calls.filter(x => x === "view").length === 2)
    assert.equal(await page.evaluate(() => (window as unknown as AdvisorRefreshWindow).fixture.calls.filter(x => x === "cancel").length), 1)
    assert.equal(await page.evaluate(() => (window as unknown as AdvisorRefreshWindow).fixture.calls.filter(x => x === "analyze").length), 1)
    await page.evaluate(() => (window as unknown as AdvisorRefreshWindow).fixture.finish())
    await page.getByRole("button", { name: "分析已有记录", exact: true }).waitFor()
    assert.equal(await page.getByText("旧阶段建议", { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as unknown as AdvisorRefreshWindow).fixture.calls.filter(x => x === "analyze").length), 1)
    assert.deepEqual(errors, [])
    console.log("PASS actual overview refresh hides old advice before delayed view, retains enable, cancels prior analysis and does not invoke model")
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

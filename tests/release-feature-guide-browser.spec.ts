import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { releaseGuideConfig } from "../src/renderer/src/components/guides/release-guide-content"

async function main() {
  assert.notEqual(releaseGuideConfig("2.0.0").guideId, releaseGuideConfig("2.1.0").guideId)
  const output = resolve("output/release-feature-guide-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const cssPath = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => undefined
  })
  const css = compiler.build(
    new Scanner({}).scanFiles(
      [
        "components/guides/ReleaseFeatureGuide.tsx",
        "components/guides/AnchoredGuide.tsx",
        "components/ui/button.tsx",
        "components/ui/popover.tsx"
      ].map((path) => ({ content: readFileSync(join(renderer, path), "utf8"), extension: "tsx" }))
    )
  )
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{ReleaseFeatureGuide}from'@/components/guides/ReleaseFeatureGuide';
      import{openApplicationUsageGuide}from'@/components/guides/application-usage-guide';
      import{useAppStore}from'@/lib/store';
      import{hasOpenModalDialog}from'@/lib/modal-dialog';window.hasOpenModalDialog=hasOpenModalDialog;
      window.calls=[];window.guideReads=0;window.claims=0;const records=new Map();
      window.api={uiGuides:{getState:async c=>{window.guideReads++;const k=c.guideId+':'+c.revision;if(!records.has(k))records.set(k,{shown:0,ack:false});const r=records.get(k);return{shouldShow:!r.ack&&r.shown<1}},recordDisplay:async c=>{const k=c.guideId+':'+c.revision;const r=records.get(k)||{shown:0,ack:false};records.set(k,r);if(r.ack||r.shown>=1)return false;r.shown++;window.claims++;return true},acknowledge:async c=>{records.get(c.guideId+':'+c.revision).ack=true}}};
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text}}});
      function Fixture(){const s=useAppStore(s=>s);const[blocked,setBlocked]=useState(true);const[epoch,setEpoch]=useState(0);window.remount=()=>setEpoch(x=>x+1);return <>
        {blocked&&<div role="dialog" aria-label="已有对话框"><button onClick={()=>setBlocked(false)}>关闭已有对话框</button></div>}
        <button id="help" onClick={openApplicationUsageGuide}>新功能指南</button>
        <button style={{position:'fixed',right:8,top:8}} onClick={()=>{s.setShowCustomizeView(false);s.setMainView('market')}}>切换到市场</button>
        <div style={{padding:80}}>
          {s.showCustomizeView?<><h1 data-release-guide={s.customizeInitialTab==='mods'?'mods':s.customizeInitialTab==='plugins'?'plugins':'tools'}>设置页</h1>{s.customizeInitialTab==='mods'&&<button data-release-guide="creator-entry" onClick={()=>window.calls.push('business')}>进入创造者模式</button>}</>:<>
            <div hidden={s.mainView!=='thread'}><textarea className="composer-textarea" aria-label="聊天草稿" defaultValue="保留我的草稿"/><button data-app-guide="workspace" onClick={()=>window.calls.push('business')}>工作区</button><button data-app-guide="progress" onClick={()=>window.calls.push('business')}>任务进展</button></div>
            <main hidden={s.mainView!=='harness'} data-release-guide="project" style={{height:'100vh'}}>原项目页面</main>
            <main hidden={s.mainView!=='market'} data-release-guide="market">应用市场</main>
          </>}
        </div><ReleaseFeatureGuide key={epoch} active/>
      </>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl" },
    define: { __APP_VERSION__: '"2.0.0"' },
    plugins: [
      {
        name: "guide-store",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "guide"
          }))
          builder.onLoad({ filter: /.*/, namespace: "guide" }, () => ({
            resolveDir: process.cwd(),
            contents: `
        import{useSyncExternalStore}from'react';const listeners=new Set();let state={accountRevision:0,mainView:'thread',showCustomizeView:false};
        const update=value=>{state={...state,...value};for(const fn of listeners)fn()};
        Object.assign(state,{setShowCustomizeView:(show,tab,section)=>update({showCustomizeView:show,customizeInitialTab:tab,customizeInitialSection:section}),setMainView:view=>update({mainView:view}),setShowHarnessBoardView:show=>update({mainView:show?'harness':'thread'})});
        export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));useAppStore.getState=()=>state;
      `
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<meta charset="utf-8"><div id="root"></div>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const intro = page.getByRole("dialog", { name: "把助手变成适合你的工作台" })
    await page.waitForFunction("window.guideReads>0")
    assert.equal(await intro.count(), 0, "Wait for existing dialogs")
    await page.getByRole("button", { name: "关闭已有对话框" }).click()
    await intro.waitFor()
    await page.waitForFunction("window.claims===1")
    assert.equal(
      await page.evaluate("window.hasOpenModalDialog()"),
      true,
      "Hide native browser surfaces behind the introduction"
    )
    assert.equal(await intro.locator("img").count(), 2)
    await page.waitForFunction(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0)
    )
    await page.screenshot({ path: join(output, "release-overview.png") })
    await intro.getByRole("button", { name: "复制这段需求" }).click()
    assert.match(await page.evaluate("window.copied"), /天气、时间和 Token/)
    assert.equal(await page.getByLabel("聊天草稿").inputValue(), "保留我的草稿")
    await intro.getByRole("button", { name: /^放大.*应用后的界面/ }).click()
    await page.getByRole("button", { name: "关闭示例大图" }).waitFor()
    await page.keyboard.press("Escape")
    await intro.waitFor()
    await intro.getByRole("button", { name: "2. 给已有项目插件加一个步骤" }).click()
    await intro.getByText(/已有特性继续使用原绑定版本/).waitFor()
    await page.screenshot({ path: join(output, "project-example.png") })
    await intro.getByRole("button", { name: "先自己试试" }).click()
    await page.evaluate("window.remount()")
    await page.waitForFunction("window.guideReads>=3")
    assert.equal(await intro.count(), 0, "Do not reopen after remount")
    assert.equal(await page.evaluate("window.hasOpenModalDialog()"), false)
    assert.equal(await page.evaluate("window.claims"), 1, "StrictMode claims once")
    await page.getByRole("button", { name: "新功能指南", exact: true }).click()
    await intro.waitFor()
    await intro.getByRole("button", { name: "带我走一遍" }).click()
    const tour = page.locator('[role="dialog"][aria-label="新功能操作指引"]')
    for (const [index, id] of [
      "mods",
      "creator",
      "composer",
      "workspace",
      "progress",
      "plugins",
      "project",
      "market",
      "tools"
    ].entries()) {
      await page.locator(`[data-ui-guide-current="${id}"]`).waitFor()
      await tour.waitFor()
      const nextButton = tour.getByRole("button", {
        name: index === 8 ? "完成指引" : "下一步",
        exact: true
      })
      const buttonBounds = await nextButton.boundingBox()
      assert(
        buttonBounds && buttonBounds.y >= 0 && buttonBounds.y + buttonBounds.height <= 850,
        `Visible next button at ${id}`
      )
      assert.equal(await tour.getByRole("status").count(), 0, `Visible anchor for ${id}`)
      if (index < 8) await tour.getByRole("button", { name: "下一步", exact: true }).click()
    }
    await tour.getByRole("button", { name: "完成指引" }).click()
    await page.getByRole("button", { name: "新功能指南", exact: true }).click()
    await page.setViewportSize({ width: 390, height: 740 })
    await intro.waitFor()
    const bounds = await intro.boundingBox()
    assert(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 390 &&
        bounds.y + bounds.height <= 740
    )
    await page.screenshot({ path: join(output, "narrow-overview.png") })
    await intro.getByRole("button", { name: /^试用与保存/ }).click()
    await page.locator('[data-ui-guide-current="workspace"]').waitFor()
    await page.locator('[data-app-guide="workspace"]').evaluate((node) => node.remove())
    await tour
      .getByRole("status")
      .getByText(/先进入创造者模式并生成候选/)
      .waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "重新打开新功能指南", exact: true }).click()
    await intro.waitFor()
    await page.setViewportSize({ width: 1280, height: 850 })
    for (const title of [
      "认识灵件",
      "用对话创造功能",
      "试用与保存",
      "导入现成插件",
      "调整项目流程",
      "分享与复用",
      "连接外部工具",
      "查看执行结果"
    ]) {
      await intro.getByRole("button", { name: new RegExp(`^${title}`) }).click()
      await tour.waitFor()
      await page.getByRole("button", { name: "切换到市场", exact: true }).click()
      assert.equal(
        await tour.isVisible(),
        true,
        `${title}: outside navigation must not dismiss the guide`
      )
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await tour.waitFor({ state: "hidden" })
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await tour.waitFor()
      await tour.getByRole("button", { name: "返回功能目录", exact: true }).click()
      await intro.waitFor()
      const heading = intro.getByRole("heading", { name: "想了解哪一块？直接带你到对应位置" })
      await heading.waitFor()
      assert.equal(await heading.evaluate((node) => document.activeElement === node), true)
    }
    await intro.getByRole("button", { name: /^调整项目流程/ }).click()
    await tour.getByRole("button", { name: "关闭使用指引", exact: true }).click()
    await page.getByRole("button", { name: "重新打开新功能指南", exact: true }).click()
    await intro.waitFor()
    await page.screenshot({ path: join(output, "reopened-after-module-navigation.png") })
    assert.deepEqual(await page.evaluate("window.calls"), [], "No business actions")
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        { passed: true, automaticClaims: 1, anchors: 9, examples: 2, businessActions: 0, errors },
        null,
        2
      )
    )
    console.log(`Release introduction regression passed: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

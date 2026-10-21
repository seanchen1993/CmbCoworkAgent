import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/creator-workspace-guide-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {ModsDevelopmentPanel} from "./src/renderer/src/components/customize/ModsDevelopmentPanel";
      import {AnchoredGuide} from "./src/renderer/src/components/guides/AnchoredGuide";
      const calls=[],listeners=new Set();
      const current={threadId:"creator",workspace:"C:/guide",enabled:true,mode:"creator",drafts:[],trials:[],
        projectTrial:{id:"request",draftId:"draft",name:"两阶段审查",revision:1,digest:"a".repeat(64),goal:"审查文件"}};
      const business=(name)=>async()=>{calls.push(["business",name]);throw Error("A guide must not execute "+name)};
      const development={status:async()=>structuredClone(current),onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        setMode:business("mode"),approveBusiness:business("install"),requestTrial:business("trial")};
      const configKey=c=>"fixture-guide:"+c.guideId+":"+c.revision;
      const state=c=>JSON.parse(localStorage.getItem(configKey(c))||'{"shownCount":0,"acknowledged":false}');
      const write=(c,s)=>localStorage.setItem(configKey(c),JSON.stringify(s));
      const uiGuides={getState:async c=>{const s=state(c);calls.push(["guide-read",c]);write(c,s);return {...s,shouldShow:!s.acknowledged&&s.shownCount<c.maxShowCount}},
        recordDisplay:async c=>{const s=state(c);calls.push(["guide-display",c]);if(s.acknowledged||s.shownCount>=c.maxShowCount)return false;s.shownCount++;write(c,s);return true},
        acknowledge:async c=>{const s=state(c);s.acknowledged=true;write(c,s);calls.push(["guide-close",c])}};
      const preview={list:async threadId=>{calls.push(["preview-read"]);return {threadId,workspace:"C:/guide",drafts:[]}},
        stageDebug:{list:async()=>{calls.push(["debug-read"]);return {snapshots:[],branches:[],diagnostics:[]}},
          prepare:business("debug-prepare"),create:business("debug-create")},create:business("project-create"),finish:business("finish")};
      window.api={uiGuides,mods:{development,globalEnabled:async()=>true,status:async()=>({workspace:"C:/guide",enabled:true,outputPolicy:true,mods:[],diagnostics:[]})},
        harnessBoard:{localProjects:{preview}}};
      const root=createRoot(document.getElementById("root"));
      const render=(thread="creator")=>root.render(<React.StrictMode><ModsDevelopmentPanel key={thread} threadId={thread}
        workspaceHint="C:/guide" mode="chat" api={{...development,status:async()=>({...structuredClone(current),threadId:thread})}}
        onReturnToChat={()=>document.getElementById("composer").focus()}/></React.StrictMode>);
      const visibilityConfig={guideId:"creator-guide-visibility-check",revision:1,maxShowCount:1};
      const visibilitySteps=[{id:"visible",title:"工作区可操作后显示",description:"被其他导览遮盖时等待，不消耗首次展示。",selectors:['[data-visible-target]']}];
      function CoveredGuide(){const ref=React.useRef(null);React.useEffect(()=>{document.getElementById('covered').dataset.ready='true'},[]);
        return <div id="covered" inert aria-hidden="true"><section ref={ref}><h2 data-visible-target>被遮盖的工作区</h2>
          <AnchoredGuide active config={visibilityConfig} rootRef={ref} steps={visibilitySteps}/></section></div>}
      window.fixture={calls,render,covered:()=>root.render(<React.StrictMode><CoveredGuide/></React.StrictMode>),state:()=>state({guideId:"mods-creator-workspace-stage-debug",revision:1}),
        noPreview:()=>{delete window.api.harnessBoard.localProjects.preview;render()}};
      render();
    `
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    write: false,
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    target: "chrome130",
    logLevel: "warning"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("Guide fixture page error:", error.message)
    })
    await page.route("http://creator-guide.fixture/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><meta charset="utf-8"><textarea id="composer"></textarea><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    const load = async () => {
      await page.goto("http://creator-guide.fixture")
      for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
        await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    }
    await load()
    const workspace = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    const guide = page.locator('[aria-label="插件创作使用指引"]')
    // A native candidate opens its workspace; the first-use guide starts without a help click.
    await workspace.waitFor()
    try {
      await guide.getByRole("heading", { name: "一个聊天，完成插件创作" }).waitFor()
    } catch (error) {
      await page.screenshot({ path: join(output, "first-guide-failure.png") })
      console.error(await page.locator("body").innerText())
      console.error(
        await page.evaluate(
          "JSON.stringify({calls:window.fixture?.calls,highlight:document.querySelector('[data-ui-guide-current]')?.outerHTML.slice(0,1500),popover:document.querySelector('[data-slot=popover-content]')?.outerHTML.slice(0,1500)})"
        )
      )
      throw error
    }
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { state(): { shownCount: number } } }).fixture.state()
          .shownCount === 1
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='guide-display').length"),
      1,
      "StrictMode must not consume the first-use display twice"
    )
    const ids = ["overview", "create", "trial", "acceptance", "debug", "delivery", "components"]
    for (const [index, id] of ids.entries()) {
      await guide.getByText(`第 ${index + 1} / 7 步`, { exact: true }).waitFor()
      await page.locator(`[data-ui-guide-current="${id}"]`).waitFor({ state: "visible" })
      const bounds = await guide.boundingBox()
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 1280 &&
          bounds.y + bounds.height <= 900,
        "Anchored help must remain inside the viewport"
      )
      if (id === "debug") {
        await workspace.getByRole("region", { name: "阶段隔离调试", exact: true }).waitFor()
        assert.equal(
          await page.evaluate("window.fixture.calls.some(row=>row[0]==='debug-read')"),
          true
        )
        await page.screenshot({ path: join(output, "stage-debug-guide.png") })
      }
      if (index < ids.length - 1)
        await guide.getByRole("button", { name: "下一步", exact: true }).click()
    }
    await guide.getByRole("button", { name: "上一步", exact: true }).click()
    await guide.getByText("第 6 / 7 步", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "下一步", exact: true }).click()
    await guide.getByRole("button", { name: "完成指引", exact: true }).click()
    await guide.waitFor({ state: "hidden" })
    await workspace.waitFor()
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    await guide.getByText("第 1 / 7 步", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    await guide.waitFor({ state: "hidden" })
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    await guide.getByRole("button", { name: "关闭使用指引", exact: true }).click()
    await guide.waitFor({ state: "hidden" })
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    await page.keyboard.press("Escape")
    await guide.waitFor({ state: "hidden" })
    assert.equal(await workspace.isVisible(), true, "Escape closes the help, not its workspace")
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='business')"),
      []
    )
    await load()
    await workspace.waitFor()
    assert.equal(
      await guide.count(),
      0,
      "A completed/skipped guide must not automatically reopen after reload"
    )
    await workspace.getByRole("button", { name: "Close", exact: true }).click()
    await workspace.waitFor({ state: "hidden" })
    // Chat help now opens the application controls walkthrough, not this workspace.
    await page.locator('[data-app-guide="workspace"]').click()
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    await guide.getByText("第 1 / 7 步", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "关闭使用指引", exact: true }).click()
    await page.setViewportSize({ width: 390, height: 740 })
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    await guide.getByText("第 1 / 7 步", { exact: true }).waitFor()
    const mobile = await guide.boundingBox()
    assert(
      mobile &&
        mobile.x >= 0 &&
        mobile.y >= 0 &&
        mobile.x + mobile.width <= 390 &&
        mobile.y + mobile.height <= 740
    )
    await page.screenshot({ path: join(output, "mobile-guide.png") })
    await guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    await page.evaluate("window.fixture.noPreview()")
    await workspace.getByRole("button", { name: "使用指引", exact: true }).click()
    for (let index = 0; index < 4; index++)
      await guide.getByRole("button", { name: "下一步", exact: true }).click()
    await guide.getByRole("heading", { name: "从阶段快照隔离调试" }).waitFor()
    assert.match(
      await page.locator('[data-ui-guide-current="debug"]').innerText(),
      /高级：独立项目试用/
    )
    await page.evaluate("window.fixture.render('other')")
    await guide.waitFor({ state: "hidden" })
    await page.evaluate("window.fixture.covered()")
    await page.locator('#covered[data-ready="true"]').waitFor({ state: "attached" })
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(row=>row[0]==='guide-display'&&row[1].guideId==='creator-guide-visibility-check').length"
      ),
      0,
      "An inert workspace behind another onboarding surface must not consume first use"
    )
    await page.locator("#covered").evaluate((element) => {
      element.removeAttribute("inert")
      element.removeAttribute("aria-hidden")
    })
    await guide.getByRole("heading", { name: "工作区可操作后显示" }).waitFor()
    await guide.getByRole("button", { name: "完成指引", exact: true }).click()
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='business')"),
      []
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS creator anchored guide: first use, seven real destinations, stage disclosure, back/skip/close/Escape, reload persistence, manual reopen and mobile; no business actions"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

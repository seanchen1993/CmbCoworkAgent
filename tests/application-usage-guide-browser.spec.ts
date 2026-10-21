import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

interface GuideFixtureWindow {
  updateGuideScope(value: unknown): void
  guideUsage: { shown: number }
}

async function main() {
  const output = resolve("output/application-usage-guide-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const cssPath = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles(
    ["components/guides/AnchoredGuide.tsx", "components/ui/popover.tsx"].map((path) => ({
      content: readFileSync(join(renderer, path), "utf8"),
      extension: "tsx"
    }))
  )
  const css = compiler.build(candidates)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ApplicationUsageGuide} from './src/renderer/src/components/guides/ApplicationUsageGuide';
      import {openApplicationUsageGuide} from './src/renderer/src/components/guides/application-usage-guide';
      window.calls=[];const business=name=>()=>window.calls.push(['business',name]);
      window.guideUsage={shown:0,acknowledged:false,reads:0};
      window.api={uiGuides:{recordDisplay:async()=>{const s=window.guideUsage;if(s.acknowledged||s.shown>=1)return false;s.shown++;return true},
        getState:async()=>{const s=window.guideUsage;s.reads++;return {shouldShow:!s.acknowledged&&s.shown<1}},
        acknowledge:async()=>{window.guideUsage.acknowledged=true}}};
      function Fixture(){return <><header style={{height:100}}>
        <button data-app-guide="navigation" onClick={business('navigation')}>导航 icon</button>
        <nav id="navigation" hidden><button data-app-guide="customize" onClick={business('settings')}>自定义助手 icon</button></nav>
      </header><div inert><button data-app-guide="creator">隐藏旧聊天</button></div>
      <main style={{height:400,overflow:'auto'}} id="scroll" data-chat-thread-id="local"><div style={{height:550}}/>
        <button data-app-guide="creator" aria-pressed="false" onClick={business('creator')}>创造者模式</button>
        <textarea className="composer-textarea" aria-label="原聊天草稿" defaultValue="不要改动我的草稿"/>
        <button data-app-guide="workspace" onClick={business('workspace')}>创作工作区</button>
        <button data-app-guide="progress" onClick={business('progress')}>任务进展</button>
        <button id="help" onClick={openApplicationUsageGuide}>使用指引</button>
      </main><ApplicationUsageGuide active/></>};createRoot(document.getElementById('root')).render(<Fixture/>);
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
        name: "bound-store",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "guide-fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "guide-fixture" }, () => ({
            contents: `const listeners=new Set();window.guideState={mainView:'thread',currentThreadId:null,threads:[],setSidebarCollapsed:value=>{window.calls.push(['sidebar',value]);document.getElementById('navigation').hidden=value}};
                window.updateGuideScope=value=>{Object.assign(window.guideState,value);listeners.forEach(listener=>listener())};
                export const useAppStore={getState:()=>window.guideState,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}}`
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<meta charset="utf-8"><div id="root"></div>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const guide = page.locator('[aria-label="应用使用指引"]')
    const help = page.getByRole("button", { name: "使用指引", exact: true })
    assert.equal(await guide.count(), 0, "No extra automatic overlay before help is requested")
    await help.click()
    const ids = ["navigation", "customize", "creator", "composer", "workspace", "progress"]
    for (const [index, id] of ids.entries()) {
      await page.locator(`[data-ui-guide-current="${id}"]`).waitFor()
      assert.equal(await page.locator("[data-ui-guide-current]").count(), 1)
      const target = page.locator(`[data-ui-guide-current="${id}"]`)
      if (id === "composer") assert.equal(await target.evaluate((node) => node.tagName), "TEXTAREA")
      else assert.equal(await target.getAttribute("data-app-guide"), id)
      assert.equal(await guide.getByRole("status").count(), 0)
      if (index < ids.length - 1)
        await guide.getByRole("button", { name: "下一步", exact: true }).click()
    }
    await page.screenshot({ path: join(output, "actual-control-guide.png") })
    await guide.getByRole("button", { name: "完成指引", exact: true }).click()
    await guide.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.id === "help")
    assert.equal(await page.getByLabel("原聊天草稿").inputValue(), "不要改动我的草稿")
    assert.deepEqual(await page.evaluate("window.calls.filter(row=>row[0]==='business')"), [])
    await page.setViewportSize({ width: 390, height: 740 })
    await help.click()
    await guide.getByText("第 1 / 6 步", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "下一步", exact: true }).click()
    await guide.getByRole("button", { name: "下一步", exact: true }).click()
    await page.locator('[data-ui-guide-current="creator"]').waitFor()
    // Replace a lazy/virtualized target while the bubble remains open.
    await page.evaluate(() => {
      const target = document.querySelector('[data-ui-guide-current="creator"]')!
      const replacement = target.cloneNode(true) as HTMLElement
      replacement.removeAttribute("data-ui-guide-current")
      replacement.id = "replacement"
      target.replaceWith(replacement)
    })
    await page.waitForFunction(
      () => document.querySelector('[data-ui-guide-current="creator"]')?.id === "replacement"
    )
    const box = await guide.boundingBox()
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 740)
    await page.screenshot({ path: join(output, "narrow-control-guide.png") })
    await page.evaluate(() => document.getElementById("replacement")?.remove())
    await guide.getByRole("status").waitFor()
    assert.match(await guide.getByRole("status").innerText(), /暂未显示这个控件/)
    await guide.getByRole("button", { name: "下一步", exact: true }).click()
    await page.locator('[data-ui-guide-current="composer"]').waitFor()
    await page.keyboard.press("Escape")
    await guide.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.id === "help")
    assert.equal(await page.locator("[data-ui-guide-current]").count(), 0)
    await help.click()
    await guide.getByText("第 1 / 6 步", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    await help.click()
    await guide.getByRole("button", { name: "关闭使用指引", exact: true }).click()
    assert.equal(await page.getByLabel("原聊天草稿").inputValue(), "不要改动我的草稿")
    assert.deepEqual(await page.evaluate("window.calls.filter(row=>row[0]==='business')"), [])
    assert.deepEqual(errors, [])
    // A new page has a fresh component lifetime and native first-use budget.
    const first = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    first.on("pageerror", (error) => errors.push(error.message))
    await first.setContent('<meta charset="utf-8"><div id="root"></div>')
    await first.addStyleTag({ content: css })
    await first.addScriptTag({ content: bundle.outputFiles[0].text })
    const firstGuide = first.locator('[aria-label="应用使用指引"]')
    const settle = () =>
      first.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
          )
      )
    const ordinary = {
      mainView: "thread",
      currentThreadId: "local",
      threads: [
        { thread_id: "local", metadata: { agentMode: "normal", workspacePath: "C:/guide" } }
      ]
    }
    await settle()
    assert.deepEqual(await first.evaluate("window.guideUsage"), {
      shown: 0,
      acknowledged: false,
      reads: 0
    })
    await first.evaluate(() =>
      document
        .querySelector('[data-app-guide="creator"]:not([inert] *)')
        ?.setAttribute("aria-pressed", "true")
    )
    await settle()
    assert.equal(await firstGuide.count(), 0, "No selected local chat must never auto-open")
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      {
        ...ordinary,
        threads: [{ thread_id: "local", metadata: { agentMode: "normal", workspacePath: "" } }]
      }
    )
    await settle()
    assert.equal(await firstGuide.count(), 0, "No local workspace must never auto-open")
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      {
        ...ordinary,
        mainView: "dashboard"
      }
    )
    await settle()
    assert.equal(
      await firstGuide.count(),
      0,
      "A background chat while another module is shown must not auto-open"
    )
    await first.evaluate(() =>
      document.getElementById("scroll")?.setAttribute("data-chat-thread-id", "old-chat")
    )
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      ordinary
    )
    await settle()
    assert.equal(
      await firstGuide.count(),
      0,
      "A retained old chat must not trigger the new chat's first-use guide"
    )
    await first.evaluate(() => {
      document.getElementById("scroll")?.setAttribute("data-chat-thread-id", "local")
      document.getElementById("scroll")?.setAttribute("aria-busy", "true")
    })
    await settle()
    assert.equal(await firstGuide.count(), 0, "A pending route must not spend the first-use budget")
    await first.evaluate(() => {
      document
        .querySelector('[data-app-guide="creator"][aria-pressed="true"]')
        ?.setAttribute("aria-pressed", "false")
      document.getElementById("scroll")?.removeAttribute("aria-busy")
    })
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      ordinary
    )
    await settle()
    assert.equal(await firstGuide.count(), 0, "Ordinary mode must not auto-open")
    await first.evaluate(() => {
      const dialog = document.createElement("div")
      dialog.id = "existing-guide"
      dialog.setAttribute("role", "dialog")
      dialog.textContent = "已有原生确认或专项指引"
      document.body.append(dialog)
      document
        .querySelector('[data-app-guide="creator"][aria-pressed="false"]')
        ?.setAttribute("aria-pressed", "true")
    })
    await settle()
    assert.deepEqual(
      await first.evaluate("window.guideUsage"),
      { shown: 0, acknowledged: false, reads: 0 },
      "Other visible dialogs must not read or consume the first-use budget"
    )
    await first.evaluate(() => document.getElementById("existing-guide")?.remove())
    await firstGuide.getByText("第 1 / 6 步", { exact: true }).waitFor()
    await first.waitForFunction(
      () => (window as unknown as GuideFixtureWindow).guideUsage.shown === 1
    )
    await first.locator('[data-ui-guide-current="navigation"]').waitFor()
    await firstGuide.getByRole("button", { name: "跳过指引", exact: true }).click()
    await firstGuide.waitFor({ state: "hidden" })
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      {
        ...ordinary,
        mainView: "dashboard"
      }
    )
    await settle()
    await first.evaluate(
      (value) => (window as unknown as GuideFixtureWindow).updateGuideScope(value),
      ordinary
    )
    await settle()
    assert.equal(
      await firstGuide.count(),
      0,
      "Returning to creator mode must respect skip and its display budget"
    )
    await first.getByRole("button", { name: "使用指引", exact: true }).click()
    await firstGuide.getByText("第 1 / 6 步", { exact: true }).waitFor()
    assert.equal(
      await first.evaluate("window.guideUsage.shown"),
      1,
      "Manual reopen must not spend another automatic display"
    )
    await firstGuide.getByRole("button", { name: "关闭使用指引", exact: true }).click()
    assert.deepEqual(await first.evaluate("window.calls.filter(row=>row[0]==='business')"), [])
    assert.deepEqual(errors, [])
    await first.close()
    // Keep the real host controls connected to the selectors exercised above.
    for (const [file, ids] of [
      ["App.tsx", ["navigation", "progress"]],
      ["components/sidebar/ThreadSidebar.tsx", ["customize"]],
      ["components/customize/ModsDevelopmentPanel.tsx", ["creator", "workspace"]],
      ["components/chat/ClawSidebar.tsx", ["progress"]]
    ] as const) {
      const source = readFileSync(join(renderer, file), "utf8")
      for (const id of ids) assert(source.includes(`data-app-guide="${id}"`), `${file}: ${id}`)
    }
    console.log(
      `PASS application control anchors, lazy replacement, scroll, missing targets, 390px, safe next/close/reopen; ${output}`
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

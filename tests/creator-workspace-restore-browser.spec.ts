/** Real creator UI: restoration is quiet, live stopping remains observable. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/creator-workspace-restore-browser")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { ModsDevelopmentPanel } from "./src/renderer/src/components/customize/ModsDevelopmentPanel";
      import { useAppStore } from "./src/renderer/src/lib/store";
      const root=createRoot(document.getElementById("root")), listeners=new Set();
      let epoch=0, stopCalls=0, reads=0, finishStop, holdRead=false, finishRead, tab;
      const trial=phase=>({componentId:"debug",draftId:"draft",revision:1,
        bundleDigest:"b".repeat(64),compiledDigest:"c".repeat(64),capabilities:[],phase});
      let state={threadId:"creator",workspace:"C:/fixture",mode:"creator",enabled:true,
        drafts:[{id:"draft",name:"调试工作台",revision:1,digest:"b".repeat(64)}],
        trials:[{...trial("unknown"),historical:true,error:"MODS_DEVELOPMENT_RESTART_UNCONFIRMED"}]};
      const emit=()=>listeners.forEach(fn=>fn({threadId:"creator"}));
      const api={status:async()=>{reads++;const value=structuredClone(state);
          if(holdRead){holdRead=false;return new Promise(resolve=>finishRead=()=>resolve(value))}return value},
        onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        stop:async()=>{stopCalls++;state.trials=[trial("retiring")];emit();
          return new Promise(resolve=>finishStop=()=>{state.trials=[trial("stopped")];resolve(structuredClone(state))})}};
      window.api={mods:{development:api}};
      window.addEventListener("claw:sidebar-tab",event=>tab=event.detail);
      const render=()=>root.render(<ModsDevelopmentPanel key={epoch} threadId="creator"
        workspaceHint="C:/fixture" mode="chat" api={api} settingsApi={{}}/>);
      window.fixture={set:phase=>{state.trials=[trial(phase)];emit()},
        remount:()=>{epoch++;render()},emit, finishStop:()=>finishStop(),
        holdRead:()=>holdRead=true, finishRead:()=>finishRead(),
        get:()=>({stopCalls,reads,tab,readHeld:!!finishRead,
          module:useAppStore.getState().rightModule,collapsed:useAppStore.getState().rightPanelCollapsed})};
      render();
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    define: {
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://creator-restore.fixture/bundle.js"'
    },
    logLevel: "error"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
    const dialog = page.getByRole("dialog")
    const entry = page.locator('[data-app-guide="workspace"]')
    await entry.waitFor()
    await settle()
    assert.equal(
      await page
        .getByRole("button", { name: "创造者模式", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    assert.equal(await dialog.count(), 0, "restored history does not open workspace")
    await entry.click()
    await page.getByText("上次试用记录（非当前运行状态）", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "停止此组件试用", exact: true }).count(), 0)
    assert.equal(
      await page
        .getByText("尚未确认是否停止。请先刷新状态；确认停止前不会开始新的试用。", { exact: true })
        .count(),
      0
    )
    await page.screenshot({ path: resolve(output, "restored-history.png"), fullPage: true })
    await page.getByRole("button", { name: "管理此会话灵件", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.deepEqual(
      await page.evaluate(
        "(({module,collapsed,tab,stopCalls})=>({module,collapsed,tab,stopCalls}))(window.fixture.get())"
      ),
      { module: "claw", collapsed: false, tab: "configuration", stopCalls: 0 }
    )

    // A fresh request still opens the approval UI; revisiting the same request does not.
    await page.evaluate("window.fixture.set('needs-approval')")
    await dialog.waitFor()
    await page.getByRole("button", { name: "确认并开始聊天试用", exact: true }).waitFor()
    await page.evaluate("window.fixture.remount()")
    await settle()
    await entry.waitFor()
    await settle()
    assert.equal(
      await dialog.count(),
      0,
      "restored pending approval stays accessible without popping up"
    )
    await entry.click()
    await page.evaluate("window.fixture.set('active')")
    const stop = page.getByRole("button", { name: "停止此组件试用", exact: true })
    await stop.click()
    const stopping = page.getByRole("button", { name: "正在停止试用…", exact: true })
    await stopping.waitFor()
    assert.equal(await stopping.isDisabled(), true)
    await page.getByText("正在停止旧版本", { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "stopping-trial.png"), fullPage: true })
    const refresh = page.getByRole("button", { name: "刷新状态", exact: true })
    assert.equal(await refresh.isEnabled(), true)
    const before = await page.evaluate("window.fixture.get().reads")
    await refresh.click()
    await page.waitForFunction(`window.fixture.get().reads > ${before}`)
    // A late read from before settlement must not overwrite the stop result.
    await page.evaluate("window.fixture.holdRead();window.fixture.emit()")
    await page.waitForFunction("window.fixture.get().readHeld")
    await page.evaluate("window.fixture.finishStop()")
    await page.getByText("已停止试用", { exact: true }).waitFor()
    await page.evaluate("window.fixture.finishRead()")
    await settle()
    assert.equal(await page.getByText("已停止试用", { exact: true }).count(), 1)
    assert.equal(await stopping.count(), 0)
    assert.equal(await page.evaluate("window.fixture.get().stopCalls"), 1)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: quiet creator restoration, historical trial navigation, fresh approval, observable stop and stale-read protection"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

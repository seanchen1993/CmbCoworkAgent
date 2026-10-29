import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { expect, it } from "vitest"

it("closes only the current guide entry before an explicit form, including late guide reads", async () => {
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{PageEntryGuide}from'./src/renderer/src/components/guides/PageEntryGuide';
      import{dismissCurrentPageEntryGuide}from'./src/renderer/src/components/guides/page-entry-guide-intent';
      import{Dialog,DialogContent,DialogTitle}from'./src/renderer/src/components/ui/dialog';
      let delayed=true,release;const calls=[];window.api={uiGuides:{
        getState:async()=>{calls.push('read');return delayed?new Promise(resolve=>release=resolve):{shouldShow:true}},
        recordDisplay:async()=>{calls.push('display');return true},
        acknowledge:async()=>calls.push('acknowledge')}};
      function Fixture(){const[active,setActive]=useState(true),[form,setForm]=useState(false);
        window.fixture={calls,open:()=>{dismissCurrentPageEntryGuide('project-mode-getting-started');setForm(true)},
          release:()=>{delayed=false;release({shouldShow:true})},leave:()=>{setActive(false);setForm(false)},
          enter:()=>setActive(true)};
        return <><PageEntryGuide active={active} guideId="project-mode-getting-started" revision={2}
          maxShowCount={3} title="项目模式使用引导"/><Dialog open={form} onOpenChange={setForm}>
          <DialogContent aria-describedby={undefined}><DialogTitle>新建项目</DialogTitle></DialogContent>
        </Dialog></>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.waitForFunction("window.fixture?.calls.includes('read')")
    await page.evaluate("window.fixture.open();window.fixture.release()")
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor()
    expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(1)
    expect(await page.evaluate("window.fixture.calls")).toEqual(["read"])
    await page.evaluate("window.fixture.leave()")
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor({ state: "detached" })
    await page.evaluate("window.fixture.enter()")
    await page.getByRole("dialog", { name: "项目模式使用引导", exact: true }).waitFor()
    await page.evaluate("window.fixture.open()")
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor()
    await page
      .getByRole("dialog", { name: "项目模式使用引导", exact: true, includeHidden: true })
      .waitFor({ state: "detached" })
    expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(1)
    expect(await page.evaluate("window.fixture.calls.includes('acknowledge')")).toBe(false)
    await page.evaluate("window.fixture.leave()")
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor({ state: "detached" })
    await page.evaluate("window.fixture.enter()")
    await page.getByRole("dialog", { name: "项目模式使用引导", exact: true }).waitFor()
  } finally {
    await browser.close()
  }
}, 60000)

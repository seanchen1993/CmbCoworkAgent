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

it("receives an earlier sibling's mount dismissal before guide effects, including StrictMode", async () => {
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
      import React,{StrictMode,useEffect,useState}from'react';
      import{createRoot}from'react-dom/client';
      import{PageEntryGuide}from'./src/renderer/src/components/guides/PageEntryGuide';
      import{dismissCurrentPageEntryGuide}from'./src/renderer/src/components/guides/page-entry-guide-intent';
      import{Dialog,DialogContent,DialogTitle}from'./src/renderer/src/components/ui/dialog';
      const mode=window.guideFixtureMode,calls=[],pending=[];let delayed=mode.delayed;
      window.api={uiGuides:{getState:async()=>{calls.push('read');return delayed
        ?new Promise(resolve=>pending.push(resolve)):{shouldShow:true}},
        recordDisplay:async()=>{calls.push('display');return true},
        acknowledge:async()=>{calls.push('acknowledge')}}};
      function EarlierSibling({launch,onOpen}){useEffect(()=>{if(launch){calls.push('dismiss');
        dismissCurrentPageEntryGuide('project-mode-getting-started');onOpen(true)}},[launch]);return null}
      function Fixture(){const[active,setActive]=useState(true),[launch,setLaunch]=useState(true),
        [form,setForm]=useState(false);window.fixture={calls,
          release:()=>{delayed=false;for(const resolve of pending.splice(0))resolve({shouldShow:true})},
          leave:()=>{setLaunch(false);setActive(false);setForm(false)},enter:()=>setActive(true)};
        return <><EarlierSibling launch={launch} onOpen={setForm}/>
          <PageEntryGuide active={active} guideId="project-mode-getting-started" revision={2}
            maxShowCount={3} title="项目模式使用引导"/>
          <Dialog open={form} onOpenChange={setForm}><DialogContent aria-describedby={undefined}>
            <DialogTitle>新建项目</DialogTitle><input aria-label="项目名称"/>
          </DialogContent></Dialog></>}
      createRoot(document.getElementById('root')).render(mode.strict?<StrictMode><Fixture/></StrictMode>:<Fixture/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    for (const strict of [false, true]) {
      for (const delayed of [false, true]) {
        const page = await browser.newPage()
        try {
          const errors: string[] = []
          page.on("pageerror", (error) => errors.push(String(error)))
          await page.setContent('<html><body><div id="root"></div></body></html>')
          await page.evaluate(
            (mode) => {
              ;(window as unknown as { guideFixtureMode: typeof mode }).guideFixtureMode = mode
            },
            { strict, delayed }
          )
          await page.addScriptTag({ content: bundled.outputFiles[0].text })
          await page.waitForFunction("window.fixture?.calls.includes('read')")
          await page.evaluate("window.fixture.release()")
          const form = page.getByRole("dialog", { name: "新建项目", exact: true })
          await form.waitFor()
          await form.getByRole("textbox", { name: "项目名称", exact: true }).fill("保留原项目表单")
          // Two frames let both a late read and Radix's modal effects settle.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              })
          )
          expect(await page.getByRole("dialog").count()).toBe(1)
          expect(await page.locator('[role="dialog"]').count()).toBe(1)
          expect(await form.getAttribute("aria-hidden")).not.toBe("true")
          expect(
            await form.getByRole("textbox", { name: "项目名称", exact: true }).inputValue()
          ).toBe("保留原项目表单")
          expect(await page.evaluate("window.fixture.calls.includes('display')")).toBe(false)
          expect(await page.evaluate("window.fixture.calls.includes('acknowledge')")).toBe(false)
          await page.evaluate("window.fixture.leave()")
          await form.waitFor({ state: "detached" })
          await page.evaluate("window.fixture.enter()")
          await page.getByRole("dialog", { name: "项目模式使用引导", exact: true }).waitFor()
          expect(await page.locator('[role="dialog"]').count()).toBe(1)
          expect(await page.evaluate("window.fixture.calls.includes('display')")).toBe(true)
          expect(await page.evaluate("window.fixture.calls.includes('acknowledge')")).toBe(false)
          expect(errors).toEqual([])
        } finally {
          await page.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 60000)

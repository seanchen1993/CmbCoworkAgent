/** Production FunctionPanes connected to actual Guest/PaneHost, including slow IPC and redraws. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../src/main/mods/v2/session"
import type { FunctionUiAction } from "../src/shared/mods/v2/ui"

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function fixture(page: Page, oldWheel = false, scrollHandler = true) {
  let ready = false,
    live = true,
    scrollCalls = 0,
    activeScroll = 0,
    maxActiveScroll = 0
  let measurements = 0,
    readCalls = 0,
    scrollSuccess = 0
  let holdReads: Promise<void> | undefined, releaseRead: (() => void) | undefined
  let failNextScroll = false
  const errors: string[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let scrolls=0,clicks=0,distance=0;
    on('session.start',async($,e,next)=>{await $.command.register({name:'open-scroll',description:'open',immediate:true});return next(e)});
    on('command.run',{command:'open-scroll'},async($)=>{await $.ui.open({id:'scroll-board',title:'滚动工作台',rows:12});return {}});
    ${scrollHandler ? "on('ui.scroll',async($,e,next)=>{scrolls++;distance+=Number(e.value.deltaY);return next(e)});" : ""}
    on('ui.render',{component:'Pane',requestId:'scroll-board'},($,e)=>{
      const {Box,Text,Input,Button}=$.ui.resolve(e);
      return Box({flexDirection:'column',gap:1,children:[
        Text({children:'scrolls:'+scrolls+' clicks:'+clicks+' distance:'+distance}),
        Input({key:'note',label:'保留输入',value:'',onInput(){},onSubmit(){}}),
        Button({key:'check',label:'检查按钮',onPress:()=>{clicks++;$.ui.invalidate('ui.render')}}),
        ...Array.from({length:60},(_,i)=>Text({children:'第 '+i+' 行：这是需要滚动阅读的工作台内容'}))
      ]})
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "scroll-board",
        root: "/scroll-board",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/fixture",
      threadId: "a",
      assertLive() {
        if (!live) throw Error("fixture closed")
      },
      publish: async (value) => value,
      uiChanged: () => {
        if (ready && !page.isClosed()) void page.evaluate("window.emitPane?.()").catch(() => {})
      }
    }
  )
  await session.start()
  await session.run("open-scroll", "")
  await page.exposeFunction("readNativePanes", async () => {
    readCalls++
    const snapshot = await session.panes.snapshot().catch((error) => {
      console.error("native pane read", error)
      throw error
    })
    await delay(60)
    if (holdReads) await holdReads
    return snapshot
  })
  await page.exposeFunction("actNativePane", async (action: FunctionUiAction) => {
    if (action.kind === "scroll") {
      scrollCalls++
      activeScroll++
      maxActiveScroll = Math.max(maxActiveScroll, activeScroll)
    }
    if (action.kind === "measure") measurements++
    try {
      if (action.kind === "scroll" && failNextScroll) {
        failNextScroll = false
        throw Error("fixture transient scroll transport failure")
      }
      if (action.kind === "scroll" || action.kind === "measure") await delay(30)
      const result = await session.panes.act(action)
      if (action.kind === "measure") await delay(100)
      if (action.kind === "scroll") scrollSuccess++
      return result
    } catch (error) {
      errors.push(String(error))
      throw error
    } finally {
      if (action.kind === "scroll") activeScroll--
    }
  })
  const component = resolve("src/renderer/src/components/chat/FunctionPanes.tsx")
  await mount(
    page,
    `
    import {FunctionPanes} from ${JSON.stringify(component)};
    import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {ClawResultsVisibility} from ${JSON.stringify(resolve("src/renderer/src/lib/claw-sidebar.ts"))};
    {
    let paneIntent=0;crypto.randomUUID??=()=>"10000000-1000-4000-8000-"+(++paneIntent).toString(16).padStart(12,"0");
    const listeners=new Set(); window.emitPane=()=>{for(const listener of listeners)listener({threadId:'a',scope:'panes'})};
    window.api.mods.panes=()=>window.readNativePanes();
    window.api.mods.paneAct=(_id,action)=>window.actNativePane(action);
    window.api.mods.onCardsChanged=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
    window.api.mods.onConfigurationChanged=()=>()=>{};
    const observations={alerts:[],tops:[],scrollTops:[]};window.observations=observations;
    let tracking=false,frame;window.track=value=>{tracking=value};
    const observe=()=>{if(tracking){const alert=document.querySelector('[role=alert]');
      if(alert)observations.alerts.push(alert.textContent);
      const body=document.querySelector('[data-function-pane-body]');if(body){observations.tops.push(body.getBoundingClientRect().top);observations.scrollTops.push(body.scrollTop)}}
      frame=requestAnimationFrame(observe)};frame=requestAnimationFrame(observe);
    window.closeFixture=()=>{cancelAnimationFrame(frame);host.unmount()};
    host.render(<main style={{width:440,padding:12}}><button>其他功能</button><ClawResultsVisibility.Provider value={true}>
      <ModsChatScope.Provider value={{threadId:'a',enabled:true}}><FunctionPanes threadId='a' revealInSidebar={false}/></ModsChatScope.Provider>
    </ClawResultsVisibility.Provider></main>);
    }
  `,
    [
      browserWorkerPlugin(),
      ...(oldWheel
        ? [
            {
              name: "previous-wheel-behavior",
              setup(build: import("esbuild").PluginBuild) {
                build.onLoad({ filter: /FunctionPanes\.tsx$/ }, () => ({
                  loader: "tsx",
                  resolveDir: resolve("src/renderer/src/components/chat"),
                  contents: readFileSync(component, "utf8")
                    .replace("observeWheel(pane, {", 'void act(pane, undefined, "scroll", {')
                    .replace('if (!passive) setError("")', 'setError("")')
                    .replace(
                      'if (!(passive && String(cause).includes("MODS_UI_STALE_ACTION"))) setError(',
                      "setError("
                    )
                }))
              }
            }
          ]
        : [])
    ]
  )
  await page.addStyleTag({
    content:
      "body{margin:0;font:14px/24px system-ui}main{box-sizing:border-box} [data-function-pane-body]{overflow:auto}button,input{font:inherit}p{margin:4px 0} [data-function-pane]{padding:12px;border:1px solid #aaa}"
  })
  ready = true
  const body = page.locator("[data-function-pane-body]")
  await body.waitFor({ timeout: 8000 }).catch(async (error) => {
    console.error("pane mount", { readCalls, errors, body: await page.locator("body").innerText() })
    await session.close()
    throw error
  })
  await delay(300)
  return {
    session,
    body,
    facts: () => ({ scrollCalls, maxActiveScroll, measurements, readCalls, scrollSuccess, errors }),
    failScrollOnce() {
      failNextScroll = true
    },
    hold() {
      holdReads = new Promise<void>((done) => {
        releaseRead = done
      })
    },
    release() {
      holdReads = undefined
      releaseRead?.()
    },
    async close() {
      releaseRead?.()
      ready = false
      await page.evaluate("window.closeFixture()")
      await session.close()
      live = false
    }
  }
}

async function main() {
  const output = resolve("output/function-pane-wheel-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const evidence: unknown[] = []
  try {
    for (const oldWheel of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 600, height: 850 } })
      const pageErrors: string[] = []
      page.on("pageerror", (error) => {
        pageErrors.push(error.message)
        console.error("page error", error)
      })
      const f = await fixture(page, oldWheel)
      try {
        await page.getByRole("textbox", { name: "保留输入", exact: true }).fill("不要丢失这段输入")
        await page.evaluate("window.track(true)")
        await f.body.hover()
        for (let i = 0; i < 24; i++) {
          await page.mouse.wheel(0, 18)
          await delay(5)
        }
        await delay(600)
        await page.evaluate("window.track(false)")
        const observed = (await page.evaluate("window.observations")) as {
          alerts: string[]
          tops: number[]
          scrollTops: number[]
        }
        if (oldWheel) {
          assert(
            observed.alerts.some((text) => text.includes("面板已更新")),
            "Original wheel actions must reproduce stale feedback"
          )
        } else {
          assert.equal(
            observed.alerts.length,
            0,
            "Native wheel redraw must not insert an error row"
          )
          assert.equal(f.facts().maxActiveScroll, 1, "Only one scroll observation may be pending")
          assert(f.facts().scrollCalls < 24, "Wheel observations must coalesce while IPC waits")
          assert(
            f.facts().scrollSuccess > 0,
            "Actual guest scroll hooks still receive observations"
          )
          assert.equal(
            f.facts().measurements,
            1,
            "Pending geometry must not be sent again by fonts or redraw"
          )
          await page.getByText("distance:432", { exact: false }).waitFor()
          assert(
            Math.max(...observed.tops) - Math.min(...observed.tops) <= 1,
            "Panel position must stay stable"
          )
          assert.equal(
            await page.getByRole("textbox", { name: "保留输入", exact: true }).inputValue(),
            "不要丢失这段输入"
          )
          // Retired button actions remain rejected; only stale passive scroll observations are quiet.
          await f.body.evaluate((element) => {
            element.scrollTop = 0
          })
          await page.getByRole("textbox", { name: "保留输入", exact: true }).focus()
          f.hold()
          f.session.panes.invalidate()
          await f.session.panes.snapshot()
          await page.getByRole("button", { name: "其他功能", exact: true }).click()
          await delay(80)
          assert.equal(
            await page.getByRole("alert").count(),
            0,
            "A retired blur observation is also passive"
          )
          await page.getByRole("button", { name: "检查按钮", exact: true }).click()
          await page.getByRole("alert").filter({ hasText: "面板已更新" }).waitFor()
          f.release()
          await delay(200)
          await page.getByRole("button", { name: "检查按钮", exact: true }).click()
          await page.getByText("clicks:1", { exact: false }).waitFor()
          await page.screenshot({ path: resolve(output, "stable-pane.png"), fullPage: true })

          // A rejected IPC must not wait forever for a generation the host never created.
          await delay(200)
          f.failScrollOnce()
          await f.body.hover()
          await page.mouse.wheel(0, 30)
          await page.getByRole("alert").filter({ hasText: "面板操作未完成" }).waitFor()
          const failed = f.facts()
          await delay(250)
          assert.equal(
            f.facts().scrollCalls,
            failed.scrollCalls,
            "Failed observations never auto-replay"
          )
          await page.mouse.wheel(0, 30)
          for (
            let attempt = 0;
            attempt < 40 && f.facts().scrollSuccess === failed.scrollSuccess;
            attempt++
          ) {
            await delay(50)
          }
          assert.equal(
            f.facts().scrollSuccess,
            failed.scrollSuccess + 1,
            "A new user wheel recovers after failed IPC without a new generation"
          )
        }
        assert.deepEqual(pageErrors, [])
        evidence.push({
          oldWheel,
          facts: f.facts(),
          observations: {
            alerts: observed.alerts.length,
            topRange: Math.max(...observed.tops) - Math.min(...observed.tops),
            finalScrollTop: observed.scrollTops.at(-1)
          },
          pageErrors
        })
      } finally {
        await f.close()
        await page.close()
      }
    }
    const passivePage = await browser.newPage()
    const passive = await fixture(passivePage, false, false)
    try {
      const before = await passive.session.panes.snapshot()
      await passive.body.hover()
      await passivePage.mouse.wheel(0, 30)
      await delay(300)
      await passivePage.mouse.wheel(0, 30)
      await delay(300)
      assert.equal(
        passive.facts().scrollSuccess,
        2,
        "Same-generation snapshots acknowledge passive scrolls"
      )
      assert.equal(
        (await passive.session.panes.snapshot())[0].generation,
        before[0].generation,
        "A pane with no scroll handler keeps its drawing"
      )
      assert.equal(await passivePage.getByRole("alert").count(), 0)
      assert.equal(passive.facts().maxActiveScroll, 1)
      evidence.push({ noScrollHandler: true, facts: passive.facts() })
    } finally {
      await passive.close()
      await passivePage.close()
    }
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ passed: true, evidence }, null, 2) + "\n"
    )
    console.log(
      "PASS actual PaneHost wheel redraw: old stale feedback reproduced; new scroll is single-flight, no flashing, retired controls still rejected"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/** Production chat-top FunctionSite + actual plugin Guest; controlled model-run boundary. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import { createFrontendWorkbenchFixture } from "./support/frontend-api-workbench-fixture"
import type { FunctionUiAction } from "../src/shared/mods/v2/ui"
import type { ModObject } from "../src/shared/mods/types"
import type { FunctionSessionHost } from "../src/main/mods/v2/session"

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function main() {
  const output = resolve("output/frontend-api-workbench-header-browser")
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const css = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
    base: renderer,
    onDependency: () => undefined
  })
  const styles = css.build(
    new Scanner({}).scanFiles(
      [
        "components/chat/FunctionPanes.tsx",
        "components/chat/FunctionSite.tsx",
        "components/ui/button.tsx"
      ].map((file) => ({
        content: readFileSync(resolve(renderer, file), "utf8"),
        extension: "tsx"
      }))
    )
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const evidence: unknown[] = []
  try {
    for (const scenario of [
      "input-click",
      "wheel-click",
      "delayed-wheel-click",
      "advanced-wheel-click",
      "preset",
      "narrow"
    ] as const) {
      const page = await browser.newPage({
        viewport: { width: scenario === "narrow" ? 390 : 1100, height: 900 }
      })
      const f = await createFrontendWorkbenchFixture()
      const actions: Array<{ kind: string; ok: boolean; error?: string }> = []
      const errors: string[] = []
      let live = true
      let mountedOwner = ""
      page.on("pageerror", (error) => errors.push(error.message))
      ;(f.session as unknown as { host: FunctionSessionHost }).host.uiChanged = (scope) => {
        if (live)
          void page
            .evaluate(
              (scope) =>
                (window as unknown as { emitHeader(scope?: string): void }).emitHeader(scope),
              scope
            )
            .catch(() => {})
      }
      try {
        f.idle()
        await page.exposeFunction("mountHeader", async () => {
          mountedOwner = await f.session.sites.mount("ChatHeader")
          return { state: "mounted", owner: mountedOwner }
        })
        await page.exposeFunction("renderHeader", async (owner: string, props: ModObject) => {
          const snapshot = await f.session.sites.render(owner, props)
          await delay(60)
          return snapshot
        })
        await page.exposeFunction("actHeader", async (owner: string, action: FunctionUiAction) => {
          try {
            await delay(15)
            const result = await f.session.sites.act(owner, action)
            actions.push({ kind: action.kind, ok: true })
            return result
          } catch (error) {
            actions.push({ kind: action.kind, ok: false, error: String(error) })
            throw error
          }
        })
        await page.exposeFunction("unmountHeader", (owner: string) =>
          f.session.sites.unmount(owner)
        )
        await mount(
          page,
          `
          import {FunctionSite} from ${JSON.stringify(resolve(renderer, "components/chat/FunctionSite.tsx"))};
          import {ModsChatScope} from ${JSON.stringify(resolve(renderer, "lib/mods-chat-scope.tsx"))};
          {
            let serial=0;crypto.randomUUID??=()=>"40000000-1000-4000-8000-"+(++serial).toString(16).padStart(12,"0");
            const listeners=new Set();
            window.emitHeader=scope=>{for(const fn of listeners)fn({threadId:'a',scope})};
            window.api.mods.siteRead=undefined;
            window.api.mods.siteMountOutcome=()=>window.mountHeader();
            window.api.mods.siteRender=(_thread,owner,props)=>window.renderHeader(owner,props);
            window.api.mods.siteAct=(_thread,owner,action)=>window.actHeader(owner,action);
            window.api.mods.siteUnmount=(_thread,owner)=>window.unmountHeader(owner);
            window.api.mods.onCardsChanged=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
            window.api.mods.onConfigurationChanged=()=>()=>{};
            window.closeFixture=()=>host.unmount();
            host.render(<ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
              <main style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',padding:12,gap:12,background:'#fff'}}>
                <header style={{fontSize:14,fontWeight:600}}>前后端联调 · 聊天顶部工作台</header>
                <FunctionSite threadId='a' component='ChatHeader' facts={{isWorking:false}}/>
                <div data-transcript style={{flex:'1 1 0',minHeight:0,overflow:'auto',padding:20,border:'1px solid #edf0f3',borderRadius:8}}>
                  <p>分析任务与报告显示在这段聊天中。</p><div style={{height:1800}}>聊天消息区域</div>
                </div>
                <textarea aria-label='聊天输入框' placeholder='也可以在这里继续追问…' style={{height:65,flexShrink:0,border:'1px solid #ddd',borderRadius:8,padding:12}}/>
              </main>
            </ModsChatScope.Provider>);
          }
        `,
          [browserWorkerPlugin()]
        )
        await page.addStyleTag({ content: styles + "\nbody{margin:0;font:14px/24px system-ui}" })
        const header = page.locator("[data-function-site=ChatHeader]")
        const start = page.getByRole("button", { name: "补齐代码并联调", exact: true })
        await start.waitFor()
        await delay(350)
        assert.deepEqual(await f.session.panes.snapshot(), [], "No sidebar pane is opened")
        const box = await header.boundingBox()
        await page.locator("[data-transcript]").evaluate((node) => {
          node.scrollTop = 1500
        })
        assert.deepEqual(
          await header.boundingBox(),
          box,
          "Chat scrolling must not move the workbench"
        )
        if (scenario === "preset" || scenario === "narrow") {
          await page.getByRole("button", { name: "填入演示案例", exact: true }).click()
          await page.waitForFunction(() =>
            (document.querySelector('[aria-label="页面地址"]') as HTMLInputElement)?.value.includes(
              "4179"
            )
          )
          assert.equal(f.runs.length, 0)
          await page.waitForFunction(() =>
            (document.querySelector('[aria-label="接口文档"]') as HTMLInputElement)?.value.endsWith(
              "api-correct.txt"
            )
          )
          await page.getByRole("button", { name: "收起配置", exact: true }).click()
          await page.getByRole("button", { name: "展开配置", exact: true }).waitFor()
          assert.equal(
            await page.getByRole("textbox", { name: "页面地址", exact: true }).count(),
            0
          )
          await page.getByRole("button", { name: "展开配置", exact: true }).click()
          await page.getByRole("textbox", { name: "页面地址", exact: true }).waitFor()
          assert.equal(
            await page.getByRole("textbox", { name: "接口文档", exact: true }).inputValue(),
            "docs/api-correct.txt"
          )
        } else {
          await page.getByRole("button", { name: "使用当前目录", exact: true }).click()
          await page
            .getByRole("textbox", { name: "页面地址", exact: true })
            .fill("http://127.0.0.1:4179/orders")
          await page
            .getByRole("textbox", { name: "接口文档", exact: true })
            .fill("GET /api/orders returns totalAmountCents in cents")
          if (scenario === "advanced-wheel-click") {
            await page.getByRole("button", { name: "运行命令（可选）", exact: true }).click()
            await page.getByRole("textbox", { name: "启动命令", exact: true }).fill("npm run dev")
            await page.getByRole("textbox", { name: "检查命令", exact: true }).fill("npm test")
          }
          if (scenario !== "input-click") {
            await header.hover()
            await page.mouse.wheel(0, scenario === "advanced-wheel-click" ? -80 : 80)
            if (["delayed-wheel-click", "advanced-wheel-click"].includes(scenario)) await delay(60)
          }
        }
        await start.click()
        await page.waitForFunction(
          () => document.body.textContent?.includes("提交已处理"),
          undefined,
          { timeout: 5000 }
        )
        assert.equal(f.runs.length, 1, scenario + ": exactly one submitted task")
        assert.equal(actions.filter((action) => !action.ok).length, 0, JSON.stringify(actions))
        assert.equal(await page.locator("[data-function-panes]").count(), 0)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        if (scenario === "preset" || scenario === "narrow") {
          await page.getByRole("button", { name: "收起配置", exact: true }).click()
          await page.getByRole("button", { name: "展开配置", exact: true }).waitFor()
          await page.screenshot({ path: resolve(output, scenario + "-collapsed.png") })
          await page.getByRole("button", { name: "展开配置", exact: true }).click()
          await page.getByRole("textbox", { name: "页面地址", exact: true }).waitFor()
          await header.evaluate((node) => {
            node.scrollTop = 0
          })
          await delay(200)
          await page.screenshot({ path: resolve(output, scenario + "-expanded.png") })
        }
        assert.deepEqual(errors, [])
        evidence.push({
          scenario,
          runs: f.runs.length,
          sidebarPanes: 0,
          actions,
          errors,
          ownerMounted: Boolean(mountedOwner)
        })
      } catch (error) {
        await page.screenshot({ path: resolve(output, scenario + "-failure.png") })
        console.error(
          JSON.stringify({
            scenario,
            actions,
            runs: f.runs.length,
            queue: f.queue.size,
            body: await page.locator("body").innerText(),
            errors
          })
        )
        throw error
      } finally {
        live = false
        await page.evaluate("window.closeFixture?.()")
        await f.close()
        await page.close()
      }
    }
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify(
        { passed: true, realGuestAndFunctionSite: true, evidence, liveModelInvoked: false },
        null,
        2
      ) + "\n"
    )
    console.log(
      "PASS actual chat-top workbench: stable dock, input/scroll click, presets, restore layout, desktop/mobile"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

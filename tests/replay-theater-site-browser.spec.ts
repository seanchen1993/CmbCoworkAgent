/** Original packaged guest + real site registry + real React surface; no model or file tools. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../src/main/mods/v2/session"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

interface ReplayFixtureWindow extends Window {
  replayNotify?: (
    scope: Parameters<NonNullable<ConstructorParameters<typeof FunctionSession>[1]["uiChanged"]>>[0]
  ) => void
  replayWorking: (working: boolean) => void
  replayHide: (hidden: boolean) => void
  replayRows: (count: number) => void
}

async function main() {
  const output = resolve("output/replay-theater-recovery-20261011", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const root = resolve("resources/mods/community-originals/replay-theater")
  assert.deepEqual(
    readFileSync(resolve(root, "hooks/replay-theater.mjs")),
    readFileSync(resolve("tests/fixtures/mods-upstream/replay-theater/hooks/replay-theater.mjs"))
  )
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    checks: string[] = []
  const calls = { mount: 0, render: 0, unmount: 0, notice: 0 }
  const noticeScopes: unknown[] = []
  let heldRead: Promise<void> | undefined
  let releaseRead: (() => void) | undefined
  let actions = 0
  let lastColumns: unknown
  page.on("pageerror", (error) => errors.push(error.message))
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "replay-browser",
      assertLive: () => undefined,
      publish: async (value) => value,
      uiChanged: (scope) => {
        calls.notice++
        noticeScopes.push(scope)
        void page
          .evaluate((scope) => (window as ReplayFixtureWindow).replayNotify?.(scope), scope)
          .catch((error) => errors.push(String(error)))
      },
      authorizeProcess: async () => {
        throw Error("NO_BUSINESS_EXECUTION")
      }
    }
  )
  const pass = (name: string) => {
    checks.push(name)
    console.log("PASS " + name)
  }
  const stable = async () => {
    await page.waitForTimeout(500)
    const before = { ...calls }
    await page.waitForTimeout(900)
    assert.deepEqual(calls, before, "idle surface must stop mounting, reading and broadcasting")
    assert.equal(await page.getByRole("status").count(), 0)
    assert.equal(await page.getByRole("alert").count(), 0)
  }
  try {
    await session.start()
    // Use the production frame rule: its conditional border must not feed back into geometry.
    const styles = readFileSync(resolve("src/renderer/src/index.css"), "utf8")
    const frameRule = styles.match(/\.sparks-inline-surface:has\([^}]+\}/)?.[0]
    assert(frameRule)
    await page.exposeFunction(
      "replayMount",
      async (component: Parameters<FunctionSession["sites"]["mount"]>[0]) => {
        calls.mount++
        return { state: "mounted", owner: await session.sites.mount(component) }
      }
    )
    await page.exposeFunction(
      "replayRender",
      async (owner: string, props: Parameters<FunctionSession["sites"]["render"]>[1]) => {
        calls.render++
        if (typeof props.bodyColumns === "number") lastColumns = props.bodyColumns
        // Leave a paint between invalidation and IPC completion, as a busy host does.
        await new Promise((resolve) => setTimeout(resolve, 50))
        await heldRead
        return session.sites.render(owner, props)
      }
    )
    await page.exposeFunction("replayUnmount", async (owner: string) => {
      calls.unmount++
      await session.sites.unmount(owner)
    })
    await page.exposeFunction(
      "replayAct",
      async (owner: string, action: Parameters<FunctionSession["sites"]["act"]>[1]) => {
        actions++
        try {
          return await session.sites.act(owner, action)
        } catch (error) {
          errors.push(String(error))
          throw error
        }
      }
    )
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      { crypto.randomUUID ??= ()=>'replay-fixture-'+Math.random().toString(16).slice(2);
      const cards=new Set();let hidden=false;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      window.replayNotify=scope=>{for(const fn of cards)fn({threadId:'replay-browser',scope})};
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=(_thread,component)=>window.replayMount(component);
      window.api.mods.siteRender=(_thread,owner,props)=>window.replayRender(owner,props);
      window.api.mods.siteUnmount=(_thread,owner)=>window.replayUnmount(owner);
      window.api.mods.siteAct=(_thread,owner,action)=>window.replayAct(owner,action);
      function Fixture(){const [working,setWorking]=useState(false),[rows,setRows]=useState(0);window.replayWorking=setWorking;window.replayRows=setRows;
        window.replayHide=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
        return <ModsChatScope.Provider value={{threadId:'replay-browser',enabled:true,ready:true}}>
          <div style={{width:640}}><FunctionSite threadId='replay-browser' component='AbovePrompt'
            className='sparks-inline-surface'
            facts={{isWorking:working}}/><textarea aria-label='Composer'/></div>
          {Array.from({length:rows},(_,index)=><FunctionSite key={index}
            threadId='replay-browser' component='AssistantMessage'
            facts={{text:'Synthetic row '+index,isFirstOfReply:true}}/>)}
        </ModsChatScope.Provider>}
      host.render(<Fixture/>); }
    `,
      [browserWorkerPlugin()]
    )
    await page.getByRole("textbox", { name: "Composer" }).waitFor()
    await page.addStyleTag({
      content: `:root { --border: #ddd; --muted: #eee }
      * { box-sizing: border-box } ${frameRule}`
    })
    await stable()
    assert.equal(calls.notice, 0)
    pass("byte-identical original empty AbovePrompt settles without a feedback loop")
    const mounts = calls.mount
    await page.evaluate(() => (window as ReplayFixtureWindow).replayWorking(true))
    await stable()
    assert.equal(calls.mount, mounts)
    assert.equal(calls.notice, 0)
    pass("working facts and actual geometry reads keep one owner and emit no redraw notices")
    await session.turnStart({ turnId: "fixture", text: "synthetic receipt" })
    await session.interceptTool(
      {
        tool: "Edit",
        tool_use_id: "fixture",
        file_path: "never-written",
        old_string: "before",
        new_string: "after",
        replace_all: false
      },
      undefined,
      async () => ({ result: "fixture", text: "fixture" })
    )
    await session.turnComplete({
      turnId: "fixture",
      answer: "done",
      durationMs: 1,
      reason: "answer",
      isAborted: false
    })
    await page.getByText("▶ Replay: 1 edit (press r)", { exact: true }).waitFor()
    await stable()
    assert.equal(calls.notice, 2)
    assert.equal(noticeScopes.filter(scope => typeof scope === "string" && scope.startsWith("site-redraw:")).length, 1)
    assert.equal(noticeScopes.filter(scope => scope === "panes").length, 1)
    pass("real original ui.invalidate updates AbovePrompt once and reaches idle")
    heldRead = new Promise<void>(resolve => { releaseRead = resolve })
    const previousActions = actions
    const composerBefore = await page.getByRole("textbox", { name: "Composer" }).boundingBox()
    await page.evaluate(() => (window as ReplayFixtureWindow).replayWorking(false))
    await page.waitForTimeout(500)
    assert.equal(await page.getByText("▶ Replay: 1 edit (press r)", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("status").count(), 0)
    await page.getByRole("button", { name: "Replay", exact: true }).dispatchEvent("click")
    assert.equal(actions, previousActions, "a retained protected drawing cannot dispatch old actions")
    assert.deepEqual(await page.getByRole("textbox", { name: "Composer" }).boundingBox(), composerBefore)
    heldRead = undefined
    releaseRead!()
    await stable()
    pass("working-only progress retains the protected original Replay frame and geometry while actions wait")
    heldRead = new Promise<void>(resolve => { releaseRead = resolve })
    await page.evaluate(() => {
      const fixture = window as ReplayFixtureWindow
      fixture.replayWorking(true)
      fixture.replayNotify?.(undefined)
    })
    await page.getByRole("status").waitFor()
    assert.equal(await page.getByText("▶ Replay: 1 edit (press r)", { exact: true }).count(), 0)
    heldRead = undefined
    releaseRead!()
    await stable()
    pass("global invalidation still removes retained progress frames until a fresh protected drawing arrives")
    for (const width of [641, 648, 647, 640]) {
      const prior = calls.render
      await page.locator('[data-function-site="AbovePrompt"]').evaluate((node, width) => {
        node.parentElement!.style.width = `${width}px`
      }, width)
      await stable()
      assert.equal(lastColumns, Math.floor(width / 8))
      assert(calls.render - prior <= 1, "one width change must cause at most one read")
    }
    pass("content frame remains stable across eight-pixel boundaries and ordinary resizes")
    await page.evaluate(() => (window as ReplayFixtureWindow).replayHide(true))
    await page.waitForTimeout(100)
    await page.evaluate(() => (window as ReplayFixtureWindow).replayHide(false))
    await page.getByText("▶ Replay: 1 edit (press r)", { exact: true }).waitFor()
    await stable()
    assert.equal(calls.notice, 2)
    assert.equal(noticeScopes.filter(scope => typeof scope === "string" && scope.startsWith("site-redraw:")).length, 1)
    assert.equal(noticeScopes.filter(scope => scope === "panes").length, 1)
    pass("hide and resume retire old owner and settle without feeding original invalidate")
    await page.getByRole("button", { name: "Replay", exact: true }).click()
    await stable()
    assert(
      (await session.panes.snapshot()).some((pane) => pane.id === "replay-theater"),
      JSON.stringify({ errors, calls })
    )
    pass("original Replay button opens its real pane and settles after both invalidations")
    await page.evaluate(() => (window as ReplayFixtureWindow).replayRows(24))
    await stable()
    await page.evaluate(async () => {
      for (let index = 0; index < 30; index++) {
        ;(window as ReplayFixtureWindow).replayNotify?.(undefined)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })
    await stable()
    pass("finite global broadcasts converge with twenty-four real queued transcript sites")
    await page.evaluate(() => (window as ReplayFixtureWindow).replayHide(true))
    await page.waitForTimeout(100)
    const hiddenCalls = { ...calls }
    await page.evaluate(() => (window as ReplayFixtureWindow).replayNotify?.(undefined))
    await page.waitForTimeout(100)
    assert.deepEqual(calls, hiddenCalls)
    await page.evaluate(() => (window as ReplayFixtureWindow).replayHide(false))
    await stable()
    pass("queued transcript and composer resume once after hidden broadcasts")
    await page.screenshot({ path: resolve(output, "replay-stable.png") })
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
    await session.close()
    await browser.close()
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify({ checks, calls, errors }, null, 2)
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

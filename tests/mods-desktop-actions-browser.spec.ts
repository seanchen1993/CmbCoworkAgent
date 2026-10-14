import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-desktop-actions-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      crypto.randomUUID??=()=> 'desktop-fixture-'+Math.random().toString(16).slice(2);
      const replies=[],copies=[],owners=[],changes=new Set();let listener,owner;
      window.api.mods.desktopAttach=async(id,value)=>{owner=value;owners.push([id,value])};
      window.api.mods.desktopDetach=async(id,value)=>owners.push(['detach',id,value]);
      window.api.mods.desktopRespond=async reply=>replies.push(reply);
      window.api.mods.desktopCopy=async reply=>copies.push(reply);
      window.api.mods.onDesktopRequest=fn=>{listener=fn;return()=>{listener=undefined}};
      window.api.mods.onConfigurationChanged=fn=>{changes.add(fn);return()=>changes.delete(fn)};
      function DesktopFixture(){
        const root=useRef(null),[thread,setThread]=useState('a'),[enabled,setEnabled]=useState(true),
          [working,setWorking]=useState(false),[hidden,setHidden]=useState(false);
        useFunctionDesktop(thread,enabled,root,working);
        window.desktop={working:setWorking,thread:setThread,enabled:setEnabled,hidden:setHidden,
          fire:request=>listener?.({...request,threadId:request.threadId??thread,owner:request.owner??owner}),
          reconfigure:()=>{for(const fn of changes)fn()},replies,copies,owners};
        return <><section ref={root} hidden={hidden} data-chat-thread-id={thread}>
          <p data-chat-message-id='row-one'>FirstChosen</p><p data-chat-message-id='row-two'>SecondChosen</p>
          <section data-function-request-id='actual-tool-use'><span>ToolChosen</span></section>
          <section data-chat-message-id='rich-row' style={{display:'contents'}}><p data-rich-first>RichFirst</p><p data-rich-last>RichLast</p></section>
          <section data-chat-message-id='outer-row'><span data-outer-start>OuterStart</span><section data-function-request-id='nested-tool'>NestedTool</section><span data-outer-end>OuterEnd</span></section>
          <textarea aria-label='draft'/><input type='password' aria-label='password' defaultValue='private'/>
          <button>Command</button>
        </section><aside data-claw-sidebar-host={thread}><p data-configuration>PrivateConfig</p><div data-claw-results>
          <section data-function-pane-key='own-pane' data-function-pane-generation='gen-1'><button>Pane command</button><p>PaneChosen</p></section>
        </div></aside><p data-outside>OutsidePrivate</p></>;
      }
      host.render(<DesktopFixture/>);
    `
    )
    await page.getByText("FirstChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    const ask = async (kind: string, extra: Record<string, unknown> = {}) => {
      await page.evaluate(
        async ({ kind, extra }) => {
          const w = window as unknown as { desktop: { fire(request: unknown): Promise<void> } }
          await w.desktop.fire({ kind, requestId: "probe", ...extra })
        },
        { kind, extra }
      )
      return page.evaluate("window.desktop.replies.at(-1)")
    }
    assert.deepEqual((await ask("selection")).selection, {
      text: "FirstChosen",
      requestId: "row-one"
    })
    await page.getByRole("button", { name: "Command", exact: true }).click()
    assert.deepEqual((await ask("selection")).selection, {
      text: "FirstChosen",
      requestId: "row-one"
    })
    // Slash completion changes the native selection programmatically, without a user gesture.
    await page.getByLabel("draft").fill("programmatic")
    await page.getByLabel("draft").evaluate((node) => node.setSelectionRange(0, node.value.length))
    assert.equal((await ask("selection")).selection.text, "FirstChosen")
    await page.getByLabel("draft").press("Control+a")
    assert.deepEqual((await ask("selection")).selection, { text: "programmatic" })
    await page.getByText("ToolChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    assert.deepEqual((await ask("selection")).selection, {
      text: "ToolChosen",
      requestId: "actual-tool-use"
    })
    const old = await ask("presence")
    await page.getByText("SecondChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    await ask("clear-selection", { revision: old.revision })
    assert.equal((await ask("selection")).selection.text, "SecondChosen")
    await page.evaluate("window.desktop.working(true)")
    await page.getByText("FirstChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    await page.evaluate("window.desktop.working(false)")
    assert.equal((await ask("selection")).selection.text, "FirstChosen")
    await page.evaluate("window.desktop.working(true)")
    await ask("presence")
    await page.evaluate("window.desktop.working(false)")
    assert.equal((await ask("selection")).selection, null)
    await page.getByText("FirstChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    await page.keyboard.press("Escape")
    assert.equal((await ask("selection")).selection, null)
    // Cross-row selection is an edge fixture; the real happy path above uses actual mouse input.
    await page.evaluate(() => {
      const first = document.querySelector('[data-chat-message-id="row-one"]')!,
        second = document.querySelector('[data-chat-message-id="row-two"]')!,
        range = document.createRange()
      range.setStart(first.firstChild!, 0)
      range.setEnd(second.firstChild!, second.textContent!.length)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      second.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })
    assert.equal((await ask("selection")).selection.requestId, undefined)
    await page.getByText("FirstChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    await page.locator('[data-chat-message-id="row-one"]').evaluate((node) => node.remove())
    assert.deepEqual((await ask("selection")).selection, { text: "FirstChosen" })
    await page.getByText("OutsidePrivate", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    assert.equal((await ask("selection")).selection, null)
    await page.getByText("SecondChosen", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    await page.getByText("PrivateConfig", { exact: true }).dblclick({ position: { x: 15, y: 8 } })
    assert.equal((await ask("selection")).selection, null)
    await page.evaluate(() => {
      const first = document.querySelector("[data-rich-first]")!,
        last = document.querySelector("[data-rich-last]")!,
        range = document.createRange()
      range.setStart(first.firstChild!, 0)
      range.setEnd(last.firstChild!, last.textContent!.length)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      last.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })
    const rich = (await ask("selection")).selection
    assert.equal(rich.requestId, "rich-row")
    assert(rich.text.includes("RichFirst") && rich.text.includes("RichLast"))
    await page.evaluate(() => {
      const start = document.querySelector("[data-outer-start]")!,
        end = document.querySelector("[data-outer-end]")!,
        range = document.createRange()
      range.setStart(start.firstChild!, 0)
      range.setEnd(end.firstChild!, end.textContent!.length)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      end.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })
    assert.equal((await ask("selection")).selection.requestId, undefined)
    await page.getByRole("button", { name: "Pane command", exact: true }).focus()
    assert.deepEqual((await ask("panes")).drawings, [
      { key: "own-pane", generation: "gen-1", isShown: true, isPlaced: true, isFocused: true }
    ])
    await page.locator("aside").evaluate((node) => (node.hidden = true))
    assert.equal((await ask("panes")).drawings[0].isShown, false)
    await page.locator("aside").evaluate((node) => (node.hidden = false))
    await page.evaluate(() => {
      const modal = document.createElement("div")
      modal.role = "dialog"
      modal.style.height = "10px"
      modal.setAttribute("aria-modal", "true")
      document.body.append(modal)
    })
    assert.equal((await ask("panes")).drawings[0].isFocused, false)
    await page.evaluate("window.desktop.reconfigure()")
    assert.equal((await ask("selection")).selection, null)
    await ask("copy")
    assert.equal(await page.evaluate("window.desktop.copies.at(-1).present"), true)
    await page
      .locator("[data-chat-thread-id]")
      .evaluate((node) => node.setAttribute("data-chat-thread-id", "b"))
    assert.equal((await ask("selection")).selection, null)
    assert.deepEqual((await ask("panes")).drawings, [])
    await ask("copy")
    assert.equal(await page.evaluate("window.desktop.copies.at(-1).present"), false)
    await page
      .locator("[data-chat-thread-id]")
      .evaluate((node) => node.setAttribute("data-chat-thread-id", "a"))
    await page.evaluate("window.desktop.hidden(true)")
    await ask("copy")
    assert.equal(await page.evaluate("window.desktop.copies.at(-1).present"), false)
    const previousOwner = await page.evaluate("window.desktop.owners.at(-1)[1]")
    await page.evaluate("window.desktop.thread('b')")
    await page.waitForFunction("window.desktop.owners.some(row=>row[0]==='b')")
    const before = await page.evaluate("window.desktop.replies.length")
    await ask("selection", { threadId: "a", owner: previousOwner })
    assert.equal(await page.evaluate("window.desktop.replies.length"), before)
    await page.evaluate("window.desktop.enabled(false)")
    await page.waitForFunction("window.desktop.owners.at(-1)[0]==='detach'")
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          status: "passed",
          errors,
          scenarios: [
            "real selection survives command click",
            "no slash-completion capture",
            "keyboard selection",
            "actual tool request id",
            "old clear retains new selection",
            "turn completion CAS",
            "Escape",
            "cross row drops id",
            "undrawn row drops id",
            "outside text excluded",
            "rich text selection keeps actual row identity",
            "nested tool rows drop ambiguous identity",
            "pane placement/focus",
            "collapsed sidebar",
            "modal focus",
            "configuration clears",
            "actual copy authorization",
            "hidden chat",
            "actual mounted chat owner checked before effect cleanup",
            "old thread request excluded",
            "Mods-off detach"
          ]
        },
        null,
        2
      )
    )
    console.log(
      "PASS desktop selection, private revision, real pane flags and mounted-chat lifecycle (21 scenarios)"
    )
  } catch (error) {
    console.error({ errors, body: await page.locator("body").textContent() })
    throw error
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

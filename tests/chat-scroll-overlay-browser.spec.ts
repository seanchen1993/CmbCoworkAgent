import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const css = await compile(
    readFileSync(resolve(renderer, "index.css"), "utf8").replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => undefined }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const stylesheet = css.build(scanner.scan())
  const output = resolve("output/chat-scroll-overlay-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let currentCase: { width: number; height: number; abovePrompt: boolean } | undefined
  try {
    for (const [width, height] of [
      [600, 900],
      [900, 900],
      [400, 500]
    ])
      for (const abovePrompt of [false, true]) {
        currentCase = { width, height, abovePrompt }
        await page.setViewportSize({ width, height })
        await mount(
          page,
          `
        import {ChatMessageScrollArea} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ChatMessageScrollArea.tsx"))};
        import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
        import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
        window.scrollFixture={scrolls:0,presses:0,actions:[],environment:{randomUUID:typeof crypto.randomUUID,secureContext:window.isSecureContext}};
        let fixtureIntent=0;
        crypto.randomUUID??=()=>"scroll-fixture-"+(++fixtureIntent);
        window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'overlay-owner'});
        window.api.mods.siteRender=async(thread,owner,input)=>({nativeContent:{component:'AbovePrompt',entries:[{ref:0,props:structuredClone(input)}]},id:'overlay',key:'overlay',plugin:'p',title:'Overlay',generation:'g',rows:2,nativeFallback:false,
          tree:{type:'Box',props:{},children:[{type:'Button',props:{key:'plugin-action',label:'Plugin action'},press:{plugin:'p',handle:1}}]}});
        window.api.mods.siteUnmount=async()=>{};
        window.api.mods.siteAct=async(thread,owner,action)=>{
          if(thread!=='a'||owner!=='overlay-owner'||action.pane!=='overlay'||action.generation!=='g')throw Error('FIXTURE_ACTION_SCOPE');
          window.scrollFixture.actions.push(action);
          if(action.kind==='press'){
            if(action.plugin!=='p'||action.handle!==1||!action.intentId)throw Error('FIXTURE_PRESS_CONTRACT');
            window.scrollFixture.presses++;
          }
          return {focused:false};
        };
        window.api.mods.onCardsChanged=()=>()=>{};
        window.api.mods.onConfigurationChanged=()=>()=>{};
        function Fixture(){const[visible,setVisible]=useState(true);const rootRef=useRef(null);window.scrollFixture.rootRef=rootRef;window.scrollFixture.show=()=>setVisible(true);return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
          <ChatMessageScrollArea scrollRef={rootRef} showScrollToBottom={visible} hasUnread unreadCount={8}
            onScrollToBottom={()=>{window.scrollFixture.scrolls++;const viewport=rootRef.current.querySelector("[data-radix-scroll-area-viewport]");viewport.scrollTop=viewport.scrollHeight;setVisible(false)}}>
            <div style={{height:1800}}>Historical messages</div>
          </ChatMessageScrollArea>
          ${abovePrompt ? '<FunctionSite threadId="a" component="AbovePrompt" facts={{isWorking:false}} />' : ""}
          <form style={{height:160,flexShrink:0}}><textarea aria-label="Composer"/></form>
        </div>}
        host.render(<ModsChatScope.Provider value={{threadId:"a",enabled:true}}><Fixture/></ModsChatScope.Provider>);
      `,
          [browserWorkerPlugin()]
        )
        await page.addStyleTag({ content: stylesheet })
        await page.addScriptTag({ content: "window.__name = value => value" })
        const jump = page.getByRole("button", { name: "回到会话底部", exact: true })
        await jump.waitFor()
        assert.equal(
          await page.evaluate(
            "Boolean(window.scrollFixture.rootRef.current.querySelector('[data-radix-scroll-area-viewport]'))"
          ),
          true
        )
        if (abovePrompt)
          await page.getByRole("button", { name: "Plugin action", exact: true }).waitFor()
        const before = await page.evaluate(() => {
          const jump = document.querySelector<HTMLButtonElement>('[aria-label="回到会话底部"]')!
          const area = document.querySelector("[data-chat-message-scroll-area]")!
          const plugin = Array.from(document.querySelectorAll("button")).find(
            (el) => el.textContent === "Plugin action"
          )
          const rect = jump.getBoundingClientRect(),
            bounds = area.getBoundingClientRect()
          const pluginRect = plugin?.getBoundingClientRect()
          const hit = (el: Element) => {
            const r = el.getBoundingClientRect()
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          }
          return {
            height: bounds.height,
            jumpHit: hit(jump),
            pluginHit: plugin ? hit(plugin) : true,
            contained: rect.top >= bounds.top && rect.bottom <= bounds.bottom,
            separated: !pluginRect || rect.bottom <= pluginRect.top,
            composerTop: document.querySelector("form")!.getBoundingClientRect().top
          }
        })
        assert(
          before.contained && before.separated && before.jumpHit && before.pluginHit,
          JSON.stringify(before)
        )
        if (abovePrompt) {
          await page.getByRole("button", { name: "Plugin action", exact: true }).click()
          await page.waitForFunction("window.scrollFixture.presses === 1")
          assert.equal(await page.evaluate("window.scrollFixture.presses"), 1)
          await page.waitForFunction(() => {
            const button = document.querySelector<HTMLButtonElement>(
              '[data-function-control="plugin-action"]'
            )
            return Boolean(
              button && !button.disabled && button.getAttribute("aria-disabled") !== "true"
            )
          })
          await page.getByRole("button", { name: "Plugin action", exact: true }).focus()
          await page.keyboard.press("Enter")
          await page.waitForFunction("window.scrollFixture.presses === 2")
          assert.equal(await page.evaluate("window.scrollFixture.presses"), 2)
        }
        await page.screenshot({
          path: resolve(output, `${width}-${abovePrompt ? "above" : "ordinary"}.png`)
        })
        await jump.click()
        await jump.waitFor({ state: "hidden" })
        assert.equal(await page.evaluate("window.scrollFixture.scrolls"), 1)
        assert(
          await page.evaluate(
            "window.scrollFixture.rootRef.current.querySelector('[data-radix-scroll-area-viewport]').scrollTop > 0"
          )
        )
        const after = await page.locator("form").evaluate((el) => el.getBoundingClientRect().top)
        assert.equal(
          after,
          before.composerTop,
          "Hiding the floating button must not consume layout space"
        )
        await page.evaluate("window.scrollFixture.show()")
        await jump.waitFor()
        await jump.focus()
        await page.keyboard.press("Enter")
        await jump.waitFor({ state: "hidden" })
        assert.equal(await page.evaluate("window.scrollFixture.scrolls"), 2)
      }
    assert.deepEqual(errors, [])
    console.log(
      "Scroll overlay: ordinary and AbovePrompt geometry, hit targets and clicks pass at 600/900"
    )
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "")
    writeFileSync(resolve(output, "failure-body.txt"), body)
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify(
        {
          currentCase,
          error: String(error),
          errors,
          site: await page
            .locator('[data-function-site="AbovePrompt"]')
            .evaluateAll((elements) =>
              elements.map((element) => ({ text: element.textContent, html: element.outerHTML }))
            )
            .catch(() => []),
          counts: await page
            .evaluate(
              "window.scrollFixture ? {scrolls:window.scrollFixture.scrolls,presses:window.scrollFixture.presses,actions:window.scrollFixture.actions,environment:window.scrollFixture.environment} : null"
            )
            .catch(() => null)
        },
        null,
        2
      )
    )
    throw error
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/** Actual MessageBubble/memo/display with host data props; not a DB/append authority test. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import type { Plugin } from "esbuild"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const nativeAssets: Plugin = { name: "conversation-notice-actual-image-assets",
  setup(builder) {
    builder.initialOptions.loader = { ...builder.initialOptions.loader, ".png": "dataurl" }
  } }

async function main() {
  mkdirSync(resolve("output"), { recursive: true })
  const output = mkdtempSync(resolve("output/mods-conversation-notice-browser-"))
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const checks: string[] = [], errors: string[] = []
  let failure = ""
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  const pass = (label: string) => { checks.push(label); console.log("PASS " + label) }
  try {
    await mount(page, `
      import {MessageBubble} from ${JSON.stringify(resolve("src/renderer/src/components/chat/MessageBubble.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {
        const effects=[];
        window.electron={process:{platform:'win32'}};
        window.api.workspace={readFile:async()=>{effects.push('FORBIDDEN_FILE_READ');throw Error('No file route')}};
        const base={id:'actual-row',role:'user',content:'Ordinary typed message',created_at:new Date(1)};
        const stamp={conversationId:'actual-conversation',branchId:'actual-branch',uuid:'actual-row',
          sequence:1,door:'note',messageType:'user',isMeta:true,origin:{kind:'plugin',name:'actual-component'}};
        const systemStamp={...stamp,messageType:'system'};delete systemStamp.isMeta;
        const noticeText='Goal 已暂停：literal\\n可用 /goal resume\\n**literal markdown** <private-tag>';
        function Fixture(){
          const [message,setMessage]=useState(base);
          window.conversationFixture={effects,
            hidden:()=>setMessage({...base,function_row:stamp}),
            invalid:()=>setMessage({...base,content:'UNVERIFIED /goal resume',function_row_invalid:true}),
            notice:()=>setMessage({...base,role:'system',content:noticeText,
              function_row:systemStamp}),
            toolSystem:()=>setMessage({...base,role:'system',content:noticeText,
              function_row:{...systemStamp,door:'tool-message',origin:{kind:'tool',tool:'actual_original_tool'}}}),
            legacy:()=>setMessage({...base,role:'system',content:noticeText}),
            legacyActions:()=>setMessage({...base,role:'system',
              content:'Goal 已暂停\\n暂停原因：original\\n可用 /goal resume'}),
            human:()=>setMessage(base)};
          useEffect(()=>{window.conversationFixture.ready=true},[]);
          return <ModsChatScope.Provider value={{threadId:'thread',enabled:false,ready:true}}>
            <section data-fixture-bubble><MessageBubble message={message} threadId='thread'
              isLoading={false} isStreaming={false}
              onSetGoalFromMessage={text=>effects.push(['goal',text])}/></section>
          </ModsChatScope.Provider>;
        }
        host.render(<Fixture/>);
      }
    `, [browserWorkerPlugin(), nativeAssets])
    await page.waitForFunction("window.conversationFixture?.ready")
    await page.getByText("Ordinary typed message", { exact: true }).waitFor()
    pass("ordinary unmarked human message retains the original bubble")

    await page.evaluate("window.conversationFixture.hidden()")
    await page.waitForFunction("document.querySelector('[data-fixture-bubble]').textContent===''")
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    pass("same-ID durable hidden stamp changes the actual memoized row without a typed bubble or action")

    // Omit isMeta entirely for a strict system stamp; undefined is not valid stored JSON.
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "conversationFixture")
      fixture.notice()
    })
    await page.waitForFunction("document.querySelector('[data-fixture-bubble]').textContent.includes('**literal markdown** <private-tag>')")
    assert.equal(await page.locator("[data-fixture-bubble] .lucide-flag").count(), 0)
    assert.equal(await page.locator("[data-fixture-bubble] strong, [data-fixture-bubble] a").count(), 0)
    assert.equal(await page.locator("[data-fixture-bubble] .liquid-glass-notice--info").count(), 1)
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    pass("SDK note/system displays literal ordinary notice without Goal inference or Markdown actions")

    await page.evaluate("window.conversationFixture.toolSystem()")
    await page.waitForFunction("document.querySelector('[data-fixture-bubble]').textContent.includes('**literal markdown** <private-tag>')")
    assert.equal(await page.locator("[data-fixture-bubble] .liquid-glass-notice--info").count(), 1)
    assert.equal(await page.locator("[data-fixture-bubble] .lucide-flag").count(), 0)
    assert.equal(await page.locator("[data-fixture-bubble] strong, [data-fixture-bubble] a, [data-fixture-bubble] button").count(), 0)
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    pass("canonical provider Tool System side keeps literal UI without Goal or command effects")

    await page.evaluate("window.conversationFixture.invalid()")
    await page.getByText("这条插件会话记录无法验证，已停止用于任务上下文。", { exact: true }).waitFor()
    assert.equal(await page.locator("[data-fixture-bubble]").textContent(),
      "这条插件会话记录无法验证，已停止用于任务上下文。")
    assert.equal(await page.locator("[data-fixture-bubble] a, [data-fixture-bubble] button").count(), 0)
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    pass("same-ID invalid host marker clears unverified text and controls while keeping hook order valid")

    await page.evaluate("window.conversationFixture.legacy()")
    await page.locator("[data-fixture-bubble] .lucide-flag").waitFor()
    assert.equal(await page.locator("[data-fixture-bubble] .liquid-glass-notice--warning").count(), 1)
    pass("removing only provenance rerenders the same-ID row into the unchanged legacy Goal presentation")

    await page.evaluate("window.conversationFixture.legacyActions()")
    await page.locator("[data-fixture-bubble] .font-mono").getByText("/goal resume", { exact: true }).waitFor()
    assert.equal(await page.locator("[data-fixture-bubble] .liquid-glass-notice--warning").count(), 1)
    assert.equal(await page.locator("[data-fixture-bubble] button").count(), 0)
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    pass("original multiline Goal notice renders its command badge without inventing a callback button")

    await page.evaluate("window.conversationFixture.human()")
    await page.getByText("Ordinary typed message", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.conversationFixture.effects"), [])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "ordinary-message-retained.png"), fullPage: true })
    pass("ordinary conversation remains usable after hidden-note and notice display transitions")
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    throw error
  } finally {
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ checks, errors, failure,
      scope: "Actual React MessageBubble and memo/display with controlled host data props; no actual append, storage, model or authority claim." }, null, 2))
    await browser.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

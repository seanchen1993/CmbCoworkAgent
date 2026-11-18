/** Real Virtuoso, message bubbles and protected sites during history recycling. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-performance-20261015/history-scroll")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {useLayoutEffect} from "react";
      import {ChatMessageVirtualList} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ChatMessageVirtualList.tsx"))};
      import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {const owners=new Map(),held=[],calls=[],refs=new Map(),virtual={current:null},range={current:null};
      let sequence=0,hold=false;
      window.api.mods.chatDisplayCapability=async()=>true;
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async(thread,component)=>{
        const owner="scroll-owner-"+(++sequence);owners.set(owner,component);calls.push(["mount",owner]);
        return {state:"mounted",owner};
      };
      window.api.mods.siteRender=async(thread,owner,props)=>{
        calls.push(["render",owner,props.text]);
        if(hold&&props.text?.includes("HISTORY_80"))await new Promise(resolve=>held.push(resolve));
        return {key:owner,id:owner,plugin:"engine",generation:owner,title:owners.get(owner),rows:12,
          closeOnEscape:false,tree:{type:"engine",ref:0},
          nativeContent:{component:owners.get(owner),entries:[{ref:0,props:{...props,text:"SAFE "+props.text}}],nativeUnchanged:false}};
      };
      window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner);calls.push(["unmount",owner])};
      const messages=Array.from({length:160},(_,i)=>({id:"history-"+i,role:i%2?"user":"assistant",
        content:i===81?"USER_HISTORY_81\\n\\n"+"Long user message that should keep its expanded state.\\n\\n".repeat(50):
          i%2?"Question "+i:"HISTORY_"+i+"\\n\\n"+("Historical content with a stable measured row. ".repeat(8+(i%7)*6))+"\\n\\nEnd of message "+i}));
      const noop=()=>{}, maps={tools:new Map(),states:new Map(),hooks:new Map(),durations:new Map(),labels:new Map()},
        indexes=messages.map((_,i)=>i),setRef=()=>noop;
      const withLongAssistant=(heading)=>messages.map((row,index)=>index===20?{...row,content:
        heading+"\\n\\n"+"word ".repeat(2400)+"\\n\\nNATIVE_LONG_MIDDLE_ANCHOR\\n\\n"+"word ".repeat(11200)}:row);
      function Fixture({native=false}){
        const [parent,setParent]=useState(null),[thread,setThread]=useState("a"),
          [history,setHistory]=useState(()=>native?withLongAssistant("NATIVE_LONG_ASSISTANT_20"):messages),
          viewport=useRef(null),state=useModsChatState(thread,"C:/scroll-fixture");
        window.historyScroll.editAssistant=()=>setHistory(withLongAssistant("NATIVE_LONG_ASSISTANT_UPDATED"));
        window.historyScroll.thread=setThread;
        useLayoutEffect(()=>setParent(viewport.current),[]);
        return <ModsChatScope.Provider value={native?{threadId:thread,enabled:false,ready:true}:{threadId:thread,...state}}>
          <div ref={viewport} data-test-viewport style={{height:800,overflow:"auto",overflowAnchor:"none"}}>
            <ChatMessageVirtualList projection={{ messages:history, contentVersion: native?2:1, structureVersion: 1 }} visibleMessageIndexes={indexes} lastUserMessageIndex={159} historyHasMore={false} historyPageLoading={false} historyRemainingCount={0}
              onLoadEarlierHistoryPage={noop} historyGapBeforeMessageId={null} canLoadReleasedHistory={false}
              onLoadReleasedHistoryWindow={noop} onRestoreLatestHistoryWindow={noop} hookLoggingEnabled={false}
              hookLogBucketByTurnId={maps.hooks} detachedHookLogBuckets={[]} contentMessageRefs={{current:refs}}
              setMessageRef={setRef} isLoading={false} toolResults={maps.tools} toolCallStates={maps.states}
              pendingApprovalToolCallKeys={new Set()} pendingApproval={null} autoApproveGitPush={false}
              onApprovalDecision={noop} onEditUserMessage={noop} onSetGoalFromMessage={noop}
              onForkFromMessage={noop} forkingMessageId={null} onOpenHookLogBucket={noop} threadId={thread}
              assistantDurationMsById={maps.durations} userSendTimeLabelById={maps.labels}
              customScrollParent={parent} virtuosoRef={virtual} navigatorVirtualRangeRef={range}
              initialTopMostItemIndex={{index:"LAST",align:"end"}} onInitialVirtualItemsRendered={noop}
              onContentHeightChanged={noop} onAtBottomStateChange={noop} footer={null}/>
          </div>
        </ModsChatScope.Provider>
      }
      window.historyScroll={calls,held:()=>held.length,hold:()=>{hold=true},
        release:()=>{hold=false;held.splice(0).forEach(resolve=>resolve())},
        openNative:()=>host.render(<Fixture native/>),
        unmount:()=>host.render(null),
        jump:index=>virtual.current.scrollToIndex({index,align:"start",behavior:"auto"})};
      host.render(<Fixture/>);}
    `,
      [
        browserWorkerPlugin(),
        {
          name: "chat-fixture-assets",
          setup(builder) {
            builder.onLoad({ filter: /\.png$/ }, (args) => ({
              contents: readFileSync(args.path),
              loader: "dataurl"
            }))
            builder.initialOptions.define = {
              ...builder.initialOptions.define,
              "import.meta.hot": "undefined"
            }
          }
        }
      ]
    )
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css"))) {
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    }
    await page.waitForFunction(
      () => document.querySelector('[data-chat-initial-presentation="ready"]') !== null
    )
    await page.evaluate("window.historyScroll.jump(80)")
    const row = page.locator('[data-chat-message-id="history-80"]')
    await row.getByText(/^SAFE HISTORY_80/).waitFor()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    const before = await row.evaluate((element) => element.getBoundingClientRect().height)
    await page.evaluate("window.historyScroll.jump(159)")
    await row.waitFor({ state: "detached" })
    await page.evaluate("window.historyScroll.hold();window.historyScroll.jump(80)")
    await row.waitFor()
    await page.waitForFunction("window.historyScroll.held() > 0")
    const pending = await row.evaluate((element) => ({
      text: element.textContent,
      height: element.getBoundingClientRect().height,
      protectedReadOnly: element.querySelector("[inert]") !== null
    }))
    const anchorFrames = await row.evaluate(async (element) => {
      const positions: number[] = []
      for (let index = 0; index < 12; index++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        positions.push(element.getBoundingClientRect().top)
      }
      return positions
    })
    writeFileSync(
      join(output, "recycle-evidence.json"),
      JSON.stringify({ before, pending, anchorFrames, errors }, null, 2)
    )
    assert(
      pending.text?.includes("SAFE HISTORY_80"),
      "Recycled history must keep its verified content while revalidating"
    )
    assert(Math.abs(pending.height - before) <= 2, JSON.stringify({ before, pending }))
    assert(
      pending.protectedReadOnly,
      "Retained history must stay read-only until fresh authorization"
    )
    assert(
      Math.max(...anchorFrames) - Math.min(...anchorFrames) <= 2,
      `Revalidating history must not shake the reading position: ${JSON.stringify(anchorFrames)}`
    )
    await page.screenshot({ path: join(output, "recycled-history.png") })
    await page.evaluate("window.historyScroll.release()")
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-chat-message-id="history-80"]')
      return row && !row.querySelector("[inert]")
    })
    await page.evaluate("window.historyScroll.jump(81)")
    const userRow = page.locator('[data-chat-message-id="history-81"]')
    const expand = userRow.locator("[data-chat-search-expand-user-content]")
    await expand.waitFor()
    await expand.click()
    assert.equal(await expand.getAttribute("aria-expanded"), "true")
    const expandedHeight = await userRow.evaluate(
      (element) => element.getBoundingClientRect().height
    )
    await page.evaluate("window.historyScroll.jump(159)")
    await userRow.waitFor({ state: "detached" })
    await page.evaluate("window.historyScroll.jump(81)")
    await userRow.getByText(/^SAFE USER_HISTORY_81/).waitFor()
    await expand.waitFor()
    const restoredUser = {
      expanded: await expand.getAttribute("aria-expanded"),
      height: await userRow.evaluate((element) => element.getBoundingClientRect().height)
    }
    writeFileSync(
      join(output, "user-expansion-evidence.json"),
      JSON.stringify({ expandedHeight, restoredUser }, null, 2)
    )
    assert.equal(
      restoredUser.expanded,
      "true",
      "History recycling must retain the user's explicit expansion"
    )
    assert(
      Math.abs(restoredUser.height - expandedHeight) <= 2,
      JSON.stringify({ expandedHeight, restoredUser })
    )
    assert.deepEqual(errors, [])
    const deletionReads = await page.evaluate(async () => {
      const original = Range.prototype.getBoundingClientRect
      let reads = 0
      Range.prototype.getBoundingClientRect = function () {
        reads++
        return original.call(this)
      }
      try {
        const history = (window as unknown as { historyScroll: { unmount(): void } }).historyScroll
        history.unmount()
        for (let frame = 0; frame < 3; frame++)
          await new Promise<void>((done) => requestAnimationFrame(() => done()))
        return reads
      } finally {
        Range.prototype.getBoundingClientRect = original
      }
    })
    assert.equal(deletionReads, 0, "Deleting protected history must not force content layout")
    console.log(
      "PASS real Virtuoso history recycling keeps protected content, row height and user expansion"
    )

    await page.evaluate("window.historyScroll.openNative()")
    await page.locator('[data-chat-message-id="history-159"]').waitFor()
    await page.evaluate("window.historyScroll.jump(20)")
    const assistantRow = page.locator('[data-chat-message-id="history-20"]')
    const expandAssistant = assistantRow.getByRole("button", { name: "展开全文" })
    const collapseAssistant = assistantRow.getByRole("button", { name: "收起长内容" })
    const recycleAssistant = async () => {
      await page.evaluate("window.historyScroll.jump(159)")
      await assistantRow.waitFor({ state: "detached" })
    }
    await expandAssistant.waitFor()
    assert(!(await assistantRow.textContent())?.includes("NATIVE_LONG_MIDDLE_ANCHOR"))
    await expandAssistant.click()
    assert((await assistantRow.textContent())?.includes("NATIVE_LONG_MIDDLE_ANCHOR"))
    const expandedAssistantHeight = await assistantRow.evaluate(
      row => row.getBoundingClientRect().height
    )
    await recycleAssistant()
    const firstRemount = await page.evaluate(async () => {
      const fixture = window as unknown as { historyScroll: { jump(index: number): void } }
      fixture.historyScroll.jump(20)
      for (let frame = 0; frame < 60; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const row = document.querySelector('[data-chat-message-id="history-20"]')
        if (!row) continue
        return {
          height: row.getBoundingClientRect().height,
          middleRendered: row.textContent?.includes("NATIVE_LONG_MIDDLE_ANCHOR")
        }
      }
      return null
    })
    writeFileSync(
      join(output, "assistant-expansion-evidence.json"),
      JSON.stringify({ expandedAssistantHeight, firstRemount }, null, 2)
    )
    assert(firstRemount?.middleRendered, "The expanded native answer must remain expanded on its first remount frame")
    assert(Math.abs(firstRemount.height - expandedAssistantHeight) <= 2,
      JSON.stringify({ expandedAssistantHeight, firstRemount }))

    await collapseAssistant.click()
    await recycleAssistant()
    await page.evaluate("window.historyScroll.jump(20)")
    await expandAssistant.waitFor()
    assert(!(await assistantRow.textContent())?.includes("NATIVE_LONG_MIDDLE_ANCHOR"))

    await expandAssistant.click()
    await recycleAssistant()
    await page.evaluate("window.historyScroll.editAssistant()")
    await page.evaluate("window.historyScroll.jump(20)")
    await expandAssistant.waitFor()
    assert((await assistantRow.textContent())?.includes("NATIVE_LONG_ASSISTANT_UPDATED"))
    assert(!(await assistantRow.textContent())?.includes("NATIVE_LONG_MIDDLE_ANCHOR"))

    await expandAssistant.click()
    await page.evaluate("window.historyScroll.thread('other')")
    await page.locator('[data-chat-message-id="history-159"]').waitFor()
    await page.evaluate("window.historyScroll.jump(20)")
    await expandAssistant.waitFor()
    assert(!(await assistantRow.textContent())?.includes("NATIVE_LONG_MIDDLE_ANCHOR"))
    assert.deepEqual(errors, [])
    console.log("PASS native assistant expansion survives row recycling and respects collapse, edit and thread changes")
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

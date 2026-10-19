import * as fs from "node:fs"
import * as path from "node:path"
import ts from "typescript"
import { build } from "esbuild"
import { chromium } from "playwright"
import assert from "node:assert/strict"
import { it } from "vitest"
const root = process.cwd()
const file = path.join(root, "src/renderer/src/components/chat/ChatContainer.tsx")
const raw = fs.readFileSync(file, "utf8")
const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = [
  "scheduleBottomScrollEffect",
  "runChatScrollTransition",
  "dispatchChatScrollEvent",
  "confirmOrDetachFromScroll"
]
const bodies = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    if (bodies.has(node.name.getText(ast))) throw Error("Duplicate callback")
    bodies.set(node.name.getText(ast), node.initializer!.getText(ast))
  }
  ts.forEachChild(node, visit)
}
visit(ast)
if (bodies.size !== 4) throw Error("Actual callbacks unavailable")
const source = `
import {createChatScrollState,transitionChatScroll,isChatScrollDetached,shouldFollowChatOutput,
  mergeChatScrollEffects,resolveChatBottomScrollWriter,shouldConfirmChatViewportBottom} from "./src/shared/chat-scroll-controller"
const useCallback=fn=>fn, viewport=document.getElementById("viewport"), body=document.getElementById("body")
let ownedViewport=viewport
const scrollParent=viewport, getViewport=()=>ownedViewport
const CHAT_AT_BOTTOM_THRESHOLD_PX=32, CHAT_SCROLL_UP_DETACH_DELTA_PX=2,
  CHAT_BOTTOM_SETTLE_MAX_FRAMES=60, CHAT_FOLLOW_SETTLE_MAX_FRAMES=12
const chatScrollStateRef={current:null},pendingBottomScrollEffectRef={current:null},bottomScrollFrameRef={current:null},
  bottomSettleAttemptRef={current:0},bottomSettleEffectKeyRef={current:""},lastVisibleMessageIndexRef={current:1},
  messageVirtualizationEnabledRef={current:false},virtuosoRef={current:null},pendingDurableHistoryAnchorRef={current:null},
  lastObservedScrollTopRef={current:0},upwardUserScrollIntentUntilRef={current:0},
  downwardUserScrollIntentUntilRef={current:Infinity},scrollbarUserIntentActiveRef={current:false}
const applyChatScrollEvent=event=>{const t=transitionChatScroll(chatScrollStateRef.current,event);chatScrollStateRef.current=t.state;return t}
${names.map((name) => "const " + name + "=" + bodies.get(name)).join("\n")}
window.actualNearBottom={async run(options={}){
  if(bottomScrollFrameRef.current!==null)cancelAnimationFrame(bottomScrollFrameRef.current)
  bottomScrollFrameRef.current=null;pendingBottomScrollEffectRef.current=null
  bottomSettleAttemptRef.current=0;bottomSettleEffectKeyRef.current=""
  body.style.height="1200px";viewport.scrollTop=1200
  lastObservedScrollTopRef.current=viewport.scrollTop+(options.upward?20:-20)
  chatScrollStateRef.current={...createChatScrollState("control"),generation:7,mode:options.mode||"detached",dataReady:true,hasMessages:true}
  upwardUserScrollIntentUntilRef.current=options.upward?Infinity:0
  downwardUserScrollIntentUntilRef.current=options.noDown?0:Infinity
  scrollbarUserIntentActiveRef.current=!!options.pointer
  let sample
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    body.style.height=(1200+(options.gap??3))+"px"
    if(options.stale){
      const captured={...chatScrollStateRef.current,mode:"following"}
      chatScrollStateRef.current=options.stale==="detached"?{...captured,mode:"detached"}:captured
      if(options.stale==="generation")chatScrollStateRef.current={...captured,generation:8}
      if(options.stale==="viewport")ownedViewport=document.createElement("div")
      if(options.stale==="disconnected")viewport.remove()
      scheduleBottomScrollEffect({type:"scroll-to-bottom",reason:"content-grown",generation:7},{state:captured,viewport})
      sample={gap:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop,mode:chatScrollStateRef.current.mode,
        pending:pendingBottomScrollEffectRef.current?.reason??null,frame:bottomScrollFrameRef.current!==null}
      runChatScrollTransition(applyChatScrollEvent({type:"USER_DETACH",source:"user-input"}))
      ownedViewport=viewport
      if(!viewport.isConnected)document.body.append(viewport)
      resolve()
      return
    }
    if(options.stronger)pendingBottomScrollEffectRef.current={type:"scroll-to-bottom",reason:"return-to-bottom",generation:7}
    confirmOrDetachFromScroll()
    sample={gap:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop,mode:chatScrollStateRef.current.mode,
      pending:pendingBottomScrollEffectRef.current?.reason??null,frame:bottomScrollFrameRef.current!==null}
    resolve()
  })))
  const after=await new Promise(resolve=>requestAnimationFrame(()=>resolve({gap:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop,mode:chatScrollStateRef.current.mode})))
  return {sample,after}
}}
`
async function main() {
  const bundle = await build({
    stdin: { contents: source, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    keepNames: false
  })
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const errors: string[] = [],
    consoleErrors: string[] = [],
    results: Array<{
      sample: { gap: number; mode: string; pending: string | null }
      after: { gap: number }
    }> = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    await page.setContent(
      '<div id="viewport" style="height:300px;width:300px;overflow:auto;overflow-anchor:none"><div id="body" style="height:1200px">Actual DOM geometry</div></div>'
    )
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    for (const options of [
      {},
      { pointer: true },
      { noDown: true },
      { mode: "restoring" },
      { upward: true },
      { gap: 33 },
      { gap: 1 },
      { stronger: true },
      { stale: "detached" },
      { stale: "generation" },
      { stale: "viewport" }
    ]) {
      const result = await page.evaluate(
        (options) =>
          (
            window as unknown as {
              actualNearBottom: {
                run(value: unknown): Promise<{
                  sample: { gap: number; mode: string; pending: string | null }
                  after: { gap: number }
                }>
              }
            }
          ).actualNearBottom.run(options),
        options
      )
      results.push(result)
    }
    assert.equal(results[0].sample.gap, 0)
    assert.equal(results[0].after.gap, 0)
    for (const i of [1, 2, 3, 4, 5])
      assert.equal(results[i].sample.mode, i === 3 ? "restoring" : "detached")
    assert.equal(results[6].sample.gap, 1)
    assert.equal(results[7].sample.pending, "return-to-bottom")
    assert.equal(results[7].sample.gap, 3)
    for (const i of [8, 9, 10]) assert.equal(results[i].sample.gap, 3)
    assert.deepEqual(errors, [])
    assert.deepEqual(consoleErrors, [])
  } finally {
    await browser.close()
  }
}
it("settles only a current user reattachment before the next paint", main, 30000)

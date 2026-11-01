import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import type {
  PromptComposerRequest,
  PromptComposerResponse
} from "../src/shared/mods/v2/prompt-composer"

declare global {
  interface Window {
    paintProbe: { fire(input: Partial<PromptComposerRequest>): Promise<PromptComposerResponse> }
  }
}

async function main() {
  const output = resolve("output/mods-prompt-paint-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (cause) => errors.push(cause.message))
  try {
    await mount(
      page,
      `
      {
      let listener, owner, sequence=0;const replies=[],changes=new Set();
      Object.assign(window.api.mods,{
        promptAttach:async(t,o)=>owner=o,promptDetach:async()=>{},promptAuthorize:async()=>true,
        promptRespond:async value=>replies.push(value),promptEditSupport:async()=>false,
        onPromptRequest:fn=>{listener=fn;return()=>{listener=null}},
        onConfigurationChanged:fn=>{changes.add(fn);return()=>changes.delete(fn)}
      });
      const fire=async request=>{await listener({...request,threadId:'a',owner,requestId:'paint-'+(++sequence)});return replies.at(-1)};
      window.paintProbe={replies,fire,configuration:()=>{for(const fn of changes)fn()}};
      function Fixture(){
        const [text,setText]=useState('a😀中文b'),state=useRef({text:'a😀中文b',revision:0}),node=useRef(null);
        const change=text=>{state.current={text,revision:state.current.revision+1};setText(text)};
        const editor=usePromptComposer({threadId:'a',enabled:true,textarea:node,read:()=>state.current,
          apply:(revision,text)=>{if(state.current.revision!==revision)return false;change(text);return true}});
        return <div style={{position:'relative',width:420}}>
          <PromptDecorations text={text} decorations={editor.decorations} textarea={node} className='paint'/>
          <textarea aria-label='真实草稿' ref={node} value={text} onChange={e=>{change(e.target.value);editor.changed()}}
            onCompositionStart={()=>editor.composition(true)} onCompositionEnd={()=>editor.composition(false)}/>
        </div>
      }host.render(<Fixture/>);
      }
    `
    )
    const draft = page.getByLabel("真实草稿")
    await draft.waitFor()
    await page.waitForFunction("typeof window.paintProbe.fire==='function'")
    await draft.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 3))
    const before = await page.evaluate("window.paintProbe.fire({kind:'read'})")
    const painted = await page.evaluate(async (before) => {
      const p = window.paintProbe
      return p.fire({
        kind: "paint",
        paintSource: "source-a",
        expectedRevision: before.revision,
        text: before.text,
        decorations: [{ start: 1, end: 3, bold: true, virtualText: "display only" }]
      })
    }, before)
    assert.equal(painted.isPainted, true)
    assert.equal(await draft.inputValue(), "a😀中文b")
    assert.equal(await draft.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 3)
    await page.locator("[data-prompt-virtual]").filter({ hasText: "display only" }).waitFor()
    await page.evaluate(
      async (before) =>
        window.paintProbe.fire({
          kind: "paint",
          paintSource: "source-b",
          expectedRevision: before.revision,
          text: before.text,
          decorations: [{ start: 3, end: 5, underline: true }]
        }),
      before
    )
    await page.evaluate(
      async (before) =>
        window.paintProbe.fire({
          kind: "paint",
          paintSource: "source-a",
          expectedRevision: before.revision,
          decorations: []
        }),
      before
    )
    assert.equal(await page.locator("[data-prompt-virtual]").count(), 0)
    assert.equal(await page.locator("[data-prompt-decorations]").count(), 1)
    await draft.fill("user edit")
    await page.locator("[data-prompt-decorations]").waitFor({ state: "detached" })
    const stale = await page.evaluate(
      async (before) =>
        window.paintProbe.fire({
          kind: "paint",
          paintSource: "source-a",
          expectedRevision: before.revision,
          text: "a😀中文b",
          decorations: [{ start: 0, end: 1, bold: true }]
        }),
      before
    )
    assert.equal(stale.isPainted, false)
    assert.equal(await draft.inputValue(), "user edit")
    await page.evaluate(async () => {
      const p = window.paintProbe,
        box = await p.fire({ kind: "read" })
      await p.fire({
        kind: "paint",
        paintSource: "source-b",
        expectedRevision: box.revision,
        text: box.text,
        decorations: [{ start: 0, end: 3, italic: true }]
      })
    })
    await draft.dispatchEvent("compositionstart")
    await page.locator("[data-prompt-decorations]").waitFor({ state: "detached" })
    await draft.dispatchEvent("compositionend")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "paint-actual-composer.png") })
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          checks: [
            "actual renderer acknowledgement",
            "UTF16/Unicode cursor unchanged",
            "virtualText excluded from draft",
            "per-source replacement and clearing",
            "native edit/IME invalidation",
            "stale revision refused"
          ]
        },
        null,
        2
      )
    )
    console.log("PASS production prompt.paint browser: " + output)
  } finally {
    await browser.close()
  }
}
void main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})

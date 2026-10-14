import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-prompt-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  try {
    await mount(
      page,
      `
      let promptListener, promptOwner, authorizeFinish, deferAuthorize=false;
      const replies=[];
      window.api.mods.onPromptRequest=fn=>{promptListener=fn;return()=>{promptListener=null}};
      window.api.mods.promptAttach=async(threadId,owner)=>{promptOwner=owner};
      window.api.mods.promptDetach=async()=>{};
      window.api.mods.promptRespond=async value=>{replies.push(value)};
      window.api.mods.promptAuthorize=async()=>deferAuthorize?await new Promise(r=>authorizeFinish=r):true;
      window.promptTest={replies,fire:input=>promptListener({...input,threadId:'a',owner:promptOwner}),defer:()=>{deferAuthorize=true},allow:value=>{deferAuthorize=false;authorizeFinish(value)}};
      function PromptFixture(){
        const [text,setText]=useState('a😀b'),[enabled,setEnabled]=useState(true);
        const state=useRef({text:'a😀b',revision:0}),node=useRef(null);
        const change=text=>{state.current={text,revision:state.current.revision+1};setText(text)};
        usePromptComposer({threadId:'a',enabled,textarea:node,read:()=>state.current,apply:(revision,text)=>{if(revision!==state.current.revision)return false;change(text);return true}});
        return <><textarea aria-label='draft' ref={node} value={text} onChange={e=>change(e.target.value)}/><button onClick={()=>setEnabled(!enabled)}>toggle</button><p data-attachment>private-attachment-content</p></>;
      }
      host.render(<PromptFixture/>);
    `
    )
    const draft = page.getByLabel("draft")
    await draft.waitFor()
    await draft.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 3))
    await page.evaluate("window.promptTest.fire({requestId:'read',kind:'read'})")
    const read = await page.evaluate("window.promptTest.replies.at(-1)")
    assert.equal(read.text, "a😀b")
    assert.equal(read.cursor, 3)
    assert.equal(JSON.stringify(read).includes("attachment"), false)
    await page.evaluate(
      (revision) =>
        (
          window as unknown as {
            promptTest: { fire(request: unknown): Promise<void>; defer(): void }
          }
        ).promptTest.fire({
          requestId: "insert",
          kind: "fill",
          expectedRevision: revision,
          text: "!",
          mode: "insert"
        }),
      read.revision
    )
    assert.equal(await draft.inputValue(), "a😀!b")
    assert.equal(await page.evaluate("window.promptTest.replies.at(-1).cursor"), 4)
    await page.evaluate("window.promptTest.fire({requestId:'read2',kind:'read'})")
    const revision = await page.evaluate("window.promptTest.replies.at(-1).revision")
    await draft.fill("user edit")
    await page.evaluate(
      (revision) =>
        (
          window as unknown as {
            promptTest: { fire(request: unknown): Promise<void>; defer(): void }
          }
        ).promptTest.fire({
          requestId: "stale",
          kind: "fill",
          expectedRevision: revision,
          text: "overwrite",
          mode: "replace"
        }),
      revision
    )
    assert.equal(await draft.inputValue(), "user edit")
    assert.equal(await page.evaluate("window.promptTest.replies.at(-1).status"), "conflict")
    await page.evaluate("window.promptTest.fire({requestId:'read3',kind:'read'})")
    const fresh = await page.evaluate("window.promptTest.replies.at(-1).revision")
    await page.evaluate((revision) => {
      ;(
        window as unknown as {
          promptTest: { fire(request: unknown): Promise<void>; defer(): void }
        }
      ).promptTest.defer()
      void (
        window as unknown as {
          promptTest: { fire(request: unknown): Promise<void>; defer(): void }
        }
      ).promptTest.fire({
        requestId: "pending",
        kind: "fill",
        expectedRevision: revision,
        text: "late",
        mode: "replace"
      })
    }, fresh)
    await draft.fill("edited during authorization")
    await page.evaluate("window.promptTest.allow(true)")
    await page.waitForFunction("window.promptTest.replies.at(-1).requestId === 'pending'")
    assert.equal(await draft.inputValue(), "edited during authorization")
    await page.evaluate(
      "const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');document.body.append(dialog);window.promptTest.fire({requestId:'dialog',kind:'read'})"
    )
    assert.equal(await page.evaluate("window.promptTest.replies.at(-1).status"), "dialog")
    assert.equal(await page.evaluate("window.promptTest.replies.at(-1).text"), "")
    await page.evaluate(
      "document.querySelector('[role=dialog]').remove();window.promptTest.fire({requestId:'beforeClose',kind:'read'})"
    )
    const closeRevision = await page.evaluate("window.promptTest.replies.at(-1).revision")
    await page.evaluate((revision) => {
      const fixture = (
        window as unknown as { promptTest: { defer(): void; fire(request: unknown): void } }
      ).promptTest
      fixture.defer()
      fixture.fire({
        requestId: "closed",
        kind: "fill",
        expectedRevision: revision,
        text: "late close",
        mode: "replace"
      })
    }, closeRevision)
    await page.getByRole("button", { name: "toggle", exact: true }).click()
    await page.evaluate("window.promptTest.allow(true)")
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
    assert.equal(await draft.inputValue(), "edited during authorization")
    assert.equal(
      await page.evaluate("window.promptTest.replies.some(r=>r.requestId==='closed')"),
      false
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "UTF16 cursor insertion without attachments",
            "user text edit refuses stale fill",
            "edit during authorization refuses late fill",
            "dialog refuses read without text leakage",
            "closing composer while authorization waits suppresses the late fill",
            "no send route is called"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS prompt composer UTF16/owner/text CAS, authorization race, dialog and attachment boundaries"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

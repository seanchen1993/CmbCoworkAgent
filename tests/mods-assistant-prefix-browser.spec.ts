/** Real FunctionSite: a late protected empty prefix must never authorize newer text/actions. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Locator } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-assistant-prefix", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (text: string) => {
    checks.push(text)
    console.log("PASS " + text)
  }
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      {const calls=[],requests=[],owners=new Set();let sequence=0;
      const frame=request=>({key:'pane-'+request.owner,id:request.owner,plugin:'prefix-test',
        generation:'read-'+request.id,title:'protected prefix',rows:12,closeOnEscape:false,
        tree:{type:'Box',props:{},children:[{type:'engine',ref:0},
          {type:'Button',props:{key:'host-action',label:'Host action'},press:{plugin:'prefix-test',handle:1}}]},
        nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:{...request.props,
          text:'PROTECTED '+(request.props.text||'EMPTY')}}]}});
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async()=>{const owner='prefix-owner-'+(++sequence);
        calls.push(['mount',owner]);owners.add(owner);return{state:'mounted',owner}};
      window.api.mods.siteUnmount=async(thread,owner)=>{calls.push(['unmount',owner]);owners.delete(owner)};
      window.api.mods.siteRender=async(thread,owner,props)=>new Promise((resolve,reject)=>{
        const request={id:requests.length,owner,props:structuredClone(props),resolve,reject,settled:false};
        requests.push(request);calls.push(['read',request.id,props.text]);});
      window.api.mods.siteAct=async(thread,owner,action)=>{calls.push(['host-action',owner,action.kind]);return{}};
      function Fixture(){const[text,setText]=useState(''),[row,setRow]=useState(0);
        window.prefix.text=setText;
        window.prefix.reset=()=>{setText('');setRow(value=>value+1)};
        return <ModsChatScope.Provider value={{threadId:'prefix',enabled:true,ready:true}}>
          <FunctionSite key={row} threadId='prefix' component='AssistantMessage' messageId={'message-'+row}
            facts={{text,isFirstOfReply:true}}
            fallback={<p>RAW FALLBACK {text}</p>}
            renderNative={safe=><div>
              <p data-safe-text>{safe.text}</p><p data-renderer-input>CAPTURE {text||'EMPTY'}</p>
              <button onClick={()=>calls.push(['native-click',text])}
                onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')calls.push(['native-key',text])}}>Native action</button>
              <a href='#prefix-test' onClick={event=>{event.preventDefault();calls.push(['native-link',text])}}
                onKeyDown={event=>{if(event.key==='Enter')calls.push(['native-key',text])}}>Native link</a>
            </div>}/>
        </ModsChatScope.Provider>}
      window.prefix={calls,requests,release:(id,failure)=>{const request=requests[id];
        if(!request||request.settled)throw Error('invalid fixture release '+id);
        request.settled=true;if(failure)request.reject(Error(failure));else request.resolve(frame(request))},
        pending:text=>requests.filter(request=>!request.settled&&request.props.text===text).map(request=>request.id)};
      host.render(<Fixture/>)}
    `,
      [browserWorkerPlugin()]
    )
    const pending = async (text: string) => {
      await page.waitForFunction(`window.prefix.pending(${JSON.stringify(text)}).length===1`)
      return (await page.evaluate(`window.prefix.pending(${JSON.stringify(text)})[0]`)) as number
    }
    const release = (id: number, failure?: string) =>
      page.evaluate(`window.prefix.release(${id},${JSON.stringify(failure ?? "")})`)
    const text = (value: string) => page.evaluate(`window.prefix.text(${JSON.stringify(value)})`)
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const actionCount = () =>
      page.evaluate(
        "window.prefix.calls.filter(call=>['host-action','native-click','native-link','native-key'].includes(call[0])).length"
      ) as Promise<number>
    const noRaw = async () => assert.equal(await page.getByText(/RAW FALLBACK/).count(), 0)
    const protectedText = (value: string) => page.getByText(`PROTECTED ${value}`, { exact: true })
    const blockedControls = async (retained: Locator) => {
      const before = await actionCount()
      for (const control of [
        retained.getByRole("button", { name: "Native action", exact: true }),
        retained.getByRole("link", { name: "Native link", exact: true })
      ]) {
        const box = await control.boundingBox()
        assert(box)
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await control.dispatchEvent("click")
        await control.dispatchEvent("keydown", { key: "Enter", bubbles: true })
        await control.dispatchEvent("keydown", { key: " ", bubbles: true })
        await control.evaluate((node) => (node as HTMLElement).focus())
        assert.equal(
          await retained.evaluate((node) => node.contains(document.activeElement)),
          false
        )
      }
      await retained
        .getByRole("button", { name: "Host action", exact: true })
        .dispatchEvent("click")
      await page.keyboard.press("Enter")
      await page.keyboard.press("Space")
      assert.equal(
        await actionCount(),
        before,
        "Retained native controls, host handles, and keyboard handlers must remain revoked"
      )
    }

    const empty = await pending("")
    await text("A")
    await settle()
    await noRaw()
    assert.equal(await page.locator("[data-safe-text]").count(), 0)
    await release(empty)
    await protectedText("EMPTY").waitFor()
    const firstA = await pending("A")
    assert.equal(await protectedText("A").count(), 0)
    assert.equal(await page.getByText("CAPTURE EMPTY", { exact: true }).count(), 1)
    assert.equal(
      await page.getByText("CAPTURE A", { exact: true }).count(),
      0,
      "A late empty frame must retain the renderer captured with its original request"
    )
    await blockedControls(page.locator('[data-function-site="AssistantMessage"] [inert]'))
    pass(
      "late first empty frame paints its captured protected renderer after token A; fresh A and actions remain guarded"
    )

    await release(firstA, "fixture protected read failed")
    await page.getByRole("alert").waitFor()
    assert.equal(await protectedText("EMPTY").count(), 1)
    assert.equal(await protectedText("A").count(), 0)
    await noRaw()
    await blockedControls(page.locator('[data-function-site="AssistantMessage"] [inert]'))
    pass(
      "failed protected A read keeps only the old empty presentation with clicks and keyboard handlers disabled"
    )

    await page.getByRole("button", { name: "重新读取界面", exact: true }).click()
    const retriedA = await pending("A")
    assert.equal(await protectedText("EMPTY").count(), 0)
    await release(retriedA)
    await protectedText("A").waitFor()
    assert.equal(await page.getByText("CAPTURE A", { exact: true }).count(), 1)
    await page.getByRole("button", { name: "Native action", exact: true }).click()
    await page.getByRole("button", { name: "Native action", exact: true }).focus()
    await page.keyboard.press("Enter")
    assert.equal(await actionCount(), 3, "Current protected native controls must actually work")
    await noRaw()
    pass(
      "A appears and native actions become usable only after a fresh successful protected A read"
    )

    await page.evaluate("window.prefix.reset()")
    const oldEmpty = await pending("")
    await text("A")
    await settle()
    await text("B")
    await settle()
    await release(oldEmpty)
    const firstB = await pending("B")
    assert.equal(
      await page.locator("[data-safe-text]").count(),
      0,
      "A replaced prefix lineage must reject the old empty response"
    )
    assert.equal(await page.getByText(/CAPTURE EMPTY|PROTECTED A/).count(), 0)
    await noRaw()
    await release(firstB)
    await protectedText("B").waitFor()
    pass(
      "empty to A to replacement B rejects the late empty response and waits for B's own protected read"
    )

    await page.evaluate("window.prefix.reset()")
    const rolledEmpty = await pending("")
    await text("A")
    await settle()
    await text("B")
    await settle()
    await text("A")
    await settle()
    await release(rolledEmpty)
    const finalA = await pending("A")
    assert.equal(
      await page.locator("[data-safe-text]").count(),
      0,
      "Returning to A must not revive an empty request from before its replacement"
    )
    await release(finalA)
    await protectedText("A").waitFor()
    assert.equal(await protectedText("EMPTY").count(), 0)
    await noRaw()
    pass(
      "empty to A to B to A cannot revive the old empty lineage when facts match an earlier value"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "protected-prefix.png"), fullPage: true })
    writeFileSync(resolve(output, "result.json"), JSON.stringify({ checks, errors }, null, 2))
    console.log(`PASS assistant empty-prefix browser: ${checks.length} scenarios; ${output}`)
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

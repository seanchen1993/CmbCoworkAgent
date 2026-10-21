/** Real dialog, site renderer and native answers; controlled host publication, no Electron claim. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const artifacts = resolve("output/question-site-layout-browser", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const cssPath = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const css = compiler.build(
    new Scanner({}).scanFiles(
      [
        "components/chat/UserInputRequestDialog.tsx",
        "components/chat/FunctionQuestionSite.tsx",
        "components/chat/FunctionSite.tsx",
        "components/chat/FunctionFeedback.tsx",
        "components/ui/button.tsx"
      ].map((path) => ({ content: readFileSync(join(renderer, path), "utf8"), extension: "tsx" }))
    )
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const checks: string[] = [],
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(join(renderer, "lib/mods-chat-scope.tsx"))};
      import {UserInputRequestDialog} from ${JSON.stringify(join(renderer, "components/chat/UserInputRequestDialog.tsx"))};
      {
        let sequence=0,revision=0,layout='legacy';const rows=new Map(),cards=new Set(),answers=[];
        window.api.mods.feedback=async()=>[];
        window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
        window.api.mods.onConfigurationChanged=()=>()=>{};
        window.api.mods.siteMountOutcome=async(threadId,component,messageId,requestId)=>{
          const owner='ask-'+(++sequence);rows.set(owner,{component,requestId});return {state:'mounted',owner}
        };
        window.api.mods.siteUnmount=async(id,owner)=>rows.delete(owner);
        window.api.mods.siteAct=async()=>{};
        window.api.mods.siteRender=async(id,owner,props)=>{
          const row=rows.get(owner),engine={type:'engine',ref:0};
          const context={type:'Text',props:{},children:['QUESTION_CONTEXT '+ 'Explanation '.repeat(350)+'CONTEXT_END']};
          const button={type:'Button',props:{key:'custom-action',label:'Custom action'},press:{plugin:'fixture',handle:1}};
          const tree=layout==='native'?engine:layout==='legacy'?{type:'Box',props:{},children:[context,engine]}:
            {type:'Box',props:{flexDirection:'column',padding:1,borderStyle:'round'},children:[
              {type:'Box',props:{flexDirection:'row',gap:1},children:[context,button]},
              {type:'fragment',children:[{type:'Box',props:{flexDirection:'column'},children:[engine]}]}]};
          return {key:'engine:'+owner,id:owner,plugin:'engine',title:'AskUserQuestion',generation:'g'+revision,
            tree,rows:12,closeOnEscape:false,nativeContent:{component:row.component,requestId:row.requestId,
              entries:[{ref:0,props}],nativeUnchanged:false}};
        };
        function Fixture(){
          const [requestId,setRequestId]=useState('R1');
          window.questionLayout={answers,show:next=>{layout=next;revision++;setRequestId('R'+(revision+1))}};
          const request={requestId,threadId:'thread',createdAt:'2026-10-21T00:00:00Z',questions:[{
            id:'original_choice',header:'Plan',question:'Original question?',options:[
              {label:'Careful',description:'Original careful'},{label:'Fast',description:'Original fast'}]}]};
          return <ModsChatScope.Provider value={{threadId:'thread',enabled:layout!=='off',ready:true}}>
            <main style={{position:'relative',width:'calc(100vw - 32px)',height:'calc(100vh - 32px)',margin:16}}>
              <textarea aria-label='Ordinary draft' defaultValue='Keep my draft'/>
              <UserInputRequestDialog request={request} onSubmit={answer=>answers.push(answer)}/>
            </main>
          </ModsChatScope.Provider>
        }
        host.render(<Fixture/>);
      }
    `,
      [browserWorkerPlugin()]
    )
    await page.addStyleTag({ content: css })
    const dialog = page.getByRole("dialog", { name: "需要用户输入", exact: true })
    for (const [layout, width] of [
      ["legacy", 1000],
      ["nested", 390],
      ["native", 390],
      ["off", 390]
    ] as const) {
      await page.setViewportSize({ width, height: 800 })
      if (layout !== "legacy")
        await page.evaluate((layout) => {
          ;(
            window as unknown as { questionLayout: { show(layout: string): void } }
          ).questionLayout.show(layout)
        }, layout)
      await dialog.getByRole("radio", { name: /Careful/ }).waitFor()
      const scroll = dialog.getByRole("region", { name: "问题内容与补充说明", exact: true })
      const bounds = await dialog.boundingBox()
      assert(
        bounds &&
          bounds.height > 0 &&
          bounds.height <= 520 &&
          bounds.y >= 0 &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= width &&
          bounds.y + bounds.height <= 800
      )
      if (layout === "legacy" || layout === "nested") {
        const context = dialog.getByText(/^QUESTION_CONTEXT /)
        assert.equal(
          await context.textContent(),
          "QUESTION_CONTEXT " + "Explanation ".repeat(350) + "CONTEXT_END"
        )
        assert(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight))
        assert(
          await context.evaluate((node) =>
            Boolean(
              node.compareDocumentPosition(
                node.closest('[role="dialog"]')!.querySelector('[role="radio"]')!
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            )
          ),
          "The real engine stays after the full custom context"
        )
        if (layout === "nested") {
          const custom = dialog.getByRole("button", { name: "Custom action", exact: true })
          assert.equal(await custom.count(), 1, "DIY controls are retained with the nested engine")
          assert(
            await custom.evaluate((node) =>
              Boolean(
                node.compareDocumentPosition(
                  node.closest('[role="dialog"]')!.querySelector('[role="radio"]')!
                ) & Node.DOCUMENT_POSITION_FOLLOWING
              )
            )
          )
        }
        await scroll.focus()
        await page.keyboard.press("End")
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>("[data-user-input-content]")
          return node && node.scrollTop > 0
        })
      }
      const radio = dialog.getByRole("radio", { name: /Fast/ })
      await radio.scrollIntoViewIfNeeded()
      const choice = await radio.boundingBox()
      assert(
        choice &&
          choice.height > 0 &&
          choice.y >= bounds.y &&
          choice.y + choice.height <= bounds.y + bounds.height
      )
      await radio.click()
      const submit = dialog.getByRole("button", { name: "提交", exact: true })
      await submit.scrollIntoViewIfNeeded()
      const footer = await submit.boundingBox()
      assert(footer && footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height)
      assert.equal(await dialog.getByRole("radio").count(), 2)
      assert.equal(await submit.count(), 1)
      await dialog.getByRole("button", { name: "折叠用户输入面板", exact: true }).click()
      await dialog.getByRole("button", { name: "展开用户输入面板", exact: true }).click()
      assert.equal(
        await radio.getAttribute("aria-checked"),
        "true",
        "Collapse keeps the request draft"
      )
      await submit.click()
      assert(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth
        ),
        "Only the question viewport scrolls, not the page"
      )
      const answers = await page.evaluate(
        () =>
          (
            window as unknown as {
              questionLayout: {
                answers: Array<{
                  requestId: string
                  answers: Record<string, { label: string; optionIndex: number }>
                }>
              }
            }
          ).questionLayout.answers
      )
      assert.equal(answers.at(-1)?.answers["original_choice"].label, "Fast")
      assert.equal(answers.at(-1)?.answers["original_choice"].optionIndex, 1)
      assert.equal(
        answers.at(-1)?.requestId,
        layout === "legacy" ? "R1" : layout === "nested" ? "R2" : layout === "native" ? "R3" : "R4"
      )
      assert.equal(
        await page.getByRole("textbox", { name: "Ordinary draft" }).inputValue(),
        "Keep my draft"
      )
      await page.screenshot({ path: join(artifacts, layout + ".png") })
      checks.push(
        layout + ": bounded dialog, reachable original controls, retained draft and answer identity"
      )
    }
    assert.deepEqual(errors, [])
    console.log(checks.join("\n"))
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({ checks, errors }, null, 2))
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

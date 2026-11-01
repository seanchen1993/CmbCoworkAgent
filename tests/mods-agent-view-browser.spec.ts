import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
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
    { base: renderer, onDependency() { /* No watch mode for the standalone fixture. */ } }
  )
  const style = css.build(
    new Scanner({ sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }] }).scan()
  )
  const output = resolve("output/mods-agent-view-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 760 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {AgentViewReceiver} from ${JSON.stringify(resolve(renderer, "components/chat/ModsAgentTranscriptPanel.tsx"))};
      import {SubagentStreamPanel} from ${JSON.stringify(resolve(renderer, "components/chat/SubagentStreamPanel.tsx"))};
      useAppStore.setState({accountRevision:1,currentThreadId:'a',mainView:'thread',threads:[{thread_id:'a',created_at:1,metadata:{workspacePath:'a',cmb_thread_incarnation:'birth'}}]});
      let pending=null, serial=0, status='running', defer=false, finish, broken=false;const viewAgents=new Map();
      const childCalls=[]; window.childFixture={calls:childCalls,open:(id='child')=>{pending={id:'intent-'+(++serial),threadId:'a',workspace:'a',agentId:id,parentIncarnation:'birth',sourceDigest:'digest'};viewAgents.set(pending.id,id)},
        defer:()=>{defer=true},finish:()=>finish?.(),broken:()=>{broken=true},account:()=>useAppStore.setState({accountRevision:2}),
        replace:()=>useAppStore.setState({threads:[{thread_id:'a',created_at:2,metadata:{workspacePath:'a',cmb_thread_incarnation:'new'}}]})};
      window.api.mods.agentViewPending=async()=>{const value=pending;pending=null;return value};
      window.api.mods.agentViewRead=async input=>{const agentId=viewAgents.get(input.intentId);childCalls.push(['read',input]);if(defer){defer=false;window.childFixture.waiting=true;await new Promise(resolve=>finish=resolve);window.childFixture.waiting=false};if(broken)throw Error('MODS_PLUGIN_CHANGED');return {status:{agentId,status,model:'test',description:'受控真实记录展示夹具',startedAt:1,scope:{workspace:'a',readOnly:true,blockedTools:[]}},
        messages:{agentId,messages:[{role:'assistant',text:agentId==='other'?'另一任务原文':input.cursor?'后续原文':'已有原文',toolUses:[],toolResults:[]}],history:'partial',truncated:!input.cursor,skippedMessages:input.cursor?0:1,...(input.cursor?{}:{nextCursor:'page-two'})}}};
      window.api.mods.agentViewStop=async input=>{childCalls.push(['stop',input]);status='stopping';return {agentId:'child',stopRequested:true,status}};
      window.api.mods.agentViewClose=async input=>{childCalls.push(['close',input])};
      function Fixture(){const focused=useAppStore(s=>s.subagentFocusView);const[text,setText]=useState('未发送的父聊天草稿');return <div className='flex h-screen flex-col p-4'>
        <AgentViewReceiver threadId='a' workspace='a'/><textarea aria-label='父聊天输入' value={text} onChange={e=>setText(e.target.value)}/>
        <button onClick={()=>window.childFixture.open()}>模拟已验证的原生查看意图</button>
        {focused?.modsView&&<div className='min-h-0 flex-1'><SubagentStreamPanel/></div>}
      </div>} host.render(<Fixture/>);
    `,
      [
        browserWorkerPlugin(),
        {
          name: "child-test-context",
          setup(build) {
            build.onResolve(
              { filter: /^(?:@\/lib\/(?:store|thread-context)|\.\/store)$/ },
              (args) => ({
                path: args.path === "./store" ? "@/lib/store" : args.path,
                namespace: "child-test"
              })
            )
            build.onLoad({ filter: /.*/, namespace: "child-test" }, (args) => ({
              resolveDir: resolve("."),
              contents: args.path.endsWith("thread-context")
                ? "export const useThreadStateSelector=()=>true; export const useThreadStream=()=>({})"
                : `import {create} from 'zustand';export const useAppStore=create(set=>({threads:[],accountRevision:0,currentThreadId:'a',
          openSubagentFocusView:view=>set({subagentFocusView:view}),closeSubagentFocusView:()=>set({subagentFocusView:null})}));
          export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
            }))
            build.onLoad({ filter: /\.(png|svg)$/ }, () => ({
              contents: 'export default "data:image/png;base64,"',
              loader: "js"
            }))
          }
        }
      ]
    )
    console.log("Mounted child viewer fixture")
    await page.addStyleTag({ content: style })
    const panel = page.getByRole("region", { name: "插件子任务只读记录" })
    await page.getByRole("button", { name: "模拟已验证的原生查看意图" }).click()
    await panel.getByText("已有原文", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("textbox", { name: "父聊天输入" }).inputValue(),
      "未发送的父聊天草稿"
    )
    assert.equal(await panel.getByRole("textbox").count(), 0)
    await panel.getByRole("button", { name: "读取下一页" }).click()
    await panel.getByText("后续原文", { exact: true }).waitFor()
    assert.equal(await panel.getByText("已有原文", { exact: true }).count(), 1)
    assert.match(await panel.innerText(), /1 条消息过大/)
    await panel.getByRole("button", { name: "请求停止子任务" }).dblclick()
    await page.waitForFunction("window.childFixture.calls.filter(x=>x[0]==='stop').length===1")
    assert.match(await panel.innerText(), /正在停止/)
    await page.screenshot({ path: resolve(output, "readonly-task-wide.png") })
    await page.setViewportSize({ width: 375, height: 760 })
    await page.screenshot({ path: resolve(output, "readonly-task-narrow.png") })
    await panel.getByRole("button", { name: "返回父聊天" }).click()
    await panel.waitFor({ state: "detached" })
    assert.equal(
      await page.getByRole("textbox", { name: "父聊天输入" }).inputValue(),
      "未发送的父聊天草稿"
    )
    await page.evaluate("window.childFixture.open()")
    await panel.getByText("已有原文", { exact: true }).waitFor()
    await page.evaluate("window.childFixture.open('main')")
    await panel.waitFor({ state: "detached" })
    await page.evaluate("window.childFixture.open()")
    await panel.getByText("已有原文", { exact: true }).waitFor()
    await page.evaluate("window.childFixture.defer()")
    await panel.getByRole("button", { name: "刷新记录" }).click()
    await page.waitForFunction("window.childFixture.waiting===true")
    await page.evaluate("window.childFixture.open('other')")
    await panel.getByText("另一任务原文", { exact: true }).waitFor()
    assert.equal(await panel.getByText("已有原文", { exact: true }).count(), 0)
    await page.evaluate("window.childFixture.finish()")
    await page.waitForFunction("window.childFixture.waiting===false")
    assert.equal(await panel.getByText("已有原文", { exact: true }).count(), 0)
    await page.evaluate("window.childFixture.open()")
    await panel.getByText("已有原文", { exact: true }).waitFor()
    await page.evaluate("window.childFixture.broken()")
    await panel.getByRole("button", { name: "刷新记录" }).click()
    await panel.getByRole("alert").filter({ hasText: "聊天或插件状态已变化" }).waitFor()
    await page.evaluate("window.childFixture.defer()")
    await panel.getByRole("button", { name: "刷新记录" }).click()
    await page.waitForFunction("window.childFixture.waiting===true")
    await page.evaluate("window.childFixture.account();window.childFixture.finish()")
    await panel.waitFor({ state: "detached" })
    assert.equal(await page.getByText("已有原文", { exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("textbox", { name: "父聊天输入" }).inputValue(),
      "未发送的父聊天草稿"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS child readonly view: native intent, pagination/partial, stop once, return, main, source error, late account fence; " +
        output
    )
  } catch (error) {
    console.error("Browser errors", errors)
    await page.screenshot({ path: resolve(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/** Real composer, mention chips and conversation receipt. No real IM connection. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React,{useState,useRef,useContext} from 'react';
import {createRoot} from 'react-dom/client';
import {BotPrivateMentionInput} from './src/renderer/src/components/bots/BotGroupMentionInput';
import {BotConversationTools} from './src/renderer/src/components/bots/BotConversationTools';
import {ChatToolPresentationContext} from './src/renderer/src/components/chat/chat-presentation-context';
window.electron={process:{platform:'darwin'}};
const groups=[
 {id:'app-room',source:'app',name:'产品协作群',description:'产品助手、研发助手',available:true},
 {id:'im-room',source:'zhaohu',name:'产品协作群',description:'服务 Bot · 群协作助手',available:true},
 {id:'offline-room',source:'zhaohu',name:'已离线的群',description:'服务 Bot · 项目助手',available:false}
];
const bot={id:'private',threadId:'private-thread',name:'私人助手',hostId:'local',color:'#188e87',shape:'circle'};
const client={hostId:'local',messageOrigins:async()=>[]};
const root=createRoot(document.getElementById('root'));
const state=window.fixture={draft:{text:'',mentions:[]},opened:[],generation:0,receipt:false};
function Receipt(){
 const render=useContext(ChatToolPresentationContext);
 const tool={id:'send-call',name:'bot_send_message',args:{groupId:'im-room',groupSource:'zhaohu',content:'请沿用群内讨论整理清单'}};
 return render?.(tool,{content:JSON.stringify({kind:'bot-group-message',groupId:'im-room',groupSource:'zhaohu',messageId:'handoff'}),is_error:false});
}
function Fixture(){
 const [draft,setDraft]=useState(state.draft),ref=useRef(null);
 return <main className="bots-workspace" style={{display:'block',height:'100vh'}}>
  <div style={{maxWidth:740,margin:'auto',padding:'42px 32px'}}>
   <header style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10}}><span style={{width:32,height:32,borderRadius:20,background:'#188e87'}}/><span>私人助手</span></header>
   <div style={{marginTop:60,color:'var(--bot-muted)',fontSize:13}}>本地交互验收 · 示例群聊</div>
   <div style={{marginTop:20,padding:'16px 20px',background:'var(--bot-hover)',borderRadius:20,maxWidth:500}}>可以交给 App 群里的多个 Bot 协作，也可以交给招乎群的服务 Bot，沿用群内讨论继续处理。</div>
   {state.receipt && <div style={{marginTop:24}}><BotConversationTools client={client} botId={bot.id} bots={[bot]} tasks={[]} groups={groups} executionDetails={false} onOpenGroup={(...args)=>state.opened.push(args)}><Receipt/></BotConversationTools></div>}
   <div style={{position:'fixed',bottom:70,left:'50%',transform:'translateX(-50%)',width:'min(700px,calc(100vw - 64px))',border:'1px solid var(--bot-line)',borderRadius:28,padding:'18px 48px',background:'var(--bot-panel)',boxShadow:'0 2px 12px #00000009'}}>
    <BotPrivateMentionInput {...draft} members={[]} inputRef={ref} onEdit={next=>{state.draft=next;setDraft(next)}} onCancelReply={()=>false} onPasteFiles={()=>{}} placeholder="给私人助手发消息…" privateChat={{groups,files:[],disabled:false,onSelectFile:()=>{},onKeyDown:()=>{},onCaret:()=>{}}}/>
   </div>
  </div>
 </main>
}
state.render=()=>root.render(<Fixture key={state.generation}/>);
state.render();`
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "transport-and-unrelated-panes",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "threads",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^@\/lib\/chat-source-navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture"
          }))
          builder.onResolve(
            {
              filter:
                /^\.\/(BotHistorySources|BotExchangePanel|BotBrowserHelpCard|BotDeliveredFile|BotQuestionHistory|BotActivity)$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            contents:
              args.path === "threads"
                ? "const state={messages:[]};const context={getThreadState:()=>state};export const useThreadContext=()=>context;export const useThreadStateSelector=(_id,select)=>select(state);"
                : args.path === "navigation"
                  ? "export const useChatSourceNavigation=()=>({open:()=>{}});"
                  : "export const BotHistorySources=()=>null,BotExchangePanel=()=>null,BotBrowserHelpCard=()=>null,BotDeliveredFile=()=>null,BotDeliveredFiles=()=>null,BotQuestionHistory=()=>null,BotActivity=()=>null;"
          }))
        }
      }
    ]
  })
  const paths = [
    "src/renderer/src/components/bots/BotGroupMentionInput.tsx",
    "src/renderer/src/components/bots/BotMentionLabel.tsx",
    "src/renderer/src/components/bots/BotAvatar.tsx",
    "src/renderer/src/components/bots/BotConversationTools.tsx"
  ]
  const stylesheet = await compile(await readFile("src/renderer/src/index.css", "utf8"), {
    base: resolve("src/renderer/src"),
    onDependency: () => {}
  })
  const css =
    stylesheet.build(
      new Scanner({}).scanFiles(
        await Promise.all(
          paths.map(async (path) => ({
            content: await readFile(path, "utf8"),
            extension: "tsx"
          }))
        )
      )
    ) + (await readFile("src/renderer/src/components/bots/bots.css", "utf8"))
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(
      req.url === "/entry.js"
        ? bundle.outputFiles[0].text
        : `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script type="module" src="/entry.js"></script>`
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 }
    })
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    const editor = page.getByRole("textbox", { name: "私聊消息" })
    await editor.fill("@")
    const app = page.getByRole("option").filter({ hasText: "App 群聊" })
    const im = page
      .getByRole("option")
      .filter({ hasText: "产品协作群" })
      .filter({ hasText: "招乎群聊" })
    assert.equal(await app.count(), 1)
    await im.waitFor()
    assert.equal(
      await page.getByRole("option").filter({ hasText: "已离线的群" }).isDisabled(),
      true
    )
    await mkdir("/tmp/bot-group-handoff-ui", { recursive: true })
    await page.screenshot({
      path: "/tmp/bot-group-handoff-ui/group-picker.png"
    })
    await im.click()
    await page.waitForFunction(
      () => (window as any).fixture.draft.mentions[0]?.groupSource === "zhaohu"
    )
    assert.equal(await editor.locator(".bot-mention-source").innerText(), "招乎")
    await page.keyboard.type("请沿用群内讨论整理清单")
    const selected = await page.evaluate(() => (window as any).fixture.draft.mentions[0])
    assert.equal(selected.groupId, "im-room")
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.generation++
      s.receipt = true
      s.render()
    })
    await page.getByRole("button", { name: "已交办到招乎群 · 产品协作群" }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.opened), [
      ["im-room", "zhaohu"]
    ])
    assert.equal(await editor.locator(".bot-mention-source").innerText(), "招乎")
    await page.screenshot({
      path: "/tmp/bot-group-handoff-ui/handoff-receipt.png"
    })
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.draft = { text: "", mentions: [] }
      s.generation++
      s.render()
    })
    await editor.fill("@产品")
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => (window as any).fixture.draft.mentions[0]?.groupSource === "app"
    )
    assert.equal(await editor.locator(".bot-mention-source").innerText(), "App")
    assert.deepEqual(errors, [])
    console.log(
      "PASS: same-name channel picker, offline guard, typed brief, restored source chip, receipt navigation, App keyboard selection"
    )
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

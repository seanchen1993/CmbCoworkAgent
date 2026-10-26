/** Actual group/card/dialog components; the Host transport and heavyweight unrelated panes are fixtures. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const empty = [
    "BotGroupQuestion",
    "BotGroupQuestionBody",
    "BotQuestionHistory",
    "BotGroupQuestionAnswer",
    "BotGroupSearch",
    "BotConversationTools",
    "BotExchangePanel",
    "ChatContainer",
    "ChatSearchContext",
    "BotJsonFilePreview",
    "BotOfficeFilePreview"
  ]
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {BotGroupConversation} from './src/renderer/src/components/bots/BotGroupConversation';
import {BotDeliveredFile} from './src/renderer/src/components/bots/BotDeliveredFile';
import {BotFilesPanel} from './src/renderer/src/components/bots/BotFilesPanel';
import {BotMessageFilePreview} from './src/renderer/src/components/bots/BotMessageFilePreview';
import {StreamingMarkdown} from './src/renderer/src/components/chat/StreamingMarkdown';
import {ChatPresentationContext} from './src/renderer/src/components/chat/chat-presentation-context';
import {groupDraftKey,sendGroupDraft,useBotGroupDrafts} from './src/renderer/src/lib/bot-group-drafts';
import {insertGroupMention} from './src/renderer/src/lib/bot-group-mentions';
window.electron={process:{platform:'darwin'}};
const root=createRoot(document.getElementById('root'));
const author={id:'author',name:'Original author',shape:'circle',color:'#ff2850'};
const peer={...author,id:'peer',name:'Remaining member'};
const state=window.historyFixture={reads:[],media:[],saves:[],privateSaves:[],groupLists:[],memberLists:[],imports:[],shares:[],render(mode){
 state.mode=mode;
 const group={id:'g',name:'Retained files',memberIds:mode.startsWith('empty')?[]:mode==='current'?['author','peer']:['peer'],version:1};
 const bots=['current','removed'].includes(mode)?[author,peer]:mode.startsWith('empty')?[]:[peer];
 root.render(mode==='native-links'?<ChatPresentationContext.Provider value='bot'><StreamingMarkdown threadId='group-g-native'>{'[URI相对文件](%41.md) '+String.fromCharCode(96)+'%41.md'+String.fromCharCode(96)}</StreamingMarkdown><BotMessageFilePreview client={client} botId='native' threadId='group-g-native' name='Native'/></ChatPresentationContext.Provider>:mode==='private'?<><BotDeliveredFile client={client} botId='private-bot' threadId='private-thread' filePath='/private/report.md'/><BotMessageFilePreview client={client} botId='private-bot' threadId='private-thread' name='Private'/></>:<><BotGroupConversation key={mode} client={client} group={group} bots={bots} tasks={mode==='current'?[{id:'task',threadId:'group-g-peer',botId:'peer',state:'running',origin:{kind:'group',groupId:'g',messageId:'request'}}]:[]} revision={1} userInitials='U' detailOpen={false} onEdit={()=>{}} onDetails={()=>{}} onOpenBot={()=>{}} onBrowser={()=>{}} onFiles={()=>{}}/><BotFilesPanel key={'library-'+mode} client={client} group={group} bot={bots.find(bot=>group.memberIds.includes(bot.id))} peers={bots}/></>);
}};
const libraryPage=()=>({files:[{path:'library.md',is_dir:false,size:12,modified_at:'2026-10-25T00:00:00Z'}],cursor:null});
const client=window.fixtureClient={hostId:'fixture',subscribe(){return()=>{}},async groupFileWorkspace(){return '/group'},async listGroupFiles(...args){state.groupLists.push({mode:state.mode,args});return libraryPage()},async listFiles(...args){state.memberLists.push(args);return libraryPage()},async importFiles(...args){state.imports.push(args);return []},async shareFile(...args){state.shares.push(args);return 'shared.md'},async cancelFileList(){},async groupMessages(){return [{id:'file-delivery',ordinal:1,groupId:'g',authorBotId:'author',text:'[查看正文文件](/group/report.md) [相对路径](report.md) [拒绝越界](../private/secret.md) [拒绝根外绝对路径](/private/secret.md) [拒绝绝对路径穿越](/group/../private/secret.md) [拒绝编码路径穿越](/group/%2e%2e/private/secret.md) [拒绝编码绝对路径](%2Fprivate%2Fsecret.md) '+String.fromCharCode(96)+'report.md'+String.fromCharCode(96),createdAt:1,files:window.historyFixture.mode?.endsWith('link-only')?[]:[{filePath:'/group/report.md',attachmentPath:'/group/.deliveries/snapshot.md',name:'report.md',size:12}]}]},async messageReactions(target,ids){return {revision:1,items:ids.map(messageId=>({messageId,canReact:true,reactions:[]}))}},async exportGroupFile(...args){state.saves.push(args);return true},async exportFile(...args){state.privateSaves.push(args);return true},filePreview:{async readFilePreview(input){state.reads.push(input.source);return {success:true,content:'preserved bytes'}},async openMediaPreview(input){state.media.push(input.source);return {success:false,error:'fixture'}},cancelReadFilePreview(){},revokeMediaPreview(){}}};
state.prepareRetry=async()=>{
 const key=groupDraftKey('fixture','g');
 useBotGroupDrafts.setState({drafts:{}});
 const selected=insertGroupMention('@',{start:0,end:1},[],'author','Original author');
 useBotGroupDrafts.getState().edit(key,{text:selected.text+'Retry once',mentions:selected.mentions});
 state.requests=[];state.loseAck=true;
 await sendGroupDraft(client,{id:'g',memberIds:['author','peer']});
 state.loseAck=false;
 useBotGroupDrafts.setState({drafts:{}});useBotGroupDrafts.getState().restore(key);
 state.render('empty');
};
state.editRetry=()=>useBotGroupDrafts.getState().edit(groupDraftKey('fixture','g'),{text:'@Original author Edited'});
client.sendGroup=async(input)=>{state.requests.push(structuredClone(input));if(state.loseAck)throw new Error('Synthetic lost acknowledgement')};
state.render('removed');`
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
        name: "unrelated-panes",
        setup(b) {
          b.onResolve(
            {
              filter:
                /(?:BotGroupQuestion|BotQuestionHistory|BotGroupQuestionAnswer|BotGroupSearch|BotConversationTools|BotExchangePanel|ChatContainer|ChatSearchContext|thread-context|use-group-questions|FileViewer|BotJsonFilePreview|BotOfficeFilePreview)$/
            },
            (args) => ({ path: args.path.split("/").pop()!, namespace: "fixture" })
          )
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            resolveDir: resolve("."),
            loader: "tsx",
            contents:
              args.path === "thread-context"
                ? "const files=[{path:'report.md',is_dir:false},{path:'A.md',is_dir:false},{path:'%41.md',is_dir:false}];export const useThreadStateSelector=(id,select)=>id?select({workspacePath:id.startsWith('group-g-')?'/group':null,workspaceFiles:files}):null;"
                : args.path === "BotConversationTools"
                ? "export const BotConversationTools=({children})=>children;"
                : args.path === "ChatContainer"
                ? `import {BotDeliveredFile} from './src/renderer/src/components/bots/BotDeliveredFile';import {StreamingMarkdown} from './src/renderer/src/components/chat/StreamingMarkdown';import {emitOpenResourcePreview} from './src/renderer/src/lib/resource-preview-events';export const ChatContainer=({threadId})=><div><BotDeliveredFile client={window.fixtureClient} botId='peer' groupId='g' threadId={threadId} filePath='/group/execution.md'/><StreamingMarkdown threadId={threadId}>[执行记录正文](/group/execution.md)</StreamingMarkdown><button onClick={()=>emitOpenResourcePreview({threadId,filePath:'/group/tool.md',workspacePathKind:'absolute'})}>工具文件预览</button></div>;`
                : args.path === "use-group-questions"
                ? "export const useGroupQuestions=()=>[]"
                : args.path === "FileViewer"
                  ? `import {useEffect} from 'react';export function FileViewer({transport,threadId,filePath,workspacePathKind,markdownBasePath}){useEffect(()=>{const request={source:{threadId,filePath,workspacePathKind},lane:'test',requestToken:filePath};transport.readFilePreview(request);transport.openMediaPreview({...request,source:{threadId,filePath:'/group/image.png',workspacePathKind:'absolute'}})},[transport,threadId,filePath]);return <p data-testid='file-preview' data-base={markdownBasePath}>{filePath}</p>}`
                  : empty.map((name) => `export const ${name}=()=>null;`).join("\n")
          }))
        }
      }
    ]
  })
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(
      req.url === "/entry.js"
        ? bundle.outputFiles[0].text
        : '<meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}.bot-conversation-content,.bot-group-timeline{height:70vh;display:flex;flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}[data-radix-popper-content-wrapper]{z-index:50}</style><div id="root"></div><script type="module" src="/entry.js"></script>'
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath())
      ? {}
      : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
    headless: true
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    for (const mode of ["current", "removed", "deleted", "empty", "private"]) {
      await page.evaluate((mode) => (window as any).historyFixture.render(mode), mode)
      const open = page.getByRole("button", { name: "打开 report.md", exact: true })
      await open.waitFor()
      await page.getByRole("button", { name: "保存 report.md", exact: true }).click()
      await open.click()
      await page.getByTestId("file-preview").waitFor()
      await page.getByRole("button", { name: "保存工作成果", exact: true }).click()
      await page.waitForFunction(() => (window as any).historyFixture.reads.length > 0)
      const state = await page.evaluate(() => (window as any).historyFixture)
      if (mode === "private") {
        assert.deepEqual(state.privateSaves, [
          ["private-bot", "/private/report.md"],
          ["private-bot", "/private/report.md"]
        ])
        assert.equal(state.reads.at(-1).botGroupId, undefined)
        assert.equal(state.reads.at(-1).threadId, "private-thread")
      } else {
        assert.deepEqual(state.saves.slice(-2), [
          ["g", "/group/.deliveries/snapshot.md"],
          ["g", "/group/.deliveries/snapshot.md"]
        ])
        assert.equal(state.privateSaves.length, 0)
        assert.equal(state.reads.at(-1).botGroupId, "g")
        assert.equal(state.media.at(-1).botGroupId, "g")
        assert.equal(
          await page.getByTestId("file-preview").getAttribute("data-base"),
          "/group/report.md"
        )
      }
      await page.keyboard.press("Escape")
      await page.getByTestId("file-preview").waitFor({ state: "hidden" })
      if (mode !== "private") {
        assert.equal(await page.getByRole("link", { name: "拒绝越界", exact: true }).count(), 0)
        assert.equal(await page.getByRole("link", { name: "拒绝根外绝对路径", exact: true }).count(), 0)
        assert.equal(await page.getByRole("link", { name: "拒绝绝对路径穿越", exact: true }).count(), 0)
        assert.equal(await page.getByRole("link", { name: "拒绝编码路径穿越", exact: true }).count(), 0)
        assert.equal(await page.getByRole("link", { name: "拒绝编码绝对路径", exact: true }).count(), 0)
        await page.getByRole("link", { name: "查看正文文件", exact: true }).click()
        await page.getByTestId("file-preview").waitFor()
        assert.equal(await page.getByTestId("file-preview").count(), 1)
        assert.equal(await page.getByTestId("file-preview").textContent(), "/group/report.md")
        await page.keyboard.press("Escape")
        await page.getByTestId("file-preview").waitFor({ state: "hidden" })
        await page.getByRole("link", { name: "相对路径", exact: true }).click()
        await page.getByTestId("file-preview").waitFor()
        assert.equal(await page.getByTestId("file-preview").textContent(), "/group/report.md")
        await page.keyboard.press("Escape")
        await page.getByTestId("file-preview").waitFor({ state: "hidden" })
      }
      if (mode === "current" || mode === "removed") {
        await page.getByRole("link", { name: "report.md", exact: true }).click()
        await page.getByTestId("file-preview").waitFor()
        assert.equal(await page.getByTestId("file-preview").textContent(), "/group/report.md")
        await page.keyboard.press("Escape")
        await page.getByTestId("file-preview").waitFor({ state: "hidden" })
      }
      if (mode !== "private") {
        const openLibrary = async (save = false) => {
          await page.locator('button.bot-file-name[title="library.md"]').click()
          await page.getByTestId("file-preview").waitFor()
          assert.equal(await page.getByTestId("file-preview").count(), 1)
          const source = await page.evaluate(() => (window as any).historyFixture.reads.at(-1))
          assert.equal(source.threadId, "group-files-g")
          assert.equal(source.botGroupId, "g")
          assert.equal(source.filePath, "library.md")
          if (save) {
            const previousSaves = await page.evaluate(() => (window as any).historyFixture.saves.length)
            await page.getByRole("button", { name: "保存工作成果", exact: true }).click()
            await page.waitForFunction((count) => (window as any).historyFixture.saves.length === count + 1, previousSaves)
            assert.deepEqual(
              await page.evaluate(() => (window as any).historyFixture.saves.at(-1)),
              ["g", "library.md"],
              `${mode}: library preview saves through the retained group owner`
            )
          }
          await page.keyboard.press("Escape")
          await page.getByTestId("file-preview").waitFor({ state: "hidden" })
        }
        await openLibrary(true)
        const library = await page.evaluate(() => (window as any).historyFixture)
        assert.equal(library.groupLists.at(-1).mode, mode)
        assert.deepEqual(library.groupLists.at(-1).args, ["g", undefined])
        assert.deepEqual(library.memberLists, [], "group reads never impersonate a member")
        const add = page.getByRole("button", { name: "添加资料", exact: true })
        if (mode === "empty") {
          if (await add.count()) assert.equal(await add.isEnabled(), false)
        } else assert.equal(await add.isEnabled(), true, `${mode}: actual member keeps import`)
        await page.getByRole("button", { name: "library.md的操作", exact: true }).click()
        const share = page.getByRole("button", { name: "分享给 Bot", exact: true })
        if (mode === "empty") {
          if (await share.count()) assert.equal(await share.isEnabled(), false)
        } else assert.equal(await share.isEnabled(), true, `${mode}: actual member keeps sharing`)
        const previousSaves = await page.evaluate(() => (window as any).historyFixture.saves.length)
        await page.getByRole("button", { name: "保存到本机", exact: true }).click()
        await page.waitForFunction((count) => (window as any).historyFixture.saves.length === count + 1, previousSaves)
        assert.deepEqual(
          await page.evaluate(() => (window as any).historyFixture.saves.at(-1)),
          ["g", "library.md"],
          `${mode}: library row exports without a member identity`
        )
        assert.equal(
          await page.evaluate(() => (window as any).historyFixture.privateSaves.length),
          0
        )
        assert.deepEqual(
          await page.evaluate(() => ({
            imports: (window as any).historyFixture.imports,
            shares: (window as any).historyFixture.shares
          })),
          { imports: [], shares: [] }
        )
        await page.keyboard.press("Escape")
        if (mode !== "current") continue
        await page.getByRole("button", { name: "Remaining member · 正在处理", exact: true }).click()
        await openLibrary()
        for (const action of [
          page.getByRole("button", { name: "打开 execution.md", exact: true }),
          page.getByRole("link", { name: "执行记录正文", exact: true }),
          page.getByRole("button", { name: "工具文件预览", exact: true })
        ]) {
          await action.click()
          await page.getByTestId("file-preview").waitFor()
          assert.equal(await page.getByTestId("file-preview").count(), 1)
          await page.keyboard.press("Escape")
          await page.getByTestId("file-preview").waitFor({ state: "hidden" })
        }
        await page.getByRole("button", { name: "返回群聊", exact: true }).click()
        await page.getByRole("button", { name: "打开 report.md", exact: true }).waitFor()
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("resource-preview:open", { detail: {
          threadId:"group-g-peer",filePath:"/group/tool.md",workspacePathKind:"absolute"
        }})))
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
        assert.equal(await page.getByTestId("file-preview").count(), 0, "inspection listener unmounts on return")
      }
    }
    for (const mode of ["deleted-link-only", "empty-link-only"]) {
      await page.evaluate((mode) => (window as any).historyFixture.render(mode), mode)
      const link = page.getByRole("link", { name: "查看正文文件", exact: true })
      await link.waitFor()
      assert.equal(await page.getByRole("button", { name: "打开 report.md", exact: true }).count(), 0)
      await link.click()
      await page.getByTestId("file-preview").waitFor()
      assert.equal(await page.getByTestId("file-preview").count(), 1)
      assert.equal(await page.getByTestId("file-preview").textContent(), "/group/report.md")
      const source = await page.evaluate(() => (window as any).historyFixture.reads.at(-1))
      assert.equal(source.botGroupId, "g")
      assert.equal(source.threadId, "group-files-g")
      await page.keyboard.press("Escape")
      await page.getByTestId("file-preview").waitFor({ state: "hidden" })
    }
    await page.evaluate(() => (window as any).historyFixture.render("native-links"))
    for (const [label, expectedPath] of [["URI相对文件", "/group/A.md"], ["%41.md", "/group/%41.md"]]) {
      const link = page.getByRole("link", { name: label, exact: true })
      await link.waitFor()
      await link.click()
      await page.getByTestId("file-preview").waitFor()
      assert.equal(await page.getByTestId("file-preview").textContent(), expectedPath)
      const source = await page.evaluate(() => (window as any).historyFixture.reads.at(-1))
      assert.equal(source.botGroupId, undefined)
      await page.keyboard.press("Escape")
      await page.getByTestId("file-preview").waitFor({ state: "hidden" })
    }
    await page.evaluate(() => (window as any).historyFixture.prepareRetry())
    const retryButton = page.getByRole("button", { name: "发送群聊消息", exact: true })
    await retryButton.waitFor()
    assert.equal(await retryButton.isEnabled(), true, "an unchanged accepted request remains retryable after all original members leave")
    await retryButton.click()
    await page.waitForFunction(() => (window as any).historyFixture.requests.length === 2)
    const retryCalls = await page.evaluate(() => (window as any).historyFixture.requests)
    assert.deepEqual(retryCalls[1], retryCalls[0], "the real composer resends the exact saved payload")
    await page.evaluate(() => (window as any).historyFixture.prepareRetry())
    await page.evaluate(() => (window as any).historyFixture.editRetry())
    await page.getByText("提及的 Bot 已不在本群，请移除该提及后重新选择。", { exact: true }).waitFor()
    assert.equal(await retryButton.isEnabled(), false, "an edited new request keeps current-membership validation")
    assert.deepEqual(errors, [])
    console.log(
      "PASS: removed author, deleted author, empty group: cards + snapshot preview + media scope + both saves; member-independent group library listing, single preview and group exports, empty-group import/share unavailable; private preview/export and current-member write controls unchanged; real absolute/relative Markdown links including deleted-author/empty link-only history, rejected traversal, library during inspection plus inspected card/link/tool routes and cleanup; real group composer unchanged retry remains exact after member removal, edited request still blocked"
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

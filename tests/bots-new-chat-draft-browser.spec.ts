/** Real new-chat components, synthetic transport/File and navigation; no app/model or user files. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"
const repo = process.cwd()
async function main() {
  const result = await build({
    stdin: {
      resolveDir: repo,
      loader: "tsx",
      contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BotsWorkspace} from './src/renderer/src/components/bots/BotsWorkspace';
import {useBotViewStore} from './src/renderer/src/components/bots/view-store';
import {useBotGroupDrafts,sendGroupDraft} from './src/renderer/src/lib/bot-group-drafts';
const f=window.fixture={change:null,host:null,groups:[],imports:[],sent:[],creates:[],privateSent:[],opens:[],updates:[],createCalls:0,failBotCreate:false,failQueue:false,failImport:false,failGroupSend:false,deferCreate:false,deferBotCreate:false,releaseBot:null,release:null,store:useBotViewStore,groupStore:useBotGroupDrafts};
const clientFor=hostId=>({hostId,
 create:async input=>{f.createCalls++;if(f.failBotCreate){f.failBotCreate=false;if(f.deferBotCreate){f.deferBotCreate=false;await new Promise(resolve=>f.releaseBot=resolve)}throw new Error('synthetic create failed')}const bot={...input,id:'created-'+hostId+'-'+(f.creates.length+1),hostId,threadId:'created-thread-'+(f.creates.length+1),archived:false,deleting:false,version:1,createdAt:1,updatedAt:1};f.creates.push(bot);f.snapshots[hostId]={...f.snapshots[hostId],bots:[...f.snapshots[hostId].bots,bot]};if(f.deferBotCreate){f.deferBotCreate=false;await new Promise(resolve=>f.releaseBot=resolve)}return bot},
 update:async input=>{f.updates.push(input);const bot=f.snapshots[hostId].bots.find(b=>b.id===input.id);Object.assign(bot,input,{version:bot.version+1});return bot},
 open:async botId=>{f.opens.push({hostId,botId})},
 send:async input=>{f.privateSent.push({hostId,...input});return input},
 requestReceipts:async()=>[],
 saveGroup:async input=>{const group={...input,id:'synthetic-group-'+hostId+'-'+(f.groups.length+1),hostId,version:1,createdAt:1,updatedAt:1};f.groups.push(group);f.snapshots[hostId]={...f.snapshots[hostId],groups:[...f.snapshots[hostId].groups,group]};if(f.deferCreate){f.deferCreate=false;await new Promise(resolve=>f.release=resolve)}return group},
 attachFileBytes:async(botId,files,remaining,groupId)=>{f.imports.push({hostId,botId,groupId,files:await Promise.all(files.map(async x=>({name:x.fileName,bytes:Array.from(new Uint8Array(x.bytes))})))});if(f.failImport)throw new Error('synthetic import failure');return files.map(x=>({filename:x.fileName,filePath:'synthetic/'+x.fileName,content:'synthetic bytes only',mimeType:'text/plain',size:x.bytes.byteLength,truncated:false}))},
 sendGroup:async input=>{f.sent.push({hostId,...input});if(f.failGroupSend){f.failGroupSend=false;throw new Error('synthetic group send failed')}return []}
});
const clients={synthetic:clientFor('synthetic'),other:clientFor('other')};f.retryGroup=id=>{const group=f.groups.find(g=>g.id===id);return sendGroupDraft(clients[group.hostId],group)};
window.api={models:{getUserInfo:async()=>null}};window.electron={onNotifyMsg:()=>()=>{}};
function Fixture(){const [view,setView]=useState('bots'),[host,setHost]=useState('synthetic');f.change=setView;f.host=setHost;return <div data-fixture-host={host}>{view==='bots'?<BotsWorkspace client={clients[host]}/>:<button onClick={()=>setView('bots')}>Return synthetic Bots</button>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": repo + "/src/renderer/src" },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "isolated-component-dependencies",
        setup(b) {
          b.onResolve(
            {
              filter:
                /(?:^@\/lib\/(?:store|thread-context)$|^\.\/use-bots$|^\.\/use-bot-read-state$|^\.\/use-bot-works$|^\.\/client$|^\.\/Bot[A-Z]|^@\/components\/chat\/CustomModelDialog$)/
            },
            (a) => {
              if (a.path === "./BotNewChat" || a.path === "./BotChatRecipientPicker")
                return undefined
              return { path: a.path, namespace: "fixture" }
            }
          )
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => {
            let contents = ""
            if (a.path === "@/lib/store")
              contents = `const state={models:[],threads:[],mainView:'bots',showCustomizeView:false,setMainView:v=>window.fixture.change(v),setShowCustomizeView:()=>{},loadThreads:()=>{}};export const useAppStore=Object.assign(selector=>selector(state),{getState:()=>state});`
            else if (a.path === "@/lib/thread-context")
              contents = `const threads={};const current=id=>threads[id]??=( {messages:[],draftInput:'',draftAttachments:[],queuedMessages:[]});const context={initializeThread:id=>current(id),getThreadState:current,getThreadActions:id=>({setDraftInput:text=>current(id).draftInput=text,setDraftAttachments:files=>current(id).draftAttachments=files,addQueuedMessage:(draft,done)=>{if(window.fixture.failQueue)done('synthetic queue write failed');else{current(id).queuedMessages.push(draft);done(null)}},deleteQueuedMessage:(draftId,done)=>{current(id).queuedMessages=current(id).queuedMessages.filter(x=>x.id!==draftId);done?.(null)},getQueuedMessage:draftId=>current(id).queuedMessages.find(x=>x.id===draftId),updateQueuedMessage:(draftId,patch,done)=>{Object.assign(current(id).queuedMessages.find(x=>x.id===draftId),patch);done?.(null)}}),subscribeToThreadState:()=>()=>{}};export const useThreadContext=()=>(window.fixture.threads=threads,context);export const useThreadStateSummaries=()=>({});`
            else if (a.path === "./use-bots")
              contents = `const bot={id:'synthetic-bot',hostId:'synthetic',threadId:'synthetic-thread',name:'Synthetic Bot',instructions:'',modelRef:null,color:'#ed2040',shape:'drop',archived:false,deleting:false,version:1,createdAt:1,updatedAt:1};const snapshot={bots:[bot],groups:[],tasks:[],activities:[],workActivity:[],schedules:[],backgroundThreads:[],revision:1};const snapshots={};export const useBots=client=>(window.fixture.snapshots=snapshots,{snapshot:snapshots[client.hostId]??=({...snapshot,groups:[],bots:[{...bot,hostId:client.hostId,id:'synthetic-bot-'+client.hostId,threadId:'synthetic-thread-'+client.hostId}]}),error:null,retry:()=>{}});`
            else if (a.path === "./use-bot-read-state")
              contents = "export const useBotReadState=()=>{};"
            else if (a.path === "./use-bot-works")
              contents =
                "export const useBotWorks=()=>({items:[],priority:[],selected:null,loading:false,error:null});"
            else if (a.path === "./client")
              contents = 'export const localBotClient=()=>({hostId:"synthetic"});'
            else if (a.path === "./BotConversation")
              contents =
                "export const BotConversation=({onConfigureModel})=><button onClick={onConfigureModel}>Configure synthetic profile</button>;"
            else if (a.path === "./BotWorkspaceMenu")
              contents =
                "export const BotWorkspaceMenu=({onWorkbench})=><button onClick={onWorkbench}>Synthetic workbench menu</button>;"
            else {
              const names = [
                "BotConversation",
                "BotGroupAvatar",
                "BotStorefrontIcon",
                "BotAvatar",
                "BotRuntimeAvatar",
                "BotAppearancePicker",
                "BotAvatarEditor",
                "BotDeleteDialog",
                "BotMemoryPanel",
                "BotSchedulePanel",
                "BotGroupEditor",
                "BotNameInput",
                "BotGroupMembers",
                "BotGroupConversation",
                "BotDetailsPane",
                "BotSectionEditor",
                "BotRowMenu",
                "BotConversationList",
                "BotProfileLabel",
                "BotBrowserPanel",
                "BotFilesPanel",
                "BotWorkPanel",
                "BotImChannelDialog",
                "BotMockChannelDialog",
                "BotPanelDivider",
                "CustomModelDialog"
              ]
              contents = names
                .map((n) => "export const " + n + "=({children})=><>{children}</>;")
                .join("\n")
            }
            return { contents, loader: "tsx", resolveDir: repo }
          })
        }
      }
    ]
  })
  const browser = await chromium.launch({
    ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
    headless: true
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    const errors: string[] = []
    page.on("pageerror", (e) => {
      errors.push(e.message)
      console.error("fixture page error:", e.message)
    })
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("https://synthetic-fixture.invalid")
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    const draft = page.getByRole("textbox", { name: "新聊天草稿", exact: true })
    await draft.fill("Synthetic unsent draft retained during navigation")
    await page.getByRole("combobox", { name: "选择聊天收件人", exact: true }).fill("Synthetic")
    await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic bytes only")
    })
    assert.equal(await draft.inputValue(), "Synthetic unsent draft retained during navigation")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 1)
    assert.equal(await page.getByLabel("移除附件 synthetic.txt", { exact: true }).count(), 1)
    await page.getByRole("button", { name: "Synthetic workbench menu", exact: true }).click()
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Synthetic unsent draft retained during navigation")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 1)
    assert.equal(await page.getByLabel("移除附件 synthetic.txt", { exact: true }).count(), 1)
    assert.deepEqual(
      await page.evaluate(async () => {
        const file = (window as any).fixture.store.getState().newChatDrafts.synthetic.files[0]
        return { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }
      }),
      { name: "synthetic.txt", bytes: Array.from(Buffer.from("synthetic bytes only")) }
    )
    // Closing the composer retains the original draft, matching its existing text/file contract.
    await page.getByRole("button", { name: "关闭新聊天", exact: true }).click()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Synthetic unsent draft retained during navigation")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 1)
    // Different hosts must never see each other's unsubmitted source File or recipients.
    await page.evaluate(() => (window as any).fixture.host("other"))
    await page.locator('[data-fixture-host="other"]').waitFor()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "")
    assert.equal(await page.getByLabel("移除附件 synthetic.txt", { exact: true }).count(), 0)
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 0)
    await draft.fill("Other host draft")
    await page.evaluate(() => (window as any).fixture.host("synthetic"))
    await page.locator('[data-fixture-host="synthetic"]').waitFor()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Synthetic unsent draft retained during navigation")
    // New chat state does not write or serialize File references through view persistence.
    assert.deepEqual(
      await page.evaluate(() =>
        Object.keys(JSON.parse(localStorage.getItem("cmb-bots-view-v1") || "{}").state || {})
      ),
      []
    )
    // Session-only edits also work while the existing preferences storage is unavailable.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.oldSetItem = Storage.prototype.setItem
      f.storageWrites = 0
      Storage.prototype.setItem = function () {
        f.storageWrites++
        throw new Error("synthetic storage unavailable")
      }
    })
    await draft.fill("storage failure must not block editing")
    assert.equal(await draft.inputValue(), "storage failure must not block editing")
    await draft.fill("Synthetic unsent draft retained during navigation")
    assert.equal(await page.evaluate(() => (window as any).fixture.storageWrites), 0)
    await page.evaluate(() => (Storage.prototype.setItem = (window as any).fixture.oldSetItem))
    // Failed preparation leaves the source intact; cached created group survives navigation retry.
    await page.evaluate(() => ((window as any).fixture.failImport = true))
    const recipients = page.getByRole("combobox", { name: "选择聊天收件人", exact: true })
    await recipients.press("Enter")
    await page.getByRole("alert").getByText("synthetic import failure", { exact: true }).waitFor()
    assert.equal(await draft.inputValue(), "Synthetic unsent draft retained during navigation")
    assert.equal(await page.getByLabel("移除附件 synthetic.txt", { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.groups.length), 1)
    await page.getByRole("button", { name: "Synthetic workbench menu", exact: true }).click()
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await page.evaluate(() => ((window as any).fixture.failImport = false))
    await recipients.press("Enter")
    await page
      .locator(".bot-new-chat")
      .waitFor({ state: "detached" })
      .catch(async (error) => {
        console.error(
          "handoff fixture state",
          await page.evaluate(() => ({
            alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
              (x) => x.textContent
            ),
            groups: (window as any).fixture.groups,
            source: Object.fromEntries(
              Object.entries((window as any).fixture.store.getState().newChatDrafts).map(
                ([id, draft]: [string, any]) => [
                  id,
                  { text: draft.text, busy: draft.busy, recipients: draft.recipients }
                ]
              )
            )
          }))
        )
        throw error
      })
    assert.equal(await page.evaluate(() => (window as any).fixture.groups.length), 1)
    assert.deepEqual(
      await page
        .evaluate(() => {
          const f = (window as any).fixture,
            s = f.store.getState().newChatDrafts.synthetic,
            target = f.groupStore.getState().drafts[JSON.stringify(["synthetic", f.groups[0].id])]
          return {
            source: [s.text, s.files.length, s.recipients.length, s.transfer.current],
            target: [target.text, target.attachments.length, target.attachments[0].filename]
          }
        })
        .then((x) => ({ source: x.source.slice(0, 3), target: x.target })),
      {
        source: ["", 0, 0],
        target: ["Synthetic unsent draft retained during navigation", 1, "synthetic.txt"]
      }
    )
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 0)
    // A late group-create response cannot move data or send after workspace unmount/host switch.
    await draft.fill("Late creation draft")
    await recipients.fill("Synthetic")
    await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
    await page.evaluate(() => ((window as any).fixture.deferCreate = true))
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.getByText("正在准备聊天…", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Synthetic workbench menu", exact: true }).click()
    await page.evaluate(() => (window as any).fixture.host("other"))
    await page.locator('[data-fixture-host="other"]').waitFor()
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Other host draft")
    await draft.fill("Other host edited while old create pending")
    await page.evaluate(() => (window as any).fixture.release())
    await page.waitForFunction(
      () => !(window as any).fixture.store.getState().newChatDrafts.synthetic.busy
    )
    assert.equal(await draft.inputValue(), "Other host edited while old create pending")
    assert.equal(await page.evaluate(() => (window as any).fixture.sent.length), 0)
    await page.evaluate(() => (window as any).fixture.host("synthetic"))
    await page.locator('[data-fixture-host="synthetic"]').waitFor()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Late creation draft")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 1)
    const beforeRetry = await page.evaluate(() => (window as any).fixture.groups.length)
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page
      .locator(".bot-new-chat")
      .waitFor({ state: "detached" })
      .catch(async (error) => {
        console.error(
          "handoff fixture state",
          await page.evaluate(() => ({
            alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
              (x) => x.textContent
            ),
            groups: (window as any).fixture.groups,
            source: Object.fromEntries(
              Object.entries((window as any).fixture.store.getState().newChatDrafts).map(
                ([id, draft]: [string, any]) => [
                  id,
                  { text: draft.text, busy: draft.busy, recipients: draft.recipients }
                ]
              )
            )
          }))
        )
        throw error
      })
    assert.equal(await page.evaluate(() => (window as any).fixture.groups.length), beforeRetry)
    assert.equal(await page.evaluate(() => (window as any).fixture.sent.length), 1)
    assert.equal(
      await page.evaluate(() => (window as any).fixture.sent[0].text),
      "Late creation draft"
    )
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "")
    assert.equal(await page.getByLabel("移除 Synthetic Bot", { exact: true }).count(), 0)
    // A new private Bot's first send keeps the established durable queue ownership contract.
    await draft.fill("Private synthetic first send")
    await recipients.fill("Synthetic")
    await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
    await recipients.fill("Private synthetic")
    await page
      .getByRole("option", { name: "将“Private synthetic”添加为新 Bot", exact: true })
      .click()
    await page.getByLabel("移除 Synthetic Bot", { exact: true }).click()
    await page.locator('input[type="file"]').setInputFiles({
      name: "private.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("private synthetic bytes")
    })
    await page.evaluate(() => ((window as any).fixture.failQueue = true))
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
    await page
      .getByRole("alert")
      .getByText("synthetic queue write failed", { exact: true })
      .waitFor()
    assert.equal(await draft.inputValue(), "Private synthetic first send")
    assert.equal(await page.getByLabel("移除附件 private.txt", { exact: true }).count(), 1)
    const retainedFileImports = await page.evaluate(() => (window as any).fixture.imports.length)
    await page.getByRole("button", { name: "Synthetic workbench menu", exact: true }).click()
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Private synthetic first send")
    assert.equal(await page.getByLabel("移除 Private synthetic", { exact: true }).count(), 1)
    await page.evaluate(() => ((window as any).fixture.failQueue = false))
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page
      .locator(".bot-new-chat")
      .waitFor({ state: "detached" })
      .catch(async (error) => {
        console.error(
          "handoff fixture state",
          await page.evaluate(() => ({
            alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
              (x) => x.textContent
            ),
            groups: (window as any).fixture.groups,
            source: Object.fromEntries(
              Object.entries((window as any).fixture.store.getState().newChatDrafts).map(
                ([id, draft]: [string, any]) => [
                  id,
                  { text: draft.text, busy: draft.busy, recipients: draft.recipients }
                ]
              )
            )
          }))
        )
        throw error
      })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          creates: f.creates.length,
          sends: f.privateSent.length,
          queued: f.threads[f.creates[0].threadId].queuedMessages.length,
          imports: f.imports.length,
          opens: f.opens.length
        }
      }),
      { creates: 1, sends: 1, queued: 0, imports: retainedFileImports, opens: 0 }
    )
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "")
    assert.equal(await page.getByLabel("移除附件 private.txt", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "Synthetic workbench menu", exact: true }).click()
    assert.equal(
      await page.evaluate(() => (window as any).fixture.store.getState().newChatDrafts.synthetic),
      undefined
    )
    const persisted = await page.evaluate(
      () => JSON.parse(localStorage.getItem("cmb-bots-view-v1") || "{}").state
    )
    assert.deepEqual(Object.keys(persisted), ["hosts"])
    // BotEditor client.create is a separate async entrance from the group prepare path above.
    const resetFixture = async () => {
      await page.goto("https://synthetic-fixture.invalid")
      await page.evaluate(() => localStorage.clear())
      await page.addScriptTag({ content: result.outputFiles[0].text })
      await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
      await page.keyboard.press("Control+Shift+N")
    }
    const stageNewRecipient = async (name: string, text: string, fileName: string) => {
      await draft.fill(text)
      await recipients.fill("Synthetic")
      await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
      await recipients.fill(name)
      await page.getByRole("option", { name: `将“${name}”添加为新 Bot`, exact: true }).click()
      await page.getByLabel("移除 Synthetic Bot", { exact: true }).click()
      await page.locator('input[type="file"]').setInputFiles({
        name: fileName,
        mimeType: "text/plain",
        buffer: Buffer.from(fileName + " synthetic bytes")
      })
    }
    const startDeferredPrivateCreate = async () => {
      await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
      await page.evaluate(() => ((window as any).fixture.deferBotCreate = true))
      await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
      await page.waitForFunction(() => typeof (window as any).fixture.releaseBot === "function")
    }
    // Same-host remount: the old completion may cache its profile, but must not send old text,
    // overwrite recipients, or clear newly edited File/text. Explicit retry reuses that profile.
    await resetFixture()
    await stageNewRecipient("Private pending remount", "Old host unsent draft", "old.txt")
    await startDeferredPrivateCreate()
    await page.evaluate(() => (window as any).fixture.change("thread"))
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await draft.fill("New source edited after remount")
    await page.getByLabel("移除附件 old.txt", { exact: true }).click()
    await page.locator('input[type="file"]').setInputFiles({
      name: "new.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("new replacement bytes")
    })
    // Retry before the old response: the staged recipient is still owned by that operation.
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page
      .getByRole("alert")
      .getByText(/这位 Bot 正在创建/)
      .waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await draft.isEnabled(), true)
    assert.equal(await page.evaluate(() => (window as any).fixture.createCalls), 1)
    // Adding another staged recipient must not duplicate the still-pending one in group prepare.
    await recipients.fill("Another staged recipient")
    await page
      .getByRole("option", { name: "将“Another staged recipient”添加为新 Bot", exact: true })
      .click()
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page
      .getByRole("alert")
      .getByText(/这位 Bot 正在创建/)
      .waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.createCalls), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.groups.length), 0)
    await page.getByLabel("移除 Another staged recipient", { exact: true }).click()
    await page.evaluate(() => {
      const f = (window as any).fixture,
        d = f.store.getState().newChatDrafts.synthetic,
        pending = d.pendingRecipients.current,
        remove = pending.delete
      pending.delete = function (key) {
        f.cacheBeforeRelease = d.createdRecipients.current.has(key)
        return remove.call(this, key)
      }
      f.releaseBot()
    })
    await page.waitForFunction(() =>
      (window as any).fixture.store
        .getState()
        .newChatDrafts.synthetic.createdRecipients.current.has("new:private pending remount")
    )
    assert.equal(await page.evaluate(() => (window as any).fixture.cacheBeforeRelease), true)
    assert.equal(await draft.inputValue(), "New source edited after remount")
    assert.equal(await page.getByLabel("移除 Private pending remount", { exact: true }).count(), 1)
    assert.equal(await page.getByLabel("移除附件 new.txt", { exact: true }).count(), 1)
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          creates: f.creates.length,
          sends: f.privateSent.length,
          imports: f.imports.length,
          selected: f.store.getState().hosts.synthetic?.selectedId ?? null
        }
      }),
      { creates: 1, sends: 0, imports: 0, selected: null }
    )
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          creates: f.creates.length,
          sends: f.privateSent.length,
          imports: f.imports.length,
          filename: f.imports[0].files[0].name,
          bytes: f.imports[0].files[0].bytes,
          hasNewText: f.privateSent[0].message.includes("New source edited after remount"),
          hasOldText: f.privateSent[0].message.includes("Old host unsent draft")
        }
      }),
      {
        creates: 1,
        sends: 1,
        imports: 1,
        filename: "new.txt",
        bytes: Array.from(Buffer.from("new replacement bytes")),
        hasNewText: true,
        hasOldText: false
      }
    )
    // Host switch: accepted old result stays in its original cache and never alters the new host.
    await resetFixture()
    await stageNewRecipient("Private pending host", "Old host kept draft", "host-old.txt")
    await startDeferredPrivateCreate()
    await page.evaluate(() => (window as any).fixture.host("other"))
    await page.locator('[data-fixture-host="other"]').waitFor()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await draft.fill("Other host independent draft")
    await page.locator('input[type="file"]').setInputFiles({
      name: "host-new.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("other host File")
    })
    await page.evaluate(() => (window as any).fixture.releaseBot())
    await page.waitForFunction(() =>
      (window as any).fixture.store
        .getState()
        .newChatDrafts.synthetic.createdRecipients.current.has("new:private pending host")
    )
    assert.equal(await draft.inputValue(), "Other host independent draft")
    assert.equal(await page.getByLabel("移除附件 host-new.txt", { exact: true }).count(), 1)
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          sends: f.privateSent.length,
          oldText: f.store.getState().newChatDrafts.synthetic.text,
          oldRecipients: f.store.getState().newChatDrafts.synthetic.recipients,
          newRecipients: f.store.getState().newChatDrafts.other.recipients,
          imports: f.imports.length
        }
      }),
      {
        sends: 0,
        oldText: "Old host kept draft",
        oldRecipients: [{ kind: "new", name: "Private pending host" }],
        newRecipients: [],
        imports: 0
      }
    )
    await page.evaluate(() => (window as any).fixture.host("synthetic"))
    await page.locator('[data-fixture-host="synthetic"]').waitFor()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await recipients.press("Enter")
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture,
          t = f.threads[f.creates[0].threadId]
        return {
          creates: f.creates.length,
          sends: f.privateSent.length,
          opens: f.opens.length,
          text: t.draftInput,
          file: t.draftAttachments[0].filename,
          newHost: f.store.getState().newChatDrafts.other.text
        }
      }),
      {
        creates: 1,
        sends: 0,
        opens: 1,
        text: "Old host kept draft",
        file: "host-old.txt",
        newHost: "Other host independent draft"
      }
    )
    // Cancel a send-intent editor, close/reopen its source, then choose draft intent.
    // The current legal create must obey the new intent, not the cancelled send.
    await resetFixture()
    await stageNewRecipient("Private cancelled send", "Keep a draft only", "cancel.txt")
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("button", { name: "关闭新聊天", exact: true }).click()
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await draft.inputValue(), "Keep a draft only")
    assert.equal(await page.getByLabel("移除附件 cancel.txt", { exact: true }).count(), 1)
    await recipients.press("Enter")
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture,
          t = f.threads[f.creates[0].threadId]
        return {
          creates: f.creates.length,
          sends: f.privateSent.length,
          opens: f.opens.length,
          text: t.draftInput,
          file: t.draftAttachments[0].filename
        }
      }),
      { creates: 1, sends: 0, opens: 1, text: "Keep a draft only", file: "cancel.txt" }
    )
    // Empty direct-picker source still owns its pending create across unmount.
    await resetFixture()
    await recipients.fill("Empty source pending")
    await page
      .getByRole("option", { name: "创建名为“Empty source pending”的 Bot", exact: true })
      .click()
    await page.evaluate(() => ((window as any).fixture.deferBotCreate = true))
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
    await page.waitForFunction(() => typeof (window as any).fixture.releaseBot === "function")
    await page.evaluate(() => (window as any).fixture.change("thread"))
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.store.getState().newChatDrafts.synthetic.pendingRecipients.current
            .size
      ),
      1
    )
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await recipients.fill("Empty source pending")
    await page
      .getByRole("option", { name: "创建名为“Empty source pending”的 Bot", exact: true })
      .click()
    await page
      .getByRole("alert")
      .getByText(/这位 Bot 正在创建/)
      .waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.createCalls), 1)
    await draft.fill("New text while original profile is pending")
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: "empty-later.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("editable source File")
      })
    await page.evaluate(() => (window as any).fixture.releaseBot())
    await page.waitForFunction(() =>
      (window as any).fixture.store
        .getState()
        .newChatDrafts.synthetic.createdRecipients.current.has("new:empty source pending")
    )
    await recipients.fill("Empty source pending")
    await page
      .getByRole("option", { name: "创建名为“Empty source pending”的 Bot", exact: true })
      .click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture,
          t = f.threads[f.creates[0].threadId]
        return {
          calls: f.createCalls,
          profiles: f.creates.length,
          sends: f.privateSent.length,
          text: t.draftInput,
          file: t.draftAttachments[0].filename,
          pending: f.store.getState().newChatDrafts.synthetic.pendingRecipients.current.size,
          cache: f.store.getState().newChatDrafts.synthetic.createdRecipients.current.size
        }
      }),
      {
        calls: 1,
        profiles: 1,
        sends: 0,
        text: "New text while original profile is pending",
        file: "empty-later.txt",
        pending: 0,
        cache: 0
      }
    )
    // A failed create releases just its own key; a current explicit retry may create again.
    await resetFixture()
    await stageNewRecipient("Failed pending recipient", "Retry original failure", "failure.txt")
    await page.evaluate(() => ((window as any).fixture.failBotCreate = true))
    await startDeferredPrivateCreate()
    await page.evaluate(() => (window as any).fixture.change("thread"))
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await draft.fill("Edited after failed attempt")
    await page.evaluate(() => (window as any).fixture.releaseBot())
    await page.waitForFunction(
      () =>
        !(window as any).fixture.store.getState().newChatDrafts.synthetic.pendingRecipients.current
          .size
    )
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.store.getState().newChatDrafts.synthetic.createdRecipients.current
            .size
      ),
      0
    )
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          calls: f.createCalls,
          profiles: f.creates.length,
          sends: f.privateSent.length,
          currentText: f.privateSent[0].message.includes("Edited after failed attempt")
        }
      }),
      { calls: 2, profiles: 1, sends: 1, currentText: true }
    )
    // Unrelated staged keys can still prepare a group while an old private key is pending.
    await resetFixture()
    await stageNewRecipient(
      "Only pending key",
      "Group with different new recipients",
      "different.txt"
    )
    await startDeferredPrivateCreate()
    await page.evaluate(() => (window as any).fixture.change("thread"))
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).waitFor()
    await page.keyboard.press("Control+Shift+N")
    await page.getByLabel("移除 Only pending key", { exact: true }).click()
    await recipients.fill("Synthetic")
    await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
    for (const name of ["Different group A", "Different group B"]) {
      await recipients.fill(name)
      await page.getByRole("option", { name: `将“${name}”添加为新 Bot`, exact: true }).click()
    }
    await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          calls: f.createCalls,
          profiles: f.creates.length,
          groups: f.groups.length,
          groupSends: f.sent.length,
          privateSends: f.privateSent.length,
          pending: f.store.getState().newChatDrafts.synthetic.pendingRecipients.current.size
        }
      }),
      { calls: 3, profiles: 3, groups: 1, groupSends: 1, privateSends: 0, pending: 1 }
    )
    await page.evaluate(() => (window as any).fixture.releaseBot())
    await page.waitForFunction(
      () =>
        !(window as any).fixture.store.getState().newChatDrafts.synthetic.pendingRecipients.current
          .size
    )
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture,
          d = f.store.getState().newChatDrafts.synthetic
        return {
          sends: f.privateSent.length,
          cache: d.createdRecipients.current.size,
          text: d.text,
          recipients: d.recipients.length
        }
      }),
      { sends: 0, cache: 0, text: "", recipients: 0 }
    )
    // Ordinary explicit profile creation/editing does not share staged-recipient deduplication.
    await resetFixture()
    await stageNewRecipient(
      "Ordinary same display name",
      "Keep old source while configuring",
      "ordinary.txt"
    )
    await startDeferredPrivateCreate()
    await page.evaluate(() => (window as any).fixture.change("thread"))
    await page.getByRole("button", { name: "Return synthetic Bots", exact: true }).click()
    await page.getByRole("button", { name: "新建 Bot", exact: true }).click()
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Bot 名称", exact: true })
      .fill("Ordinary same display name")
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Configure synthetic profile", exact: true }).click()
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Bot 名称", exact: true })
      .fill("Ordinary edited profile")
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture
        return {
          calls: f.createCalls,
          profiles: f.creates.length,
          updates: f.updates.length,
          sends: f.privateSent.length,
          pending: f.store.getState().newChatDrafts.synthetic.pendingRecipients.current.size
        }
      }),
      { calls: 2, profiles: 2, updates: 1, sends: 0, pending: 1 }
    )
    await page.evaluate(() => (window as any).fixture.releaseBot())
    await page.waitForFunction(
      () =>
        !(window as any).fixture.store.getState().newChatDrafts.synthetic.pendingRecipients.current
          .size
    )
    assert.equal(await page.evaluate(() => (window as any).fixture.privateSent.length), 0)
    // Creating profiles returns a replacement snapshot, as the production IPC does.
    // The in-flight group attachment transfer must use the returned materialized identities.
    for (const scenario of [
      { mixed: false, file: true, failSend: false },
      { mixed: true, file: true, failSend: false },
      { mixed: false, file: true, failSend: true },
      { mixed: false, file: false, failSend: false }
    ]) {
      await resetFixture()
      await draft.fill("First group message with newly created recipients")
      await recipients.fill("Synthetic")
      await page.getByRole("option", { name: "Synthetic Bot", exact: true }).first().click()
      for (const name of ["Materialized A", "Materialized B"]) {
        await recipients.fill(name)
        await page.getByRole("option", { name: `将“${name}”添加为新 Bot`, exact: true }).click()
      }
      if (!scenario.mixed) await page.getByLabel("移除 Synthetic Bot", { exact: true }).click()
      const bytes = Buffer.from("\ufeffid,amount\r\nnew,4.25\r\n")
      if (scenario.file)
        await page.locator('input[type="file"]').setInputFiles({
          name: "materialized.csv",
          mimeType: "text/csv",
          buffer: bytes
        })
      await page.evaluate((failSend) => {
        const f = (window as any).fixture
        f.originalSnapshot = f.snapshots.synthetic
        f.failGroupSend = failSend
      }, scenario.failSend)
      await page.getByRole("button", { name: "发送新聊天消息", exact: true }).click()
      await page.locator(".bot-new-chat").waitFor({ state: "detached" })
      const state = await page.evaluate(() => {
        const f = (window as any).fixture,
          group = f.groups[0],
          target = f.groupStore.getState().drafts[JSON.stringify(["synthetic", group.id])],
          source = f.store.getState().newChatDrafts.synthetic
        return {
          creates: f.creates.length,
          groups: f.groups.length,
          imports: f.imports.length,
          sends: f.sent.length,
          oldBots: f.originalSnapshot.bots.length,
          oldGroups: f.originalSnapshot.groups.length,
          currentBots: f.snapshots.synthetic.bots.length,
          memberIds: group.memberIds,
          targetIds: f.sent[0].targetBotIds,
          imported: f.imports[0],
          source: [source.text, source.files.length, source.recipients.length],
          target: { text: target.text, files: target.attachments.length, error: target.error }
        }
      })
      assert.equal(state.creates, 2)
      assert.equal(state.groups, 1)
      assert.equal(state.imports, scenario.file ? 1 : 0)
      assert.equal(state.sends, 1)
      assert.equal(state.oldBots, 1)
      assert.equal(state.oldGroups, 0)
      assert.equal(state.currentBots, 3)
      assert.equal(state.memberIds.length, scenario.mixed ? 3 : 2)
      assert.deepEqual(state.targetIds, [...state.memberIds].sort())
      assert.deepEqual(state.source, ["", 0, 0])
      if (scenario.file) {
        assert.equal(state.memberIds.includes(state.imported.botId), true)
        assert.equal(state.imported.groupId, "synthetic-group-synthetic-1")
        assert.deepEqual(state.imported.files, [
          { name: "materialized.csv", bytes: Array.from(bytes) }
        ])
      }
      assert.deepEqual(state.target, {
        text: scenario.failSend ? "First group message with newly created recipients" : "",
        files: scenario.failSend && scenario.file ? 1 : 0,
        error: scenario.failSend ? "synthetic group send failed" : null
      })
      if (scenario.failSend) {
        // The original persistent target draft owns the failed request and its imported File.
        // Reload and retry that exact request through the production group send helper.
        const retained = await page.evaluate(() => {
          const f = (window as any).fixture,
            key = JSON.stringify(["synthetic", f.groups[0].id])
          f.groupStore.setState({ drafts: {} })
          f.groupStore.getState().restore(key)
          const target = f.groupStore.getState().drafts[key]
          return { text: target.text, files: target.attachments.length, id: target.request.id }
        })
        assert.deepEqual(retained, {
          text: "First group message with newly created recipients",
          files: 1,
          id: await page.evaluate(() => (window as any).fixture.sent[0].requestId)
        })
        await page.evaluate(() => {
          const f = (window as any).fixture
          return f.retryGroup(f.groups[0].id)
        })
        const retried = await page.evaluate(() => {
          const f = (window as any).fixture,
            target = f.groupStore.getState().drafts[JSON.stringify(["synthetic", f.groups[0].id])]
          return {
            creates: f.creates.length,
            groups: f.groups.length,
            imports: f.imports.length,
            sends: f.sent,
            target: [target.text, target.attachments.length, target.request, target.error]
          }
        })
        assert.equal(retried.creates, 2)
        assert.equal(retried.groups, 1)
        assert.equal(retried.imports, 1)
        assert.equal(retried.sends.length, 2)
        assert.deepEqual(retried.sends[1], retried.sends[0])
        assert.deepEqual(retried.target, ["", 0, null, null])
      }
    }
    // An existing group still resolves its ordinary member from the original snapshot.
    await resetFixture()
    await page.evaluate(() => {
      const f = (window as any).fixture,
        snapshot = f.snapshots.synthetic,
        group = {
          id: "preexisting-group",
          hostId: "synthetic",
          name: "Existing group",
          memberIds: [snapshot.bots[0].id],
          version: 1,
          createdAt: 1,
          updatedAt: 1
        }
      f.groups.push(group)
      f.snapshots.synthetic = { ...snapshot, groups: [group] }
    })
    await draft.fill("Existing group draft with attachment")
    await page.locator('input[type="file"]').setInputFiles({
      name: "existing.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("existing group bytes")
    })
    await recipients.fill("Existing group")
    await page.getByRole("option", { name: "Existing group", exact: true }).click()
    await page.locator(".bot-new-chat").waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => {
        const f = (window as any).fixture,
          target = f.groupStore.getState().drafts[JSON.stringify(["synthetic", "preexisting-group"])]
        return {
          creates: f.creates.length,
          groups: f.groups.length,
          imports: f.imports.length,
          sent: f.sent.length,
          member: f.imports[0].botId,
          bytes: f.imports[0].files[0].bytes,
          target: [target.text, target.attachments.length]
        }
      }),
      {
        creates: 0,
        groups: 1,
        imports: 1,
        sent: 0,
        member: "synthetic-bot-synthetic",
        bytes: Array.from(Buffer.from("existing group bytes")),
        target: ["Existing group draft with attachment", 1]
      }
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS actual new-chat draft/File/host handoff; editor pending-key ownership, editable retry, failure release, different-key and ordinary-profile controls, late-cache identity isolation; immutable all-new/mixed/existing group File transfer and persistent retry"
    )
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

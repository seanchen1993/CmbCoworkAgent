/** Production workspace/components in Electron; isolated profile and synthetic IM transport. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { BotStore } from "../src/main/bots/store"

/** Send the same SQLite projection as Host.snapshot(), including its source fields. */
function previewTasks(
  tasks: Array<{
    id: string
    botId: string
    threadId: string
    state: string
    origin: object
    workId?: string
    mockSource?: { transport: "im"; bindingId: string }
  }>
) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const store = new BotStore(db)
    for (const task of tasks) {
      const source = task.mockSource
        ? {
            ...task.mockSource,
            grantVersion: 1,
            conversationId: task.threadId,
            audienceKey: `im:${task.mockSource.bindingId}`,
            eventId: `event-${task.id}`,
            messageId: `message-${task.id}`,
            senderId: "member"
          }
        : null
      db.run(
        `INSERT INTO bot_tasks(id,bot_id,thread_id,work_id,request_id,message,state,created_at,updated_at,origin_json,mock_source_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          task.id,
          task.botId,
          task.threadId,
          task.workId ?? null,
          `request-${task.id}`,
          "群内测试任务",
          task.state,
          1,
          1,
          JSON.stringify(task.origin),
          source ? JSON.stringify(source) : null
        ]
      )
    }
    return store.recentTasks(true)
  } finally {
    db.close()
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-im-conversation-"))
  const repo = process.cwd()
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const result = await build({
      entryPoints: ["tests/fixtures/bots-im-conversation.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      outfile: join(dir, "harness.js"),
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "isolate-unrelated-workbench",
          setup(b) {
            b.onResolve(
              {
                filter:
                  /(?:^@\/lib\/(?:store|thread-context)$|^\.\/Bot[A-Z]|^@\/components\/chat\/(?:CustomModelDialog|ChatContainer)$)/
              },
              (a) => {
                if (
                  [
                    "./BotImConversation",
                    "./BotImConversationRows",
                    "./BotDeliveredFile",
                    "./BotBrowserPanel",
                    "./BotSchedulePanel",
                    "./BotAvatar",
                    "./BotRuntimeAvatar",
                    "./BotStorefrontIcon",
                    "./BotGroupAvatar",
                    "./BotDetailsPane",
                    "./BotConversationList",
                    "./BotPanelDivider",
                    "./BotWorkPanel",
                    "./BotMemoryPanel",
                    "./BotExecutionDetailsToggle",
                    "./BotImChannelDialog"
                  ].includes(a.path)
                )
                  return
                return { path: a.path, namespace: "fixture" }
              }
            )
            b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => {
              let contents = ""
              if (a.path === "@/lib/store")
                contents = `const state={models:[],threads:[],mainView:'bots',showCustomizeView:false,loadThreads:()=>{}};export const useAppStore=Object.assign(selector=>selector(state),{getState:()=>state});`
              else if (a.path === "@/lib/thread-context")
                contents = `const state={messages:[],draftInput:'',draftAttachments:[],queuedMessages:[],pendingApprovals:[],coordinatorWorkers:[]};const context={initializeThread:()=>{},getThreadState:()=>state,getStreamData:()=>({isLoading:false,liveMessages:[]}),getThreadActions:()=>({setDraftInput:()=>{},setDraftAttachments:()=>{}}),subscribeToThreadState:()=>()=>{},subscribeToStream:()=>()=>{}};export const useThreadContext=()=>context;export const useThreadStateSummaries=()=>({});export const useThreadStateSelector=(id,selector)=>id?selector({...state,historyLoading:window.fixture.executionReady===false,historyConversationPresence:window.fixture.executionReady===false?"unknown":"nonempty"}):null;`
              else if (a.path === "@/components/chat/ChatContainer")
                contents = `export const ChatContainer=({threadId,readOnlyReason})=><div data-testid="native-execution" data-thread={threadId}>{readOnlyReason}</div>;`
              else if (a.path === "./BotConversationTools")
                contents = `export const BotConversationTools=({children,conversationThreadId,executionDetails})=><div data-testid="execution-tools" data-thread={conversationThreadId} data-details={executionDetails}>{children}</div>;`
              else if (a.path === "./BotMessageFilePreview")
                contents = `export const BotMessageFilePreview=()=>null;`
              else if (a.path === "./BotConversation")
                contents = `export const BotConversation=({work})=><div data-testid="private-conversation">{work?.id==='work-a'?'任务对话：演示准备清单':'私人主对话'}</div>;`
              else
                contents = [
                  "BotNameInput",
                  "BotGroupMembers",
                  "BotGroupConversation",
                  "BotNewChat",
                  "BotSectionEditor",
                  "BotRowMenu",
                  "BotProfileLabel",
                  "BotBrowserPanel",
                  "BotFilesPanel",
                  "BotWorkspaceMenu",
                  "BotAppearancePicker",
                  "BotAvatarEditor",
                  "BotDeleteDialog",
                  "BotMemoryPanel",
                  "BotSchedulePanel",
                  "BotGroupEditor",
                  "CustomModelDialog"
                ]
                  .map((n) => "export const " + n + "=({children})=><>{children}</>;")
                  .join("\n")
              return { contents, loader: "tsx", resolveDir: repo }
            })
          }
        }
      ]
    })
    const assets = process.env.BOT_TEST_APP_OUT
      ? join(process.env.BOT_TEST_APP_OUT, "renderer/assets")
      : null
    assert(assets, "Set BOT_TEST_APP_OUT to an isolated build for production CSS")
    const css = (await readdir(assets)).filter(
      (name) => name.startsWith("index-") && name.endsWith(".css")
    )
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8">' +
        css
          .map((name) => '<link rel="stylesheet" href="' + pathToFileURL(join(assets, name)) + '">')
          .join("") +
        '<style>html,body,#root{height:100%;margin:0}#root{display:flex}.bots-workspace{height:100%}</style><div id="root"></div><script>' +
        result.outputFiles.find((file) => file.path.endsWith(".js"))!.text +
        "</script><style>" +
        result.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join("") +
        "</style>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((req,done)=>done({cancel:!req.url.startsWith('file:')&&!req.url.startsWith('data:')}));new BrowserWindow({show:true,width:1440,height:960,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))})})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env,
      timeout: 15000
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.setDefaultTimeout(10000)
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error(error.stack)
    })
    await page.getByLabel("产品协作群消息记录").waitFor()
    await page.getByText("已整理好本周的项目进展。", { exact: true }).last().waitFor()
    await page.waitForFunction(() =>
      (window as any).fixture.reads.some((args: any[]) => args[0] === "im" && args[1] === "group-a")
    )
    assert(
      !(await page.evaluate(() => (window as any).fixture.reads)).some(
        (args: any[]) => args[0] === "bot"
      )
    )
    assert.equal(await page.locator(".bots-conversation textarea").count(), 0)
    const unread = (id: string) => page.locator(`[data-bot-row-key="im:${id}"] .bot-unread-dot`)
    await unread("group-a").waitFor({ state: "detached" })
    assert.equal(await unread("group-b").count(), 1)
    const imOrder = () =>
      page
        .locator('.bot-im-list [data-bot-row-key^="im:group-"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-bot-row-key")))
    assert.deepEqual(
      await imOrder(),
      ["im:group-a", "im:group-b"],
      "Reading the selected row clears its dot without immediately moving it"
    )
    const artifacts = join(process.env.BOT_TEST_APP_OUT!, "artifacts")
    assert.equal(await page.getByRole("button", { name: "执行详情", exact: true }).count(), 0)
    await page.getByRole("button", { name: "查看执行过程", exact: true }).click()
    assert.equal(await page.getByTestId("native-execution").getAttribute("data-thread"), "im-a")
    assert.equal(await page.getByTestId("execution-tools").getAttribute("data-details"), "true")
    assert.equal(
      await page
        .getByRole("button", { name: "收起执行过程", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    assert.equal(await page.getByRole("button", { name: "返回群聊", exact: true }).count(), 0)
    await page.getByRole("button", { name: "招乎群聊：体验优化小组", exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="native-execution"]')?.getAttribute("data-thread") ===
        "im-b"
    )
    // Opening a group with execution details already enabled must acknowledge it too.
    await unread("group-b").waitFor({ state: "detached" })
    await page.evaluate(() => {
      const f = (window as any).fixture
      for (const group of f.groups) {
        group.activity.version++
        group.activity.unread = true
      }
      f.bump()
    })
    await page.waitForFunction(() =>
      (window as any).fixture.reads.some(
        ([kind, id, version]: any[]) => kind === "im" && id === "group-b" && version === 3
      )
    )
    await unread("group-b").waitFor({ state: "detached" })
    assert.equal(await unread("group-a").count(), 1)
    assert.equal(
      await page.evaluate(
        () => (window as any).fixture.calls.filter((call: any) => call.id === "group-b").length
      ),
      0,
      "Execution details must not load a second copy of the IM history just to mark it read"
    )
    // Native execution details wait for their own history, without fetching the IM feed twice.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.executionReady = false
      f.groups[1].activity.version++
      f.groups[1].activity.unread = true
      f.bump()
    })
    await unread("group-b").waitFor({ state: "visible" })
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.executionReady = true
      f.bump()
    })
    await unread("group-b").waitFor({ state: "detached" })
    // Background updates stay unread until the window regains focus.
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: Boolean.bind(null, false)
      })
      const f = (window as any).fixture
      f.groups[1].activity.version++
      f.groups[1].activity.unread = true
      f.bump()
    })
    await unread("group-b").waitFor({ state: "visible" })
    assert.equal(
      await page.evaluate(() =>
        (window as any).fixture.reads.some(
          ([kind, id, version]: any[]) => kind === "im" && id === "group-b" && version === 5
        )
      ),
      false
    )
    await page.evaluate(() => {
      delete (document as any).hasFocus
      window.dispatchEvent(new Event("focus"))
    })
    await unread("group-b").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "招乎群聊：产品协作群", exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="native-execution"]')?.getAttribute("data-thread") ===
        "im-a"
    )
    await unread("group-a").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "收起执行过程", exact: true }).click()
    await page.getByLabel("产品协作群消息记录").waitFor({ state: "visible" })
    const taskSnapshot = previewTasks([
      {
        id: "im-task-a",
        botId: "bot",
        threadId: "im-a",
        state: "running",
        origin: { kind: "mock" },
        mockSource: { transport: "im", bindingId: "group-a" }
      },
      {
        id: "im-task-queued",
        botId: "bot",
        threadId: "im-a",
        state: "queued",
        origin: { kind: "mock" },
        mockSource: { transport: "im", bindingId: "group-a" }
      },
      {
        id: "other-group",
        botId: "bot",
        threadId: "im-b",
        state: "running",
        origin: { kind: "mock" },
        mockSource: { transport: "im", bindingId: "group-b" }
      },
      {
        id: "private",
        botId: "bot",
        threadId: "private",
        state: "queued",
        origin: { kind: "user" }
      },
      {
        id: "work",
        botId: "bot",
        threadId: "task-a",
        workId: "work-a",
        state: "running",
        origin: { kind: "mock" },
        mockSource: { transport: "im", bindingId: "group-a" }
      }
    ])
    await page.evaluate((tasks) => {
      const f = (window as any).fixture
      f.tasks = tasks
      f.bump()
    }, taskSnapshot)
    await page.getByRole("button", { name: "停止群内执行", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-execution-controls.png")
    })
    await page.getByRole("button", { name: "停止群内执行", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.cancelled.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.cancelled), [
      "im-task-a",
      "im-task-queued"
    ])
    await page
      .getByRole("button", { name: "停止群内执行", exact: true })
      .waitFor({ state: "detached" })
    await page.evaluate(() => {
      ;(window as any).fixture.tasks = []
      ;(window as any).fixture.backgroundThreads = ["im-b", "private", "task-a"]
      ;(window as any).fixture.bump()
    })
    // Other rooms, private chat and independent work must not create this room's stop control.
    await page.waitForTimeout(100)
    assert.equal(await page.getByRole("button", { name: "停止群内执行", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as any).fixture.backgroundThreads.push("im-a")
      ;(window as any).fixture.bump()
    })
    await page.getByRole("button", { name: "停止群内执行", exact: true }).waitFor()
    await page.getByRole("button", { name: "查看执行过程", exact: true }).click()
    await page.getByTestId("native-execution").waitFor()
    await page.getByRole("button", { name: "停止群内执行", exact: true }).click()
    await page
      .getByRole("button", { name: "停止群内执行", exact: true })
      .waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.stoppedBackgroundThreads), [
      "im-a"
    ])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.backgroundThreads), [
      "im-b",
      "private",
      "task-a"
    ])
    await page.getByRole("button", { name: "收起执行过程", exact: true }).click()

    await page.getByRole("button", { name: "电脑", exact: true }).click()
    await page.waitForFunction(() =>
      (window as any).fixture.calls.some(
        (c: any[]) => c[0] === "browser" && c[1] === "im-group-a--bot"
      )
    )
    await page.screenshot({ animations: "disabled", path: join(artifacts, "bot-im-computer.png") })
    await page.getByRole("button", { name: "电脑", exact: true }).click()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-group-light.png")
    })
    await page.getByRole("button", { name: "查看更早消息", exact: true }).click()
    await page.getByText("早些时候：我们先明确本周的演示范围。").waitFor()
    await page.evaluate(() => (window as any).fixture.bump())
    await page.getByText("早些时候：我们先明确本周的演示范围。").waitFor()
    assert.equal(await page.getByRole("button", { name: "查看更早消息", exact: true }).count(), 0)
    await page.getByRole("button", { name: "查看独立任务", exact: true }).click()
    await page.getByTestId("private-conversation").getByText("任务对话：演示准备清单").waitFor()
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.groups[0].activity.version++
      f.groups[0].activity.unread = true
      f.bump()
    })
    await unread("group-a").waitFor({ state: "visible" })
    assert.equal(
      await page.locator('[data-bot-row-key="im:group-a"]').getAttribute("data-selected"),
      "true"
    )
    const details = page.getByLabel("招乎群详情", { exact: true })
    await details.getByRole("heading", { name: "群内任务" }).waitFor()
    await details.getByRole("button", { name: "返回群聊", exact: true }).waitFor()
    assert.equal(await details.getByText("返回主对话", { exact: true }).count(), 0)
    await details.getByRole("button", { name: "完成任务", exact: true }).click()
    await details.getByRole("button", { name: "继续处理", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-task-scope.png")
    })
    await details.getByRole("button", { name: "电脑", exact: true }).click()
    await page.waitForFunction(() =>
      (window as any).fixture.calls.some(
        (c: any[]) => c[0] === "browser" && c[1] === "work-work-a--bot"
      )
    )
    await details.getByRole("button", { name: "电脑", exact: true }).click()
    await details.getByRole("button", { name: "继续处理", exact: true }).click()
    await details.getByRole("button", { name: "完成任务", exact: true }).waitFor()
    await page.getByRole("button", { name: "← 产品协作群", exact: true }).click()
    await page.getByLabel("产品协作群消息记录").waitFor()
    await unread("group-a").waitFor({ state: "detached" })
    await details.getByRole("button", { name: "记忆", exact: true }).click()
    await details.getByText("团队写作格式", { exact: true }).waitFor()
    await details.getByText("演示约定", { exact: true }).waitFor()
    assert.equal(await details.getByText("私人偏好", { exact: true }).count(), 0)
    assert.equal(await details.getByText("体验组约定", { exact: true }).count(), 0)
    await details.getByRole("button", { name: "编辑 演示约定", exact: true }).click()
    await details.getByRole("combobox", { name: "记忆使用范围", exact: true }).click()
    await page.getByRole("option", { name: "Bot 共享", exact: true }).click()
    await details.getByRole("button", { name: "保存", exact: true }).click()
    await details.getByText("演示约定", { exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-memory-scope.png")
    })
    await page.getByRole("button", { name: "返回 Bot 主对话", exact: true }).click()
    await page.getByTestId("private-conversation").getByText("私人主对话").waitFor()
    assert.equal(await page.getByRole("button", { name: /演示准备清单/ }).count(), 0)
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "模拟 IM 接入", exact: true }).count(), 0)
    await page.getByRole("button", { name: "招乎接入", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-menu.png")
    })
    await page.getByRole("button", { name: "招乎接入", exact: true }).click()
    await page.getByRole("heading", { name: "招乎接入 · 招乎T", exact: true }).waitFor()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "删除已撤销测试群接入记录", exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "撤销", exact: true }).count(), 1)
    assert.equal(await dialog.getByRole("button", { name: /删除.*接入记录/ }).count(), 2)
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-remove-binding.png")
    })
    await dialog.getByRole("button", { name: "删除已撤销测试群接入记录", exact: true }).click()
    await dialog.getByText("已撤销测试群", { exact: true }).waitFor({ state: "detached" })
    await dialog.getByRole("button", { name: "删除已过期测试群接入记录", exact: true }).click()
    await dialog.getByText("已过期测试群", { exact: true }).waitFor({ state: "detached" })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("button", { name: "招乎接入", exact: true }).click()
    await page.getByRole("heading", { name: "招乎接入 · 招乎T", exact: true }).waitFor()
    await dialog.getByRole("button", { name: "撤销", exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: /删除.*接入记录/ }).count(), 0)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    // A late history result cannot populate the next selected group.
    await page.evaluate(() => {
      ;(window as any).fixture.hold = true
    })
    await page.getByRole("button", { name: "招乎群聊：产品协作群", exact: true }).click()
    await page.waitForFunction(() => typeof (window as any).fixture.release === "function")
    await page.getByRole("button", { name: "招乎群聊：体验优化小组", exact: true }).click()
    await page
      .getByLabel("体验优化小组消息记录")
      .getByText("三个界面问题，已整理为改进清单。")
      .waitFor()
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(
      await page.getByLabel("体验优化小组消息记录").getByText("已整理好本周的项目进展。").count(),
      0
    )
    assert.equal(await details.getByRole("button", { name: /演示准备清单/ }).count(), 0)
    await details.getByRole("button", { name: "记忆", exact: true }).click()
    await details.getByText("演示约定", { exact: true }).waitFor()
    await details.getByText("体验组约定", { exact: true }).waitFor()
    assert.equal(await details.getByText("私人偏好", { exact: true }).count(), 0)
    await page.getByText("离线 · 保留本地记录", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.groups[1].state = "revoked"
      f.bump()
    })
    await page.getByText("接入已解除，历史消息仍可查看", { exact: true }).waitFor()
    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-group-dark.png")
    })
    await page.getByRole("button", { name: "招乎群聊：产品协作群", exact: true }).click()
    await page.getByRole("button", { name: "管理群接入", exact: true }).click()
    await page.getByRole("button", { name: "打开群会话", exact: true }).waitFor()
    await page.getByRole("button", { name: "打开群会话", exact: true }).click()
    await page.getByLabel("产品协作群消息记录").waitFor()
    // Recoverable local read failure and retry, without falling back to private chat.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.fail = true
      f.groups[0].activity.version++
      f.groups[0].activity.unread = true
      f.bump()
    })
    await page.getByRole("alert").getByText("本地记录读取失败", { exact: false }).waitFor()
    assert.equal(
      await unread("group-a").count(),
      1,
      "A failed refresh must not acknowledge an unseen version"
    )
    await page.evaluate(() => {
      ;(window as any).fixture.fail = false
    })
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.bot-im-transcript [role="alert"]'))
    if (await page.getByRole("button", { name: "查看新消息", exact: true }).isVisible())
      await page.getByRole("button", { name: "查看新消息", exact: true }).click()
    await unread("group-a").waitFor({ state: "detached" })
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
    await page.setViewportSize({ width: 1100, height: 820 })
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-group-compact.png")
    })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false
    )
    // File cards use the same compact component as private/work conversations.
    await page.evaluate(() => {
      const f = (window as any).fixture
      for (const [index, state] of ["sending", "sent", "failed", "unknown"].entries()) {
        const file = {
          filePath: `/workspace/report-${index}.docx`,
          attachmentPath: `/workspace/.bot-deliveries/hash/report-${index}.docx`,
          name: `report-${index}.docx`,
          size: 28672
        }
        f.latest.push({
          id: `attachment-${index}`,
          kind: "bot",
          text: "",
          senderId: "Bot",
          state,
          createdAt: Date.now() + index,
          threadId: "im-a",
          files: [file],
          delivery: { id: `attachment-${index}`, file, state, progress: 43 }
        })
      }
      f.bump()
    })
    await page.getByText("上传中 43%", { exact: true }).waitFor()
    await page.getByText("已送达招乎", { exact: true }).waitFor()
    await page.getByText("送达待核对 · 请查看招乎", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: /重试发送/ }).count(), 1)
    await page.getByRole("button", { name: "重试发送 report-2.docx" }).scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-file-delivery.png")
    })
    await page.getByRole("button", { name: "重试发送 report-2.docx" }).click()
    await page.getByText("等待发送到招乎", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: /重试发送/ }).count(), 0)
    assert.equal(await page.getByText("已送达招乎", { exact: true }).count(), 1)
    // A task card in the group feed must retain its task identity for native export.
    await page.evaluate(() => {
      const f = (window as any).fixture
      const file = {
        filePath: "/selected-project/任务报告.xlsx",
        attachmentPath: "/selected-project/.bot-deliveries/hash/任务报告.xlsx",
        name: "任务报告.xlsx",
        size: 1024
      }
      f.latest.push({
        id: "task-attachment",
        kind: "bot",
        text: "",
        senderId: "Bot",
        state: "sent",
        createdAt: Date.now() + 10,
        workId: "work-a",
        threadId: "task-a",
        files: [file],
        delivery: { id: "task-attachment", file, state: "sent", progress: 100 }
      })
      f.bump()
    })
    await page.getByRole("button", { name: "保存 任务报告.xlsx", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.exported), [
      ["bot", "group-a", "/selected-project/.bot-deliveries/hash/任务报告.xlsx", "work-a"]
    ])
    await page.getByRole("button", { name: "保存 report-1.docx", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.exported[1]), [
      "bot",
      "group-a",
      "/workspace/.bot-deliveries/hash/report-1.docx",
      undefined
    ])
    await page.getByRole("button", { name: "招乎群聊：体验优化小组", exact: true }).click()
    await page.getByText("接入已解除，历史消息仍可查看", { exact: true }).waitFor()
    assert.equal(await page.locator(".bot-delivered-file").count(), 0)

    // Real sidebar controls: pin order, unread priority, retained selection and history.
    await page.evaluate(() => {
      const f = (window as any).fixture,
        now = Date.now()
      f.setView({
        selectedId: "bot",
        imConversationId: null,
        imHistoryCollapsed: true,
        pinnedImConversationIds: [],
        hiddenImConversationIds: [],
        sidebarWidth: 280
      })
      f.tasks = []
      f.backgroundThreads = []
      Object.assign(f.groups[0], { state: "active", connected: true })
      Object.assign(f.groups[0].activity, { unread: false, updatedAt: now - 60000 })
      Object.assign(f.groups[1], { state: "active" }) // offline still belongs in active list
      Object.assign(f.groups[1].activity, { unread: true, updatedAt: now - 180000, version: 20 })
      f.groups.push({
        ...f.groups[0],
        id: "group-c",
        bindingId: "remote-c",
        threadId: "im-c",
        title: "需求评审群",
        activity: {
          kind: "im",
          id: "group-c",
          version: 20,
          unread: true,
          updatedAt: now - 120000,
          preview: "请确认本次演示范围。"
        }
      })
      f.groups.push({
        ...f.groups[0],
        id: "group-old",
        bindingId: "remote-old",
        threadId: "im-old",
        state: "revoked",
        activity: {
          kind: "im",
          id: "group-old",
          version: 1,
          unread: false,
          updatedAt: now,
          preview: "历史接入记录"
        }
      })
      f.bump()
    })
    const waitOrder = async (ids: string[]) =>
      page
        .waitForFunction((expected) => {
          const actual = [
            ...document.querySelectorAll('.bot-im-list [data-bot-row-key^="im:group-"]')
          ].map((row) => row.getAttribute("data-bot-row-key"))
          return JSON.stringify(actual) === JSON.stringify(expected.map((id) => `im:${id}`))
        }, ids)
        .catch(async (error) => {
          console.error("Sidebar order mismatch", {
            expected: ids,
            actual: await imOrder(),
            history: await page.locator(".bot-im-history-toggle").getAttribute("aria-expanded")
          })
          await page.screenshot({ path: join(artifacts, "bot-sidebar-failure.png") })
          throw error
        })
    await waitOrder(["group-c", "group-b", "group-a"])
    assert.equal(
      await page
        .getByRole("button", { name: "已解绑 · 1", exact: true })
        .getAttribute("aria-expanded"),
      "false"
    )
    await page.locator('[data-bot-row-key="im:group-a"]').hover()
    await page.getByRole("button", { name: "产品协作群 的操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click()
    await waitOrder(["group-a", "group-c", "group-b"])
    await page.locator('[data-bot-row-key="im:group-c"]').click()
    await unread("group-c").waitFor({ state: "detached" })
    await waitOrder(["group-a", "group-c", "group-b"])
    await page.getByRole("button", { name: "返回 Bot 主对话", exact: true }).click()
    await waitOrder(["group-a", "group-b", "group-c"])
    // Marking read is local view state and does not open or execute a group.
    await page.locator('[data-bot-row-key="im:group-b"]').click({ button: "right" })
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.groups[2].activity.version++
      f.groups[2].activity.unread = true
      f.bump()
    })
    await unread("group-c").waitFor({ state: "visible" })
    assert.deepEqual(
      await imOrder(),
      ["im:group-a", "im:group-b", "im:group-c"],
      "A new message must not reorder rows under an open menu"
    )
    await page.getByRole("menuitem", { name: "标为已读", exact: true }).click()
    await unread("group-b").waitFor({ state: "detached" })
    await waitOrder(["group-a", "group-c", "group-b"])
    await page.getByTestId("private-conversation").waitFor()
    // An explicit user question remains pending after its blue dot clears.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.tasks = [
        {
          id: "question-c",
          botId: "bot",
          threadId: "im-c",
          state: "waiting_user",
          createdAt: 1,
          updatedAt: 1,
          origin: { kind: "mock" },
          mockSource: { transport: "im", bindingId: "group-c" }
        }
      ]
      f.groups[2].activity.version++
      f.groups[2].activity.unread = true
      f.bump()
    })
    await page.locator('[data-bot-row-key="im:group-c"]').click()
    await unread("group-c").waitFor({ state: "detached" })
    await page
      .locator('[data-bot-row-key="im:group-c"] .bot-im-row-caption')
      .getByText(/待你处理/)
      .waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-sidebar-active.png")
    })
    // Revocation demotes even a pinned room, without removing its messages or merging same-name rooms.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.groups[0].state = "revoked"
      f.bump()
    })
    await waitOrder(["group-c", "group-b"])
    await page.getByRole("button", { name: "已解绑 · 2", exact: true }).click()
    await waitOrder(["group-c", "group-b", "group-old", "group-a"])
    await page.locator('[data-bot-row-key="im:group-old"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "从侧边栏隐藏", exact: true }).click()
    await waitOrder(["group-c", "group-b", "group-a"])
    await page.getByRole("button", { name: "搜索 Bot", exact: true }).click()
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("产品协作群")
    await waitOrder(["group-old", "group-a"])
    await page.locator('[data-bot-row-key="im:group-old"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "显示在侧边栏", exact: true }).click()
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("招乎T")
    await waitOrder(["group-c", "group-b", "group-old", "group-a"])
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("")
    await page.locator('[data-bot-row-key="im:group-a"]').click()
    await page.getByText("接入已解除，历史消息仍可查看", { exact: true }).waitFor()
    await page.getByRole("button", { name: "查看独立任务", exact: true }).first().click()
    await page.getByTestId("private-conversation").getByText("任务对话：演示准备清单").waitFor()
    await details.getByRole("button", { name: "返回群聊", exact: true }).click()
    await page.getByLabel("产品协作群消息记录").waitFor()
    assert.equal(
      await page.locator('[data-bot-row-key="im:group-a"]').getAttribute("data-selected"),
      "true"
    )
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-sidebar-history.png")
    })
    // While reading older messages, new content stays unread until explicitly revealed.
    await page.getByLabel("产品协作群消息记录").evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.latest.push({
        id: "new-at-bottom",
        kind: "bot",
        senderId: "Bot",
        text: "新的交付已准备好。",
        state: "sent",
        createdAt: Date.now() + 1000
      })
      f.groups[0].activity.version++
      f.groups[0].activity.unread = true
      f.bump()
    })
    await page.getByRole("button", { name: "查看新消息", exact: true }).waitFor()
    await page.getByText("新的交付已准备好。", { exact: true }).waitFor({ state: "attached" })
    assert.equal(await unread("group-a").count(), 1)
    await page.getByRole("button", { name: "查看新消息", exact: true }).click()
    await unread("group-a").waitFor({ state: "detached" })
    await page.getByText("新的交付已准备好。", { exact: true }).waitFor()
    // Bot conversations above the IM section use the same read priority, within existing sections/pins.
    await page.evaluate(() => {
      const f = (window as any).fixture,
        now = Date.now()
      f.bots.push(
        { ...f.bots[0], id: "bot-recent", name: "文档助手", threadId: "private-recent" },
        { ...f.bots[0], id: "bot-unread", name: "项目助手", threadId: "private-unread" }
      )
      f.activities.push(
        {
          kind: "bot",
          id: "bot-recent",
          unread: false,
          updatedAt: now,
          version: 1,
          preview: "[文件] prd.md"
        },
        {
          kind: "bot",
          id: "bot-unread",
          unread: true,
          updatedAt: now - 60000,
          version: 1,
          preview: "评审清单已准备好。"
        }
      )
      f.bump()
    })
    const botOrder = () =>
      page
        .locator('.bots-list [data-bot-row-key^="bot:"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-bot-row-key")))
    await page.locator('[data-bot-row-key="bot:bot-unread"]').waitFor()
    assert.deepEqual(await botOrder(), ["bot:bot-unread", "bot:bot-recent", "bot:bot"])
    await page.locator('[data-bot-row-key="bot:bot-unread"]').click()
    await page
      .locator('[data-bot-row-key="bot:bot-unread"] .bot-unread-dot')
      .waitFor({ state: "detached" })
    assert.deepEqual(await botOrder(), ["bot:bot-unread", "bot:bot-recent", "bot:bot"])
    await page.locator('[data-bot-row-key="im:group-c"]').click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('.bots-list [data-bot-row-key^="bot:"]')
          ?.getAttribute("data-bot-row-key") === "bot:bot-recent"
    )
    // Archiving the serving Bot cannot hide the group's retained history.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.bots[0].archived = true
      f.bump()
    })
    await page.locator('[data-bot-row-key="im:group-c"]').waitFor()
    await page
      .locator('[data-bot-row-key="im:group-c"] .bot-im-row-caption')
      .getByText(/Bot 已归档/)
      .waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "PASS: IM group workspace routing, private/work return links, scoped read state, paging, late responses, offline/revoked history, management, retry and light/dark/compact layout"
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

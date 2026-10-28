/** Production workspace/components in Electron; isolated profile and synthetic IM transport. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

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
                  /(?:^@\/lib\/(?:store|thread-context)$|^\.\/Bot[A-Z]|^@\/components\/chat\/CustomModelDialog$)/
              },
              (a) => {
                if (
                  [
                    "./BotImConversation",
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
                contents = `const state={messages:[],draftInput:'',draftAttachments:[],queuedMessages:[]};const context={initializeThread:()=>{},getThreadState:()=>state,getThreadActions:()=>({setDraftInput:()=>{},setDraftAttachments:()=>{}}),subscribeToThreadState:()=>()=>{}};export const useThreadContext=()=>context;export const useThreadStateSummaries=()=>({});`
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
      console.error(error.message)
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
    const artifacts = join(process.env.BOT_TEST_APP_OUT!, "artifacts")
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
    await page.getByRole("button", { name: "IM 接入", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "bot-im-menu.png")
    })
    await page.getByRole("button", { name: "IM 接入", exact: true }).click()
    await page.getByRole("heading", { name: "IM 接入 · 招乎T", exact: true }).waitFor()
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
    await page.getByRole("button", { name: "IM 接入", exact: true }).click()
    await page.getByRole("heading", { name: "IM 接入 · 招乎T", exact: true }).waitFor()
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
      f.bump()
    })
    await page.getByRole("alert").getByText("本地记录读取失败", { exact: false }).waitFor()
    await page.evaluate(() => {
      ;(window as any).fixture.fail = false
    })
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.bot-im-transcript [role="alert"]'))
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

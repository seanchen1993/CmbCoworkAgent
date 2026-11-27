import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { chromium } from "playwright"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const root = process.cwd()
const output = resolve(root, "tests/screenshots")
await mkdir(output, { recursive: true })
const fixture = await mkdtemp(join(output, "task-commit-binding-"))
let server
let browser
try {
  await writeFile(
    join(fixture, "index.html"),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="root"></main><script type="module" src="./main.jsx"></script></body></html>'
  )
  await writeFile(
    join(fixture, "main.jsx"),
    `
    import React from "react"
    import { createRoot } from "react-dom/client"
    import "/src/renderer/src/index.css"
    import { TaskCommitBindingControl } from "/src/renderer/src/components/git/TaskCommitBindingControl.tsx"
    import { AgentGitCommitDialog } from "/src/renderer/src/components/chat/AgentGitCommitDialog.tsx"
    function Fixture() {
      const [review, setReview] = React.useState(false)
      return <>
        <TaskCommitBindingControl threadId="task-A" />
        <button onClick={() => setReview(true)}>打开提交预览</button>
        {review && <AgentGitCommitDialog open threadId="task-A" workspacePath="C:/tasks/order"
          suggestedMessage="更新结算" suggestedGitWorktreePath="C:/code/payment-service"
          suggestedFileBasePath="C:/code/payment-service" suggestedFilePaths={["pay.ts"]}
          suggestedFileSelectionSource="pathspec" commitBindingVersion="v1"
          onCommitted={() => setReview(false)} onCancel={() => setReview(false)} />}
      </>
    }
    createRoot(document.querySelector("#root")).render(<Fixture />)
  `
  )
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(fixture, "cache"),
    logLevel: "error",
    plugins: [react({ include: /\.[jt]sx$/ }), tailwindcss()],
    optimizeDeps: { entries: [join(fixture, "index.html")] },
    resolve: { alias: { "@": resolve(root, "src/renderer/src") } },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [root, await realpath(resolve(root, "node_modules"))] }
    }
  })
  await server.listen()
  browser = await chromium.launch().catch((error) => {
    if (process.platform !== "win32") throw error
    return chromium.launch({ channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 920, height: 580 } })
  page.on("pageerror", (error) => console.error(error))
  await page.addInitScript(() => {
    const primary = "C:/code/order-service"
    const external = "C:/code/payment-service"
    let binding = null
    window.confirmed = []
    window.commits = []
    window.api = {
      taskCards: {
        list: async () => ({ success: true, cards: [{ taskKey: "PAY-51", taskName: "结算" }] })
      },
      workspace: {
        getGitPanelDiffs: async () => ({
          success: true,
          taskId: "task-A",
          changedFiles: ["pay.ts"],
          commitPreviewRevision: "r1",
          totals: { additions: 1, deletions: 0, fileCount: 1 },
          files: [
            {
              path: "pay.ts",
              status: "modified",
              diffLoaded: true,
              diff: "+pay",
              additions: 1,
              deletions: 0
            }
          ]
        }),
        commitWorktree: async (...args) => {
          window.commits.push(args)
          return { success: true }
        }
      },
      taskCommitBinding: {
        read: async () => binding,
        open: async () => ({
          token: "editor",
          repositories: binding?.repositoryPaths ?? [primary],
          selected: binding?.repositoryPaths ?? [primary],
          cardNumber: binding?.cardNumber ?? "ORDER-2481",
          active: Boolean(binding)
        }),
        choose: async () => [external],
        save: async (_, cardNumber, repositoryPaths) => {
          binding = { cardNumber, repositoryPaths, version: "v1", workspacePath: "C:/tasks/order" }
          window.confirmed.push(binding)
          return binding
        },
        revoke: async () => {
          binding = null
        }
      }
    }
  })
  const { port } = server.httpServer.address()
  await page.goto(
    `http://127.0.0.1:${port}/${relative(root, fixture).split("\\").join("/")}/index.html`
  )
  const button = (name) => page.getByRole("button", { name, exact: true })
  await button("任务提交设置").click()
  await button("选择本地仓库").click()
  await page.getByRole("checkbox", { name: "C:/code/payment-service" }).waitFor()
  assert.equal(await page.evaluate(() => window.confirmed.length), 0)
  const dialog = page.getByRole("dialog")
  await dialog.screenshot({ path: join(output, "task-commit-binding.png"), animations: "disabled" })
  await page.getByRole("checkbox", { name: "C:/code/order-service" }).uncheck()
  await page.getByRole("checkbox", { name: "C:/code/payment-service" }).uncheck()
  assert.equal(await button("确认本任务授权").isDisabled(), true)
  await page.getByRole("checkbox", { name: "C:/code/payment-service" }).check()
  await button("确认本任务授权").click()
  await button("ORDER-2481").click()
  assert.deepEqual(await page.evaluate(() => window.confirmed[0].repositoryPaths), [
    "C:/code/payment-service"
  ])
  await button("清除预选任务卡").click()
  await button("确认本任务授权").click()
  await button("提交时选卡").click()
  assert.equal(await button("选择或输入任务卡号").isVisible(), true)
  await dialog.screenshot({
    path: join(output, "task-commit-repository-only.png"),
    animations: "disabled"
  })
  await button("取消").click()
  await button("打开提交预览").click()
  await button("选择任务卡片").waitFor()
  assert.equal(await button("确认提交").isDisabled(), true)
  await button("选择任务卡片").click()
  await page.getByPlaceholder("手动输入卡号").fill("PAY-51")
  await page.keyboard.press("Escape")
  await button("确认提交").click()
  const [[thread, message, files, options]] = await page.evaluate(() => window.commits)
  assert.equal(thread, "task-A")
  assert.equal(message, "PAY-51 #comment fix:更新结算 #CMBDevClaw")
  assert.deepEqual(files, ["pay.ts"])
  assert.equal(options.worktreePath, "C:/code/payment-service")
  assert.equal(options.commitBindingVersion, "v1")
  assert.equal(options.commitPreviewRevision, "r1")
  await button("提交时选卡").click()
  assert.equal(await button("选择或输入任务卡号").isVisible(), true)
  await button("撤销授权").click()
  await button("任务提交设置").waitFor()
  console.log("Verified repository selection, optional card, manual commit confirmation and revocation.")
} finally {
  await browser?.close()
  await server?.close()
  await rm(fixture, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m04-workspace-ui-")),
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/expert-workspace-fixture.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      outdir: dir,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: { "@": resolve("src/renderer/src") },
      loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
      plugins: [
        {
          name: "isolated-thread-provider",
          setup(plugin) {
            plugin.onResolve({ filter: /\?worker$/ }, (args) => ({
              path: args.path,
              namespace: "fixture-worker"
            }))
            plugin.onLoad({ filter: /.*/, namespace: "fixture-worker" }, () => ({
              contents:
                "export default class Worker extends EventTarget {postMessage(){} terminate(){}}",
              loader: "js"
            }))
            plugin.onLoad({ filter: /\/lib\/thread-context\.tsx$/ }, () => ({
              contents: `const context={getThreadState:()=>({pendingApprovals:[],coordinatorWorkers:[],toolCallStates:{}}),getStreamData:()=>({isLoading:false,liveMessages:[]}),subscribeToThreadState:()=>()=>{},subscribeToStream:()=>()=>{}};export const THREAD_MESSAGE_RESIDENT_LIMIT=1500,THREAD_MESSAGE_PROTECTED_TAIL=320;export const ThreadProvider=({children})=>children;export const useThreadContext=()=>context;export const useThreadStream=()=>({});export const useCurrentThread=()=>({});export const useThreadState=()=>null;export const useThreadStateSelector=()=>null;export const useThreadActions=()=>null;export const useAllThreadStates=()=>({});export const useThreadStateSummaries=()=>({});export const useAllStreamLoadingStates=()=>({});`,
              loader: "tsx"
            }))
            plugin.onLoad({ filter: /\/chat\/ChatContainer\.tsx$/ }, () => ({
              contents: "export const ChatContainer=()=>null",
              loader: "tsx"
            }))
          }
        }
      ]
    })
    let css = bundle.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("\n")
    for (const name of (await readdir("out/renderer/assets")).filter(
      (n) => n.endsWith(".css") && n.startsWith("index-")
    ))
      css = (await readFile(join("out/renderer/assets", name), "utf8")) + "\n" + css
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8"><style>' +
        css +
        '</style><style>html,body,#root{height:100%;margin:0}.bots-workspace{height:100vh;width:100vw}</style><div id="root"></div>'
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1250,height:900,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: binary,
      args: [join(dir, "main.cjs")],
      env,
      timeout: 30000
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error(error.message)
    })
    await page.waitForURL(/index\.html$/)
    await page.addScriptTag({ content: "globalThis.__name = value => value" })
    await page.evaluate(() => {
      const w = window as any
      const stats = {
        sends: 0,
        cancels: [] as string[],
        localWrites: 0,
        reads: 0,
        lists: 0,
        completes: 0,
        reopens: 0,
        retries: 0,
        maxRead: 0,
        maxUpdates: 0
      }
      const tasks = Array.from({ length: 41 }, (_, i) => ({
        taskRef: "task-" + (i + 1),
        taskNumber: "TASK-" + (i + 1),
        title: i === 0 ? "整理季度安排" : "历史任务 " + (i + 1),
        taskStatus: "active",
        role: "task",
        status: "succeeded",
        busy: false
      }))
      const records = new Map<string, any[]>([
        [
          "main",
          [
            {
              requestId: "main-1",
              taskRef: "main",
              text: "请整理季度安排",
              status: "succeeded",
              notice: null,
              runId: "run-main",
              createdAt: new Date().toISOString(),
              result: {
                runId: "run-main",
                attemptId: "attempt-main",
                outcome: "succeeded",
                text: "已交办到任务会话。",
                settledAt: new Date().toISOString()
              },
              coordination: { taskRef: "task-1", title: "整理季度安排", state: "delivered" }
            }
          ]
        ],
        [
          "task-1",
          Array.from({ length: 101 }, (_, i) => ({
            requestId: "history-" + i,
            taskRef: "task-1",
            text: "任务讨论 " + i,
            status: "succeeded",
            notice: null,
            runId: "run-" + i,
            createdAt: new Date().toISOString(),
            result: {
              runId: "run-" + i,
              attemptId: "attempt-" + i,
              outcome: "succeeded",
              text:
                i === 100
                  ? "季度安排已整理：先明确目标，再分配各月工作。"
                  : i === 99
                    ? "## 本轮要点\n- 保留目标\n- 补充边界\n\n|阶段|动作|\n|---|---|\n|一|讨论|\n\n```text\n仅文本，无工具执行\n```"
                    : "历史回复 " + i,
              settledAt: new Date().toISOString()
            }
          }))
        ]
      ])
      const retries: Array<{ taskRef: string; requestId: string; operationId: string }> = []
      let taskCount = 41
      let loseSendReply = false
      const committed = new Map<string, any>()
      let failRefresh = false,
        heldRead: (() => void) | null = null,
        delayRead = false,
        heldSend: (() => void) | null = null,
        delaySend = false
      const info = () => ({
        connected: true,
        nodeEnabled: true,
        conversationId: "scope-A",
        mainTaskRef: "main",
        expertName: "工作协调专家",
        selectedModel: { ref: "fixture:model", name: "测试文本模型" },
        models: [{ ref: "fixture:model", name: "测试文本模型" }]
      })
      const api = {
        openChats: async () => info(),
        selectModel: async () => info(),
        subscribeInvalidation: (cb: any) => {
          w.invalidate = cb
          return () => {}
        },
        chatTasks: async (v: any) => {
          stats.lists++
          if (failRefresh) {
            failRefresh = false
            throw Error("DEPENDENCY_UNAVAILABLE")
          }
          const filtered = tasks.slice(0, taskCount).filter((t) => t.title.includes(v.query))
          const after = v.cursor ? Number(v.cursor) : 0
          return {
            selectedTask: structuredClone(tasks.find((t) => t.taskRef === v.selectedRef)),
            items: structuredClone(filtered.slice(after, after + 40)),
            nextCursor: filtered.length > after + 40 ? String(after + 40) : null,
            pending:
              retries.length > 0 || [...records.values()].flat().some((r) => r.status === "running")
          }
        },
        read: async (v: any) => {
          stats.reads++
          if (delayRead) {
            delayRead = false
            await new Promise<void>((r) => (heldRead = r))
          }
          const all = records.get(v.taskRef) ?? [],
            end = v.cursor ? Number(v.cursor) : all.length
          stats.maxRead = Math.max(stats.maxRead, Math.min(40, end))
          return {
            items: structuredClone(all.slice(Math.max(0, end - 40), end)),
            nextCursor: end > 40 ? String(end - 40) : null,
            task: structuredClone(tasks.find((t) => t.taskRef === v.taskRef))
          }
        },
        updates: async (v: any) => {
          stats.maxUpdates = Math.max(stats.maxUpdates, v.requestIds.length)
          return structuredClone(
            (records.get(v.taskRef) ?? []).filter((r) => v.requestIds.includes(r.requestId))
          )
        },
        chat: async (v: any) => {
          if (committed.has(v.requestId)) return structuredClone(committed.get(v.requestId))
          stats.sends++
          const ref = v.role === "main" ? "main" : (v.taskRef ?? "task-new")
          if (ref === "task-new" && !tasks.some((t) => t.taskRef === ref))
            tasks.unshift({
              taskRef: ref,
              taskNumber: "TASK-42",
              title: v.text,
              role: "task",
              taskStatus: "active",
              status: "running",
              busy: true
            })
          const r = {
            requestId: v.requestId,
            taskRef: ref,
            text: v.text,
            status: "running",
            notice: null,
            runId: "run-new",
            result: null,
            createdAt: new Date().toISOString()
          }
          records.set(ref, [...(records.get(ref) ?? []), r])
          committed.set(v.requestId, r)
          if (delaySend) {
            delaySend = false
            await new Promise<void>((resolve) => (heldSend = resolve))
          }
          if (loseSendReply) {
            loseSendReply = false
            throw Error("DEPENDENCY_UNAVAILABLE")
          }
          return structuredClone(r)
        },
        cancel: async (v: any) => {
          stats.cancels.push(v.requestId)
          for (const r of [...records.values()].flat())
            if (r.requestId === v.requestId) r.status = "cancelled"
        },
        taskLifecycle: async (v: any) => {
          const task = tasks.find((t) => t.taskRef === v.taskRef)!
          task.taskStatus = v.action === "complete" ? "completed" : "active"
          stats[v.action === "complete" ? "completes" : "reopens"]++
        },
        retryChat: async (v: any) => {
          stats.retries++
          retries.push(v)
          // The real IPC acknowledges the action before its child request exists.
        }
      }
      w.fixtureLocalBot = {
        hostId: "local",
        snapshot: async () => ({
          host: { id: "local", name: "本机", status: "online" },
          revision: 1,
          bots: [
            {
              id: "local-bot",
              hostId: "local",
              threadId: "local-thread",
              name: "本地写作 Bot",
              instructions: "写作",
              modelRef: null,
              color: "#37b897",
              shape: "circle",
              archived: false,
              version: 1,
              createdAt: 1,
              updatedAt: 1
            }
          ],
          tasks: [],
          groups: [],
          activities: [],
          schedules: []
        }),
        subscribe: () => () => {},
        markRead: async () => {},
        submit: async () => {
          stats.localWrites++
          throw Error("LOCAL_ESCAPE")
        }
      }
      w.electron = { onNotifyMsg: () => () => {} }
      w.api = {
        serviceConversation: api,
        bots: w.fixtureLocalBot,
        models: { getUserInfo: async () => null }
      }
      w.m04 = {
        stats,
        seedFailure: (id: string, older = false) => {
          const failed = {
            requestId: id,
            taskRef: "main",
            text: "仅咨询 " + id,
            status: "failed",
            notice: "COORDINATION_INVALID_OUTPUT",
            result: null,
            runId: "run-" + id,
            createdAt: new Date().toISOString()
          }
          const later = older
            ? Array.from({ length: 41 }, (_, i) => ({
                ...failed,
                requestId: id + "-later-" + i,
                text: "已有讨论 " + i,
                status: "succeeded",
                notice: null
              }))
            : []
          records.set("main", [...(records.get("main") ?? []), failed, ...later])
        },
        applyRetry: (label: string) => {
          setTimeout(() => {
            const action = retries.shift()!
            const list = records.get(action.taskRef)!,
              source = list.find((r) => r.requestId === action.requestId)
            const requestId = "ec-retry:" + action.operationId
            source.supersededBy = requestId
            list.push({
              ...source,
              requestId,
              supersededBy: undefined,
              status: "succeeded",
              notice: null,
              runId: "run-" + requestId,
              result: {
                runId: "run-" + requestId,
                attemptId: "attempt-" + requestId,
                outcome: "succeeded",
                text: label,
                settledAt: new Date().toISOString()
              }
            })
          }, 50)
        },
        limitTasks: (count: number) => {
          taskCount = count
        },
        loseSendReply: () => {
          loseSendReply = true
        },
        failRefresh: () => {
          failRefresh = true
        },
        delayRead: () => {
          delayRead = true
        },
        releaseRead: () => heldRead?.(),
        delaySend: () => {
          delaySend = true
        },
        releaseSend: () => heldSend?.(),
        settle: () => {
          for (const r of [...records.values()].flat())
            if (r.status === "running") {
              r.status = "succeeded"
              r.result = {
                runId: r.runId,
                attemptId: "attempt-new",
                outcome: "succeeded",
                text: "已按补充意见调整。",
                settledAt: new Date().toISOString()
              }
            }
          for (const t of tasks) {
            t.status = "succeeded"
            t.busy = false
          }
        }
      }
    })
    await page.addScriptTag({
      content: bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text
    })
    await page.getByRole("button", { name: "工作协调专家 主对话" }).waitFor()
    await page.getByRole("button", { name: "整理季度安排", exact: true }).last().click()
    await page.getByRole("textbox", { name: "给任务发消息" }).waitFor()
    await page.getByText("季度安排已整理：先明确目标，再分配各月工作。", { exact: true }).waitFor()
    await page.getByRole("heading", { name: "本轮要点" }).waitFor()
    assert.equal(await page.locator(".service-chat-reply > svg").count(), 0)
    assert.ok(await page.locator('[data-message-bubble="assistant"] [data-message-body]').count())
    assert.ok(
      (await page
        .locator(".service-chat-composer")
        .evaluate((el) => el.getBoundingClientRect().height)) <= 50
    )
    await page.screenshot({ path: "/tmp/m04-bots-workspace.png" })
    assert.equal(await page.getByRole("button", { name: "本地写作 Bot", exact: true }).count(), 1)
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.locator('.service-chat-task-row[title="历史任务 40"]').waitFor()
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.getByRole("button", { name: /历史任务 41/ }).waitFor()
    assert.ok(
      (await page
        .locator(".service-chat-transcript")
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 2
    )
    await page.locator(".service-chat-transcript").evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event("scroll"))
    })
    const oldAnchor = await page
      .locator('[data-request-id="history-61"]')
      .evaluate((el) => el.getBoundingClientRect().top)
    await page
      .getByRole("button", { name: "加载更早消息" })
      .evaluate((el) => (el as HTMLButtonElement).click())
    await page.getByText("任务讨论 21", { exact: true }).waitFor()
    assert.ok(
      Math.abs(
        (await page
          .locator('[data-request-id="history-61"]')
          .evaluate((el) => el.getBoundingClientRect().top)) - oldAnchor
      ) < 3
    )
    const draft = page.getByRole("textbox", { name: "给任务发消息" })
    await draft.fill("请补充风险安排")
    await draft.press("Enter")
    await page.getByText("正在处理", { exact: true }).last().waitFor()
    await page.locator(".service-chat-transcript").evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event("scroll"))
    })
    await page.evaluate(() => (window as any).m04.settle())
    await page.getByText("已按补充意见调整。", { exact: true }).waitFor()
    assert.equal(await page.locator(".service-chat-transcript").evaluate((el) => el.scrollTop), 0)
    await draft.fill("这轮请先暂停")
    await draft.press("Enter")
    await page.getByRole("button", { name: "停止当前请求" }).click()
    await page.evaluate(() => (window as any).m04.settle())
    await page.getByRole("button", { name: "完成", exact: true }).click()
    await page.getByRole("button", { name: "继续处理", exact: true }).waitFor()
    await page.getByRole("button", { name: "搜索 Bot", exact: true }).click()
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("历史任务 41")
    await page.getByRole("button", { name: "继续处理", exact: true }).click()
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("")
    await page.getByRole("button", { name: "完成", exact: true }).waitFor()
    await page.getByRole("button", { name: "回到专家主对话" }).click()
    await page.getByRole("textbox", { name: "给专家发消息" }).fill("主对话草稿")
    await page
      .getByRole("button", { name: /整理季度安排 任务会话|整理季度安排 已回复/ })
      .first()
      .click()
    await draft.fill("任务草稿")
    await page.getByRole("button", { name: "回到专家主对话" }).click()
    assert.equal(
      await page.getByRole("textbox", { name: "给专家发消息" }).inputValue(),
      "主对话草稿"
    )
    await page.evaluate(() => (window as any).m04.delayRead())
    await page
      .getByRole("button", { name: /整理季度安排 已回复/ })
      .first()
      .click()
    await page.getByRole("button", { name: "回到专家主对话" }).click()
    await page.evaluate(() => (window as any).m04.releaseRead())
    assert.equal(
      await page.getByText("季度安排已整理：先明确目标，再分配各月工作。", { exact: true }).count(),
      0
    )
    const mainDraft = page.getByRole("textbox", { name: "给专家发消息" })
    await mainDraft.fill("输入法组合中")
    const beforeIme = await page.evaluate(() => (window as any).m04.stats.sends)
    await mainDraft.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    assert.equal(await page.evaluate(() => (window as any).m04.stats.sends), beforeIme)
    await page.evaluate(() => (window as any).m04.delaySend())
    await mainDraft.fill("迟到发送保留原请求")
    await mainDraft.press("Enter")
    await page
      .getByRole("button", { name: /整理季度安排 已回复/ })
      .first()
      .click()
    await page.evaluate(() => (window as any).m04.releaseSend())
    await page.getByRole("button", { name: "回到专家主对话" }).click()
    assert.equal(await mainDraft.inputValue(), "迟到发送保留原请求")
    const beforeReplay = await page.evaluate(() => (window as any).m04.stats.sends)
    await mainDraft.press("Enter")
    await page.waitForFunction(
      () =>
        (document.querySelector('[aria-label="给专家发消息"]') as HTMLTextAreaElement)?.value === ""
    )
    assert.equal(await page.evaluate(() => (window as any).m04.stats.sends), beforeReplay)
    await page.evaluate(() => (window as any).m04.loseSendReply())
    await mainDraft.fill("失回包重开后用同请求")
    await mainDraft.press("Enter")
    await page.getByRole("alert").waitFor()
    const beforeRemount = await page.evaluate(() => (window as any).m04.stats.sends)
    await page.evaluate(() => (window as any).remountM04())
    await mainDraft.waitFor()
    assert.equal(await mainDraft.inputValue(), "失回包重开后用同请求")
    await mainDraft.press("Enter")
    await page.waitForFunction(
      () =>
        (document.querySelector('[aria-label="给专家发消息"]') as HTMLTextAreaElement)?.value === ""
    )
    assert.equal(await page.evaluate(() => (window as any).m04.stats.sends), beforeRemount)
    const listBefore = await page.evaluate(() => (window as any).m04.stats.lists)
    await page.evaluate(() => (window as any).m04.failRefresh())
    await page.waitForFunction(
      (count) => (window as any).m04.stats.lists >= count + 2,
      listBefore,
      { timeout: 10000 }
    )
    await page.evaluate(() => (window as any).m04.settle())
    await page.getByText("已按补充意见调整。", { exact: true }).first().waitFor()
    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await page.setViewportSize({ width: 740, height: 820 })
    await page.screenshot({ path: "/tmp/m04-bots-workspace-dark.png" })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false
    )
    await page.evaluate(() => {
      ;(window as any).m04.limitTasks(6)
      ;(window as any).remountM04()
    })
    await page.getByRole("button", { name: "工作协调专家 主对话" }).waitFor()
    assert.equal(await page.locator('.service-chat-task-row[title="历史任务 6"]').count(), 0)
    const beforeExpand = await page.evaluate(() => (window as any).m04.stats.lists)
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.locator('.service-chat-task-row[title="历史任务 6"]').waitFor()
    assert.equal(await page.evaluate(() => (window as any).m04.stats.lists), beforeExpand)
    assert.equal(await page.getByRole("button", { name: "更多任务", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as any).m04.seedFailure("retry-first", true)
      ;(window as any).remountM04()
    })
    await page.getByRole("textbox", { name: "给专家发消息" }).waitFor()
    await page.getByRole("button", { name: "加载更早消息" }).click()
    await page.getByText("仅咨询 retry-first", { exact: true }).waitFor()
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.waitForFunction(() => (window as any).m04.stats.retries === 1)
    await page.evaluate(() => (window as any).m04.applyRetry("无需切换即可看到重试结果"))
    await page.getByText("无需切换即可看到重试结果", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "重试", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as any).m04.seedFailure("retry-remount")
      ;(window as any).remountM04()
    })
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.waitForFunction(() => (window as any).m04.stats.retries === 2)
    await page.evaluate(() => (window as any).remountM04())
    await page.getByText("仅咨询 retry-remount", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).m04.applyRetry("重挂后自动发现后台结果"))
    await page.getByText("重挂后自动发现后台结果", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "重试", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as any).m04.seedFailure("retry-switch")
      ;(window as any).remountM04()
    })
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.waitForFunction(() => (window as any).m04.stats.retries === 3)
    await page.locator('.service-chat-task-row[title="整理季度安排"]').click()
    await page.getByRole("textbox", { name: "给任务发消息" }).waitFor()
    await page.evaluate(() => (window as any).m04.applyRetry("回主对话可见且不污染任务会话"))
    await page.waitForTimeout(2500)
    assert.equal(await page.getByText("回主对话可见且不污染任务会话", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "工作协调专家 主对话" }).click()
    await page.getByText("回主对话可见且不污染任务会话", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "重试", exact: true }).count(), 0)
    const stats = await page.evaluate(() => (window as any).m04.stats)
    assert.ok(stats.maxRead <= 40)
    assert.ok(stats.maxUpdates <= 40)
    assert.equal(stats.retries, 3)
    assert.equal(stats.localWrites, 0)
    assert.equal(stats.sends, 4)
    assert.equal(stats.cancels.length, 1)
    assert.equal(stats.completes, 1)
    assert.equal(stats.reopens, 1)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        status: "complete",
        stats,
        screenshots: ["/tmp/m04-bots-workspace.png", "/tmp/m04-bots-workspace-dark.png"]
      })
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

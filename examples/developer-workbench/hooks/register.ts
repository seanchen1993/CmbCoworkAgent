import type { On, JsonObject, Stream, ProcessChunk, ProcessResult } from "claude-code"
import { argv, defaults, settings } from "./settings"
import { workbenchStatusRow, type WorkbenchStatusRow } from "./status-summary"

const target = { kind: "current" as const }
const tasksRef = { provider: "developer-workbench", id: "tasks", version: "1.0.0" }
const workspaceRef = { provider: "native.workspace", id: "changes", version: "1.0.0" }
const codeRef = { provider: "native.code", id: "java", version: "1.0.0" }
const editorRef = { provider: "native.editor", id: "navigation", version: "1.0.0" }
const gitRef = { provider: "native.git", id: "inspection", version: "1.0.0" }
const workflowRef = { provider: "native.workflow", id: "runs", version: "1.0.0" }
const object = { type: "object" }

/** Public SDK only. Registration and opening a pane never run a process or start an LSP. */
export function register(on: On) {
  let config = { ...defaults },
    tasks: JsonObject[] = [],
    loaded = false,
    sequence = 0
  let status = "先保存设置；所有检查都需要明确点击。",
    observations: WorkbenchStatusRow[] = [],
    result = "",
    showDeveloperInfo = false
  let subscription: string | undefined,
    watcher: { cancel(): Promise<void> } | undefined,
    revision = 0
  let directoryRef = "",
    observationGeneration = 0,
    connecting = false
  const jobs = new Map<
    string,
    {
      cancelRequested: boolean
      stream?: Stream<ProcessChunk, ProcessResult>
      done: Promise<void>
      finish(): void
    }
  >()

  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "tasks",
      version: "1.0.0",
      title: "开发工作台检查任务",
      scope: "conversation",
      stateSchema: object,
      actions: [
        {
          id: "start",
          title: "启动明确指定的检查",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              taskId: { type: "string", minLength: 1, maxLength: 80 },
              argv: {
                type: "array",
                minItems: 1,
                maxItems: 16,
                items: { type: "string", maxLength: 256 }
              }
            },
            required: ["taskId", "argv"]
          },
          outputSchema: object,
          requiredPermissions: [
            "clock.after",
            "platform.publish",
            "process.spawn",
            "store.get",
            "store.set",
            "ui.invalidate"
          ],
          cancellable: false,
          idempotency: "keyed"
        },
        {
          id: "cancel",
          title: "请求取消并等待 SDK 关闭回执",
          inputSchema: {
            type: "object",
            properties: { taskId: { type: "string", minLength: 1, maxLength: 80 } },
            required: ["taskId"],
            additionalProperties: false
          },
          outputSchema: object,
          requiredPermissions: [
            "platform.publish",
            "process.spawn",
            "store.get",
            "store.set",
            "ui.invalidate"
          ],
          cancellable: false,
          idempotency: "keyed"
        }
      ]
    },
    {
      async act($, event) {
        if (!loaded) {
          const history = await $.store.get("task-history")
          tasks = Array.isArray(history)
            ? history.slice(-4).map((value) => ({
                ...(value as JsonObject),
                phase: "historical-unknown",
                note: "历史快照；未连接进程，不重放"
              }))
            : []
          loaded = true
        }
        const publish = async () => {
          await $.store.set("task-history", tasks)
          await $.platform.publish({ id: "tasks", version: "1.0.0", target, value: { tasks } })
          $.ui.invalidate("ui.render")
        }
        const id = String(event.input.taskId)
        if (event.action === "cancel") {
          const job = jobs.get(id),
            task = tasks.find((item) => item.id === id)
          if (!job || !task) throw Error("没有本次会话中可取消的活动任务；历史记录不会重放")
          job.cancelRequested = true
          task.phase = "cancel-requested"
          await publish()
          try {
            if (job.stream) {
              await job.stream.return({ code: null, signal: null })
              task.closeConfirmed = true
            }
            await job.done
          } catch (error) {
            task.error = String(error).slice(0, 120)
          }
          task.phase = task.closeConfirmed ? "closed-after-cancel" : task.phase
          await publish()
          return { taskId: id, phase: task.phase }
        }
        const command = argv(JSON.stringify(event.input.argv))
        if (tasks.some((item) => item.id === id) || jobs.size >= 4)
          throw Error("任务身份已使用或活动任务已达上限")
        while (tasks.length >= 4) {
          const index = tasks.findIndex((item) => !jobs.has(String(item.id)))
          if (index < 0) throw Error("活动任务已达上限")
          tasks.splice(index, 1)
        }
        let finish!: () => void
        const job = {
          cancelRequested: false,
          stream: undefined as Stream<ProcessChunk, ProcessResult> | undefined,
          done: new Promise<void>((resolve) => {
            finish = resolve
          }),
          finish: () => finish()
        }
        jobs.set(id, job)
        const task: JsonObject = {
          id,
          phase: "scheduled",
          output: "",
          startEvidence: "none",
          exitObserved: false,
          closeConfirmed: false,
          command: JSON.stringify(command).slice(0, 96)
        }
        tasks.push(task)
        await publish()
        $.clock.after(0, async () => {
          try {
            if (job.cancelRequested) {
              task.phase = "cancelled-before-start"
              return
            }
            task.phase = "awaiting-sdk-process"
            await publish()
            const stream = $.process.spawn({ argv: command })
            // Cancellation rejects result; consume that rejection even while iterating output.
            void stream.result.catch(() => undefined)
            job.stream = stream
            for await (const chunk of stream) {
              task.startEvidence = "sdk-output-observed"
              task.phase = job.cancelRequested ? "cancel-requested" : "output-observed"
              task.output = (String(task.output) + chunk.stream + ": " + chunk.text).slice(-512)
              await publish()
            }
            // Iterator.return's seed is not an exit code. Only natural result is exit evidence.
            if (!job.cancelRequested) {
              const exit = await stream.result
              task.exitObserved = true
              task.code = exit.code
              task.signal = exit.signal
              task.closeConfirmed = true
              task.startEvidence = "sdk-result-observed"
              task.phase = "closed-with-result"
            }
          } catch (error) {
            task.phase = job.cancelRequested ? "cancel-requested" : "unknown"
            task.error = String(error).slice(0, 120)
          } finally {
            jobs.delete(id)
            job.finish()
            await publish()
          }
        })
        return { taskId: id, phase: "scheduled" }
      }
    }
  )

  for (const placement of ["page", "navigation", "sidebar", "toolbar", "settings"] as const) {
    const pane = placement === "settings" ? "developer-settings" : "developer-workbench"
    on.capability(
      {
        apiVersion: "devclaw.capability/v1",
        id: "workbench-" + placement,
        version: "1.0.0",
        title: placement === "settings" ? "开发工作台设置" : "开发工作台",
        scope: "conversation",
        stateSchema: object,
        presentation: {
          type: "surface",
          apiVersion: "devclaw.surface/v1",
          id: "developer-" + placement,
          title: "开发工作台",
          placement,
          paneId: pane,
          openAction: "open",
          closeAction: "close"
        },
        actions: [
          {
            id: "open",
            title: "打开开发工作台",
            inputSchema: object,
            outputSchema: object,
            requiredPermissions: ["store.get", "ui.open"],
            cancellable: true,
            idempotency: "keyed"
          },
          {
            id: "close",
            title: "关闭观察",
            inputSchema: object,
            outputSchema: object,
            requiredPermissions: ["platform.unsubscribe"],
            cancellable: true,
            idempotency: "keyed"
          }
        ]
      },
      {
        async act($, event): Promise<JsonObject> {
          if (event.action === "close") {
            observationGeneration++
            connecting = false
            const old = watcher
            watcher = undefined
            if (old) await old.cancel()
            const id = subscription
            subscription = undefined
            if (id) await $.platform.unsubscribe({ subscriptionId: id })
            return { closed: true }
          }
          config = settings(await $.store.get("settings"))
          if (!loaded) {
            const history = await $.store.get("task-history")
            tasks = Array.isArray(history)
              ? history.slice(-4).map((value) => {
                  const old = value as JsonObject
                  return {
                    ...old,
                    phase: "historical-unknown",
                    exitObserved: old.exitObserved === true,
                    note: "历史快照；未重新连接进程，不会重放"
                  }
                })
              : []
            loaded = true
          }
          await $.ui.open({ id: pane, title: "开发工作台" })
          return { opened: true }
        }
      }
    )
  }
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "dev-workbench",
      description: "打开开发工作台（不自动执行检查）"
    })
    await $.command.register({
      name: "dev-workbench-settings",
      description: "配置检查 argv 与源码位置"
    })
    return next(event)
  })
  for (const command of ["dev-workbench", "dev-workbench-settings"]) {
    on("command.run", { command }, async ($) => {
      config = settings(await $.store.get("settings"))
      if (!loaded) {
        const history = await $.store.get("task-history")
        tasks = Array.isArray(history)
          ? history.slice(-4).map((value) => ({
              ...(value as JsonObject),
              phase: "historical-unknown",
              note: "历史快照；未连接进程，不重放"
            }))
          : []
        loaded = true
      }
      await $.ui.open({
        id: command.endsWith("settings") ? "developer-settings" : "developer-workbench",
        title: "开发工作台"
      })
      return { text: "已打开开发工作台；尚未执行检查。" }
    })
  }
  on("ui.close", { id: "developer-workbench" }, async ($, event, next) => {
    observationGeneration++
    connecting = false
    const old = watcher
    watcher = undefined
    if (old) await old.cancel()
    const id = subscription
    subscription = undefined
    if (id) await $.platform.unsubscribe({ subscriptionId: id })
    return next(event)
  })
  on("ui.render", { component: "Pane", requestId: "developer-settings" }, ($, event) => {
    const { Box, Text, Form } = $.ui.resolve(event)
    return Box({
      flexDirection: "column",
      children: [
        Text({ children: status }),
        Form({
          key: "settings",
          label: "仅此聊天保存；保存不执行。argv 为 JSON 数组，无 shell 拼接。",
          fields: [
            { name: "argv", label: "检查 argv JSON", type: "text", required: true },
            { name: "path", label: "工作区相对源码路径", type: "text", required: true },
            { name: "line", label: "行（从 1 开始）", type: "text", required: true },
            { name: "column", label: "列（从 1 开始）", type: "text", required: true }
          ],
          values: config,
          submitLabel: "保存并读回设置",
          onSubmit: async (json) => {
            try {
              const next = settings(JSON.parse(json))
              await $.store.set("settings", next)
              config = settings(await $.store.get("settings"))
              status = "设置已保存并读回；尚未执行检查。"
            } catch (error) {
              status = String(error)
            }
            $.ui.invalidate("ui.render")
          }
        })
      ]
    })
  })
  on("ui.render", { component: "Pane", requestId: "developer-workbench" }, ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    async function invoke(ref: typeof tasksRef, action: string, input: JsonObject) {
      const answer = await $.platform.act({
        ref,
        target,
        action,
        input,
        requestKey: "developer-" + Date.now() + "-" + ++sequence
      })
      if (answer.status !== "succeeded")
        throw Error(String(answer.error || answer.status) + "；未确认，不自动重放")
      return answer.value as JsonObject
    }
    async function perform(work: () => Promise<void>) {
      try {
        await work()
      } catch (error) {
        status = String(error)
      }
      $.ui.invalidate("ui.render")
    }
    const button = (key: string, label: string, work: () => Promise<void>) =>
      Button({ key, label, onPress: () => perform(work) })
    return Box({
      flexDirection: "column",
      gap: 1,
      children: [
        Text({ children: "开发工作台 · 公开能力组合；不启动 Java 服务，不运行项目构建。" }),
        Text({ children: status }),
        button("settings", "工作台设置", async () => {
          await $.ui.open({ id: "developer-settings", title: "开发工作台设置" })
        }),
        button("notification", "核对原生通知", async () => {
          await $.ui.toast("开发工作台：这是明确点击产生的通知")
        }),
        button("refresh", "读取能力与原生状态", async () => {
          const available = await $.platform.list()
          const next: WorkbenchStatusRow[] = []
          for (const ref of [codeRef, editorRef, workspaceRef, gitRef, workflowRef]) {
            let state: unknown
            try {
              state = await $.platform.read({ ref, target })
            } catch (error) {
              state = { status: "unknown", reason: String(error) }
            }
            next.push(workbenchStatusRow(ref, available, state))
          }
          observations = next
          status = "已读取当前原生状态；能力来源可用不代表服务已启动。"
        }),
        button("observe", "订阅工作区变更（仅失效提示）", async () => {
          if (subscription || connecting)
            throw Error("本页已有订阅或正在连接；关闭观察后可重新连接")
          connecting = true
          const generation = ++observationGeneration
          let admitted: string | undefined
          try {
            const initial = await $.platform.read({ ref: workspaceRef, target })
            if (generation !== observationGeneration) return
            const sub = await $.platform.subscribe({ ref: workspaceRef, target })
            admitted = sub.subscriptionId
            if (generation !== observationGeneration) {
              await $.platform.unsubscribe({ subscriptionId: sub.subscriptionId })
              return
            }
            subscription = sub.subscriptionId
            revision = sub.revision
            result = JSON.stringify(initial).slice(0, 1800)
            watcher = $.clock.every(1000, async () => {
              if (generation !== observationGeneration || subscription !== sub.subscriptionId)
                return
              try {
                const poll = await $.platform.poll({
                  subscriptionId: sub.subscriptionId,
                  afterRevision: revision
                })
                if (generation !== observationGeneration || subscription !== sub.subscriptionId)
                  return
                revision = poll.revision
                if (poll.events.length || poll.resync) {
                  const state = await $.platform.read({ ref: workspaceRef, target })
                  if (generation !== observationGeneration || subscription !== sub.subscriptionId)
                    return
                  result = JSON.stringify({
                    events: poll.events,
                    resync: poll.resync,
                    state
                  }).slice(0, 1800)
                  status = "工作区观察已更新；提示可能有界合并，不证明文件内容或精确变更类型。"
                  $.ui.invalidate("ui.render")
                }
              } catch (error) {
                if (generation !== observationGeneration || subscription !== sub.subscriptionId)
                  return
                subscription = undefined
                const old = watcher
                watcher = undefined
                if (old) void old.cancel()
                try {
                  await $.platform.unsubscribe({ subscriptionId: sub.subscriptionId })
                } catch {
                  /* revoked */
                }
                status = "观察失效：" + String(error).slice(0, 160) + "；需手动重新连接。"
                $.ui.invalidate("ui.render")
              }
            })
          } catch (error) {
            if (admitted) {
              if (subscription === admitted) subscription = undefined
              try {
                await $.platform.unsubscribe({ subscriptionId: admitted })
              } catch {
                /* closed */
              }
            }
            throw error
          } finally {
            if (generation === observationGeneration) connecting = false
          }
        }),
        button("stop-observe", "关闭观察", async () => {
          observationGeneration++
          connecting = false
          const old = watcher
          watcher = undefined
          if (old) await old.cancel()
          const id = subscription
          subscription = undefined
          if (id) await $.platform.unsubscribe({ subscriptionId: id })
          status = "观察已关闭。"
        }),
        button("diagnostics", "查询所选 Java 文件诊断", async () => {
          result = JSON.stringify(
            await invoke(codeRef, "diagnostics", { path: config.path, limit: 8 })
          ).slice(0, 2500)
          status = "Java 诊断是缓存观察，版本可能未知；不可用请到原自定义设置，不自动启动服务。"
        }),
        button("preview", "原生安全源码定位", async () => {
          result = JSON.stringify(
            await invoke(editorRef, "preview", {
              path: config.path,
              line: Number(config.line),
              column: Number(config.column)
            })
          )
          status = "按原生回执核对定位；外部 IDE 只能在源码预览中明确点击，显示状态未知。"
        }),
        button("git", "确认仓库并读取 HEAD 差异清单", async () => {
          if (!directoryRef)
            directoryRef = String(
              (await invoke(gitRef, "bind", { directory: await $.session.cwd() })).directoryRef
            )
          result = JSON.stringify(
            await invoke(gitRef, "list", { directoryRef, baseCommit: "HEAD", limit: 8 })
          ).slice(0, 2500)
        }),
        button("run", "启动已保存的检查（原生审批）", async () => {
          config = settings(await $.store.get("settings"))
          const n = Number((await $.store.get("task-sequence")) || 0) + 1
          if (!Number.isSafeInteger(n)) throw Error("任务序号无效")
          await $.store.set("task-sequence", n)
          result = JSON.stringify(
            await invoke(tasksRef, "start", { taskId: "check-" + n, argv: argv(config.argv) })
          )
          status = "仅已排队；有真实 SDK 输出或结果才有启动证据。stdout PASS 不代表检查通过。"
        }),
        ...tasks.map((task) =>
          Box({
            key: String(task.id),
            flexDirection: "column",
            children: [
              Text({ children: JSON.stringify(task) }),
              ...(jobs.has(String(task.id))
                ? [
                    button("cancel-" + task.id, "请求取消 " + task.id, async () => {
                      result = JSON.stringify(
                        await invoke(tasksRef, "cancel", { taskId: String(task.id) })
                      )
                    })
                  ]
                : [])
            ]
          })
        ),
        Text({ children: "Java设置入口：原“自定义设置 → Java 代码诊断”；本页不后台启动服务。" }),
        button("developer-info", showDeveloperInfo ? "收起开发信息" : "查看开发信息", async () => {
          showDeveloperInfo = !showDeveloperInfo
        }),
        ...observations.map((row) =>
          Box({
            key: "status-" + row.provider,
            flexDirection: "column",
            children: [
              Text({ children: row.label }),
              ...(showDeveloperInfo ? [Text({ children: "开发信息：" + row.detail })] : [])
            ]
          })
        ),
        Text({ children: result })
      ]
    })
  })
}

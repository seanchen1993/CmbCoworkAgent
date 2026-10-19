/** This package knows only the public provider contract. No Electron IPC or platform source edits. */
export function register(on, options) {
  const ref = options.ref || { provider: "task-workbench-provider", id: "tasks", version: "1.0.0" }
  const target = { kind: "current" }
  const consumerRef = {
    provider: "task-workbench-consumer",
    id: "workbench-page",
    version: "1.0.0"
  }
  let state = { tasks: [] },
    stateRevision = 0,
    subscription,
    watcher,
    lastError = ""
  let title = "个人任务工作台",
    nextTask = 0
  const placements = ["page", "navigation", "sidebar", "toolbar", "settings"]
  const object = { type: "object", additionalProperties: false, properties: {} }
  const permissions = [
    "ui.open",
    "platform.read",
    "platform.subscribe",
    "platform.poll",
    "platform.unsubscribe",
    "clock.every",
    "ui.invalidate",
    "store.get",
    "store.set"
  ]

  async function release($) {
    if (watcher) {
      const old = watcher
      watcher = undefined
      await old.cancel()
    }
    if (subscription) {
      const old = subscription
      subscription = undefined
      await $.platform.unsubscribe({ subscriptionId: old })
    }
  }
  async function read($) {
    const value = await $.platform.read({ ref, target })
    stateRevision = value.revision
    if (value.status === "ready") state = value.value
    else lastError = "提供方尚未发布当前版本状态，请先核对提供方是否启用"
  }
  for (const placement of placements) {
    const settings = placement === "settings"
    on.capability(
      {
        apiVersion: "devclaw.capability/v1",
        id: "workbench-" + placement,
        version: "1.0.0",
        title: settings ? "工作台设置" : "个人任务工作台",
        scope: "conversation",
        stateSchema: object,
        actions: [
          {
            id: "open",
            title: "打开工作台",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { surfaceId: { type: "string" } },
              required: ["surfaceId"]
            },
            outputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { opened: { type: "boolean" } },
              required: ["opened"]
            },
            requiredPermissions: permissions,
            cancellable: true,
            idempotency: "keyed"
          },
          {
            id: "task-start",
            title: "委托已授权的任务提供方启动任务",
            inputSchema: { type: "object", additionalProperties: true },
            outputSchema: { type: "object", additionalProperties: true },
            requiredPermissions: [
              "platform.act",
              "clock.after",
              "platform.publish",
              "process.spawn",
              "fs.write"
            ],
            cancellable: false,
            idempotency: "keyed"
          },
          {
            id: "task-cancel",
            title: "委托任务提供方取消并核对真实退出",
            inputSchema: { type: "object", additionalProperties: true },
            outputSchema: { type: "object", additionalProperties: true },
            requiredPermissions: ["platform.act", "platform.publish", "process.spawn"],
            cancellable: false,
            idempotency: "keyed"
          },
          {
            id: "close",
            title: "停止此页面刷新并退订",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { surfaceId: { type: "string" } },
              required: ["surfaceId"]
            },
            outputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { closed: { type: "boolean" } },
              required: ["closed"]
            },
            requiredPermissions: ["platform.unsubscribe"],
            cancellable: true,
            idempotency: "keyed"
          }
        ],
        presentation: {
          type: "surface",
          apiVersion: "devclaw.surface/v1",
          id: "workbench-" + placement,
          title: settings ? "工作台设置" : placement === "toolbar" ? "打开任务" : "个人任务工作台",
          placement,
          paneId: settings ? "task-settings" : "task-workbench",
          openAction: "open",
          closeAction: "close",
          order: placements.indexOf(placement)
        }
      },
      {
        act: async ($, event) => {
          if (event.action === "task-start" || event.action === "task-cancel")
            return await $.platform.act({
              ref,
              target,
              action: event.action === "task-start" ? "start" : "cancel",
              input: event.input,
              requestKey: event.requestKey + ":provider"
            })
          if (event.action === "close") {
            await release($)
            return { closed: true }
          }
          title = (await $.store.get("workbench-title")) || title
          if (!settings) {
            await read($)
            if (!subscription)
              subscription = (await $.platform.subscribe({ ref, target })).subscriptionId
            if (!watcher)
              watcher = $.clock.every(500, async () => {
                try {
                  const updates = await $.platform.poll({
                    subscriptionId: subscription,
                    afterRevision: stateRevision
                  })
                  if (updates.resync) await read($)
                  else
                    for (const event of updates.events) {
                      state = event.value
                      stateRevision = event.revision
                    }
                  if (updates.resync || updates.events.length)
                    $.ui.invalidate("ui.render")
                } catch {
                  lastError = "订阅中断，请关闭页面后重新打开以读取当前状态"
                  $.ui.invalidate("ui.render")
                }
              })
          }
          await $.ui.open({
            id: settings ? "task-settings" : "task-workbench",
            title: settings ? "工作台设置" : title
          })
          return { opened: true }
        }
      }
    )
  }
  on("ui.render", { component: "Pane", requestId: "task-settings" }, ($, event) => {
    const { Form } = $.ui.resolve(event)
    return Form({
      key: "workbench-settings",
      label: "此聊天的工作台设置",
      fields: [{ name: "title", label: "页面标题", type: "text", required: true }],
      values: { title },
      submitLabel: "保存设置",
      onSubmit: async (json) => {
        const values = JSON.parse(json)
        await $.store.set("workbench-title", values.title)
        title = values.title
        $.ui.invalidate("ui.render")
      }
    })
  })
  on("ui.render", { component: "Pane", requestId: "task-workbench" }, ($, event) => {
    const { Box, Text, Button, Table, Chart, Tree, Log, List, Form } = $.ui.resolve(event)
    const tasks = Array.isArray(state.tasks) ? state.tasks : []
    return Box({
      flexDirection: "column",
      gap: 2,
      children: [
        Text({ bold: true, children: title }),
        Text({
          children: "状态来自 " + ref.provider + " / " + ref.version + "，版本 " + stateRevision
        }),
        ...(lastError ? [Text({ children: lastError })] : []),
        Form({
          key: "new-task",
          label: "启动获准的本地任务",
          fields: [{ name: "title", label: "任务名称", type: "text", required: true }],
          values: { title: "本地任务" },
          submitLabel: "启动实际任务",
          onSubmit: async (json) => {
            nextTask = Math.max(nextTask, Number((await $.store.get("task-sequence")) || 0)) + 1
            await $.store.set("task-sequence", nextTask)
            const taskId = "task-" + nextTask
            const argv = options.argv || [
              "node",
              "-e",
              "const fs=require('node:fs');const files=fs.readdirSync('.').slice(0,16);let i=0;function step(){if(i>=files.length)return;const name=files[i++];const s=fs.statSync(name);console.log(name+' '+s.size+' bytes');setTimeout(step,200)}step()"
            ]
            const result = await $.platform.act({
              ref: consumerRef,
              target,
              action: "task-start",
              input: { taskId, title: JSON.parse(json).title, argv },
              requestKey: taskId
            })
            lastError =
              result.status === "succeeded" && result.value?.status === "succeeded"
                ? ""
                : "启动结果：" + result.status + "，请核对实际状态，不会自动重试"
            await read($)
            $.ui.invalidate("ui.render")
          }
        }),
        Table({
          label: "真实任务",
          columns: [
            { key: "title", label: "任务" },
            { key: "status", label: "状态" }
          ],
          rows: tasks
            .slice(0, 100)
            .map((task) => ({ title: task.title || task.id, status: task.status }))
        }),
        Chart({
          label: "当前任务分布",
          series: ["running", "succeeded", "failed", "cancelled"].map((status) => ({
            label: status,
            value: tasks.filter((task) => task.status === status).length
          }))
        }),
        Tree({
          label: "任务层级",
          items: [
            {
              id: "tasks",
              label: "当前聊天",
              children: tasks
                .slice(0, 100)
                .map((task) => ({ id: task.id, label: task.title || task.id }))
            }
          ]
        }),
        List({
          label: "输出摘要",
          items: tasks.slice(0, 50).map((task) => ({
            id: task.id,
            label: task.title || task.id,
            detail: String(task.output || task.error || task.status).slice(-1000)
          }))
        }),
        Log({
          label: "当前结果",
          entries: tasks.slice(-50).map((task) => ({
            id: task.id,
            text: task.id + ": " + task.status,
            level: task.status === "failed" ? "error" : "info"
          }))
        }),
        ...tasks
          .filter((task) => task.status === "running")
          .slice(0, 20)
          .map((task) =>
            Button({
              key: "cancel-" + task.id,
              label: "取消 " + (task.title || task.id),
              onPress: async () => {
                const result = await $.platform.act({
                  ref: consumerRef,
                  target,
                  action: "task-cancel",
                  input: { taskId: task.id },
                  requestKey: "cancel-" + task.id
                })
                lastError =
                  result.status === "succeeded" && result.value?.status === "succeeded"
                    ? ""
                    : "取消尚未确认，请核对状态"
                await read($)
                $.ui.invalidate("ui.render")
              }
            })
          ),
        Button({
          key: "check-toast",
          label: "核对通知样式",
          onPress: async () => {
            await $.ui.toast("任务工作台通知")
          }
        }),
        Button({
          key: "check-suggestion",
          label: "核对输入建议",
          onPress: async () => {
            await $.prompt.suggest({ text: "继续检查任务工作台状态" })
          }
        }),
        Button({
          key: "refresh",
          label: "重新读取真实状态",
          onPress: async () => {
            await read($)
            $.ui.invalidate("ui.render")
          }
        })
      ]
    })
  })
}

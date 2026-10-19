import type { On, JsonObject } from "claude-code"

const query = {
  ref: { provider: "native.file-edits", id: "changes", version: "1.0.0" },
  target: { kind: "current" as const }
}

export function register(on: On, options: JsonObject) {
  let last: JsonObject = { status: "unknown" }
  let revision = 0
  let subscription: string | undefined
  let watcher: { cancel(): Promise<void> } | undefined
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "reminder",
      version: "1.0.0",
      title: "编辑提醒",
      scope: "conversation",
      stateSchema: { type: "object" },
      presentation: {
        type: "surface",
        apiVersion: "devclaw.surface/v1",
        id: "reminder",
        title: "编辑提醒",
        placement: "sidebar",
        paneId: "edits",
        openAction: "open",
        closeAction: "close"
      },
      actions: [
        {
          id: "open",
          title: "查看宿主编辑完成记录",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: [
            "platform.read",
            "platform.publish",
            "platform.subscribe",
            "platform.poll",
            "clock.every",
            "ui.invalidate",
            "ui.open"
          ],
          cancellable: false,
          idempotency: "keyed"
        },
        {
          id: "close",
          title: "停止提醒并退订",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.unsubscribe"],
          cancellable: false,
          idempotency: "keyed"
        }
      ]
    },
    {
      async act($, event): Promise<JsonObject> {
        const read = async () => {
          const state = await $.platform.read(query)
          revision = state.revision
          last =
            state.status === "ready"
              ? { status: "ready", revision, edit: state.value ?? null }
              : { status: "unknown", revision }
          await $.platform.publish({
            id: "reminder",
            version: "1.0.0",
            target: { kind: "current" },
            value: last
          })
          $.ui.invalidate("ui.render")
        }
        if (event.action === "close") {
          await watcher?.cancel()
          watcher = undefined
          if (subscription) await $.platform.unsubscribe({ subscriptionId: subscription })
          subscription = undefined
          return { closed: true }
        }
        await read()
        if (!subscription) {
          subscription = (await $.platform.subscribe(query)).subscriptionId
          watcher = $.clock.every(500, async () => {
            if (!subscription) return
            const packet = await $.platform.poll({
              subscriptionId: subscription,
              afterRevision: revision
            })
            if (packet.resync || packet.revision !== revision) await read()
          })
        }
        await $.ui.open({ id: "edits", title: "编辑提醒" })
        return { opened: true }
      }
    }
  )
  on("ui.render", { component: "Pane", requestId: "edits" }, ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    const edit = last.edit as JsonObject | undefined
    return Box({
      children: [
        Text({
          children:
            last.status === "ready"
              ? `宿主已完成 ${String(edit?.operation)}：${String(edit?.path)}（版本 ${revision}）`
              : "尚无可核对的宿主文件编辑完成记录"
        }),
        Button({
          key: "write-example",
          label: "明确写入示例文件",
          onPress: async () => {
            // This path is reached only from a fresh native user action with the real write lease.
            await $.fs.write(
              String(options.path ?? "edit-reminder.txt"),
              String(options.text ?? "此文件由编辑提醒的明确操作写入。")
            )
          }
        })
      ]
    })
  })
}

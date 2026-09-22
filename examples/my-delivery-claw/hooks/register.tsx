export function register(on) {
  const completed = new Set()
  const paneId = "my-delivery-claw"
  async function settings($) {
    return {
      name: (await $.store.get("name")) || "阿牛",
      rule: (await $.store.get("rule")) || "交付前确认：代码检视、功能测试、未解决的问题。",
      enabled: (await $.store.get("enabled")) !== false
    }
  }
  async function saveText($, key, text, limit, label) {
    const value = text.trim()
    if (!value || value.length > limit) return `请输入 1–${limit} 个字符。`
    await $.store.set(key, value)
    $.ui.invalidate("ui.render")
    return `已保存${label}：${value}\n\n${card(await settings($), "当前预览")}\n\n本项目的其他会话也会使用这项设置。`
  }
  function card(config, detail) {
    return [
      `${config.name} · ${detail}`,
      `交付提醒：${config.rule}`,
      "待确认：代码检视 / 功能测试 / 未解决的问题",
      "这是交付提醒，不代表已经完成检视或测试。"
    ].join("\n")
  }
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "my-claw",
      description: "打开我的交付助手，设置名字、提醒并预览交付卡",
      argumentHint: "[preview | status | on | off | last | name 名字 | rule 提醒]",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "my-claw" }, async ($, e) => {
    const args = e.args.trim()
    if (args.startsWith("name ")) return { text: await saveText($, "name", args.slice(5), 30, "名字") }
    if (args.startsWith("rule ")) return { text: await saveText($, "rule", args.slice(5), 300, "提醒") }
    if (args === "on" || args === "off") {
      await $.store.set("enabled", args === "on")
      $.ui.invalidate("ui.render")
      return { text: args === "on" ? "已开启自动交付提醒。" : "已关闭自动交付提醒。" }
    }
    if (args === "preview" || args === "status")
      return { text: card(await settings($), args === "status" ? "当前状态" : "预览（未执行任务）") }
    if (args === "last")
      return { text: (await $.store.get("last-report")) || "本项目还没有交付卡。" }
    if (args) return { text: "用法：/my-claw [preview | status | on | off | last | name 名字 | rule 提醒]" }
    await $.ui.open({ id: paneId, title: "我的交付 Claw", rows: 18, closeOnEscape: true })
    return { text: "交付助手已打开。修改名字和提醒，再发一条普通消息体验自动交付卡。" }
  })
  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== "answer" || e.isAborted || completed.has(e.turnId))
      return result
    const config = await settings($)
    if (!config.enabled) return result
    const report = card(config, `本轮已结束 · ${Math.round(e.durationMs / 1000)} 秒`)
    await $.store.set("last-report", report)
    completed.add(e.turnId)
    if (completed.size > 64) completed.delete(completed.values().next().value)
    $.ui.invalidate("ui.render")
    // Preserve text added by other completion hooks instead of replacing it.
    const previous = result.text && result.text !== e.answer ? `${result.text}\n\n` : ""
    return { ...result, text: previous + report }
  })
  on("ui.render", { component: "Pane", requestId: paneId }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const config = await settings($)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{config.name} · 我的交付助手</Text>
        <Text>每次主会话回答结束后，显示你自己的交付提醒。</Text>
        <Input
          key="name"
          label="Claw 的名字（最多 30 字）"
          value={config.name}
          submitLabel="保存名字"
          onSubmit={async (value) => { await saveText($, "name", value, 30) }}
        />
        <Input
          key="rule"
          label="交付提醒（最多 300 字）"
          value={config.rule}
          submitLabel="保存提醒"
          onSubmit={async (value) => { await saveText($, "rule", value, 300) }}
        />
        <Button
          key="toggle"
          label={config.enabled ? "关闭自动提醒" : "开启自动提醒"}
          onPress={async () => {
            await $.store.set("enabled", !config.enabled)
            $.ui.invalidate("ui.render")
          }}
        />
        <Text>状态：{config.enabled ? "已开启" : "已关闭"}</Text>
        <Text>{card(config, "交付卡预览")}</Text>
        <Text dimColor>只设置交付提醒，不修改模型提示词，也不自动检视代码或运行测试。</Text>
      </Box>
    )
  })
}

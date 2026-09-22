import { recordsFrom, relativePath } from "./core.js"
import { inspectFeature } from "./inspect.js"

export function register(on) {
  let rows = []
  let selected = ""
  let text = "点击刷新读取项目状态。"
  let reviewMode = "off"
  let reviewTarget = ""
  const pane = "autobiz-kanban"

  async function refresh($) {
    reviewMode = await $.store.get("review-mode") || "off"
    reviewTarget = await $.store.get("review-target") || ""
    try {
      rows = recordsFrom(await $.fs.read(".autobizdevops/state.json"))
      selected = selected && rows.some(item => item.feature === selected) ? selected : rows[0]?.feature || ""
      text = selected ? await check($, selected) : "当前项目没有 Feature。"
    } catch (error) {
      rows = []
      text = `无法读取：${error.message}`
    }
    await $.ui.invalidate("ui.render")
  }

  async function check($, id) {
    try { return await inspectFeature($, id) }
    catch (error) { return `无法检查：${error.message}` }
  }

  on("session.start", {}, async ($, e, next) => next(e))
  on("command.run", { command: "kanban" }, async ($) => {
    await refresh($)
    await $.ui.open({ id: pane, title: "Autobiz · 项目交付看板", rows: 22, closeOnEscape: true })
    return { text }
  })
  on("ui.render", { component: "Pane", requestId: pane }, ($, e) => {
    const { Box, Text, Select, Button, Input } = $.ui.resolve(e)
    return <Box flexDirection="column" gap={1}>
      <Text bold>Autobiz · 项目交付看板</Text>
      <Text>完成前自动单文件评审（开启会产生模型用量；不代替测试和业务验收）</Text>
      <Select key="review-mode" value={reviewMode} options={[
        { value: "off", label: "关闭" }, { value: "report", label: "仅报告" },
        { value: "check", label: "有问题则阻止完成" }, { value: "repair", label: "自动修复并复检" }
      ]} onSelect={async value => {
        if (!["off", "report", "check", "repair"].includes(value)) return
        await $.store.set("review-mode", value)
        reviewMode = value
        await $.ui.invalidate("ui.render")
      }} />
      <Input key="review-target" label="评审文件（项目相对路径）" value={reviewTarget}
        onSubmit={async value => {
          try {
            relativePath(value)
            await $.fs.read(value)
            await $.store.set("review-target", value)
            reviewTarget = value
            text = `已保存评审范围：${value}`
          } catch (error) { text = `未保存：${error.message}` }
          await $.ui.invalidate("ui.render")
        }} />
      <Button key="review-last" label="最近自动评审结果" onPress={async () => {
        text = (await $.store.get("review-result"))?.report || "尚无自动评审记录。"
        await $.ui.invalidate("ui.render")
      }} />
      {rows.length ? <Select key="feature" value={selected} options={rows.map(item => ({ value: item.feature, label: `${item.feature} · ${item.checkpoint}` }))} onSelect={async value => { selected = value; text = await check($, value); await $.ui.invalidate("ui.render") }} /> : <Text>请点击刷新。</Text>}
      <Button key="refresh" label="刷新真实状态" onPress={async () => refresh($)} />
      <Button key="check" label="检查当前阶段产物" onPress={async () => { text = await check($, selected); await $.ui.invalidate("ui.render") }} />
      <Text>{text}</Text>
    </Box>
  })
}

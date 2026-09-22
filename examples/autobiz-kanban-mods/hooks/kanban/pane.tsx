import { recordsFrom, relativePath } from "./core.js"
import { inspectFeature } from "./inspect.js"

export function register(on) {
  let rows = []
  let selected = ""
  let text = "点击刷新读取项目状态。"
  let reviewMode = "off"
  let reviewTarget = ""
  let policy = { mode: "off", scope: "project", checks: ["code-review", "unit-test", "e2e", "autobiz-validator"], maxRepairs: 2, timeoutMs: 120000, modelTokenBudget: 8192 }
  const pane = "autobiz-kanban"

  async function refresh($) {
    reviewMode = await $.store.get("review-mode") || "off"
    reviewTarget = await $.store.get("review-target") || ""
    try { policy = { ...policy, ...(await $.store.get("completion-config") || {}), mode: reviewMode } } catch {}
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
      <Text>完成门禁：{policy.mode} · 范围：{policy.scope} · 检查：{policy.checks.join(", ")}</Text>
      <Select key="review-mode" value={reviewMode} options={[
        { value: "off", label: "关闭" }, { value: "report", label: "仅报告" },
        { value: "check", label: "有问题则阻止完成" }, { value: "repair", label: "自动修复并复检" }
      ]} onSelect={async value => {
        if (!["off", "report", "check", "repair"].includes(value)) return
        await $.store.set("review-mode", value)
        policy = { ...policy, mode: value }
        await $.store.set("completion-config", policy)
        reviewMode = value
        await $.ui.invalidate("ui.render")
      }} />
      <Select key="review-scope" value={policy.scope} options={[
        { value: "file", label: "当前文件" }, { value: "diff", label: "当前 diff" },
        { value: "feature", label: "Feature" }, { value: "project", label: "整个项目" }
      ]} onSelect={async value => {
        if (!["file", "diff", "feature", "project"].includes(value)) return
        policy = { ...policy, scope: value }
        await $.store.set("completion-config", policy)
        await $.ui.invalidate("ui.render")
      }} />
      <Select key="review-check" value={policy.checks[0] || "code-review"} options={[
        { value: "code-review", label: "代码评审" }, { value: "unit-test", label: "单元测试" },
        { value: "e2e", label: "E2E" }, { value: "autobiz-validator", label: "Autobiz validator" }
      ]} onSelect={async value => {
        if (!["code-review", "unit-test", "e2e", "autobiz-validator"].includes(value)) return
        policy = { ...policy, checks: [value] }
        await $.store.set("completion-config", policy)
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
      <Input key="review-budget" label={`最大修复次数（${policy.maxRepairs}）`} value={String(policy.maxRepairs)}
        onSubmit={async value => { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 10) text = "最大修复次数必须是 0 到 10"; else { policy = { ...policy, maxRepairs: n }; await $.store.set("completion-config", policy); text = "已保存修复次数" }; await $.ui.invalidate("ui.render") }} />
      <Input key="review-timeout" label={`最长时间毫秒（${policy.timeoutMs}）`} value={String(policy.timeoutMs)}
        onSubmit={async value => { const n = Number(value); if (!Number.isInteger(n) || n < 1000 || n > 3600000) text = "最长时间必须在 1000 到 3600000 毫秒"; else { policy = { ...policy, timeoutMs: n }; await $.store.set("completion-config", policy); text = "已保存最长时间" }; await $.ui.invalidate("ui.render") }} />
      <Input key="review-tokens" label={`模型用量预算（${policy.modelTokenBudget}）`} value={String(policy.modelTokenBudget)}
        onSubmit={async value => { const n = Number(value); if (!Number.isInteger(n) || n < 256 || n > 1000000) text = "模型预算必须在 256 到 1000000"; else { policy = { ...policy, modelTokenBudget: n }; await $.store.set("completion-config", policy); text = "已保存模型预算" }; await $.ui.invalidate("ui.render") }} />
      <Button key="review-last" label="最近自动评审结果" onPress={async () => {
        const result = await $.store.get("review-result")
        text = result ? `检查证据：${JSON.stringify(result)}` : "尚无检查证据。"
        await $.ui.invalidate("ui.render")
      }} />
      {rows.length ? <Select key="feature" value={selected} options={rows.map(item => ({ value: item.feature, label: `${item.feature} · ${item.checkpoint}` }))} onSelect={async value => { selected = value; text = await check($, value); await $.ui.invalidate("ui.render") }} /> : <Text>请点击刷新。</Text>}
      <Button key="refresh" label="刷新真实状态" onPress={async () => refresh($)} />
      <Button key="check" label="检查当前阶段产物" onPress={async () => { text = await check($, selected); await $.ui.invalidate("ui.render") }} />
      <Text>{text}</Text>
    </Box>
  })
}

import { recordsFrom, relativePath } from "./core.js"
import { inspectFeature } from "./inspect.js"

const modes = { off: "关闭", report: "仅报告", check: "有问题则阻止完成", repair: "自动修复并复检" }
const scopes = { file: "当前文件", diff: "当前 diff", feature: "Feature", project: "整个项目" }
const checks = {
  "code-review": "代码评审",
  "unit-test": "单元测试",
  e2e: "E2E",
  "autobiz-validator": "Autobiz validator"
}
const statuses = {
  passed: "通过",
  failed: "失败",
  blocked: "阻塞",
  "not-run": "未执行",
  skipped: "跳过",
  timeout: "超时",
  error: "错误"
}
const defaults = {
  mode: "off",
  scope: "project",
  checks: Object.keys(checks),
  maxRepairs: 2,
  timeoutMs: 120000,
  modelTokenBudget: 8192
}
const options = (values) => Object.entries(values).map(([value, label]) => ({ value, label }))
const record = (value) => value && typeof value === "object" && !Array.isArray(value)
const safe = (value, limit = 1000) =>
  typeof value === "string"
    ? // eslint-disable-next-line no-control-regex -- Guest evidence is plain text, never terminal controls.
      value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, limit)
    : ""

function numberValue(value, min, max, label, fromInput = false) {
  if (typeof value !== "number" && !(fromInput && typeof value === "string"))
    throw Error(`${label}必须是整数`)
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) throw Error(`${label}必须是整数`)
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max)
    throw Error(`${label}必须在 ${min} 到 ${max} 之间`)
  return number
}

function normalized(input) {
  if (!record(input)) throw Error("完成配置必须是对象")
  const policy = { ...defaults, ...input }
  if (!Object.hasOwn(modes, policy.mode) || !Object.hasOwn(scopes, policy.scope))
    throw Error("模式或范围无效")
  if (
    !Array.isArray(policy.checks) ||
    policy.checks.length > 4 ||
    policy.checks.some((check) => !Object.hasOwn(checks, check))
  )
    throw Error("检查项无效")
  policy.checks = [...new Set(policy.checks)]
  if (policy.mode !== "off" && !policy.checks.length) throw Error("开启前至少选择一项检查")
  policy.maxRepairs = numberValue(policy.maxRepairs, 0, 10, "最大修复次数")
  policy.timeoutMs = numberValue(policy.timeoutMs, 1000, 3600000, "最长时间毫秒")
  policy.modelTokenBudget = numberValue(
    policy.modelTokenBudget,
    256,
    1000000,
    "模型 Token 总预算（输入 + 输出）"
  )
  if (policy.target !== undefined) relativePath(policy.target)
  if (policy.feature !== undefined) {
    relativePath(policy.feature)
    if (policy.feature.includes("/")) throw Error("Feature 名称不能包含目录")
  }
  return policy
}

export function register(on) {
  let rows = []
  let selected = ""
  let text = "点击刷新读取项目状态。"
  let policy = { ...defaults }
  let configError = ""
  let review = null
  const pane = "autobiz-kanban"

  async function loadReview($) {
    const value = await $.store.get("review-result")
    review = record(value) ? value : null
  }
  async function save($, updates) {
    const next = normalized({ ...policy, ...updates })
    // The structured project policy is authoritative; aliases support older commands only.
    await $.store.set("completion-config", next)
    policy = next
    configError = ""
    await $.store.set("review-mode", next.mode)
    await $.store.set("review-target", next.target || "")
    text =
      next.mode === "off"
        ? "已关闭此插件的完成门禁。"
        : "已保存项目规则；下一轮完成前读取这些设置。"
  }
  async function edit($, operation) {
    try {
      await operation()
    } catch (error) {
      text = `未保存：${error.message}`
    }
    await $.ui.invalidate("ui.render")
  }
  async function refresh($) {
    configError = ""
    try {
      const saved = await $.store.get("completion-config")
      if (saved !== undefined) policy = normalized(saved)
      else {
        const mode = (await $.store.get("review-mode")) || "off"
        const target = await $.store.get("review-target")
        policy = normalized(
          target
            ? { ...defaults, mode, scope: "file", checks: ["code-review"], target }
            : { ...defaults, mode }
        )
      }
    } catch (error) {
      policy = { ...defaults }
      configError = `已保存配置无效：${error.message}。宿主将拒绝该配置；请修改后保存。`
    }
    await loadReview($)
    try {
      rows = recordsFrom(await $.fs.read(".autobizdevops/state.json"))
      selected =
        selected && rows.some((item) => item.feature === selected)
          ? selected
          : rows[0]?.feature || ""
      text = selected ? await check($, selected) : "当前项目没有 Feature。"
    } catch (error) {
      rows = []
      text = `无法读取：${error.message}`
    }
    await $.ui.invalidate("ui.render")
  }
  async function check($, id) {
    try {
      return await inspectFeature($, id)
    } catch (error) {
      return `无法检查：${error.message}`
    }
  }

  on("session.start", {}, async ($, e, next) => next(e))
  on("command.run", { command: "kanban" }, async ($) => {
    await refresh($)
    await $.ui.open({ id: pane, title: "Autobiz · 项目交付看板", rows: 32, closeOnEscape: true })
    return { text }
  })
  on("ui.render", { component: "Pane", requestId: pane }, ($, e) => {
    const { Box, Text, Select, Button, Input } = $.ui.resolve(e)
    const featureOptions = [
      { value: "", label: "请选择验收 Feature" },
      ...rows.map((item) => ({ value: item.feature, label: item.feature }))
    ]
    if (policy.feature && !rows.some((item) => item.feature === policy.feature))
      featureOptions.push({ value: policy.feature, label: `${policy.feature}（当前状态中不存在）` })
    const steps = Array.isArray(review?.steps) ? review.steps.slice(0, 24).filter(record) : []
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Autobiz · 项目交付看板</Text>
        <Text>
          {configError ||
            `已保存规则：${modes[policy.mode]} · 范围：${scopes[policy.scope]} · 检查：${policy.checks.map((check) => checks[check]).join("、") || "未选择"}`}
        </Text>
        <Text>{`文件：${policy.target || "未设置"} · Feature：${policy.feature || "未设置"} · 最多修复 ${policy.maxRepairs} 次 · 最长 ${policy.timeoutMs} 毫秒`}</Text>
        <Select
          key="review-mode"
          label="完成行为"
          value={policy.mode}
          options={options(modes)}
          onSelect={(value) => edit($, () => save($, { mode: value }))}
        />
        <Select
          key="review-scope"
          label="检查范围"
          value={policy.scope}
          options={options(scopes)}
          onSelect={(value) => edit($, () => save($, { scope: value }))}
        />
        <Text>检查项（可组合选择）：</Text>
        {Object.entries(checks).map(([value, label]) => (
          <Button
            key={`review-check-${value}`}
            label={`${policy.checks.includes(value) ? "已选" : "未选"} · ${label}`}
            onPress={() =>
              edit($, () =>
                save($, {
                  checks: policy.checks.includes(value)
                    ? policy.checks.filter((check) => check !== value)
                    : [...policy.checks, value]
                })
              )
            }
          />
        ))}
        <Input
          key="review-target"
          label="评审文件（项目相对路径）"
          value={policy.target || ""}
          onSubmit={(value) =>
            edit($, async () => {
              const target = relativePath(value.trim())
              await $.fs.read(target)
              await save($, { target })
            })
          }
        />
        <Select
          key="review-feature"
          label="验收 Feature"
          value={policy.feature || ""}
          options={featureOptions}
          onSelect={(value) =>
            edit($, async () => {
              if (!rows.some((item) => item.feature === value))
                throw Error("请选择当前项目状态中的 Feature")
              await save($, { feature: value })
            })
          }
        />
        <Input
          key="review-budget"
          label="最大修复次数"
          value={String(policy.maxRepairs)}
          onSubmit={(value) =>
            edit($, () => save($, { maxRepairs: numberValue(value, 0, 10, "最大修复次数", true) }))
          }
        />
        <Input
          key="review-timeout"
          label="最长时间（毫秒）"
          value={String(policy.timeoutMs)}
          onSubmit={(value) =>
            edit($, () =>
              save($, { timeoutMs: numberValue(value, 1000, 3600000, "最长时间毫秒", true) })
            )
          }
        />
        <Input
          key="review-tokens"
          label="模型 Token 总预算（输入 + 输出）"
          value={String(policy.modelTokenBudget)}
          onSubmit={(value) =>
            edit($, () =>
              save($, {
                modelTokenBudget: numberValue(value, 256, 1000000, "模型 Token 总预算", true)
              })
            )
          }
        />
        <Text>模型输入、输出均计入预算；实际用量和耗尽原因以宿主执行证据为准。</Text>
        <Button
          key="review-last"
          label="最近自动评审结果"
          onPress={async () => {
            await loadReview($)
            await $.ui.invalidate("ui.render")
          }}
        />
        <Text bold>插件评审意见</Text>
        <Text>
          以下是插件记录，不代表宿主测试验收或 checkpoint 推进；真实验收以宿主完成门禁证据为准。
        </Text>
        {review ? (
          <Box flexDirection="column" gap={1}>
            <Text>{`任务轮次：${safe(review.turnId, 240) || "未记录"}`}</Text>
            <Text>{safe(review.report, 6000) || "没有摘要。"}</Text>
            {steps.map((step, index) => (
              <Box key={`review-step-${index}`} flexDirection="column">
                <Text>{`${index + 1}. ${checks[step.check] || safe(step.check, 80) || "未知检查"} · ${scopes[step.scope] || safe(step.scope, 80) || "范围未记录"} · 插件报告：${statuses[step.status] || safe(step.status, 80) || "状态未记录"}`}</Text>
                <Text>{`原因：${safe(step.reason) || "未记录"}`}</Text>
                <Text>{`文件：${
                  Array.isArray(step.files)
                    ? step.files
                        .slice(0, 12)
                        .map((file) => safe(file, 240))
                        .filter(Boolean)
                        .join("、") || "未记录"
                    : "未记录"
                }`}</Text>
                <Text>{`下一步：${safe(step.nextAction) || "查看宿主检查证据后重试。"}`}</Text>
              </Box>
            ))}
            {Array.isArray(review.steps) && review.steps.length > 24 ? (
              <Text>仅显示前 24 项；请查看宿主完整检查记录。</Text>
            ) : null}
            <Text>{`下一步动作：${safe(review.nextAction) || "查看宿主完成门禁记录；修复问题后重新检查。"}`}</Text>
          </Box>
        ) : (
          <Text>尚无检查意见。下一步：保存规则并执行一个真实任务。</Text>
        )}
        {rows.length ? (
          <Select
            key="feature"
            label="浏览当前阶段产物"
            value={selected}
            options={rows.map((item) => ({
              value: item.feature,
              label: `${item.feature} · ${safe(item.checkpoint, 240)}`
            }))}
            onSelect={async (value) => {
              selected = value
              text = await check($, value)
              await $.ui.invalidate("ui.render")
            }}
          />
        ) : (
          <Text>请点击刷新。</Text>
        )}
        <Button key="refresh" label="刷新真实状态" onPress={async () => refresh($)} />
        <Button
          key="check"
          label="检查当前阶段产物"
          onPress={async () => {
            text = await check($, selected)
            await $.ui.invalidate("ui.render")
          }}
        />
        <Text>{safe(text, 6000)}</Text>
      </Box>
    )
  })
}

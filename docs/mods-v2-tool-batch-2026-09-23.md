# PostToolBatch 主 Agent 适配

Host v48，参考 Claude Code v2.1.278 Mods 声明。当前主 Agent 模型生成的工具批次全部
返回后，在下一次模型请求前触发一次 `classic.PostToolBatch`：

```ts
on("classic.PostToolBatch", async ($, event, next) => {
  const lower = await next(event)
  // event.tool_calls 按模型请求顺序排列，包含失败工具的可见输出。
  return { ...lower, additionalContext: ["请综合本批次工具返回继续处理"] }
})
```

返回 `block` 或 `preventContinuation` 阻止下一次模型请求；不把停止转换成任务成功。
原 legacy Hook 是 `next` 的一次性核心，重复调用不会重复执行原检查。导入的
`async: true` 对该事件不生效，因为检查必须在下一次模型请求前结束。
配置界面提供该事件、输入输出示例及范围说明。

`tool_calls` 由宿主组装并固定，插件不能改变工具 ID、名称、请求参数或返回内容；
同样固定工作区、线程等公共身份。输入是模型原请求参数，输出是最终模型可见的
ToolMessage 内容，不承诺包含 PreToolUse 修改后的原生参数，也不是原生执行凭证。
它不能证明测试通过、业务验收通过或允许 checkpoint 推进。

适配标为 **adapted**：仅当前 main runtime，批次最多 128 项，并受既有 classic JSON
大小与深度限制。没有共享子 Agent 批次声明，不重放重启前历史。部分返回不会被
视为完整批次；同一批次缓存结果或失败，重试不重复 Hook 副作用。

执行仍通过原 ModsManager、FunctionSession、runHooksEnriched 和 runtime authority。
取消、撤权会终止正在等待的模型评审，失效结果不能送入下一次模型请求。关闭且没有
legacy 批次规则时不安装此 middleware。若用户另行启用 legacy 批次规则，其原有规则
独立生效。

验证记录见 `output/mods-v2-validation/2026-09-23-tool-batch.md`。

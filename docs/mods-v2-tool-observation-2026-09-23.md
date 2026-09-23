# 工具执行观察与失败生命周期（2026-09-23）

参考 Claude Code v2.1.278 的 PostToolUse / PostToolUseFailure 输入契约和
[官方 Hook 说明](https://code.claude.com/docs/en/hooks)。本项仍为 partial。

## 执行信息

PostToolUse / PostToolUseFailure 的 tool_name、tool_use_id、tool_input、原始结果或错误、
可选 is_interrupt、duration_ms、MCP 来源固定为宿主输入。省略字段会恢复原值，next 改写
事实会被拒绝并由原可选 Hook 恢复策略处理。允许的 updatedToolOutput / updatedMCPToolOutput
仍只改变模型和显示投影，不改变执行结果或审计记录。

原 scoped MCP 实际 adapter 调用用单调时钟计时，排除前后 Hook、权限审批、标签页预选和
输出过滤。原回退调用属于同一 adapter 调用，计时包含回退；不是服务端 CPU 时间。
只有测量到才发 duration_ms；原生工具和抛出异常路径未测量时省略，不填 0。
传统脚本保留既有 tool_response，并补齐可用的宿主调用 ID、顶层 error/is_interrupt 和耗时。

## 身份与生命周期

- 原生抛出失败从原 toolCall.id 传到 HookContext；sandbox 失败去重不再信任参数中
  tool_call_id/tool_use_id。同一次执行不会因为参数中的旧 ID 而被抑制。
- 错误分类识别原生 AbortError 与 TimeoutError，保留显式上层取消的优先级和原失败信息。
- Electron 红测发现 MCP 失败观察以 fire-and-forget 越过原调用 lease，真实 guest host call
  被 MODS_CALL_SCOPE_EXPIRED 拒绝。开启 Mods 时等待该观察在原 lease 内结束，仍通过原
  ModsManager / FunctionSession / authority / generation。观察结果不伪造成功状态。
- 关闭 Mods 保留原 legacy 异步时序；这不是新完成门禁。MCP 取消、撤权继续关闭真实上游请求，
  不允许晚到观察继续模型循环。

原生失败通知的异步策略、取消后的通知完整性、所有工具耗时、MCP 多媒体精确投影仍未声明
完成。本项测试不是 Autobiz 业务验收。详见 output/mods-v2-validation/2026-09-23-tool-observation.md。

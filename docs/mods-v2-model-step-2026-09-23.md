# 主模型 step 选择与 effort（2026-09-23）

本轮对齐 Claude Code v2.1.278 `TurnStepInput` 中可重写的 model / effort。
主 Agent 每次模型请求都通过原 ModsManager、FunctionSession 流式边界；插件只提交模型引用和
effort，凭据、endpoint、请求上下文、工具、用量和运行身份仍由宿主持有。

```ts
on("turn.step", async function* ($, e, next) {
  const selected = e.index === 0
    ? { ...e, model: "custom:review-model", effort: "high" }
    : e
  for await (const chunk of next(selected)) yield chunk
})
```

模型引用须能解析到应用已配置且有凭据的模型。每一步从本轮默认配置开始；插件选择不写入
全局设置，也不改变下一个 step 的默认值。默认模型使用捕获的原配置，避免同名模型映射到
其他 endpoint。宿主通过原 `getModelInstance` 创建 provider，保留既有 retry、响应诊断、
thread capture 和 cancellation transport，并重新绑定该请求当前的工具及绑定选项。

显式 effort 控制目前仅适用于宿主已有的 **DeepSeek 请求适配器**（工厂按模型名称中的
`deepseek` 选择此协议分支），支持 `low`、`high`、`max`，并启用该步的 thinking/effort。
该适配器明确写入顶层 `reasoning_effort`；其他适配器只有泛化的 `chat_template_kwargs`，
不足以证明 provider 消费 effort，因此显式 effort 请求会拒绝。不更改原全局模型工厂或
用户已有默认配置，非 DeepSeek 原生请求仍可运行；它们的 step 输入不广告无法保证的 effort。
切换到此类模型时，需要从传给 next 的输入中移除旧模型 effort，使用目标模型原配置。
`medium`、`xhigh`、数值及其他无法映射的值同样返回 `MODS_MODEL_EFFORT_UNSUPPORTED`；未知模型
返回 `MODS_MODEL_NOT_CONFIGURED`。不把未配置的 Claude 模型别名自动映射到任意 provider。
这一项为 adapted，并非所有上游 effort 值和 provider 语义完全兼容。

宿主保留目标模型的输出预算和安全余量，使用现有本地估算器计入当前 messages（包括 system）
与绑定工具 schema。估算输入超过目标模型预算时，在请求前返回 `MODS_MODEL_INPUT_BUDGET`。
这是有界的本地估计，不是 provider tokenizer 保证；切换到更小的模型不会静默截断消息，
也不会重置本轮额度或自动修改原 compaction 策略。

解析模型后、发布有效模型后以及 provider 每次读取前后检查取消/authority。model stream
同时注册到准确的 runtime authority：替换、关闭或撤销 owner 会主动 abort 正在等待的
provider signal，不必等下一块输出。正常结束、未消费流关闭、取消和生命周期创建失败都会
解除该资源。FunctionModsManager 的发布包装在 finally 关闭内层 core，保证消费者提前结束
或发布失败时仍释放 provider。一个 boundary
拒绝重叠 provider 请求，避免并发请求覆盖有效会话模型。provider 请求期间 session.model 和
context window 更新为该步的实际选择，结束、异常或消费者关闭后恢复默认。旧的异步 session
读快照在模型/window 改变时失效。更新不会清空 messages、request、compactor 或真实用量；
已完成回复上的 provider model_name 与 usage_metadata 保留，和当前有效模型区分。

本轮没有建立新的 classic.PreModelSwitch / PostModelSwitch 生命周期，也未扩大 child Agent、
fork/classify、流式 chunk schema 的支持范围。主 Agent 的 turn.step 输入省略 agentId，
符合官方主循环身份约定。关闭 Mods 时直接使用原模型，不调用 resolver。

## 验证

先增加失败测试，再实现宿主 resolver、工具重绑定、预算和取消校验。另加旧 session 快照
失效的失败回归后补上 snapshot invalidation。

- `mods-model-boundary.test.ts`：21/21。包含真实 QuickJS guest、真实 createAgent 和实际
  ChatOpenAI SSE transport：首步切换 provider、真实工具调用、第二步恢复默认、对应会话
  model/window 和真实响应 usage/model_name；low/high/max 请求体；未知模型/effort；
  取消/替换期间零请求；工具 schema 超预算；异常/消费者关闭后恢复；关闭模块零 resolver。
- `mods-session-view.test.ts` 和 `session-read-host.test.ts`：14/14。
- 三套合计 35/35（2026-09-23 09:05，11.73 秒），Node typecheck 通过，相关四个文件
  ESLint `--quiet` 通过。
- 独立审查后追加失败回归：三个非 DeepSeek 实际 transport 可用但显式 effort 拒绝；
  真实 FunctionModsManager/FunctionSession/guest 路径的 consumer-close 与发布失败；
  provider 正在等待时替换 authority 主动中止；四种结束方式各重复 105 次均释放资源。
  最终三套合并 **87/87 通过**（2026-09-23 09:14，32.53 秒），见同日 model-step-selection
  验证报告及 model-step-review-tests.log。
- 模型 transport 使用本地测试响应，不调用外部付费模型。这是运行链路验证，不能当作模型
  质量或 Autobiz 业务验收。Electron E2E、打包和性能回检由本轮统一验证报告记录。

Electron 追加场景可复用既有本地 model server：为第二个配置引用建立独立 endpoint，
让 module 仅在首个 step 选择该引用，验证服务端接收的 model、effort、tools 和实际文件读取，
随后默认 endpoint 完成回复；同一任务关闭 module 时应只访问默认 endpoint。

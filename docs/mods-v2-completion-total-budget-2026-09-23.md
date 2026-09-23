# DIY 检查和原修复循环的总模型预算

本能力把输入和输出 token 纳入同一个宿主预算，并让检查、原有 Stop / PostSkillUse 修复、门禁修复及复检共享一个绝对截止时间。它没有建立第二个 Agent 循环，也不替代原有 authority、lease、generation、checkpoint 和证据检查。

## 计量与调用边界

- 必须门禁的预算在宿主创建 gate 时绑定。原完成循环从 gate 取回同一对象，包住完整的异步消费过程，所有原修复入口继续调用原来的 `runRevision`。纯关闭配置不创建该预算作用域。
- 主 Agent、摘要模型、工具调用中的子 Agent，在真实 HTTP fetch 的每次物理尝试处预留用量。预留输入包含实际序列化 messages、tools 和请求字段的 UTF-8 字节数，以及每条消息的 framing 余量；输出上限写入真实请求的 `max_tokens` 或 `max_completion_tokens`，不依赖当前 LangChain 未映射的调用选项。
- 输入预留是保守的准入估算，不是所有供应商分词协议的数学上界或外部账单保证。最终结算使用供应商真实响应中的 input/output usage。供应商超报、漏报、无法映射或实际用量超预算都会阻止完成；不能用估算值补造 PASS。
- SDK `complete` / `classify` / `fork` 由 `FunctionModels` 已有宿主调用边界预留、记录及结算；其 `function-completion` transport 不再重复计费。清理 LangChain 嵌套回调上下文不会清理宿主预算 AsyncLocalStorage。
- 预算结束必须没有未结算 reservation。未知用量、超额、重复结算和已过期异步作用域会留下不可被插件 catch 后清除的失败状态。

当前 transport 适配现有 OpenAI-compatible messages JSON / SSE 协议；不支持的请求形状安全拒绝。它不宣称与其他供应商任意原生协议完全兼容。

## 流式与重试

SSE 继续逐 chunk 透传，解析跨 chunk 的 usage。累计 usage 重复事件只结算一次，cache 命中字段不再重复加到 prompt tokens。请求体有 8 MiB 上限；待解析数据和单事件有 1 MiB 上限，单事件最多 8192 条 data 行。

收到 `[DONE]` 时按此前真实 usage 结算；重复终止标记幂等。终止标记后再出现非终止 data 会留下未知用量失败，不允许较大的迟到 usage 被静默忽略。缺 usage、格式错误、累计值倒退、未结束消费或中途取消不能形成最终 PASS。

每次重试独立预留、结算。失败响应只有提供有效真实 usage（例如明确 0 / 0）才可能继续重试。HTTP 错误、连接失败或中止而无法取得 usage 时，预算会阻断后续重试及完成。这是有意收紧的适配行为，不能描述为保留所有原重试语义。

## 截止时间和原生工具

原 loop 把同一截止时间信号传给原 `runRevision`、Stop 和 PostSkillUse HookContext。IPC invoke / resume / interrupt 与 IM 的原 callback 把该信号传到原图流式调用；IM 消费也使用同一信号。

每个既有 runtime 建立局部取消控制器，与原父 signal 合并。仅在预算作用域中的实际 tool middleware 入口，把本次图 signal 和剩余 deadline 单向接入这个 runtime 的 sandbox / MCP / subagent 已有共享信号。退出调用时移除监听；不取消外部 controller，也不污染下一次新建 runtime。预算内的后台 execute 请求按前台执行，以免原生进程逃出修复期限。

关闭时真实 fetch 直接委托，不解析 body、不扫描输入、不包装响应；工具预算入口直接执行，不建立期限定时器。原 loop 继续使用原 signal。原取消/撤权仍由原 authority 和 lease 验证，不授予新权限。

## 验证边界

`completion-budget-loop.test.ts` 验证三个原修复来源共享预算、未知/未结算用量拒绝完成、原 hooks 信号和关闭对照。`mods-model-budget.integration.test.ts` 使用真实 loopback HTTP producer、真实模型 adapter、真实 createAgent 和工具中子 Agent，覆盖物理请求输出上限、完整工具输入、摘要/子 Agent、真实重试、SSE 分片/重复/超限/迟到事件、取消和关闭。

`completion-native-budget.test.ts` 使用真实 LocalSandbox 启动阻塞 Node 子进程，期限结束后验证进程已退出；并验证调用结束后的 signal 不会误杀后续 runtime，关闭时不建 timer。这些是执行链和合同测试，不能替代真实业务验收。Electron E2E、安装包和完整业务演示由总集成报告统一记录。

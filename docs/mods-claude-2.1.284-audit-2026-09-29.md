# Claude Code 2.1.284 安装包复核与本轮迭代

## 发布版本与证据范围

2026-09-29 核实 npm `latest/next=2.1.284`、`stable=2.1.277`。GitHub 官方 release 为 [v2.1.284](https://github.com/anthropics/claude-code/releases/tag/v2.1.284)，发布时间 2026-09-28 18:02:03 UTC。本机全局 CLI 为 2.1.272；本轮单独下载固定版本用于研究，没有替换全局安装。

官方来源：

- [npm Windows x64 包元数据](https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/2.1.284)
- [固定版本公开类型](https://github.com/anthropics/claude-code/blob/v2.1.284/mods/types/claude-code.d.ts)
- [官方 Mods 使用说明](https://github.com/anthropics/claude-code/blob/v2.1.284/mods/README.md)

这里的“反编译”具体指 PE/Bun 模块表提取、内嵌压缩资产解码和 JavaScript 格式化。没有恢复原始 TypeScript、原始符号或原生机器码。第三方安装包和提取代码保存在忽略的 `output/`，不复制进产品。

产物目录：`C:\ai\CmbCoworkAgent-mods-v2\output\claude-code-2.1.284-analysis`。

| 产物 | 可复核值 |
| --- | --- |
| npm 原始包 | `anthropic-ai-claude-code-win32-x64-2.1.284.tgz`，111621304 字节 |
| npm SRI | `sha512-Usw9Z8unwN6sWlhAJm5pBdTj5LoYBotUddhCBpnnH1XFJT9dgxRvRXqhftuVQi6LhorFo/HD0VfeHmmJFNCMaw==`，下载后完整校验通过 |
| 二进制 | `native/package/claude.exe`，246480032 字节；实际 `--version` 返回 `2.1.284 (Claude Code)` |
| 二进制 SHA256 | `0416631e846f743110da5282409776fa1313e65f33a588aae066eaf8db0fda7d` |
| 提取索引 | `manifest.json`，2377 个模块，44140449 字节内容，0 个 sourcemap；每个模块有偏移和 SHA256 |
| 内嵌声明 | `readable/claude-code.d.ts-c417f0db.txt`，SHA256 `7BDD541D2D29D2331D292EE614AF35D18C949668473B07C792D458AB95A4001D` |
| 公开声明 | `official-v2.1.284.d.ts`，SHA256 `6D19C8250D22358C8527189274D96F9F862C30C8650C92030359AA407A01DEA2` |
| 声明差分 | `embedded-declarations.diff`，相对 283 内嵌声明新增 396 行、删除 27 行；283/284 公开声明却完全相同 |

公开文件仍不是最新二进制契约的完整反映。因此不能仅更新版本号或比对 GitHub 的类型文件便宣布完成兼容。

## 运行实现和实际探针

`formatted/chunk-hvqemeay.js`：

- `Gxe`（76502 行附近）处理独立 completion 的模型白名单、maxTokens、effort、timeoutMs，并返回 `isAnswered` 结果联合。
- `xwt`（76627 行附近）处理 fork：冷会话返回 `nothing-to-fork`；使用主线程捕获上下文、禁止工具调用；汇总四字段 usage，区分 API 错误、空回复和取消。
- `_Ce`（60995 行附近）通过原生 `fetch` 发请求，HTTP 边界另做逐跳重定向和凭据句柄处理。自动解压是底层 fetch 的行为；本工程新增的解压不是从上游拷贝一套传输实现。
- `Rto` 返回进程 stdout/stderr 的独立截断标记；上游输出上限和本工程配额不同，不能只增加字段就称整体等价。

原版二进制在隔离 `CLAUDE_CONFIG_DIR` 下运行。不开 early access 时，CLI 明确提示设置 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 才能运行插件测试；按其提示开启后：

| 探针 | 结果 | 证明范围 |
| --- | --- | --- |
| 既有 middleware/stream conformance | 21 通过、0 失败 | 原版插件测试引擎的链顺序、next、异常、流语义 |
| 新模型联合结果探针 | 6 通过、0 失败 | 原版 SDK 桥接的成功/空回复/API 错误/取消、fork 无上下文、284 独立 signal 预取消 |

日志为 `conformance.log`、`model-contract-probe.log`，探针源码为同目录 `probe/`。模型下层由测试 Hook 提供，没有调用真实付费模型；不能把这些探针当作原版模型供应商传输的验收。新的 signal 探针确认预取消时下层零调用。本工程 provider/HTTP/IPC 的运行证据见 [本轮交付报告](mods-claude-284-delivery-2026-09-29.md)。

## 核实出的差距与本轮决策

| 差距 | 本轮处理 | 使用价值 |
| --- | --- | --- |
| 当前 complete 返回字符串、fork 返回对象或 null；安装包已使用联合结果 | 显式选择 `result-v1`，旧包保留 `legacy-v1`；不按安装时间猜版本 | 新插件可以判断是模型回答、接口出错、无文本还是无上下文，旧 Autobiz 和 review 插件继续运行 |
| cache usage 被 provider 到 SDK 的路径丢弃 | 新协议传递完整四字段；内部预算仍保留未知成本语义 | 插件可观察缓存命中与实际模型消耗，不把未知费用当免费 |
| 常见 gzip/deflate/br 响应被拒绝 | 单编码流式解压，传输和解压后各限 256KiB | 插件可访问默认压缩的 API；批准、保护、取消继续生效 |
| 284 的 fs.list 条目增加 mtimeMs | 复用既有每项 lstat；文件取自身时间，目录/链接为 0 | 插件可选最近修改的文件，不必逐个再次 stat |
| 兼容清单漏掉 9 个已知名字 | 补齐库存并明确标为 unavailable | 不再把缺失的官方事件当成未经识别的自定义事件 |

两位独立评审见 [架构与迁移契约](mods-model-protocol-migration-review-2026-09-29.md)、[质量评审](mods-model-http-quality-review-2026-09-29.md)。`cmbCompatibility.modelProtocol` 是本工程兼容选择字段，不是 Claude 原生清单字段。

## 仍须保留的边界

本轮不是全部 API 或产品完全对齐：

1. `model.complete` 的独立 `options.signal`（284 新增）尚待独立 provider 取消域；整个 turn/session 的撤权或取消仍禁止发布结果。`effort` 明确拒绝，不会接收后静默丢弃。宿主 token/时间配额仍有界。
2. `skill.prompt` 必须接真实完整技能正文；现有显式 Skill 标记和 Pre/PostSkillUse 不等同于它。完整正文扩展、后续分页读取的一致性需要下一步契约。
3. `prompt.read/fill/edit/attachment` 等草稿能力和 `tool.describe` 模型工具说明尚未形成完整生产链。
4. `env.set` 需要会话环境覆盖层和 MCP 连接池隔离。直接写全局 `process.env` 会影响其他聊天，不能照搬 CLI 的进程假设。
5. 上游新增 telemetry 发送属于 Anthropic/built-in 环境；本工程记录为不可用，不伪造第一方目的地。`ui.copy/panes`、session measure/end 等未接入事件也保持不可用。
6. 依赖插件类型聚合、terminal 专有 UI/凭据/配置、进程截断标记等仍有差异。HTTP 的不透明授权句柄、Unix socket、多层 content-encoding 尚不支持。

本工程可视化 Flow 是自身的产品能力，不能把跨 Skill/MCP/插件的步骤编辑器说成 Claude 官方已提供同款页面。

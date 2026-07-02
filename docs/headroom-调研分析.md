# Headroom 调研与借鉴可行性分析

> 调研对象: `C:\ai\headroom`（chopratejas/headroom，Apache-2.0）
> 目标工程: `CmbCoworkAgent` / `cmbdevclaw`（Electron + React + TypeScript + DeepAgents/LangChain/LangGraph 桌面 Agent）
> 调研日期: 2026-06-09

## 0. 结论摘要

**不建议直接集成 headroom 本体。** 它的 TypeScript SDK 是 HTTP 客户端，实际压缩依赖本地/云端 Headroom proxy；这会给本工程引入额外 Python/Rust 常驻进程、全量 prompt 明文代理、打包运维和合规审计成本，而且会和本工程已有的 DeepAgents summarization、filesystem eviction、Anthropic prompt cache middleware 叠加。

**有借鉴价值，但价值点需要重新排序。** 原调研里“唯一有价值的是 SmartCrusher JSON 压缩”这个判断偏窄。代码核验和本机 trace 统计显示，本工程历史负载里更大的 token 来源是 `execute` / `task_output` / `read_file`，而不是大型同构 JSON。当前样本中“大同构 JSON 工具输出”命中为 0，因此 JSON SmartCrusher 只能作为条件性候选；更值得排在前面的，是借鉴 headroom 的 **LogCompressor 思路**，做一个纯 TS、可逆、保守的命令/测试日志压缩器。

**推荐路线:** 不接 headroom proxy；先固化 trace 量化脚本/指标，然后只在数据证明有收益时做本工程原生压缩。优先级为：

1. **P0 量化指标**：统计工具输出按类型/工具名的 token 占比、驱逐次数、summary 触发次数。
2. **P1 命令/日志输出压缩**：针对 `execute`、`task_output` 做保守压缩，原文落到现有 filesystem backend，可用 `read_file` 取回。
3. **P2 JSON 同构数组压缩**：只在 MCP / `code_exec` 真实出现大量结构化 JSON 数组后再做。
4. **P3 CCR 搜索化取回**：当前已有 `/large_tool_results` 和 conversation history 取回路径，暂不急。

---

## 1. Headroom 是什么

Headroom 的定位是 **AI Agent 上下文压缩层**：在 prompt 发给 LLM 前，压缩工具输出、日志、RAG 结果、文件内容和对话历史，目标是降低输入 token，同时尽量保留答案质量。

核心能力来自 README 和代码双重证据：

- README 宣称覆盖 `Library` / `Proxy` / `Agent wrap` / `MCP server` / 跨 Agent 记忆 / `headroom learn` / CCR 可逆压缩：`C:\ai\headroom\README.md:47-55`。
- 压缩流程是 `CacheAligner -> ContentRouter`，由 ContentRouter 路由到 SmartCrusher、CodeCompressor、Kompress-base 等：`C:\ai\headroom\README.md:57-83`。
- Rust workspace 包含 `headroom-core`、`headroom-proxy`、`headroom-py`、`headroom-parity`：`C:\ai\headroom\Cargo.toml:1-18`。
- Python 侧仍承担包入口、pipeline 编排、proxy glue、CCR store、telemetry 等，Rust 侧承担热路径实现。不能简单说“纯 Rust 工程”，更准确是 **Python 包 + Rust core/proxy/PyO3 扩展 + TS HTTP SDK**。

### 1.1 接入形态

| 形态 | 说明 | 对本工程意义 |
|---|---|---|
| Python library | `from headroom import compress`，本地包内跑 pipeline | 本工程是 Electron/TS 主体，引入 Python runtime 成本高 |
| Proxy | `headroom proxy --port 8787`，作为 Anthropic/OpenAI 兼容代理 | 可接，但会代理全量 prompt，合规和运维成本最高 |
| Agent wrap | `headroom wrap claude|codex|cursor|aider|copilot` | 面向外部 CLI，和本工程内嵌 Agent Runtime 不匹配 |
| MCP server | `headroom_compress` / `headroom_retrieve` / `headroom_stats` | 可试用，但不是透明压缩本工程消息链路 |
| TypeScript SDK | npm 包调用 `compress()` | SDK 自身不压缩，只调用 proxy/cloud |

### 1.2 TypeScript SDK 的关键限制

原调研中“TS SDK 是薄 HTTP 客户端”这一点是正确的：

- `sdk/typescript/README.md` 明确写明需要 running proxy 或 Headroom Cloud API key：`C:\ai\headroom\sdk\typescript\README.md:11`。
- `compress.ts` 只做格式检测、转 OpenAI 格式、调用 `HeadroomClient.compress()`：`C:\ai\headroom\sdk\typescript\src\compress.ts:46-60`。
- `HeadroomClient` 默认 baseUrl 为 `http://localhost:8787`，通过 `/v1/compress`、`/v1/retrieve` 等 HTTP endpoint 工作：`C:\ai\headroom\sdk\typescript\src\client.ts:44-65`、`235-280`、`397-427`。
- 官方 wiki 也写明 Node.js 内不跑压缩逻辑，重活在 proxy/cloud：`C:\ai\headroom\wiki\typescript-sdk.md:27-40`。

结论：**如果本工程“引入 headroom-ai npm 包”，本质上仍要引入 Headroom proxy 或云 API，不是一个普通 TS 库依赖。**

---

## 2. Headroom 当前实现需要注意的事实

### 2.1 IntelligentContext / RollingWindow 已在当前 pipeline 中退休

Headroom 部分文档仍保留 IntelligentContext、RollingWindow、message-level CCR 的说明，但当前代码显示该阶段已退休：

- `TransformPipeline` 注释写明 IntelligentContextManager / RollingWindow “drop messages from history” stage 已退休，当前只做 live-zone 内容压缩：`C:\ai\headroom\headroom\transforms\pipeline.py:35-43`。
- proxy server 同样写明不再需要 context manager transform stage，状态为 passthrough：`C:\ai\headroom\headroom\proxy\server.py:342-349`。
- `ccr.mdx` 又说明旧的 Message-level CCR via IntelligentContext 已退休：`C:\ai\headroom\docs\content\docs\ccr.mdx:165-168`。

这说明 headroom 文档和 wiki 存在滞后/不一致，调研应优先看代码。

### 2.2 当前核心压缩面是 ContentRouter

当前 pipeline 主要是：

- CacheAligner：前缀/cache 相关处理。
- ContentRouter：检测内容类型，路由到 JSON、log、search、diff、code、text 等压缩器。

证据：

- pipeline 默认构建 CacheAligner + ContentRouter：`C:\ai\headroom\headroom\transforms\pipeline.py:89-102`。
- proxy 也只注册 CacheAligner disabled stub + ContentRouter：`C:\ai\headroom\headroom\proxy\server.py:351-375`。
- ContentRouter 注释列出 JSON、code、search、log、Kompress 等路由：`C:\ai\headroom\headroom\transforms\content_router.py:1-20`。

### 2.3 SmartCrusher 是真实价值点，但不是唯一价值点

SmartCrusher 当前是 Rust-backed 的 JSON array crusher：

- Python 实现已退休，`SmartCrusher` 委托 `headroom._core`：`C:\ai\headroom\headroom\transforms\smart_crusher.py:1-19`。
- 它保留 first/last、错误项、异常值、相关项等：`C:\ai\headroom\headroom\config.py:294-324`。
- 默认配置包括 `min_tokens_to_crush=200`、`max_items_after_crush=15` 等：`C:\ai\headroom\headroom\transforms\smart_crusher.py:119-134`。
- lossy row-drop 路径会插入 CCR sentinel，便于 LLM 取回原文：`C:\ai\headroom\headroom\transforms\smart_crusher.py:59-68`。

但 headroom 还有确定性日志/搜索压缩器：

- `LogCompressor` 保留 error、fail、warn、stack trace、summary，总行数默认最多 100：`C:\ai\headroom\headroom\transforms\log_compressor.py:96-112`。
- `SearchCompressor` 保留每文件/全局 top matches，并支持 error boost：`C:\ai\headroom\headroom\transforms\search_compressor.py:82-95`。
- 文档宣称日志压缩保留错误、警告、栈、摘要，丢弃大量 passed/重复成功输出：`C:\ai\headroom\docs\content\docs\text-and-logs.mdx:58-93`。

因此，原调研把可借鉴点收窄为“只有 JSON 压缩”不够全面。

### 2.4 CCR 的真实形态

CCR 是 Headroom 的可逆压缩机制：压缩时将原文存本地 cache，提示 LLM 用 `headroom_retrieve` 取回。

关键事实：

- 默认 CCR TTL 是 300 秒，即 5 分钟：`C:\ai\headroom\headroom\config.py:388-432`、`C:\ai\headroom\headroom\cache\compression_store.py:83-99`。
- 支持 `POST /v1/retrieve`、`GET /v1/retrieve/{hash}`、`POST /v1/retrieve/tool_call`：`C:\ai\headroom\headroom\proxy\server.py:2458-2514`、`2793-2820`、`2822-2918`。
- 支持 query 时在缓存内容内做搜索：`C:\ai\headroom\headroom\proxy\server.py:2798-2807`。

CCR 的优势不是“本工程完全没有可逆取回”，而是 **统一 hash + 可选 query search + 自动工具调用处理**。这一点后面会纠正原调研。

---

## 3. 本工程已有上下文管理能力

本工程是本地 AI Agent 桌面应用，README 定位是 `Electron + React + TypeScript + DeepAgents/LangChain`：`C:\ai\CmbCoworkAgent\README.md:1-4`。

### 3.1 历史压缩与落盘

本工程通过 DeepAgents summarization middleware 处理长对话：

- runtime 组装 `summarizationOptions`，包括 model、backend、`.cmbdevclaw/conversation_history`、trigger/keep、summaryPrompt、truncateArgs：`src/main/agent/runtime.ts:1032-1045`。
- 主 Agent 和 subagent 都启用 `createSummarizationMiddleware` 与 `anthropicPromptCachingMiddleware`：`src/main/agent/runtime.ts:1349-1359`、`1382-1405`。
- 实际运行时显式传入 `triggerTokens`、`keepTokens`、`trimForSummary`、自定义 summary prompt 和 args 截断：`src/main/agent/runtime.ts:3594-3603`。
- deepagents 在 summary 前会把被总结消息 append 到 history 文件，并在 summary message 里写入 full conversation history path：`node_modules/deepagents/dist/index.js:2747-2827`。

### 3.2 工具输出驱逐不是“永久丢失”

原调研中“非文件工具输出一旦被 `toolTokenLimitBeforeEvict` 驱逐即永久丢失”是错误的。

DeepAgents filesystem middleware 对非排除工具的大输出会写入虚拟文件：

- 大输出模板明确提示结果保存到 filesystem，可用 `read_file` 按 offset/limit 读取：`node_modules/deepagents/dist/index.js:606-612`。
- `wrapToolCall` 中，当 ToolMessage content 超过 `toolTokenLimitBeforeEvict * 4`，会写到 `/large_tool_results/{tool_call_id}`，然后返回提示消息：`node_modules/deepagents/dist/index.js:1052-1083`。
- `read_file` 本身支持 offset/limit，并在超字符上限时提示格式化大文件：`node_modules/deepagents/dist/index.js:831-849`。

所以本工程在“单条大工具结果可逆取回”上已经有基础能力，只是没有 headroom 那种 hash/query/search 化的 CCR UX。

### 3.3 文件读取已有分页和字符保护

本工程还额外 patch 了 read_file 输出：

- 行数超限时加 `[More content is available ... use offset=N]`：`src/main/agent/read-file-output.ts:130-175`。
- 字符上限约为 `4 * toolTokenLimitBeforeEvict`：`src/main/agent/read-file-output.ts:177-190`。

这使得 headroom 的“读文件后保留原文并按需取回”对本工程不是新增能力。

### 3.4 MCP 和 code_exec 的结构化输出路径

MCP 工具结果在本工程中会被规范化为 ToolMessage：

- MCP eager tool 通过 `toEagerToolResponse(result)` 输出内容与 artifact：`src/main/mcp/langchain-tool.ts:145-165`。
- 若 `structuredContent` 存在，最终会被 JSON.stringify 成文本返回给模型：`src/main/mcp/result-utils.ts:201-256`。
- `code_exec` 也会把返回值 JSON 序列化成字符串：`src/main/code-exec/script-runtime.ts:229-236`。

这说明如果未来出现大量结构化数组，落点是存在的；但当前样本未显示这是主矛盾。

### 3.5 Trace 已足够做机会评估

Trace 类型中记录了模型输入、工具调用、token usage：

- local traces 写到 `~/.cmbcoworkagent/traces/{threadId}/{traceId}.jsonl`：`src/main/agent/trace/collector.ts:84-104`。
- `TraceModelCall.inputMessages` 保留请求侧上下文，`tokenUsage` 保存 provider usage：`src/main/agent/trace/types.ts:48-62`。
- IPC 流处理里 normalize provider `usage_metadata` 并写入 tracer：`src/main/ipc/agent.ts:5067-5087`。
- Tool result node 也记录输出：`src/main/ipc/agent.ts:5142-5180`。

因此，“先量化再做压缩”不是空话，本工程已有数据源。

---

## 4. 本机 trace 样本统计

我对当前机器 `C:\Users\87624\.cmbcoworkagent\traces` 做了只输出统计、不展示内容的分析，样本如下：

| 指标 | 数值 |
|---|---:|
| trace 文件数 | 626 |
| trace 数 | 626 |
| 模型调用数 | 2089 |
| provider input tokens | 38,989,764 |
| provider output tokens | 191,093 |
| provider total tokens | 39,180,857 |
| 估算 input chars | 4,332,027 |
| tool input chars | 3,568,488 |
| tool input chars 占比 | 82.37% |
| 大同构 JSON tool input chars | 0 |
| 大同构 JSON 占 input chars | 0% |
| 大同构 JSON tool result nodes | 0 |
| `/large_tool_results` 引用次数 | 12 |

工具输入字符 Top：

| 工具 | input chars |
|---|---:|
| `execute` | 1,532,112 |
| `read_file` | 675,421 |
| `task_output` | 462,480 |
| `ls` | 346,514 |
| `start_worker` | 138,472 |
| `write_file` | 118,380 |
| `glob` | 99,137 |
| `grep` | 62,765 |

这个结果有两个含义：

1. **JSON SmartCrusher 在当前样本中 ROI 很低。** 大同构 JSON 命中为 0，直接做 JSON 压缩大概率没有体感收益。
2. **日志/命令输出才更像机会点。** `execute` alone 占工具输入字符约 42.9%，占估算总 input chars 约 35.4%。如果保守压缩 `execute` 的一部分输出，理论上有 5% 到 15% 级别的输入缩减空间；实际收益要扣掉工具 schema、系统 prompt、provider 计费细节和重复上下文影响。

注意：这是本机历史 trace 样本，不等同于生产全量画像。它足以说明“不应先做 JSON 压缩”，但还不足以直接证明“日志压缩必做”。

---

## 5. 是否直接集成 headroom 本体

结论：**不建议。**

### 5.1 架构不匹配

本工程主链路是 Electron main process 内组装 LangChain/DeepAgents Agent，已有 middleware 栈；headroom TS SDK 需要外部 proxy。直接接入会遇到：

- 需要随桌面应用打包/启动/监控 Python/Rust proxy。
- 需要把 OpenAI/Anthropic/LangChain 请求导向 proxy，或在每次模型调用前手动调用 `compress()`。
- 与现有 `createSummarizationMiddleware`、`createFilesystemMiddleware`、`anthropicPromptCachingMiddleware` 叠加，可能造成重复压缩、prefix cache 不稳定、summary 语义漂移。
- streaming、tool call、subagent、MCP、hook 的边界都要重新验。

### 5.2 合规风险高

如果本工程按 CMB 内部/银行侧合规口径上线，headroom proxy 的风险包括：

- proxy 会处理全量 prompt 明文、工具输出和可能的业务数据。
- TS SDK 支持 Headroom Cloud API key，必须禁用或审计。
- Kompress-base 首次使用会从 HuggingFace 拉模型；即使可选，也需要打包策略和离线策略。
- CCR / telemetry / TOIN / memory 等本地存储点需要额外数据分级和清理策略。

### 5.3 维护风险高

headroom 当前代码和文档体现出高速迭代：

- 当前 pipeline 已退休 IntelligentContext/RollingWindow，但部分 wiki/docs 仍描述旧能力。
- PyPI wheel size 注释显示版本发布频繁且曾触达 PyPI 存储上限：`C:\ai\headroom\Cargo.toml:80-108`。
- 多处功能从 Python 迁到 Rust/PyO3，接口仍在收敛。

直接集成本体会把这些波动带进本工程。

---

## 6. 对本工程的借鉴点排序

### P0：先做 trace 量化指标

**推荐做。成本低，收益高。**

建议把本次临时统计固化为脚本或 dashboard 指标：

- 按工具名统计 tool input chars / approx tokens。
- 识别大同构 JSON 数组占比。
- 识别 build/test/log 输出占比。
- 统计 `/large_tool_results` 触发次数和后续是否被 `read_file` 读取。
- 统计 summarization 触发次数、history 文件引用次数。

决策门槛建议：

| 指标 | 阈值 | 动作 |
|---|---:|---|
| 大同构 JSON tool tokens / total input tokens | > 10% | 做 JSON crusher spike |
| `execute`/`task_output` tokens / total input tokens | > 20% | 做 log compressor spike |
| `/large_tool_results` 后续读取率 | > 30% | 考虑 CCR search 化取回 |
| summary 后 history 回读率 | 很低 | 保持现状，不加复杂 retrieval |

### P1：借鉴 LogCompressor，做本工程原生命令输出压缩

**这是当前样本下最有潜力的借鉴点。**

目标不是引入 headroom 的 Rust/Python 实现，而是在本工程用 TypeScript 实现一个保守版：

- 只处理 `execute`、`task_output`，可扩展到 `code_exec`。
- 只在输出超过阈值且检测为 build/test/log 时触发。
- 保留：
  - 命令退出码与 `[Command failed/succeeded]` 尾标；
  - error/fatal/exception/failed/warn 行；
  - stack trace；
  - pytest/npm/jest/maven/gradle/cargo 等 summary；
  - 头部少量行、尾部少量行；
  - 被省略行数统计。
- 原文写入现有 backend，如 `/compressed_tool_results/{tool_call_id}`。
- 压缩结果里明确提示：完整输出可用 `read_file(file_path=..., offset=..., limit=...)` 分段读取。

可行性：

| 项 | 评估 |
|---|---|
| 技术可行性 | 中高，纯 TS，无新依赖 |
| 工程位置 | 新增 middleware，或在 filesystem middleware 相邻位置处理 ToolMessage/Command |
| 预估工作量 | 2-4 天含单测/回归 |
| 风险 | 压缩误删关键成功上下文；需保守阈值和原文可取回 |
| 成效 | 本机样本上限较好，但需 A/B 验证真实 input token 和任务成功率 |

建议先做 spike，不直接默认开启。可用 feature flag：

- `CMB_TOOL_OUTPUT_COMPRESSION=off|audit|on`
- `audit` 只记录“若压缩可省多少”，不改变消息。
- `on` 只对非交互命令输出生效。

### P2：借鉴 SmartCrusher，做结构化 JSON 压缩

**技术上容易，当前样本下不优先。**

可做最小版：

- 检测 ToolMessage content 是否为 JSON。
- 找出顶层数组，或对象中第一层/第二层的大数组。
- 判断数组长度 >= 20，前 30 个样本 shape 同构度 >= 80%。
- 输出 schema、总数、首尾样本、错误项、异常项、少量代表样本。
- 原文写入 `/compressed_tool_results/{tool_call_id}`，允许 read_file 取回。

可行性：

| 项 | 评估 |
|---|---|
| 技术可行性 | 高，纯 TS 约 150-300 行 |
| 工程位置 | MCP / code_exec ToolMessage 形成后统一处理 |
| 预估工作量 | 1-2 天含单测 |
| 风险 | 对“需要完整枚举”的任务可能误导，需要可取回和禁用开关 |
| 当前成效 | 本机 trace 样本为 0，短期不建议投入 |

### P3：CCR 搜索化取回

**暂缓。**

本工程已具备：

- 大工具结果写 `/large_tool_results/{tool_call_id}` 后用 `read_file` 分段取回。
- 对话历史写 `.cmbdevclaw/conversation_history` 后由 summary message 引用。
- read_file 自身有 offset/limit。

headroom CCR 的额外价值是：

- hash 化引用；
- query 搜索；
- 自动注入 retrieve tool；
- retrieval feedback 学习。

这些能力有价值，但成本比日志/JSON 压缩更高，而且当前 trace 中 `/large_tool_results` 只有 12 次，暂未显示强需求。建议等“模型频繁读回大结果”或“read_file 分段查找体验差”被数据证明后再做。

### 不建议借鉴的部分

| headroom 能力 | 判断 | 原因 |
|---|---|---|
| TS SDK / proxy 本体 | 不做 | 需要外部 proxy/cloud，架构和合规成本过高 |
| CacheAligner | 基本不做 | 本工程已有 `anthropicPromptCachingMiddleware`，且手动重排 prompt 风险高 |
| IntelligentContext / RollingWindow | 不做 | headroom 当前代码已退休该阶段；本工程已有 summarization |
| Cross-agent memory | 不做 | 本工程已有本地 memory、skill evolution、trace 优化 |
| Kompress-base ML | 不做 | 引入模型权重、ONNX/PyTorch/HF 下载和审计成本 |
| CodeCompressor | 暂不做 | read_file/edit 工作流要求精确上下文，本工程已有分页和 grep/glob |

---

## 7. 成效预估

### 7.1 直接集成 headroom proxy

| 维度 | 评级 |
|---|---|
| 可行性 | 低 |
| 安全合规 | 低 |
| 收益确定性 | 低到中 |
| 维护成本 | 高 |
| 推荐度 | 不推荐 |

即使压缩率可观，也会引入新的运行时组件和全量 prompt 代理。对桌面端 Agent 产品来说，风险大于收益。

### 7.2 原生日志压缩

| 维度 | 评级 |
|---|---|
| 可行性 | 中高 |
| 安全合规 | 高 |
| 收益确定性 | 中 |
| 维护成本 | 中 |
| 推荐度 | 推荐 spike |

本机样本中 `execute` 是最大工具输入来源。保守估算：

- 若只压缩 `execute`，且平均压缩 30%，估算总 input chars 下降上限约 10.6%。
- 若平均压缩 50%，估算总 input chars 下降上限约 17.7%。
- 真实 provider input token 降幅会更低，因为系统 prompt、工具 schema、多轮重复、缓存命中都会稀释。

因此目标不应承诺“省 80% token”，而应以 A/B 指标验证：

- input tokens 下降 >= 5%；
- 任务成功率不下降；
- 因输出缺失导致的二次 `read_file`/重跑命令不显著上升。

### 7.3 原生 JSON SmartCrusher

| 维度 | 评级 |
|---|---|
| 可行性 | 高 |
| 安全合规 | 高 |
| 收益确定性 | 当前低 |
| 维护成本 | 低到中 |
| 推荐度 | 条件性 |

如果未来接入 GitHub/Jira/CMDB/监控类 MCP，返回大量 JSON 数组，则收益可能立刻变高。当前样本不支持优先投入。

### 7.4 CCR 搜索化取回

| 维度 | 评级 |
|---|---|
| 可行性 | 中 |
| 安全合规 | 中高 |
| 收益确定性 | 当前低 |
| 维护成本 | 中高 |
| 推荐度 | 暂缓 |

更适合在压缩器已经落地后补强，而不是第一步。

---

## 8. 对原调研的修正清单

| 原判断 | 修正 |
|---|---|
| “headroom 核心是 Rust” | 更准确是 Python 包 + Rust core/proxy/PyO3 + TS HTTP SDK；Rust 是热路径和 proxy 重要部分 |
| “TS SDK 是薄 HTTP 客户端” | 正确，已由 README/wiki/源码确认 |
| “现有中间件覆盖约 70%” | 方向正确，但 70% 是主观估算，不宜当作量化结论 |
| “非文件工具输出驱逐即永久丢失” | 错误。DeepAgents 会写 `/large_tool_results/{tool_call_id}`，可用 `read_file` 取回 |
| “唯一价值是结构化 JSON 压缩” | 偏窄。当前样本中 JSON 占比为 0，日志/命令输出压缩更值得作为候选 |
| “文件/日志/shell 输出现有截断足够” | 文件读取基本足够；日志/shell 输出还值得量化，因为 `execute` 占比最高 |
| “IntelligentContext / RollingWindow 是 headroom 主要能力差” | 需修正。当前 headroom pipeline 已退休 message-dropping context manager |
| “直接集成本体不做” | 结论维持，证据更强 |

---

## 9. 推荐实施计划

### 阶段 1：量化固化（0.5-1 天）

新增或临时保留一个只读分析脚本，统计：

- tool input/output chars by tool；
- 大 JSON 数组识别；
- log/build/test 输出识别；
- `/large_tool_results` 写入与回读；
- summarization 触发与 history 回读。

产物：一份本地 dashboard 或 CLI 统计，不改变 Agent 行为。

### 阶段 2：日志压缩 spike（2-4 天）

实现 `createToolOutputCompressionMiddleware`：

- 默认 audit 模式。
- 仅 `execute` / `task_output`。
- 原文落 backend，压缩内容保守展示。
- 单测覆盖：
  - pytest 失败；
  - npm/jest 失败；
  - maven/gradle/cargo 构建；
  - 成功长输出；
  - stack trace；
  - 原文取回提示；
  - Command update 中多个 ToolMessage。

验收指标：

- trace 中 input token 降幅 >= 5%；
- 任务成功率不下降；
- 二次读取/重跑命令不上升。

### 阶段 3：JSON 压缩条件触发（暂缓）

只有当 P0 指标显示大同构 JSON token 占比 > 10% 时启动。

---

## 10. 最终裁决

**headroom 作为外部工程，对本工程的主要价值不是“拿来集成”，而是提供了一个设计方向：在已有 summarization/eviction/prompt cache 之上，对高频工具输出做内容类型感知的、可逆的、保守压缩。**

当前最合理的选择是：

- 不集成 headroom proxy / TS SDK。
- 保留并强化本工程现有 DeepAgents 上下文管理。
- 先量化，再按 trace 结果做原生压缩。
- 短期优先研究 `execute`/日志压缩；JSON SmartCrusher 暂不优先。

一句话版本：

**Headroom 本体不适合直接引入；它的 ContentRouter/LogCompressor/SmartCrusher/CCR 思路有借鉴价值，但本工程应只借鉴算法和产品策略，做纯 TypeScript、可审计、与现有 filesystem backend 兼容的最小实现。**

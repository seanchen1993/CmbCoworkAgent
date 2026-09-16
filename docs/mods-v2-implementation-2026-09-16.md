# Mods v2 实施与验证记录

分支 `codex/mods-v2`，从最新拉取的 UAT `18e2ea88` 新开，纳入 v1 的 `82bceb0c`。
目标是完成 v2 设计中的八批补齐，并以同一插件在 Claude Code 与 CMB 中的结果作对照。
本记录不把底层通过等同于产品全部可用；尚未完成项继续保留在兼容矩阵中。

## 已落地的运行时基础

- 标准 `.claude-plugin/plugin.json`、`hooks/hooks.json` 的同步 `register(on, options)`
  加载与稳定文件快照；摘要包含源文件、清单、编译器和兼容版本。支持 TS/TSX 编译，
  拒绝越界路径、运行时动态导入和未提供的包依赖。
- QuickJS 常驻实例、多调用帧、独立取消、宿主能力回调、输入冻结、预算与迟到结果失效。
  生产 CLI 已走 Electron utilityProcess；主进程不执行插件源码。
- 普通事件链、多次 next、catch 恢复、next.to 层级与 trace；一条调用链固定插件快照。
- 拉取式流桥，区分可见 chunk 与生成器终值；慢消费者受背压限制，失败续传不重新请求模型。
- `openwork plugin check|inspect <directory>` 检查包、摘要及注册结果。
  当前明确返回 `scope: package-and-registration-check` 和 `authorized: false`；
  尚不是完整宿主 API 兼容检查，不授予插件权限。

边界：完整字段 schema、engine.create 能力提供、真实会话/模型/工具接入、持久面板与
完整开发工具链还未交付。117 个事件名称与 65 个成员的清单仅用于覆盖盘点。

## 已验证的契约与原型

同一夹具位于 `tests/fixtures/mods-v2/conformance`。隔离安装官方
`@anthropic-ai/claude-code@2.1.273`，通过其 `cli-wrapper.cjs plugin test` 运行，
不替换用户日常 Claude 安装，也不调用实际模型或外部业务工具。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| Claude 2.1.273 原生 plugin test | 21/21 | 15 普通事件语义及 6 流式语义 |
| CMB 的同一插件源文件 | 21/21 | 同样的组合、短路、异常、重放、保留字段与流变换结果 |
| CMB v2 定向单测 | 46/46 | 包、VM、流、Client 隔离与模型边界原型 |
| 原有 Mods + v2 + 工具回归 | 153/153 | v1、v2 及有关工具路径的定向回归 |
| 真实 Electron utilityProcess | 24/24 | 上述 21 项，加并发取消、卸载清理、真实进程故障恢复 |
| 两层 hook 热调用，100 次 | P50 5.42 ms，P95 8.04 ms | 本机跨进程开销，非完整应用性能结论 |

跨进程测试卸载后：runtime/frame/reply/主进程待处理调用均为零，重载子进程 RSS 约 64 MiB。
可复现命令：`node tests/run-function-mods-process.mjs`；详细报告写入忽略目录
`output/mods-v2-validation/process/process-report.json`。

真实 LangChain `createAgent` + MemorySaver 原型证明：在 provider callback 之前接入流变换，
回调、消息流和 checkpoint 能同时得到改写文本。此测试用模拟模型，不证明真实多供应商、
工具参数片段、签名 thinking 或所有流出口已经接通。

Client 原型证明独立 VM 的状态、尺寸、输入、重复按钮、定时器及销毁可以隔离。
它还不是接入 React 的 Pane，更不能称官方 diff 插件已经原文件可用。

## 与原设计相比已校正的规则

用户要求效果一致后，取消原设计 D02 中 v2 工具 next 一律最多一次的限制。
普通 hook 的前置异常跳过，后置异常保留最近下游结果；显式多次 next 是不同调用，
catch 的重复 next 重取结果。这与宿主最终权限校验及 v1 的单次执行规则分开实现。

Claude 2.1.273 的测试 SDK 外层流在实测中不暴露可用的 `.result`，夹具从 iterator 终值
检查答案；插件内部 `next(e).result` 正常可用，transform 夹具同时覆盖这一点。

## 本轮构建与全量回归

- `npm run build` 通过；实际构建产物执行 `node bin/cli.js plugin check` 通过。
- Node TypeScript 检查通过；新增源文件、测试和 CLI 的定向 ESLint 通过。
- `npm test` 的首次全量 Vitest 与构建并行，出现 69 项失败及超时；未忽略这些结果。
  改为四 worker 且不并行构建后复跑，3153 项中 3121 通过、27 失败、5 跳过。
  26 项失败名称与 v1 最终基线完全相同；新增的浏览器脚本超时单独复跑通过，
  该文件仅余已知 Windows 路径断言问题。完整测试仍非全绿。
- 全量记录写入 `output/mods-v2-validation/vitest-full.json`；最新 46 项 v2 定向测试
  在后续补入命令保留字段契约后独立通过。全量报告计数对应当时收集的测试快照。

## 待完成的验证

standalone 回归仍在执行；实际应用 UI E2E、真实模型与 MCP、长时资源压力、最终安装包
及逐项兼容复核尚待后续集成完成后执行。不能把这些项记为通过。

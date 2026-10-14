# Mods：Claude Code 2.1.284 核验与兼容补齐

面向使用和迁移的完整说明见 [未对齐能力影响、存量 Plugin 改造与使用指南](mods-compatibility-impact-and-plugin-migration-2026-09-29.md)。

开发分支：`codex/mods-v2`；目录：`C:\ai\CmbCoworkAgent-mods-v2`。本轮没有在 UAT 开发。

状态：本轮实现、双 Agent 检视、类型检查、构建、全量回归与 Electron 验收完成。仍非 Claude 全量功能对齐；未实现项保留在报告末尾。

## 本轮实际效果

| 能力 | 之前 | 现在 |
| --- | --- | --- |
| 新模型调用结果 | complete 只能得到字符串，fork 用 null 表示部分失败 | 新协议可以判断回答、API 失败、空回复、独立超时、无上下文；包含四项 token usage |
| 原有插件 | 依赖字符串和旧 fork 对象 | 默认继续旧协议；宿主升级不自动更改其清单、返回类型或已批准摘要 |
| 多插件拦截模型调用 | 新旧返回格式若混用会误读结果 | 在执行拦截器/请求之前检查协议冲突，错误指出冲突插件；不静默跳过检视 Hook |
| HTTP API | 压缩响应被拒绝 | gzip、deflate、br 单层压缩自动解码；原逐跳批准、保护、取消和大小上限保留 |
| 查询最近修改文件 | 列目录后再逐项 stat | fs.list 已带文件 mtimeMs；目录和链接为 0，不跟随链接，无额外 I/O |
| 兼容诊断 | 漏识别 9 个官方名字 | 补入已知但未实现清单，不把注册成功当成有生产提供者 |

这轮重点是插件运行兼容，不改 DIY 页面布局，也没有把本工程 Flow 页面称为 Claude 官方能力。

## 怎么使用

旧插件无需改动。需要新版模型结果的插件，在实际插件清单中选择：

```json
{"cmbCompatibility":{"modelProtocol":"result-v1"}}
```

该字段为本工程扩展，会改变包摘要，需要重新批准，并更新引用旧摘要的 Claw。随后在插件中使用：

```ts
const reply = await $.model.complete({
  model: "default",
  prompt: "检查当前变更的风险",
  maxTokens: 512,
  timeoutMs: 8000
})
if (reply.isAnswered) await $.ui.log(reply.text)
else await $.ui.log(`本次未得到答案：${reply.reason}`)
```

完整迁移、观察器、CLI 类型说明见 [作者使用说明](mods-model-result-v1-authoring.md)。HTTP 调用方式不变，返回的 `text` 已解压，不要根据仍保留的 wire 响应头重复解压。`fs.list` 的新增字段使用方式是 `entries.sort((a,b) => b.mtimeMs-a.mtimeMs)`；本工程使用与 fs.stat 相同的整数毫秒精度。

## 设计与检视

- [固定 2.1.284 安装包核验、提取索引及差距](mods-claude-2.1.284-audit-2026-09-29.md)
- [模型协议架构与迁移评审](mods-model-protocol-migration-review-2026-09-29.md)
- [第二位 Agent 质量评审](mods-model-http-quality-review-2026-09-29.md)

实现检视发现并修复了两个实际漏洞：非法清单 null 被误当缺省 legacy；异常恢复处理器可能吞掉嵌套协议冲突。均有真实编译/QuickJS 反例测试。模型供应商错误只在 provider 边界转成普通失败结果；权限、预算、撤权、内容保护错误仍抛出。after-hook 能调整显示结果，但不能改写真实费用账本。

## 验证记录

证据目录：`output/claude-code-2.1.284-analysis/`。

| 检查 | 结果 |
| --- | --- |
| 原版 2.1.284 CLI/插件探针 | 版本确认；21 项既有探针 + 6 项新协议探针通过，下层模型使用测试 Hook，未调用付费模型 |
| 两位 Agent 检视 | 无剩余生产阻断；第二位独立 10 文件 134 项通过 |
| Node/Web 类型检查 | `npm run typecheck` 通过，`typecheck.log` |
| 生产构建 | `npm run build` 通过，`build.log` |
| 低并发全量 Vitest | 679 文件；5426 通过、11 失败、5 跳过，`full-vitest.json` |
| 基线差分 | 11 个失败名称与上一轮完全相同，新增失败 0，`baseline-comparison.json` |
| Electron 新模型/HTTP | 7 组通过，`e2e-model-http-284/result.json` |
| Electron 文件元数据 | 5 组通过，`e2e-file-metadata/result.json`，包括撤权、外部链接拒绝、Mods 关闭原生 read |
| Electron 存量功能 | Plugin 项目模式/Harness 7 组、Flow 9 组、组合 11 组、Skill/MCP 来源组合 10 组通过，`legacy-production-e2e-results.json` |
| Electron 合计 | 6 个场景，共 49 组通过；本轮生产构建没有 test-only `mods-e2e.js` |
| 真实隔离进程 | 55 组通过，`function-process-report.json`，包含旧 SDK、文件读取和 IPC/VM 生命周期 |
| standalone | adoption/messages/hooks/plugins/task-cards/merge/workflow/desktop-agent-baseline/im-v1 九条 npm 链均 exit 0，`standalone-report.json` |
| 定向 ESLint / diff | 无 lint error；大文件保留 24 个格式 warning，未整份格式化。`git diff --check` 通过 |

全量测试不是全绿。11 个基线失败为：macOS IDE 路径在 Windows 测试中的 5 项，缺少忽略目录 chrome-extension 资产的 5 项，主题样式 Windows 路径匹配的 1 项。没有为本轮隐藏或跳过它们。

原始 `npm test` 默认并发运行记录也保留：5369 通过、68 失败、5 跳过、2 个运行时错误，主要伴随高并发超时；该轮停止在 Vitest，不能声称后续 standalone 链已经执行。冻结后限制两个 worker 复测，额外失败和运行时异常均未复现。Agent 当时扩大窄测的 20 个超时也被此完整复测覆盖，不以猜测代替实测。

随后独立执行了上表九条 standalone 链。workflow 的单次测试进程显式使用本机 Git Bash（`SHELL`/`GIT_BASH_PATH`），以满足既有 `pwd -W` 用例；未改变产品或用户默认 shell。本轮该整条 workflow 链通过，而非仅补跑中断后的脚本。

新 Electron 测试第一次将无参数 `/legacy-284` 留在斜杠命令选择菜单，发送按钮按既有规则不可用。测试使用明确的 `normal` 参数后通过，没有放宽断言、增加盲等或修改生产逻辑；首次日志保留为 `e2e-model-http-284-initial-fixture.log`。新场景实际覆盖了 ZIP 安装/批准、聊天命令、受控模型 HTTP、缓存 token 口径、空回复、400 脱敏、旧插件字符串、压缩请求两跳批准和协议冲突零模型请求。

性能抽测：本地 128KiB 响应，预热 5 次后每组 40 次，identity p50 2.75ms / p95 4.33ms，gzip p50 2.50ms / p95 3.33ms，见 `http-performance.json`。这是受控传输测试，不是外网或整机性能结论；压缩前后各 256KiB 上限与背压是防止无界内存的关键。文件 mtimeMs 复用原 lstat，没有额外磁盘请求。

## 没有宣称完成的能力

`effort`、2.1.284 新增独立模型 `options.signal`、完整 skill.prompt 正文扩展、聊天草稿读写、tool.describe、env.set 的会话/MCP 隔离、依赖类型聚合及部分第一方/终端能力仍未全面接入。具体语义和原因见核验报告。

本轮保留明确边界：默认/最大输出、任务时限、文件和 HTTP 配额仍按本工程宿主政策；父任务取消或撤权后禁止发布迟到结果；fork 是经过清理的宿主文本快照，不等于 Claude 内部缓存上下文。新版模型 `usage` 缺项对外显示零，但内部未知费用仍保守结算。

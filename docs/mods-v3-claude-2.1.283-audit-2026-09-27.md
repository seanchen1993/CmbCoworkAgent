# Claude Code 2.1.283 提取与 DIY 设计依据

2026-09-27 核对 npm 最新版本与 [官方 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.283)，均为 2.1.283。独立下载 npm Windows x64 包，实际二进制 `--version` 返回 `2.1.283 (Claude Code)`；全局 CLI 保持原版本。本次没有调用付费模型或把提取代码复制到产品。

## 可复核产物

目录：`C:\ai\CmbCoworkAgent-mods-v2\output\claude-code-2.1.283-analysis`（忽略目录，不提交上游代码）。

| 产物 | 证据 |
| --- | --- |
| npm native archive | `anthropic-ai-claude-code-win32-x64-2.1.283.tgz`，npm shasum `998db7763fbfefb232fc1f5fceba2520670c4a9a` |
| 二进制 | `native/package/claude.exe`，244960928 字节，SHA256 `9dbe16dafed59da5cdabbfe11ad0335738c753fad794989b47f9446accd6de3a` |
| 提取器及索引 | `extract_bun.py`、`manifest.json`，PE/Bun 范围和路径校验；2368 模块、44276588 字节内容、无 sourcemap |
| 内嵌声明 | `readable/claude-code.d.ts-8ef3f324.txt`，SHA256 `5592BB7FE8E043E7ECDBDE6D280D78033832DE34B66ECCFA53D165A7AF0EB30D` |
| 官方固定 tag 声明 | `official-v2.1.283.d.ts`，SHA256 `6D19C8250D22358C8527189274D96F9F862C30C8650C92030359AA407A01DEA2` |
| 两种声明差异 | `declarations.diff`，3517 行 unified diff；不是仅文件头差异。公开 tag 声明头仍由 2.1.277 生成 |
| 可读模块 | `formatted/`，六个目标模块格式化；没有恢复原始 TypeScript/符号名或 Bun 原生机器码 |

## 确认到的行为

1. `formatted/chunk-0w5kpsps.js:826`：`next.to` 仅对允许的 managed tier 开放。插件组合与业务流程跳转不是同一概念，不能利用业务分支绕过权限层。
2. `formatted/chunk-gbtzpa3e.js:1849` 附近：注册入口与访问方式由静态分析约束；`engine.create` 有专门规则。声明对象里有字段不代表可以任意访问宿主。
3. `formatted/chunk-7dvkmj58.js:2160` 附近：workflow journal 分 started/failed/result，null 结果按失败处理；恢复是 Agent 调用记录与执行策略，不能当作业务事务恰好一次证明。
4. `formatted/src/plugins/functionHooks/hooks-worker/hooks-worker.js`：独立 worker 与调用桥；代码标记版本 2.1.283。
5. `readable/reference-2ccb611f.md`：插件模块 register、配置选项、监听重载、noun types 契约与测试工具。使用仍以代码/插件组合为基础，没有从这些模块确认出通用的业务流程可视化编辑器。
6. 新内嵌声明相对公开 tag 还包含 Atom/Derived、模型结果/usage、process spawn、session send 及自动类型生成等变化。本轮逐步 DIY 不依赖全量开放这些新 SDK；不能把业务流程完成写成 2.1.283 全量 API 兼容。

## 对本工程的直接决策

- 宿主提供有类型的业务流程定义和状态机，插件继续作为能力提供者；不让模型重新解释用户保存的步骤顺序。
- 复用原生 Agent、工具权限、租约、检查、Autobiz validator/CAS。新增的内容是业务组合与证据管理，不重做模型客户端和隔离运行时。
- 业务不通过、执行错误、取消、未知副作用分别处理；修复后旧 PASS 失效，人工确认绑定具体产物。
- 最后一次检查/确认全部通过后才允许唯一阶段提交；提交后不再执行可能推翻验收的规则。
- 新流程入口独立于 Mods 安装和完成规则；普通用户通过步骤列表编辑，不必写 hooks 代码。

正式设计及两位评审结果见 [迭代方案](mods-v3-diy-flow-plan-2026-09-27.md)。静态提取证明实现结构，不等于已对上游所有事件做运行语义测试。

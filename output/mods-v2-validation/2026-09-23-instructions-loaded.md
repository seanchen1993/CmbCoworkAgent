# InstructionsLoaded：异步观察验证（2026-09-23）

基线 668287ca，host v49；只在 Mods v2 工作树。此观察事件不提供业务 PASS 或完成门禁。

## 代码检视与方向校正

- 从原 AGENTS 加载器的预算裁剪结果获得来源；省略占位文件不计入，保留 User/Project/Local 归属，不重新扫描文件。
- main runtime 的通知异步启动一次，不等待观察结果再调用模型；返回的阻止决策被丢弃，观察失败不会使主任务失败。原模型错误按原样继续抛出，并取消观察。
- 使用原 runHooks、ModsManager、FunctionSession 与 authority；公共身份和来源字段固定。load_reason matcher；通知 10 秒上限，任务完成、取消、撤权和 runtime 失效处理未完成操作。关闭时没有额外观察 middleware。
- 初版误用 Mods 通用返回类型，把观察事件当成可阻止门禁。复核[官方运行时说明](https://code.claude.com/docs/en/hooks#instructionsloaded)后纠正，新增“不等待、不阻止、原模型失败取消”红测再修改实现。Electron2 的旧阻止测试不作为最终兼容证据。
- 官方来源为 CLAUDE.md/rules，明确不为直接 AGENTS 加载触发；本工程映射自己的 AGENTS 加载器，标 adapted 并列出差异。只覆盖主 runtime 的 session_start；不声明动态嵌套、include、Managed、compact 或子 Agent 完整语义。
- UI 说明异步观察，并隐藏此事件的强制修订、停止和阻断联动配置；原有其他事件的配置行为保留。

## 验证

- middleware/source/schema/pinned/bridge/matcher/matrix/模型错误的失败先行日志均保存。
- 修正后窄测 11 文件 69 项通过；随后增加真实 guest/FunctionSession 丢弃决策验证。
- Mods23：140 文件 1103 项通过，105.49 秒，maxWorkers4。
- Node/Web 最终类型检查 exit0；作用文件 ESLint 0 errors / 1266 warnings，未整体格式化现有大文件。
- AddHookDialog 另有 18 errors，使用 HEAD 源码逐项复现且与当前相同，见 instructions-lint-baseline.json；不能宣称项目 ESLint 全绿。
- 原 agents-md 独立 spec 在 Windows symlink EPERM 停止；HEAD 基线复现相同失败。临时 harness 独立运行原有各函数，12 项通过、3 项符号链接测试不可用。硬链接、全局/项目顺序、覆盖优先级、预算、UTF-8/emoji 裁剪通过。没有更改原 spec 或把不可用项计为通过。
- 聚焦 Electron1 因新测试入口拼接多了一行导致语法错误；已修正并保留日志。
- 最终聚焦 Electron3：6 checks、exit0，普通 out 已恢复。真实 AGENTS 进入模型请求；多步任务仅一次来源通知；关闭保留原指令；block 输出不阻止模型；取消与撤权关闭两个真实 HTTP 流，没有迟到观察。
- 截图已查看；最终聚焦产物归档 instructions-observer-artifacts。
- 综合 Electron23：130 checks、exit0，普通 out 恢复，产物归档 2026-09-23-electron-23-artifacts。原模型、工具、MCP、UI、完成循环与新增事件全部通过。
- 最后代码检视后窄测 4 文件 49 项通过，Node/Web 再检查均 exit0。

## 性能与限制

本轮同一路径 absent/off 读取 p95 分别 3.4821/3.1073ms（-10.7636%）；noop 1000 次 p95 9.3739ms，pendingRequests=0。这只是本轮观测，不替代正式五轮门禁。此前正式五轮入口性能预算失败仍未解决；不使用单次观测替代正式门禁。完整应用性能、两小时 soak、真实 Autobiz 业务示例与 GitHub Actions 安装包仍待完成。全仓已知基线失败有独立记录，不宣称 npm test 全绿。

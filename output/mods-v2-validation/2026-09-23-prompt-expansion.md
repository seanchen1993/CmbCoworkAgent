# UserPromptExpansion 生产适配验证（2026-09-23）

基线 fb1d4e24，host v50；仅 Mods v2 工作树。

## 实现与检视

- 接在原标准用户提示准备流程中：先验证实际技能来源，再检查展开，成功后仍由原 activateSkillLifecycle 和 UserPromptSubmit 执行。普通文本、未信任标记、无效技能、模型工具调用不会产生伪展开事件。
- 回调经过原 ModsManager、FunctionSession、authority、generation；来源字段固定，legacy matcher 按 command_name，等待 imported async，重复 next 不重做原检查。
- block 不激活技能、不调用主模型；上下文仅进入当前运行。主 IPC 补齐原 isPreparationCurrent 防取消/替换后继续激活；队列的阻止信息保留实际事件类型。
- Hooks UI 可以选择该事件和技能名 matcher，字段说明按实际桌面来源编写。矩阵为 adapted，明确没有 MCP prompt、任意自定义 prompt 命令和上游全部 source 分类；不把选择标记等同上游 slash 解析器。
- 代码检视确认没有改动既有技能解析器、模型 Skill 工具、原完成循环或 checkpoint。原错误与门禁语义沿用既有入口。

## 验证记录

- 先失败：标准准备 3 个失败，contract/bridge/pinned 3 个失败，兼容矩阵 1 个失败；日志保留。
- 窄测 5 文件 52 项通过，包含真实 guest / FunctionSession 输出投影和拒绝伪造来源。
- Mods24：142 文件 1118 项通过，114.37 秒，maxWorkers4。
- Node/Web 最终类型检查 exit0。作用文件 ESLint 0 errors / 4349 warnings；AddHookDialog 单独与 HEAD 按 rule/message 比对，18 个既有 errors 完全一致，不宣称全仓 lint 通过。
- 原 skill-lifecycle、slash-skill-marker、standard-thread-turn-architecture、desktop-agent-invoke-characterization 独立回归通过。
- 原 message-queue-plumbing 有 4 个源码形状断言落后于当前实现，全部在 HEAD 基线独立复现；分别涉及共享压缩控制器、提前拒绝使用的第 4 个通道调用、固定长度切片截断较长 completion 参数、既有 bizRetryPending 条件。断言更新后 52 项全部通过；未削弱队列顺序/运行隔离/终止检查。测试维护单独提交。
- 聚焦 Electron1：6 checks、exit0，普通 out 恢复。真实插件安装与技能发现、一次来源通知、上下文进入真实主模型 HTTP 请求、开启阻止/关闭同输入放行、取消/撤权关闭检查连接且无后续主模型均通过。
- 聚焦截图已查看，正确归档 2026-09-23-prompt-expansion-focused-artifacts；最早误复制的 prompt-expansion-artifacts 是上一轮综合目录，不作为聚焦证据。
- 综合 Electron24：135 checks、exit0，普通 out 恢复，产物归档 2026-09-23-electron-24-artifacts。

## 性能和边界

本轮同路径读取 absent/off p95 为 2.7679/2.7528ms（-0.5455%）；noop1000 p95 14.7756ms，pendingRequests=0。这是单次观测，不是正式预算通过；此前正式五轮预算失败仍待解决。本轮用可复现 HTTP 协议模型夹具验证真实应用链路，不作为真实 Autobiz 业务验收。完整性能矩阵、长稳、Autobiz 演示和 Actions 安装包仍未完成；不宣称全计划已完成。

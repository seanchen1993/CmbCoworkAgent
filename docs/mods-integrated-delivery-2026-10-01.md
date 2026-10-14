# 四方向统一交付与验证记录

分支：`codex/mods-v2`，工作区：`C:\ai\CmbCoworkAgent-mods-v2`。本轮不在 UAT 开发。
状态：四方向实现已落地，官方发布后的增量与最终冻结验收见
[最新交付报告](mods-official-launch-implementation-2026-10-02.md)。以下保留首次验证记录。

## 这次要交付的效果

用户可以从真实 Autobiz 包选择组件，把宿主 Agent、项目测试、其他插件动作与不同模型
组合成流程，应用到当前对话后发送任务。项目完成规则继续作为底线，Claw 附加规则只能
收紧检查。保存组合、应用组合与执行一次流程是三个不同操作，界面和指南均明确说明。

| 方向 | 已实现 | 验收重点 |
| --- | --- | --- |
| Autobiz | 固定上游归档、组件包、只检视/检视测试/修复复检三预设、受限 Python 检查、跨插件结果输入 | 真读文件、真运行原测试、失败后编辑实现并复测，不改变原测试 |
| 交互 | 应用前差异确认、配置及工作目录版本检查、升级修复草稿、独立 Flow 副本、互斥模型选择、真实测试证据 | 不误应用旧预览，不把历史 PASS 或插件文字当测试通过 |
| 旧 Plugin/Harness | 支持有效本地项目及 Feature，标准 Skill/Hook 生命周期、父 Stop、阶段权限与租约 | 原项目页面可打开 Claw 并运行流程；控制器、远端、IM 仍拒绝 |
| Function 兼容 | 完整 Skill 正文快照、实际模型工具描述、草稿读写、单次模型取消、有限 effort、附加完成规则 | 身份固定、撤权取消、输入框版本保护、模型请求及实际工具链 |

## 用户和作者入口

- [Autobiz 逐步实操](mods-integrated-hands-on-2026-10-01.md)
- [插件作者接口和迁移](mods-integrated-authoring-2026-10-01.md)
- [统一实施契约](mods-integrated-iteration-contract-2026-10-01.md)
- [架构评审](mods-integrated-architecture-review-2026-10-01.md)
- [体验评审](mods-integrated-experience-review-2026-10-01.md)
- [Autobiz 专项证据](mods-autobiz-integrated-verification-2026-10-01.md)
- [Claude 2.1.286 原版核验](mods-claude-2.1.286-audit-2026-10-01.md)
- [逐项兼容矩阵](mods-v2-compatibility-matrix.json)

可导入包位于
`output/autobiz-integrated-2026-10-01-final/AutobizDevOps_Plugin_Kanban_Mods.zip`，
SHA256 为 `EBD626A1BF0B0B6033374846FC47A505F0C1FBC946BCA89066879510DF9203EC`。
同目录 `autobiz-source-project` 可作为体验项目；原 `C:\ai\autobiz_kanban` 未被修改。

## 回归记录

首次 `npm test`：705 个测试文件，5,672 项通过、21 项失败、5 项跳过，耗时 1,089.92 秒。
日志：`output/mods-integrated-npm-test.log`。与上一轮逐名比较见
`output/mods-integrated-baseline-comparison.json`，11 项既有失败全部复现：macOS IDE 五项、
缺少 Chrome 扩展资源五项、既有固定色表面策略一项。不能宣称全量测试全绿。

新增十项记录分别涉及：四项 5 秒超时、文件树事件循环耗时、QuickJS Base64、Python
目录替换边界、Claw 旧错误文案断言、兼容清单计数和来源说明。后两类文档/断言已修正，
Python 边界在首次测试模块载入之后完成修复；所有新增失败仍以单独复核结果为准。
保留首次日志，不将后续通过回填成首次通过。

九条独立回归链全部通过：adoption、messages、hooks、plugins、task-cards、merge、workflow、
desktop-agent-baseline、im-v1。报告与每条原始日志在 `output/mods-integrated-standalone/`。
保持原九条 npm 脚本执行链，workflow 在 Windows 使用 Git Bash，未跳过失败命令。
最终类型检查、构建、Electron、浏览器与性能结果待最终运行后补入。

## 验证方法与边界

Electron 使用真实生产 React、IPC、独立 Function 进程、QuickJS、Agent 工具和文件系统，
模型端是可控本地 HTTP 服务。它证明运行协议与读写审批链路，不证明线上模型的判断质量。
浏览器独立测试使用受控 IPC，只证明交互与时序，不能替代主进程权限测试。

Autobiz 原始全套基线 168 项中有 5 failure、1 error，保持上游原测试，不为演示改弱断言。
故障注入只在验收隔离目录进行，交付体验目录不带注入。新 Python 配置固定运行器及参数，
不执行配置提供的任意 shell；审批前后重查配置及真实目录，零测试不算通过。

官方发布后的增量已接通真实请求的 `prompt.compose`、`prompt.section`，并提供有界
SDK compose，详细边界见最新交付报告。本轮仍不是完全 Claude API 或产品对齐。
`prompt.submit/asUser`、更广的
草稿/附件编辑、完整终端、多环境 MCP 隔离、远端/定时 DIY 及任意副作用恢复仍未覆盖。
`effort` 当前只映射既有 DeepSeek low/high/max，其余明确拒绝。Skill 正文在实际读取时
展开；不把未读取的显式选择称为已经注入。旧插件可继续按包使用，任意内部逻辑不会自动
变成可组合组件，作者须声明组件入口或可调用动作。

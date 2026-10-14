# 参数表单：独立生产 Electron 验收

分支 `codex/mods-v2`，使用包含禁用步骤校验修复的最终普通生产构建。Node 22，五个脚本串行执行；未重建或手改生成产物，未使用宿主测试后门。

## 最终结果

| 场景 | 业务检查组 | 退出码 |
| --- | ---: | ---: |
| 新表单 `mods-flow-forms-e2e.spec.ts` | 5 | 0 |
| 原 Flow `mods-flow-e2e.spec.ts` | 9 | 0 |
| 跨插件组合 `mods-composition-e2e.spec.ts` | 11 | 0 |
| 传统 Plugin/Harness `legacy-plugin-project-e2e.spec.ts` | 7 | 0 |
| Skill/MCP `mods-claw-sources-e2e.spec.ts` | 10 | 0 |
| 合计 | 42 | 全部通过 |

这里统计脚本输出的业务检查组，不是单元测试数量。完整单元回归、专项浏览器矩阵和宿主调用边界单测由主任务与其他评审 agent 负责，本报告不冒充这些检查的独立执行记录。

## 新表单实际验证

新增独立脚本与 `tests/support/mods-flow-forms-fixtures.ts` 使用真实 ZIP 安装两个插件，经过实际授权、宿主 schema 目录、生产 React、保存 IPC、Claw 绑定、聊天发送、Flow 和 QuickJS 执行。所用 provider 为独立测试插件，不将它们声称为真实 Autobiz 业务包。

1. 填写 Feature、文件路径、布尔配置 false、整数 0、空字符串；切换 JSON/表单时未知嵌套对象保持。已知对象路径 `/payload` 可选择并映射到 JSON Pointer，再切回完整输出对象。保存后的实际定义与期望类型和值一致，准备和保存均没有动作或模型请求。
2. 绑定保存版本，通过聊天的“执行流程”发送任务。真实 A 输出到真实 B，固定 feature 覆盖上游同名值，path 保留上游值；两个动作各执行一次，最终宿主验收完成。
3. 通过真实 IPC 保存缺失或类型错误的 config，并保留 inputFrom。启动可先返回 queued，最终准备失败；A/B 业务动作计数均不增加。
4. 上游真实动作输出不符合下游 inputSchema 的类型时，在合并后的校验中失败，下游动作未调用。测试没有把 schema 提示当作已保证的运行结果。
5. 无 configSchema 的旧动作仍收到任意旧配置，嵌套对象、false、0 和空串保持。

实际调用前 config 防线无法从正常不可变的已准备 Flow 中合法绕过准备阶段单独触达，因此由宿主边界单测验证；Electron 没有为此添加特权入口。

## 存量回归范围

- Flow：真实 Agent 测试失败与修复、禁用步骤零请求、人工确认和取消、模型顺序、Autobiz 编译及原生 checkpoint、重启不重放。
- 跨插件组合：真实 A/B 输出传递、角色模型、线程隔离、审批、取消、绑定默认模型、目录读取零动作及撤权。
- 传统 Plugin/Harness：Mods 默认关闭与开启但未授权时的旧功能、ZIP/Skill/Hook/MCP 发现、真实项目/worker/产物访问、启停、重启持久化、卸载恢复诊断。
- Skill/MCP：选择范围、空选择、旧缓存更新、子线程继承、Skill 真实文件读取及 Pre/Post、MCP 单次执行与结构化输出、PreSkillUse 否决、来源身份持久化。

这些实际路线未发现新增生产回归；这不是所有模块、所有第三方包或任意环境均已测试的声明。

## 界面与首次失败复核

已目视最终 1366 和 800 像素表单截图：字段、类型、存在性、未知内容保留提示清楚，窄窗没有表单水平溢出。最终聊天截图展开了“已完成”、两个动作通过和最终验收结果。

首次联调的两项失败均保留：

- 800 窄窗中的自定义页面不显示聊天列表；测试按聊天标题返回失败，改为实际可见的“到聊天启动此流程”。
- 测试经 API 先绑定 Claw，再从表单回聊天立即发送，遇到模板选择被加载完成的绑定副本替换。生产正确拒绝并提示选择已改变，完整保留输入，没有业务执行。最终脚本等待页面明确呈现“使用已应用 Claw 的流程副本。”后发送，未增加固定 sleep 或绕过聊天。该初始化期间仍可能出现安全拒绝提示，是已观察的交互限制，不应表述为任何时刻立即发送均已通过。

本轮浏览器测试另外发现并修复了“禁用未完成步骤仍被必填校验阻断”问题；本文中的最终 Electron 五组均在该修复后的生产构建运行。

## 文件与证据

- `output/mods-flow-forms-validation/results.json`：五组耗时、退出码和检查组数。
- 同目录 `forms.log`、`flow.log`、`composition.log`、`legacy-plugin.log`、`claw-sources.log`：最终日志。
- 同目录各场景子目录：最终报告、截图及运行证据。
- `output/mods-flow-forms-validation/forms/forms-800.png`：真实窄窗表单。
- `output/mods-flow-forms-validation/forms/forms-chat-complete.png`：真实聊天运行完成并展开结果。
- `output/mods-flow-forms-e2e/initial-navigation-failure.*`、`selection-race-failure.*`：保留的首次定位证据；不是最终失败。
- `output/mods-flow-forms-e2e-lint.log`：新增两个测试文件的定向 ESLint 通过记录。

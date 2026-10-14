# DIY 参数表单与草稿保护迭代

开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本轮降低配置成本，
不修改 UAT，不改变旧 Plugin/Harness 的运行模式，也不宣称所有 Claude API 已对齐。

## 用户现在少做什么

| 操作 | 之前 | 本轮 |
| --- | --- | --- |
| 填插件动作或 MCP 参数 | 手写 JSON，自己找字段名和类型 | 常见声明自动显示字段表单、说明、必填标记及枚举/布尔选择 |
| 区分不设置、false、0、空字符串 | 依靠手写 JSON 表达 | 明确的“设置此参数”开关，值按原类型保存 |
| 连接前一步结果 | 手写 JSON Pointer | 选择完整输出或已声明的对象路径；MCP 可选择结构化内容 |
| 配置插件动作 | 只有任意 config JSON | 作者可声明可选 configSchema，表单和宿主共同使用同一声明 |
| 修正错误草稿 | 存在只改无效 JSON 后仍能运行旧版本的问题 | 未完成的 JSON/数字阻止保存、运行、到聊天；切步骤不丢草稿 |
| 插件更新 | 容易按同名来源理解旧配置 | 只按完整身份与摘要使用 schema；失效来源保留数据并提示重新选择 |

高级 JSON 仍保留，表单不删除未知字段、不把字符串强制转数字，也不自动填 schema.default。
嵌套对象、复杂组合约束及无 schema 的旧配置不假装自动表单化。所有实际调用仍经过宿主校验。

## Autobiz 的实际操作

1. 更新并重新批准 Autobiz 1.4.0 安装包、Review 1.2.0 示例包，重新选择已更新来源并应用组合。
   Autobiz 用项目打包脚本生成；`examples/autobiz-kanban-mods` 本身不是完整安装包。
2. DIY 流程添加 Autobiz「准备单文件检视输入」。在“动作输入”表单设置“项目文件路径”，
   填写业务工程内相对路径，例如 `order-export.cjs`。有多个 Feature 时设置“Feature ID”。
3. 添加独立 Review 动作，选择前一步为输入来源，在“输出来源路径”选“完整输出对象”。
   不必把 path/source 再抄一遍；不设置的字段可由前一步补齐。
4. Review 的“检视模型引用”不设置时使用 Claw 默认模型；需要指定时填写已配置的模型引用，
   并确保该模型在当前 Claw 允许范围内。这个字段是示例作者声明，不是所有动作通用的保留字段。
5. 添加人工确认，保存流程，在“我的 Claw”选择该版本、保存并应用；输入框切到“执行流程”，
   输入这次检视目标并发送。保存和应用本身不会执行插件。

业务项目需有真实 Feature 状态与指定文件。示例依然只检视一个最多 4000 字符的文件，
不运行测试、不自动推进阶段；需要这些能力时分别添加真实检查/阶段推进并满足原有条件。

已经安装的旧包可以继续用：原有 inputSchema 通常可直接生成基础表单；没有 configSchema 时
动作配置仍使用高级 JSON。更新声明需要新摘要批准，不能仅替换显示名称。

## 底层变化与检视发现

- 可选 configSchema 贯通作者清单、可信目录、Flow 准备和真实动作调用；缺省 config 按 `{}` 校验。
  input 来自前步时也不能绕过 config 检查。旧包省略该字段时保留原行为及摘要算法。
- 来源匹配使用插件 ID、插件名称、action ID、摘要；MCP 使用服务完整身份、工具名和 schema 摘要。
  目录只用于帮助编辑，不替代运行时授权。
- 编辑器报告独立 dirty/valid 状态，解决“无效文本没有写入 definition，因此误认为未修改”的问题。
  同一编辑会话切步骤/模式保留草稿，显式放弃或保存新版本才重置。
- 额外修复非法 `claw: null` 被当作缺省声明的情况；非法清单不能静默降级。
- 最终回检复现并修复了禁用步骤的兼容问题：禁用的未完成步骤不做执行参数语义校验；
  其中尚未解析的原始 JSON/数字草稿仍阻止保存，避免静默丢失。浏览器保留修复前失败与修复后通过证据。
- 未增加自动连接 MCP、模型调用或插件执行来推测字段；前步输出提示受数量/深度约束。

设计与实现均完成双评审：[实施契约](mods-flow-forms-contract-2026-09-29.md)、
[架构评审](mods-flow-forms-architecture-review-2026-09-29.md)、
[质量评审](mods-flow-forms-quality-review-2026-09-29.md)。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| 后端专项 | 6 文件、75 项通过，包含真实 QuickJS 配置拒绝零调用、旧包兼容及摘要检查 |
| 表单帮助器 | 最终 20 项通过，包含禁用步骤保留语义、未完成草稿仍阻断 |
| 浏览器专项 | 最终 8 组通过，页面异常 0；包括禁用步骤修复前失败/修复后通过 |
| 原浏览器交互 | 最终 20 组通过，覆盖原 Flow、Claw、来源选择、取消/审批及侧栏 |
| 新生产 Electron | 5 组通过：真实 ZIP/目录/表单/保存/聊天执行/QuickJS 结果、配置和合并后输入拒绝、旧包兼容 |
| 存量生产 Electron | Flow 9 组、跨插件组合 11 组、传统 Plugin/Harness 7 组、Skill/MCP 10 组，全部通过 |
| 全量 npm test 的 Vitest 阶段 | 682 文件、5482 项：5464 通过、13 失败、5 跳过；完整原始日志保留 |
| 全量失败差分及复测 | 11 项与上轮失败名称一致；另 2 项为浏览器测试超时和 Windows 临时 exe 清理 EBUSY，原样复跑 2 文件/16 项全过 |
| 后续独立回归链 | 9/9 条通过，共完成 package.json 声明的 84 个顺序命令；覆盖 adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1 |
| 类型与构建 | 最终 Node/Web TypeScript、生产 build 均通过 |
| 示例校验 | Review 1.2.0 与实际生成的 Autobiz 1.4.0 包的 strict-compatibility check 均通过 |

全量结果不能表述为全绿。11 项基线失败是 macOS IDE 路径模拟、缺少 Chrome 扩展资产、Windows
主题路径匹配；逐项对比记录在 `output/mods-flow-forms-baseline-comparison.json`。
另两项没有改生产代码、放宽断言或增加超时，原样复测记录在 `mods-flow-forms-extra-failures-recheck.json`。
完整测试运行期间收敛了禁用步骤的最终修复，该全量结果已包含最后 20 项表单帮助器测试；
最终 UI 使用修复后的生产构建，重新执行了浏览器及 Electron 验收。

`npm test` 在上述 Vitest 非零处中断，后续 9 条 standalone 链按原顺序单独执行，全部退出 0。
使用 Node 22.23.2、最多 2 个测试 worker，与全量 Vitest 不重叠；仅 workflow 子进程指定 Git Bash，
满足既有 Windows `pwd -W` 测试前提。各子脚本统计口径不同，不将 PASS 日志行混加为测试用例总数。
完整命令和结果见 `output/mods-flow-forms-standalone/report.json`、同目录 `report.md` 与各链日志。
日志与截图位于 `output/mods-flow-forms-*`。测试使用隔离项目和受控模型，不能代替企业网络与实际业务模型质量验收。
新 Electron 使用测试动作包；Autobiz/Review 的真实示例代码另由后端示例测试及完整打包检查覆盖，
不能把测试动作包的结果说成已在用户业务工程完成验收。

性能：最终 64 步表单、预热后 20 次本机浏览器填写，p50 31.5ms、p95 38.7ms，包含自动化往返。
这是并行验证期间的编辑交互观测，不是对模型推理、网络性能的提升承诺。首次空闲抽测 p95 约 21ms，
两次负载不同，不据此得出回归或提速结论。

验收还记录了两次测试定位问题：窄窗自定义页面隐藏聊天列表，脚本改用真实“到聊天启动此流程”；
返回聊天时模板选择会被已应用 Claw 副本替换，过早发送被宿主安全拒绝、输入保留，脚本等待可见的
“使用已应用 Claw 的流程副本”状态后发送。该初始化交互仍可继续优化，没有通过绕过聊天入口完成测试。
详见 [独立 Electron 验收](mods-flow-forms-electron-verification-2026-09-29.md)。

## 本机体验材料

- [Autobiz 1.4.0 安装包](../output/mods-flow-forms-packages/AutobizDevOps_Plugin_Kanban_Mods.zip)
- [Review 1.2.0 安装包](../output/mods-flow-forms-packages/review-agent-1.2.0.zip)
- [真实 Electron 800px 表单](../output/mods-flow-forms-validation/forms/forms-800.png)
- [真实聊天执行完成结果](../output/mods-flow-forms-validation/forms/forms-chat-complete.png)

这些 ZIP 和截图是本机 `output/` 产物，不包含在源码提交中。安装授权只更新扩展包，不修改业务项目文件。

## 本轮仍保留的边界

- Flow 仍需已授权的“所属 Mods”；宿主独立执行主体未在本轮实现。
- 插件仍整体加载；任意 Hook 拆分、组件级授权需要后续新契约。
- 传统 Plugin/Harness 不能直接使用这套 Flow；本轮回归其原路径，不声称完成模式接入。
- 前步绑定仍是对象合并，不是逐字段任意映射或表达式引擎。
- 完成规则仍按项目共享；环境隔离、通用故障恢复及剩余 Claude API 不在本轮实现范围。
- 面板内切换、复制、去 Mods 有草稿守卫；未提供全应用导航/窗口关闭的自动草稿恢复。

下一阶段应优先评审“宿主管理 Flow 执行主体”和“显式组件边界”，再接入无所属插件流程及
组件级选择。不能通过移除授权或过滤几个 Hook 名称来快速拼出这些能力。

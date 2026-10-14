# 显式组件选择：独立 Electron 验收

工作树 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。以下最终结果全部来自完成规则兼容修复后的同一普通生产构建，构建与完整类型检查日志为 `output/mods-components-build-final.log`、`output/mods-components-typecheck-final.log`。使用 Node 22；验收任务没有修改生产代码、生成产物或 UAT。测试不是宿主 stub：ZIP 安装、批准、保存、应用、命令、运行均经过生产 IPC，组件在真实 QuickJS guest 中执行，模型经过真实本机 HTTP 适配器。

## 结果

| 脚本 | 通过业务组 | 耗时 |
| --- | ---: | ---: |
| `mods-components-e2e.spec.ts` | 10 | 36.72 秒 |
| `mods-host-flow-e2e.spec.ts` | 9 | 30.45 秒 |
| `mods-composition-e2e.spec.ts` | 11 | 23.81 秒 |
| `legacy-plugin-project-e2e.spec.ts` | 7 | 12.40 秒 |
| `mods-flow-e2e.spec.ts` | 9 | 54.15 秒 |
| `mods-flow-forms-e2e.spec.ts` | 5 | 17.59 秒 |
| `mods-claw-sources-e2e.spec.ts` | 10 | 22.82 秒 |
| 合计 | **61** | 七个进程均退出 0 |

各脚本串行执行，没有与全量测试竞争资源。修复后七个脚本原样完整重跑，没有降低或更改断言；上表不沿用任何修复前结果，也不重复计算业务组。耗时只是本机受控小 fixture 的整套验收耗时，不是大项目或线上模型性能基准。两份新增测试文件的定向 ESLint 通过；全量测试、类型检查、设计审查与浏览器矩阵由主任务另行汇总。

## 构建换版与覆盖限制

第一轮 Electron 61 组已通过，证据保留在 `output/mods-components-validation/`。随后主任务全量测试发现四项真实新增兼容失败：`setCompletionPolicy` 无条件失效整个工作区，误关闭旧整包实例。架构实现与质量复核将其修为保留原完成证据失效语义，仅关闭不满足新强制规则的部分选择或排除来源线程。该问题没有被第一轮 Electron 场景捕获，不能将当时的通过写成没有生产回归。

收到最终构建通知后，本验收任务将全部七套原脚本重新运行一遍，结果为上表 61 组全过；新证据独立保存在 `output/mods-components-validation-final/`。精确命中四项兼容失败的单元回归及完整全量结论由主任务提供，本报告不把它们伪称为 Electron 自身捕获。

## 新能力的实际证据

1. **真实上传授权**：A/B 两份 ZIP 通过 `window.api.plugins.install` 安装，native `mods/manifest.json` 没有旧入口 `entry`，随后通过 `approveFunction` 批准。没有预写插件目录、直接写授权 store 或使用测试专属宿主入口。安装前先应用空 Claw，避免默认整包业务会话影响观察。
2. **真实界面配置**：进入“我的 Claw”，选择两个插件，启用范围切换为“指定组件”。取消 A 的自动改写和基础能力，保存被缺依赖条件阻止；点击“加入所需依赖”后恢复基础能力。设置 A 检视参数 `review-alpha`、B 报告参数 `report-beta`、默认模型，保存并点击“应用到当前对话”。
3. **实际只加载选择入口**：未选 rewrite 文件顶层设置 guest 全局 marker。真实主会话 inspect 和 Flow 子运行的 review 输出均断言 marker 为 false，且 rewrite 命令不存在。A 的声明顺序刻意将 review 放在 core 前；实际 session 初始化顺序仍为 `core → review`。core 没有拿到 review 的组件参数，包公共参数保持传入。
4. **普通聊天生效**：真实聊天发送后，选中 review 的 turn hook 计数增长，受控 HTTP 服务实际收到 `components` 模型请求并返回聊天回复。
5. **跨包流程生效**：保存宿主 Flow 后应用为 Claw 副本，用户在聊天选择“执行流程”并发送任务。A.review 的结构化输出进入 B.report，结果同时包含正确的文件和两个组件参数；Agent 实际模型为 `custom:components`。点击生产侧栏“同意并继续”后完成，动作结果保留 `components-a/review` 与 `components-b/report` 的真实来源身份。
6. **生命周期与拒绝边界**：活动流程期间应用另一组合被 busy 拒绝；只保存修改后的模板不会改变已应用参数，再显式应用才改为新值。缺依赖、错误配置类型、partial selection 下启用 mandatory check 均被拒绝。完整退出并重启应用后，选择和参数仍保持，未选 marker 仍为 false。
7. **存量与撤权**：未修改的旧整包插件可以与新组件共存并真实执行命令。最后在等待人工确认时撤销 A 授权，活动流程结束而不是发布完成；旧组合的 commands 读取被明确拒绝为来源未授权，不能恢复旧命令。

最终新组件报告记录三次真实模型请求：普通聊天一次、两次 Flow 的 Agent 各一次。新脚本本身不包含 MCP 节点，因此不声称新增组件 fixture 调用了 MCP。MCP 实际进程调用、独立 Skill、Pre/Post hooks、原生 Skill 读取和结构化输出连接，由同构建的 host-flow 与 claw-sources 脚本验证。

此新 fixture 的“代码检视/生成报告”动作仅对结构化输入添加可核验字段，用于证明真实组合、参数及数据传递，并未读取或检视项目源码。模型 HTTP 服务也是受控固定响应，不能将它的通过结果等同于真实模型完成业务质量判断。

Flow 定义通过生产 API 保存，主要组件配置和聊天启动通过 React 页面操作；本文不将 API 保存流程定义描述为全程手工拖拽。Electron 原生权限框由测试驱动返回批准，聊天中的成果确认则实际点击页面按钮。

## 初次失败的归属

- **fixture 注册规则错误**：A 包三个入口都无 matcher 注册 `session.start`，触发既有同事件重复注册限制，审批 probe 返回脱敏 `MODS_GUEST_ERROR`。fixture 改用受支持的 `on("session.start", {}, handler)`，没有放宽 guest 规则或绕过批准。原证据保留在 `initial-registration-fixture/`。
- **窄窗口脚本操作遗漏**：800px 时右侧面板作为覆盖式抽屉，脚本未收起便点击被遮挡的发送按钮。按真实用户路径点击“收起 Claw 工作台”后发送成功，没有 force click 或 API 替代启动。原证据保留在 `initial-narrow-drawer/`。
- **撤权断言规格过窄**：脚本原以为空列表代表撤权，真实宿主对含失效来源的 Claw 拒绝整个 commands 读取，这是正确的安全拒绝。改为精确断言来源未授权错误，继续保留活动流程终止断言。原证据保留在 `initial-revoke-contract/`。

最终构建的独立 Electron 未发现新的阻断问题。修复前全量测试发现的问题及重新构建验证见前述说明，不能据此断言覆盖了所有插件作者代码或所有组合规模。

授权/兼容性探针仍会在隔离 guest 中评估整包并检查注册，不能把“未选业务入口不执行”误写为“授权检查也完全不接触未选源码”。测试使用 marker 区分隔离探针与真实会话；未选顶层 throw 的严格投影证明由编译器/QuickJS 专项测试覆盖。

## 交互目视与边界

- 1366、1024、800 宽度的真实组件编辑页均截图。800 宽度下组件名称、依赖、选择框和参数没有横向挤出；纵向滚动展示长配置。
- 审批截图和最终展开截图均已目视。完成页明确显示“已完成”，完整运行详情同时显示 A/B 动作来源和通过状态。
- 窄窗口右侧工作台需先收起才能点击其覆盖区域内的发送按钮，现有 X 可用；后续可考虑更显眼的窄屏退出提示。
- 一个非阻断的既有提示问题：已应用 Flow 副本存在但模板列表暂为空时，仍可同时显示“先在 DIY 流程保存一套步骤”。实际副本可以运行，后续可让该提示也检查已应用副本，减少误解。
- 完成页的通用“所选检查与应用完成规则全部通过”不代表此新组件流程执行了项目测试：该定义只有 action、Agent、approval，没有 native test/check 节点。后续可按实际检查类型和数量生成完成文案。其他 host-flow 回归确实执行了项目测试，但不能把其证据归到新组件示例上。

## 证据

- `output/mods-components-validation-final/results.json`：修复后七套脚本退出码、构建标识和耗时。
- 同目录 `components.log`、`host.log`、`composition.log`、`legacy-plugin.log`、`flow.log`、`forms.log`、`claw-sources.log`：61 组 PASS 记录。
- 同目录各脚本同名子目录：各自原始 JSON、运行记录、模型/工具证据与截图副本。
- `output/mods-components-validation-final/components/component-editor-1366.png`、`component-editor-1024.png`、`component-editor-800.png`：最终构建真实组件选择配置页，800 宽度已重新目视。
- `output/mods-components-validation-final/components/component-chat-approval.png`：等待人工确认的真实聊天流程。
- `output/mods-components-validation-final/components/component-chat-complete.png`：最终构建展开的完成结果页面，已重新目视。
- `output/mods-components-validation-final/components/component-complete-evidence.png`：最终构建完整运行详情，包含两个包的实际动作来源，已重新目视。
- `output/mods-components-validation-final/components/report.json`：最终运行、模型请求、断言分组；`runtime.log` 为隔离应用运行日志。
- `output/mods-components-validation/`：保留修复前 61 组结果、当时截图与三项测试规格错误初次证据，不与最终构建混用。

新增文件仅为 `tests/mods-components-e2e.spec.ts`、`tests/support/mods-components-fixtures.ts` 与本报告。未创建提交，未更改已有未提交工作。

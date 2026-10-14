# 无所属插件 Flow：独立 Electron 验收

分支 `codex/mods-v2`，使用 Node 22 与普通生产 Electron 构建。执行期间没有修改 UAT、生成产物或生产权限，没有使用测试专属宿主入口。

## 最终结果与构建范围

| 脚本 | 通过业务组 | 耗时 | 构建 |
| --- | ---: | ---: | --- |
| `mods-host-flow-e2e.spec.ts` | 9 | 35.80 秒 | 最终审批文案构建 |
| `mods-flow-forms-e2e.spec.ts` | 5 | 19.58 秒 | 最终审批文案构建 |
| `mods-flow-e2e.spec.ts` | 9 | 60.55 秒 | 审批失效清理修复构建 |
| `mods-composition-e2e.spec.ts` | 11 | 27.49 秒 | 审批失效清理修复构建 |
| `legacy-plugin-project-e2e.spec.ts` | 7 | 17.70 秒 | 审批失效清理修复构建 |
| `mods-claw-sources-e2e.spec.ts` | 10 | 25.11 秒 | 审批失效清理修复构建 |
| 合计 | **51** | | 六个进程均退出 0 |

六组脚本串行运行。旧四组通过后仅修改了宿主流程审批框的标题与请求主体文案，再构建并完整重跑 host、forms；不声称旧四组是在最终文案构建重新运行。其后源码只有原生 MCP 注释修改，无行为变化。业务组数不等于单元测试数；完整单元测试、设计评审、类型检查和浏览器矩阵由主任务另行汇总。

## 零插件包的真实执行

新脚本通过 `skills.upload` 上传独立用户 Skill，通过 `mcp.create` 创建独立本机 stdio 服务。开始阶段同时断言 `plugins.list()` 与 Function Mods 列表为空，没有安装任何插件包、没有 Function 授权，Claw 的 `capabilities` 为空。

生产目录仍提供宿主 Flow；通过真实 IPC 保存 `schemaVersion: 2`、`execution: { kind: "host" }` 且没有 `plugin` 字段的定义。实际打开 DIY 编辑页，断言不存在“所属 Mods”选择器，并目视“由应用运行”说明。定义由 IPC 建立，本文不把这一步称为纯手工从空白 UI 创建；UI 创建入口另有浏览器测试。

绑定保存副本后，实际在聊天中选择“执行流程”并发送任务，依次完成：

- Skill 模型真实调用 `read_file`，下一次模型 HTTP 请求中包含实际 Skill 文档；真实 HTTP PreSkillUse/PostSkillUse 钩子均触发。
- MCP 真实 stdio 进程调用一次，日志记录进程和参数。
- Agent 通过真实本机 HTTP 模型适配器返回结构化结果。
- `unit-test` 与 `e2e` 分别运行项目 `npm run test`、`npm run test:e2e`，真实断言项目文件并写入隔离证据。最终检查再次运行，两个检查分别至少有两条执行记录。
- 生产侧栏出现人工确认，点击“同意并继续”，最终流程完成。MCP 没有因最终复验而被重放。

本机受控小项目从聊天发送到首次人工确认约 **11.41 秒**，包括真实模型 HTTP、MCP 与 npm 子进程。此数据是一次阶段耗时，不是性能基准，也不能外推到线上模型或大型工作区。

## 权限、兼容和恢复

- v2 保存阶段拒绝 `plugin` 字段、`code-review`、`autobiz-validator`、`autobiz-stage`，未假装这些能力已支持。
- 同工作区第二个线程无法并发启动；取消后旧确认被拒绝，待执行 MCP 没有调用。
- MCP 禁用、工作区 Mods 关闭、Skill 内容在准备后变化，均导致旧授权失效，没有后续模型/工具执行或完成发布。
- 完整应用重启后，未完成确认变为 `interrupted`，完成记录与已绑定 Flow 摘要保留，没有模型、MCP 或项目检查重放。
- Workflow 与 Harness 项目会话仍被普通本地会话范围校验拒绝。
- 零包场景完成后才安装 Function 插件。无授权、已授权但未选入 Claw 的两次运行均被拒绝；随后授权并选入后读取真实插件计数仍为 0，再分别运行 v2/v1 后计数为 1/2。
- 旧 v1 保存内容、所属插件、revision 和 digest 原样保持。撤权后 v1 与混合 v2 都不能执行动作。
- 四套旧场景验证原 Flow、跨插件/模型组合、传统 Plugin/Harness 和 Skill/MCP；上一轮表单的五组也通过，包括参数保真、聊天触发、错误配置准备拒绝、合并后输入拒绝与旧配置兼容。

## 真实问题及闭环

首次 Electron 在 Skill 内容变更后发现：`flowDecide` 拒绝旧确认，但流程仍停留在 waiting，未释放执行占用。不是测试超时推测，也不是直接篡改运行状态；测试调用的是实际 `skills.write` 和审批 IPC。保留终态断言后，主任务修复了审批校验失败时的 abort、等待者拒绝和清理，并补充单测。修复后的同一 Electron 反例通过，后续等待、重启和权限检查继续完成。

最终审批文案通过捕获真实 Electron `dialog.showMessageBox` 参数验证：MCP 一次、项目检查四次共五条审批均为“批准流程操作”，主体为“当前 DIY 流程请求执行”，没有伪称插件或暴露 `flow:` 运行身份。审批响应由测试驱动，本文不把捕获参数称为真实点击系统对话框。

测试曾错误地禁止所有 UUID，将 MCP 连接器稳定身份误判为 Flow 运行身份；随后精确工具断言又少写了 canonical `connector:` 前缀。两项均是测试规格错误，已保留证据并按真实能力身份修正，不改变生产权限目标。最终断言要求审批对象准确等于所选 `mcp:connector:<connector.id>:echo`。

MCP 提示目前仍显示精确的内部工具标识，尚未替换为服务友好名称；这是一项交互改进空间。页面 `host-chain · v1` 表示保存 revision 1，实际定义格式为 schemaVersion 2，两者不是同一个版本号。

## 证据位置

- `output/mods-host-flow-validation/results.json`：最终 51 组汇总、退出码、耗时和构建标识。
- 同目录 `host-complete.log`、`forms-complete.log` 与四套旧场景日志。
- `host-complete/report.json`：实际 Flow 结果、模型请求、Skill 钩子、MCP/检查进程日志及五条原生审批参数。
- `host-complete/host-no-plugin-editor.png`：无所属插件编辑器，已目视。
- `host-complete/host-no-plugin-complete.png`：真实聊天运行完成与展开结果，已目视。
- `initial-skill-drift/` 与对应日志：首次生产问题完整证据。
- `dialog-tool-identity-initial*`、`dialog-canonical-target-initial*`：两项测试断言误判证据。
- `output/mods-host-flow-e2e-lint.log`：两个新增测试文件定向 ESLint 通过。

本验收证明上述受控路线已运行通过，不声称任意线上模型回答质量、任意第三方来源、全部 Harness 场景或未实现的显式组件导出契约已验证。

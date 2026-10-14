# 任务用量提示与普通聊天兼容修复

本阶段已经实现真实任务的用量通知，完成两位独立代码检视、最终广域回归与真实 Electron 验证。整体 Mods 对齐仍在继续，不是全功能完全一致。

## 用户能感受到什么

你可以给自己的 Claw 组合加入“任务用量提示”组件。发送普通任务后，右侧面板显示模型实际报告的输入量；实际数字变化时自动更新。相同数字不会反复通知，不另开一次模型任务，也不会按回答字数猜测用量。

安装包在 `output/mods-usage-notice.zip`，源码和逐步说明在 `examples/mods-usage-notice/README.md`。上传、批准，进入右侧 Claw 配置，选择组件，保存并应用到当前聊天，再输入 `/usage-board` 打开面板。它可以和其他插件的输入规则、代码检视、复制标题等组件组合。

没有安装或启用这一通知的组件时，不查询额外用量，不启动插件。这份显示是最近一次模型响应的实际上下文用量，不是累计费用。

## 与 Claude 的对应及边界

采用 Claude 的 `session.measure` 事件名称和实际数字变化才通知的方式。依据是官方 [Mods 事件说明](https://code.claude.com/docs/en/plugins/mods/events) 和本机校验过的软件包声明与可读程序片段。

原始资料位于 `output/claude-code-2.1.288-alignment-analysis-2026-10-03/readable/claude-code.d.ts` 和 `extracted/chunk-xg8vtq37.js`。后者的实际通知程序先更新“已发出”的数字，再调用处理链，失败时不恢复旧数字。这支持“已发出通知”的含义，不能等同于“插件回调已经执行成功”。这些证据来自校验过的包及可读片段，不代表已还原所有字节码。

DevClaw 只在原主助手任务真正收尾时通知，沿用原任务身份。已被运行进程接纳的通知可能因随后取消而没有执行，同一数字不会自动重发；新的变化仍会通知。观察最长五秒，结束时关闭这次观察自己启动的定时器和进程；长期后台服务应放在会话启动或明确命令中。

本地没有 Claude 订阅额度及美元费用账本，因此额度列表为空，费用字段省略。没有增加不存在的 `$.session.measure()` 调用方法。这里只补事件，不假造官方账户能力。

## 同时修复了什么

真实应用测试发现：关闭 Mods、但保留内容保护时，普通聊天曾被模型开关判断阻断。本次修复宿主模型和原生子任务入口，插件本身仍必须启用并批准才会运行。

只保留保护时，模型输入、每段回答和最终回答继续接受内容过滤。开启 Mods 但没有安装组件时，提示文字和模型回答也受保护。附件输入和输出使用自己的格式校验，提示来源清单不会恢复已经删除的旧文字。等待过滤期间若原聊天身份被替换、设置改变或任务取消，旧处理不能继续调用模型或发布结果。

这些修复不要求已有 Plugin 改包，也不改变关闭全部选项时的普通聊天路径。

## 已完成的验证

- 两位独立代码检视通过，范围包括用量通知、原身份、超时清理、通知接纳，以及仅保留保护和无组件时的宿主路径。
- 聚焦回归 65 项通过；随后补充附件及无组件发布期间竞态后，相关 37 项通过。两组有重叠，不相加冒充独立总数。
- 真实 Electron 用量及兼容场景 9 项、输入编辑 10 项、连续任务 8 项通过。包括四种开关组合、原生子任务、真实 HTTP 系统提示和页面回答过滤，以及删除全部组件后的实际聊天。
- 最终两次实际插件通知的处理函数分别用时 68 和 70 毫秒，包括状态保存和界面更新；不包括模型、用量读取及整体图任务耗时。无订阅时的零查询由宿主测试验证。
- 最终受控广域回归 350 个文件、2939 项通过。覆盖 Mods、共享契约、界面库、相关浏览器性能及实际任务收尾测试；明确排除先前已有失败的 `theme-surface-policy.test.ts`，不是全工程所有测试通过的声明。
- 首轮广域发现保护层将原生 `null` 结束值误转为空对象，已修复为原值发布，补空帧和终值回归，相关 75 项及第二轮广域全部通过。
- 新增文件代码检查、Node 和网页类型检查通过。最终代码的 Electron 用量与保护 9 项再次通过；输入编辑 10 项、连续任务 8 项在相邻生产代码变更后已通过。

证据：`output/mods-policy-fallback-narrow.log`、`output/mods-policy-complete-narrow.log`、`output/mods-measure-electron-complete-protection.log`、`output/mods-validation/e2e-session-measure/result.json`、`session-measure-performance.json`。真实右侧界面截图在同一目录的 `session-measure.png`。

最终证据：`output/mods-measure-controlled-broad-confirmed.log`、`output/mods-measure-null-result-regression.log`、`output/mods-measure-electron-final-confirmed.log`、`output/mods-measure-final-gates-typecheck.log`、`output/mods-measure-final-lint.log`、`output/mods-measure-null-final-lint.log`。通知权限的宿主版本为 `module-resources-v72`，旧批准需按现有批准流程更新。

## 下一步

继续配置的列出、显示说明和修改能力，使原来的配置习惯能迁移到 DevClaw。再推进会话结束、消息写入及其余可适配能力。不存在同名 Claude 设置并不等于框架无法实现；应接到 DevClaw 的真实设置并明确范围，不能用无效果接口冒充对齐。

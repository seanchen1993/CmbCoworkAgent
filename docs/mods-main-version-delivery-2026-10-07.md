# DIY Claw 主版本说明

更新：2026 年 10 月 9 日。当前候选版本 **1.5.9**，供面客演示和小范围试用，尚未正式稳定签收。
这一版优先完成上传组件、自己组合助手、选择模型和步骤、在对话中运行并查看反馈的主流程。
新包的主要界面流程和模型规则已有实际通过记录；完整工程首轮有一项子进程执行超时，
原文件补验与九组原有独立回归已通过，尚未正式稳定签收。

代码只在 `C:/ai/CmbCoworkAgent-mods-v2` 的开发分支 `codex/mods-v2`。
持续将最新 UAT 合入开发分支，不把开发代码反向合入 UAT 或其他分支。
声音、插件主动建立新服务连接等附加能力继续后移。

## 获取和启动

下载 [Windows 安装包 1.5.9](../output/stage43-main-release-win-native-20261008/CMBDevClaw%20Setup%201.5.9.exe)，
旁边附有[简短使用说明](../output/stage43-main-release-win-native-20261008/使用说明.txt)、
[文件摘要](../output/stage43-main-release-win-native-20261008/SHA256SUMS.txt)和三份 DIY 示例。
也可保留完整 `win-unpacked` 目录，直接启动其中的 `CMBDevClaw.exe`。

先配置自己可用的模型连接，打开普通本地会话，选择实际项目目录和原聊天模型。
模型用量与费用按所用模型服务计算。安装包已生成，不等于已经在客户机器完成安装、
启动和卸载验收；本轮体验以 1.5.9 为准，旧版本保留用于问题复核。

## 从上传组件到实际使用

1. 打开「自定义设置 → Function Mods」，分别上传组件 ZIP，核对用途、版本和请求权限，再授权。
2. 在「DIY 流程」安排实现、检视、测试或修复步骤；Agent 步骤可以分别选择已有模型。
   在「我的 Claw」把不同插件的组件放到同一组合，选择组合默认模型及已保存的流程版本。
3. 保存流程和能力组合，再选择「应用到当前对话」，核对预览并「确认应用」。
   **保存和确认应用都不会自动发送任务或运行流程。**
4. 回到对话右侧「Claw 工作台」，确认当前采用的组合。在 Function Mods 开启应用和当前项目开关。
5. 普通聊天直接输入任务；要运行整条步骤，在输入框选择「执行流程」及所用流程，再输入本次目标并发送。
6. 在「Claw 工作台」和「运行与历史」查看本次执行记录、结果、错误及人工确认。
   插件命令的回复在「插件与结果」中查看。

旧 Plugin 项目模式保留原入口。作者明确声明的组件可以独立选择；没有这种声明的旧插件按整包选择。
不用上传插件也能先体验内置流程：选择「Autobiz · 只检视」，填写目标、保存并运行。
例如：「检视当前分支的本次修改，列出具体问题及文件位置，保持文件原样。」
操作细节见[上手说明](mods-diy-claw-quickstart.md)。

![1.5.9 实际界面完成跨插件组合，原面板按钮仍可操作](../output/mods-v2-validation/stage43-first-use-ui-new159/05-cross-plugin.png)

## 模型、保存版本和开关的含义

组合可以指定普通任务的默认模型；执行流程时，Agent 步骤按各自保存的模型设置运行。
输入框分别说明「当前组合模型」或「模型按步骤设置」。
「原聊天模型与智能路由」用于设置原聊天规则；修改组合模型需要编辑组合、保存并重新确认应用。

只保存模板，不会替换当前对话已经应用的副本。例如模板改为 C 但未确认应用，当前对话仍使用 B。
流程修改后，也要重新选择版本、保存组合并确认应用，当前对话才采用新版。

关闭项目或应用的 Mods 开关，会暂停组合的影响；重新开启后，已应用的组合重新生效。
手动选模时，关闭 Mods 或选择「恢复原配置」并确认，会回到原聊天模型设置。
智能路由保留原开关：开启时会按任务选择模型，候选模型也可能与组合实际使用的模型不同，
不能把候选名称当成本次已经调用的模型。

1.5.9 进一步保护后来的手动选模：旧任务稍后返回的模型信息，不能覆盖你已经做出的新选择。
这项保护不负责取消原任务；原任务的结果仍按原有规则显示，下一次任务采用新的模型选择。

![1.5.9 从聊天启动已应用的流程副本](../output/mods-v2-validation/stage43-first-use-ui-new159/09-chat-flow-start.png)

## 用随包示例体验组合

[DIY 示例说明](../output/stage43-main-release-win-native-20261008/DIY示例/使用说明.txt)附完整 ZIP、
对应源码和[包摘要清单](../output/stage43-main-release-win-native-20261008/DIY示例/packages.json)。
三个 ZIP 与上一候选包字节一致，分别上传，不要把整个目录当成一个包。

| 示例包 | 可以看到的变化 |
| --- | --- |
| [看板包](../output/stage43-main-release-win-native-20261008/DIY示例/mods-composition-board.zip) | 保存并应用后，在普通聊天输入 `/claw-board`，从命令列表选择并发送，打开面板并操作按钮。 |
| [样式包](../output/stage43-main-release-win-native-20261008/DIY示例/mods-composition-style.zip) | 加入同一组合后，文字和按钮样式改变；移除后恢复原面板。 |
| [检视与汇报组件包](../output/stage43-main-release-win-native-20261008/DIY示例/component-review-kit.zip) | 独立选择检视、汇报及依赖，设置检视重点和默认模型。 |

先只选「代码检视＋示例说明」，保存并应用，在普通聊天输入：

    /component-review function first(xs) { return xs[0].name }

加入「汇报整理」并重新保存应用后，`/component-report` 才会出现。
也可把检视和汇报放进流程：检视返回的完整 `{text}` 对象传给汇报，随后按需要加入人工确认。
这些示例处理给定文本，没有检视真实仓库或运行项目测试；看板计数也只是当前实例的演示值。
步骤「通过」表示该步骤执行成功，项目测试是否通过应查看本次实际测试回执。

![1.5.9 的执行结果和人工确认完成后仍可查看](../output/mods-v2-validation/stage43-first-use-ui-new159/11-flow-complete.png)

以上截图来自当前 1.5.9 的真实界面。模型连接和测试会话由验收初始化，
组件上传、授权、组合、编辑流程及执行均走公开界面；模型使用本地控制回复，
用于核对调用和数据传递，不代表客户模型的检视质量。

## 1.5.9 当前验证状态

| 范围 | 当前记录 |
| --- | --- |
| 首次使用主流程 | [12 个界面步骤通过](../output/mods-v2-validation/stage43-first-use-ui-new159/report.json)，附 12 张截图；3 次实际模型请求依次为 A、B、B。保存不运行，检视输出完整传给汇报，人工确认及刷新不重放均已检查。 |
| 模型和组合规则 | [8 项通过](../output/mods-v2-validation/stage43-model-package-new159/report.json)：项目／应用开关、未应用模板、移除后原模型、智能路由候选与实际请求、固定 A／B 流程步骤均按原断言验证。 |
| 迟到模型结果保护 | [2 个目标通过](../output/mods-v2-validation/stage43-model-intent-package-new159-first/report.json)，先完成 5 个正向检查。旧任务实际从 B 失败切换到 D，随后任务仍使用用户新选的 A；真实请求为 B 返回 404、D 成功、A 成功。此包内场景未应用 Claw，不冒称它覆盖所有关闭 Claw 的时序。 |
| 旧 Plugin 与项目入口 | [9 项通过](../output/mods-v2-validation/stage43-legacy-new159/result.json)，包括传统目录、开关、真实适配器参数、项目／特性、产物读取、重启，以及真实宿主准备、等待人工确认后取消；没有代验批准后的业务完成、外部服务或真实客户模型。 |
| 原聊天执行链路 | [Mods 关闭](../output/mods-v2-validation/stage43-harness-off-new159/1791475258476/result.json)和[开启但未装模组](../output/mods-v2-validation/stage43-harness-on-new159/1791475521283/result.json)均实际退出 0，覆盖普通工具、Goal、评估、注入错误、取消、续聊、刷新和重启。旧脚本没有证明所有进程完全闭合。 |
| 完整工程回归 | [首轮记录](../output/stage43-full-npm-test-exit.json)：10,525 项通过、1 项失败、9 项跳过。唯一失败是子进程超过原 4.5 秒执行时限；按原断言和预算[重跑整个文件](../output/stage43-origin-original-single-once-exit.json)，24 项全部通过。[九组原有独立回归](../output/stage43-independent-groups.json)退出码均为 0；首轮失败保留，不能称完整 `npm test` 全绿。 |

每套检查使用独立配置与会话，不把它们合称一条连续流程，也不累加成新增能力。
[本轮功能汇总](../output/stage43-main-package-functional-verification.json)已生成，分别记录各组来源、退出码和边界。
本轮通过记录不替代客户安装、企业登录、线上 IM、客户模型质量或真实业务验收。

## 历史记录和仍需收口的事项

1.5.7 的[79 个检查标签及补验](../output/mods-v2-validation/stage39-main-package-combined-20261008/verification.json)、
原 10 项故障恢复和空记录读取结果均保留为历史证据，不转记为 1.5.9 全链通过。
此前 Autobiz 使用固定版本的私有源码副本和指定原 Python 测试完成
[失败、有限修复及复测](../output/stage40-main-autobiz-package-verification.json)；
这不是本轮对客户业务或完整 Autobiz 项目的验收。`C:/ai/autobiz_kanban` 是真实业务仓库，不是内置示例。

1.5.8 的[分项回检](../output/stage42-main-package-functional-verification.json)保留。
同一个旧包的[迟到模型真实失败](../output/mods-v2-validation/stage43-model-intent-package-old158-first/report.json)也保留：
正向检查完成后，旧任务的 D 覆盖了用户新选的 A，下一次请求实际仍用了 D。
本次没有把旧包失败记录改成通过。

历史[完整工程首轮](../output/stage42-full-npm-test-exit.json)的 29 个失败文件、103 个失败用例及
3 个未处理错误未被抹去；1.5.7 的首轮失败及后续专项也各自保留。
旧结果与单文件补跑不能替代当前源码首次完整回归的结论，处理范围见[回归复核方案](mods-main-regression-triage-2026-10-08.md)。
旧 Git 目录占用及历史波动仍未确认根因；历史共享任务约 39 秒仍超过 30 秒目标，不能据局部测量宣称整体提速。

旧 1.5.3 强制界面崩溃测试曾出现主进程原生异常，之后恢复检查通过也未定位根因；
详情见[稳定性补验记录](mods-main-stability-followup-2026-10-08.md)。本次不宣称已解决这个原生问题。

主要适用普通本地会话。安装包未捆绑 Claude Code，涉及其终端适配时需要已有 CLI。
[Chrome 扩展 ZIP](../output/stage43-main-release-win-native-20261008/Chrome扩展/chrome-extension.zip)
及[摘要](../output/stage43-main-release-win-native-20261008/Chrome扩展/SHA256SUMS.txt)随包提供；
真实 Chrome 的安装、授权及登录状态导入尚未验收。
本轮使用离线登录，未验证企业 SSO；也未在客户机器完成安装和卸载。

当前主要能力已可演示和小范围试用。后续稳定性工作包括定位子进程超时、隔离安装与真实业务试用，声音和主动服务连接继续后移。
具体状态见[主版本验收计划](mods-main-release-plan-2026-10-07.md)和[继续迭代清单](mods-remaining-capabilities-2026-10-07.md)。

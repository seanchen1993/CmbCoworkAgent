# 启动时独立分析：已实现效果与验收

工作位置为 `C:/ai/CmbCoworkAgent-mods-v2`，开发分支 `codex/mods-v2`，没有改 UAT、提交或发布。参考已核对的 Claude Code 2.1.288。本阶段实现经两位独立静态评审通过；整体对齐仍继续。

## 用户得到的变化

作者可以在组件首次启动时调用模型分析，然后把分析结果供自己的命令或后续规则使用。模型看到当前组合中所有组件的实际规则和本次参数；明确重载后重新分析，新旧组合不会混用。以前这条链可能等待自己的启动结束而卡住，现在有专门的宿主入口。

原使用习惯保持：导入组件、核对并批准代码、选择组合、照常聊天。组件声明的参数在“自定义 → Function Mods → 插件参数”填写。普通保存不偷偷调用模型；需要启动分析的组件在用户明确点击“重新加载当前组合”后才分析新参数。失败显示组合停止，修正后明确重试，不后台重复花费模型额度。

实际桌面示例由两个组件组成：一项提供共同规则，一项按用户选的分析风格启动分析。第一次请求包含两项规则和 `STYLE_warm`。保存 `formal` 时请求数仍为1；明确重载后第二次请求改用 `STYLE_formal`，没有旧风格。回到会话执行 `/startup-result`，实际结果为 `RESULT:formal`，不会为读取已有结果再调用模型。

作者使用普通 `session.start`、`$.model.complete/classify/fork` 和规则接口，不需要访问这条宿主入口。独立分析不能递归调用另一独立分析；启动期间普通重入明确拒绝。有可复制的实际对话才可 fork，没有历史返回真实的无内容可分析结果，不创造历史。

## 复核中修正的边界

专用入口只认本次实际启动、当前会话、实际独立模型请求和当前规则帧。输入内容不能伪造入口。权限、源码、保存版本和取消仍在模型请求前后以及处理链实际进入前复核；规则帧结束不能复活。作者捕获失效错误也不能继续写状态或接纳旧启动结果。后台资源沿原新鲜入口运行，不继承启动特殊待遇。

自动参数接纳保持只读，不允许借启动模型请求执行副作用。整次启动从引擎组装开始共用120秒上限；超时明确失败。单次模型请求保留原60秒上限，CPU片段、内存和原取消限制继续有效。这个有界启动适配尚不等于官方“等待 SDK 不消耗规则自身时间”，后者是正在继续的下一阶段。

## 实际验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 真 QuickJS、SQLite、生产模型与实际 HTTP 窄回归 | 5文件69项通过 | output/mods-startup-model-narrow-final.log |
| 实际 Electron 启动/多组件/保存/重载/聊天命令 | 5检查点通过 | output/mods-validation/e2e-startup-model/result.json |
| 实际 Electron 原配置/重载 | 14检查点通过 | output/mods-validation/e2e-config/result.json |
| 实际 Electron 连续任务 | 8检查点通过 | output/mods-validation/e2e-continuity/result.json |
| Node/Web 类型检查 | 通过 | output/mods-startup-model-types-delivery.log |
| 本阶段 lint | 0错误、1516存量风格警告 | output/mods-startup-model-lint.json |
| 受控广域 | 360文件、3074项通过 | output/mods-startup-controlled-broad.log；scope.txt列出实际文件 |

实际 Electron 最终日志为 output/mods-startup-model-electron-qualified.log；请求证据为 e2e-startup-model/startup-model-evidence.json；截图为 startup-model-reloaded.png。最终已恢复普通构建，测试入口不进入安装包。早期桌面测试发现示例误把函数当数据匹配器，修正为官方的数据匹配器后实际聊天结果通过，不把早期失败说成通过。

静态评审没有替代运行测试。受控广域也不等于全部 npm test；原全工程已知测试和 lint 债务未在此阶段冒称解决。

## 性能与下一阶段

最终窄测4次实际启动/重载，128个源码文件约1.83MiB，中位7335.51ms、最大7813.35ms，包含完整源码复核、真实模型 HTTP 和明确重载，不含界面绘制。原始样本在 output/mods-startup-model-performance.json。完整复核有实际成本，不能将这个数字当所有机器保证；后续优化须保持异步边界后的源码、权限和保存版本检查。

宿主版本为 module-resources-v77。现在继续 [处理规则等待计量](mods-hook-wait-budget-design-2026-10-04.md)，随后接流式累计、退出生命周期及更多消息能力。当前没有新的框架限制证据，不在本阶段结束整体目标。

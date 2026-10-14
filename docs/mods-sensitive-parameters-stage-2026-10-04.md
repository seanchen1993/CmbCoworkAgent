# 敏感参数：已完成的效果与验证

工作位置：`C:/ai/CmbCoworkAgent-mods-v2`，`codex/mods-v2`。参考目标为已核对的 Claude Code 2.1.288；没有改 UAT，没有提交或发布。方案见 [设计](mods-sensitive-parameters-design-2026-10-04.md)。整体对齐仍进行中，本阶段完成后继续下一阶段。

## 用户现在怎样使用

进入“自定义 → Function Mods”，找到插件并展开“插件参数”。作者声明为敏感的字段只显示“已安全保存”“使用作者默认值”或“尚未填写”。填入新值并保存后，输入会清空；不重新填写就不能误点保存覆盖原值。“清除已保存值”删除自己填写的覆盖值，恢复作者默认；必填且没有默认值的项目需要重新填写才能启动新实例。

保存的数据属于当前项目和这个插件，不进入 Claw 模板。模板继续保存组件选择；应用组合后照常对话，参数通过插件自己的 register options 生效。旧代码无需为新参数重新批准；插件升级代码仍须单独批准。运行中保存的参数依照原安全应用规则处理，旧运行值不会被中途偷换；需要启动操作的组件使用明确重载。

字符串、数字、布尔、列表及文件/目录路径均支持敏感声明。列表逐项保存，逗号和换行保留原文；false、0、[] 都是实际填写的值。敏感路径只手填，不开启选择器或读取文件。普通参数、普通 config Hook 和旧 scalar 列表加载方式继续保留。

## 保存与使用边界

秘密以系统加密后的逐字段内容保存，与普通参数共用一次原子保存和版本检查。秘密不回填表单，不进入普通 config.list/set、保存回执、配置通知或宿主诊断。只有已批准的对应代码接收自己的值。安装检查也会执行注册代码，因此尚未批准的新版本不能借安装检查读取旧秘密；页面明确提示先核对并批准代码。

系统安全保存不可用时，敏感操作明确拒绝，普通参数仍可编辑并保留其他有效密文。损坏字段可以明确清除；损坏整个记录严格拒绝覆盖，错误不带旧记录文本。升级时，下一次明确保存会原子清理已删除或已普通化字段的旧密文，保留当前仍有效的其他秘密，不因旧版64项占满而无法继续使用。

Windows 使用本机实际 Electron 的系统保护。它保护其他系统用户，不能承诺隔离同一系统用户的所有其他程序。Linux 的 basic_text 或未知后端不被当作安全保存。[系统隔离范围依据](https://www.electronjs.org/docs/latest/api/safe-storage)。作者默认值来自包源码，本来可由查看源码获知；已获授权的作者代码主动输出自己的秘密是作者行为，不能冒称任意恶意代码绝对不泄漏。

关闭表单丢弃秘密草稿，重新打开不能把空白当成新值。成功旧回执只清理对应未再编辑的输入，保留最新页面版本；晚到回执不清新输入，也不切回旧项目。原生参数区从桌面选择中排除，跨过参数区的整段选区拒绝；可见、hidden、inert 和关闭区均已验证。这个修正防止原生配置区被当成可交给模组的聊天正文，不根据遮蔽后的显示文字猜隐私边界。

## 独立评审

两位独立 agent 已分别通过设计评审与最终静态复审。实际修复并补回归的发现包括：

- 未批准的新注册代码可以收到旧秘密：增加解封前后精确代码批准与 epoch 检查。
- 清空草稿后仍留已编辑标记：同步基线，保留有意填成空或[]的草稿。
- 较新版本早于旧成功回执：单字段清空成功草稿，页面版本不倒退。
- 旧64项密文占满但无法清理：只在明确保存时原子清理失效字段。
- 损坏旧明文 JSON 可能带出诊断片段：统一固定错误码。
- 跨原生参数区的 Range 原来仍能进入桌面正文采集：真实反例先失败，再补整段拒绝和隐藏区变体。

评审未运行测试；以下运行证据由主任务实际执行，不能把静态 PASS 当作全工程通过。

## 实际验证证据

| 范围 | 结果 | 记录 |
| --- | --- | --- |
| 受控广域 | 357文件、3049项通过 | output/mods-sensitive-controlled-broad.log；scope.txt列出实际文件 |
| 针对性首次边界 | 7文件、66项通过 | output/mods-sensitive-boundaries.log |
| 最终来源/重授和 IPC | 见最终窄测日志 | output/mods-sensitive-closed-narrow.log |
| 真实 React 参数表单 | 20场景通过 | output/mods-sensitive-browser-final.log |
| 原桌面选择/面板浏览器 | 21场景通过 | output/mods-sensitive-desktop-selection-final.log |
| 原交互与兼容检查 | 通过 | output/mods-sensitive-review-browser.log |
| 实际 Electron 敏感保存 | 10检查点通过 | output/mods-sensitive-electron-final.log；output/mods-validation/e2e-sensitive-config/result.json |
| 实际 Electron 原配置/重载 | 14检查点通过 | 同上；e2e-config/result.json |
| 实际 Electron 连续任务 | 8检查点通过 | output/mods-sensitive-electron.log；e2e-continuity/result.json |
| 实际 Electron 桌面交互 | 9检查点通过 | output/mods-sensitive-electron-final.log；e2e-desktop-actions/result.json |
| Node/Web 类型 | 通过 | output/mods-sensitive-types-final.log |
| 本阶段 lint | 0错误、1025警告 | output/mods-sensitive-lint-final.log/json |

受控广域复用上一阶段明确范围并加入敏感测试，不等于全部 npm test。已知存量失败与旧 lint 债务未冒称解决。最后真实 Electron 运行结束已恢复普通构建，测试入口不进入安装包。截图：output/mods-validation/e2e-sensitive-config/sensitive-configuration-saved.png 和 output/mods-config-browser/sensitive-parameter-form.png。

实际 Electron 覆盖真实系统加解密、严格生产 IPC、实际 React 保存、SQLite、utility guest、自身/另一插件隔离、重载恢复、清除默认及必填清除阻止新实例。原控制数据库及 WAL 检查固定测试值，不读取用户秘密。真实 Windows 系统保存已验证；macOS/Linux系统后端只完成逻辑和拒绝回归，不冒称已在其系统实测。

## 性能与继续项

最终8次系统密文保存的中位67.7ms、95分位75ms，含原生 IPC、源码检查、系统加解密、SQLite保存和安全视图；不含模型和绘制。原始样本见 output/mods-validation/e2e-sensitive-config/sensitive-save-performance.json。不是规模上限或所有机器保证。此前源码复用降低大量参数保存开销的优化继续保留。

host revision 为 module-resources-v76，扩展宿主能力后旧批准需按新摘要重新核对。现在继续 [启动时独立分析方案](mods-startup-model-design-2026-10-04.md)，随后核对会话结束及更多输入链。系统剪贴板正向授权和原生文件选择器正向点击仍按前阶段的未验证事实保留；这些未验证项目前没有被判定为框架限制。整体目标仍未完成。

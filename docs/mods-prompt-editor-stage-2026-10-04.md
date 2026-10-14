# 输入规则与下一步建议：已完成的效果

本阶段完成，整体对齐仍继续。两位独立代码复审通过，广域回归 242 个文件、2253 项通过，真实 Electron 输入与旧对话连续回检 18 项通过。

## 用户现在怎么用

仍在原来的聊天输入框输入和发送。装入提供输入规则的组件后，它可以整理文字、标记文字或拒绝某次输入。输入法结束后才检查整段文字。快速输入时，新字不会偷偷把尚未检查的旧字变成已通过；发送前会检查最新版本。

提供下一步建议的组件可以在任务空闲、输入框为空时显示灰色建议。按 Tab 或 → 接受，接受后仍检查输入规则，确认后自己发送。它不会替你自动发送。默认不会额外请求模型生成建议，需要组件显式提供内容。

可实际拆选的例子：`examples/mods-input-kit/README.md`。只选“下一步建议”，`/input-next` 出现小写建议；再加入“输入整理”，接受同一建议后变为大写并有标记。移除建议组件会真正取消命令注册，输入整理仍保留。这与流程中选择步骤互补，不要求为了改输入去新建流程。

## 作者与旧功能的边界

- 官方事件名 `prompt.edit`、`prompt.suggest` 保留。输入事件只提供文字、光标、实际替换范围和真实按键；附件、技能及审批私有信息不进入它。
- 编辑准备使用独立短期只读身份，不替换正在运行的主助手，不因键盘输入取得文件写入或工具执行权。
- `$.prompt.suggest` 使用实际插件名称，必须得到真实输入框的回执。等待时输入又删除、切会话、撤权或替换任务绑定，旧建议也不能重新出现。
- 输入规则内需要改本次文字，请调用 `next` 调整编辑或返回最终文本。当前有未确认编辑时，SDK append/insert 立即返回未填入；不等待自己，不把未校验文字提升为基线。作者可在编辑完成后显式重新填入。
- 普通发送、忙时队列、Goal、Flow、传统 Plugin、项目模式和 Harness 仍使用原有路由。等待编辑完成后会重取当前附件、技能和任务状态；状态已改变则保留输入，不能把旧快照发送或清掉新草稿。
- 新能力进入批准摘要，宿主为 `module-resources-v70`。已有 Function Mods 需按界面重新批准，传统 Plugin 的启用规则不变。

这是桌面适配，不是终端绘制和 Claude 全功能已对齐的声明。文字装饰按完整字符边界显示，启用装饰时用等宽字体；复制、选择、面板状态等继续下一阶段。

## 可复核证据

- `output/mods-prompt-editor-broad-final.log`：242 文件、2253 项通过。
- `output/mods-prompt-editor-boundary-verified.log`：97 项通过，覆盖真实 Session/QuickJS、短期身份、取消、启动失败与物理执行权替换。
- `output/mods-prompt-editor-admission-final.log`：56 项通过，包含建议私有版本与能力声明。
- `output/mods-prompt-editor-electron-reentry-final.log`：18 项真实 Electron 通过；首次模型执行前的冷命令建议、真实编辑 Hook 内 SDK append 立即拒绝、多插件改写、provider 与 SQLite 历史、拒绝编辑零请求、建议接受不发送、原忙时队列与关闭恢复均通过。验收结束后正常构建已恢复。
- `output/mods-prompt-edit-browser-all-edges-final.log`：实际 React/DOM 的快速输入、输入法、选区、重复字符、Backspace、Shift+Enter、追加冲突、继续任务保留、弹窗旧建议、装饰偏移和撤权通过。早期失败日志保留；其中两次是测试读取了前一次相同内容的请求、或把会改变选区的按键当作无状态操作，已按实际行为修正，未放宽运行时判断。
- `output/mods-prompt-editor-example-passed.log`：实际编译和 QuickJS 证明两个示例组件可以独立选择，未选的命令没有注册。
- 类型检查通过，见 `output/mods-prompt-editor-typecheck-closed.log`；涉及生产文件 lint 无错误，保留既有格式警告，见 `output/mods-prompt-editor-lint-verified.log`。
- `output/mods-prompt-editor-performance.json`：本地 1.6 万字符、256 个装饰的边界处理中位 4.44 ms、95 分位 5.15 ms；累计输入整理中位 0.12 ms、95 分位 0.75 ms。不含网络、IPC、磁盘及实际模型耗时。

下一阶段设计见 `mods-desktop-actions-design-2026-10-04.md`，继续复制、最近选中内容及实际面板状态。完整目标见 `mods-continuous-alignment-plan-2026-10-03.md`。

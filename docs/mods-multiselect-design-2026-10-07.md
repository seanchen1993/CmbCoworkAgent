# 组件一次询问多个选择

工作目录 `C:/ai/CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
两位独立方案及源码评审通过；下面说明本阶段实现合同与尚待验证范围。

## 用户得到什么

组件询问“要进行检视、测试、汇报哪些步骤”时，用户可一次勾选多个选项，
点击提交后继续任务。普通单选题保持现有操作。自由文字、跳过、取消和原审批继续保留。
固定 Claude 2.1.290 `AskOptions` 声明允许 `multiSelect`，答复为用逗号连接的文字。
DevClaw 使用桌面勾选控件和原提问链路，无需复制终端界面或内部状态。

## 原链路及最小改动

当前 `ui-ask.ts` 拒绝所有 multiSelect，原共享 schema 和 UserInputQuestion 没有此字段，
原对话框仅有 radio。沿同一提问工具和等待状态接通，不另加 IPC、提问队列或授权层。

1. 原共享 question schema 和 Main 类型增加可选 boolean `multiSelect`。
   缺省或 false 仍为原单选；ui.ask 接受 true/false，其它类型仍拒绝。
2. 新答复使用明确的 `type: "options"`、questionId、optionIndices、labels、descriptions。
   不把多选伪装成第一个单选，不改变旧 option/other 的含义。
3. Main 在清除 pending 之前验证新 options 答复：它必须对应原问题且原问题允许多选，
   序号为非空、唯一、有界整数。实际文字由原问题选项生成，忽略来报 labels/descriptions，
   按原选项顺序归一化。非法答复返回 false，原等待仍保留，不能消耗这次提问。
   不借本阶段重写所有原单选校验；原 ignored 和超时行为保留。
4. 对话框为多选提供 checkbox 角色、清楚的“可多选”提示，勾选不自动跳下一题，
   允许取消某项；至少选择一项后可提交。单选原自动下一题及补充说明不变。
   多选不展示单项补充说明按钮，自由文字仍是单独答复。
5. AskUserQuestion 展示改写固定原 multiSelect 事实，不能把单选呈现成多选或反过来。
   ui.ask 接收归一化的选项文字并 `join(", ")`，历史导航能显示完整多选答复。
6. 原 IM 答题文本支持多选题的 `/回答 <短码> 1,2` 或中文逗号，重复及越界编号拒绝。
   单个编号兼容原操作；单选仍拒绝多个编号。卡片若原平台只支持单值，提供原文本
   兜底并明确提示编号组合，不能让单值卡片冒充多选。已答标签和汇总显示完整答复。

源码叶片为 `src/shared/user-input-schema.ts`、`src/main/types.ts`、
`src/main/services/user-input.ts`、`src/main/mods/v2/ui-ask.ts`、
`src/shared/mods/v2/sites.ts`、`src/main/services/im/remote-user-input-service.ts`、
`src/renderer/src/components/chat/UserInputRequestDialog.tsx` 和 `ChatScrollNavigator.tsx`。
若 IM 平台卡片必须增字段，先检查原卡片实际能力，不伪造兼容。
本阶段不修改 Session/Manager/公共事件目录，与声音和 MCP 作者分开。

## 评审和验证

两位独立方案评审通过后由 Root 单独实现。补 ui.ask validator/answer、展示固定事实、
Main 无效多选不能消耗等待、IM 多编号与原单选回归。源码冻结后两位独立检视。
复用原 `mods-ui-ask-e2e.ts` 和 ui-ask focus，保留原全部场景，追加实际勾选两项、
取消一项再选回、零选择禁提交、自由文字及取消场景，截图实际控件及答复。
不得只提交构造的答案绕过界面。核对无额外模型请求、原审批/经典拒绝/全局关闭仍有效。
随后主进程与界面类型检查、限定 lint，并回归原 IM 答题脚本。

## 当前实际证据

8 个生产文件和 4 个测试文件已接线并由两位独立评审检查。
7 项纯专项回归通过，记录为 `output/stage26-multiselect-narrow-current.log`。
覆盖多选及 false 单选参数、答复、展示模式不可翻转、稀疏或无效编号不能消耗等待、
原标签重建及旧单选补充说明。源码冻结后只微调了选项描述，使“互斥”只针对单选，
这项文字微调也经过两位独立复核。

IM 完整脚本已通过，保留原八项并追加真实多选与混合题场景，记录为
`output/stage26-multiselect-im-regression-current.log`。多选不尝试单值卡片，
错误编号保留短码，中文逗号答复按原选项归一化，前后单选和短码单次使用均保留。
限定 lint 为零错误；自己新增的历史导航格式警告已修正并单文件 lint 通过，
原服务文件未改动段落的格式警告未作无关整理。

主进程与界面类型检查均已通过，记录为
`output/stage27-main-release-type-node-fixed-current.log` 和
`output/stage27-main-release-type-web-fixed-current.log`。
真实桌面 ui-ask 回检 10 项通过，记录为
`output/stage27-main-release-dialogs-fixed-20261007/ui-ask/result.json`，包含原生提问、
多选勾选及取消、零选择限制、完整选项返回、自由回答、关闭与撤权取消、原生模型提问。
实际多选截图为该目录的 `ui-ask-multiple.png`。

首次桌面执行暴露了测试同步问题：窗口外壳先出现，实际正文仍在异步加载。
诊断记录保留在 `stage27-main-release-dialogs-diagnostic-20261007`。
经两位独立方案及源码审查，等待条件改为原预算内看到真实目标正文；原结果、审批、
模型请求数和取消断言全部保留。修正后 ui-ask 与连续输入回检均通过，且恢复普通构建，
不把测试专用入口带入交付。

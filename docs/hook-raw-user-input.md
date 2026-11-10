# Hook 读取用户原始输入

命令类型 Hook 可以通过环境变量 `RAW_USER_INPUT` 读取本轮用户输入。

```powershell
# PowerShell
$text = $env:RAW_USER_INPUT
```

```bash
# Bash
printf '%s' "$RAW_USER_INPUT"
```

```js
// Node.js
const text = process.env.RAW_USER_INPUT
```

`USER_PROMPT` 保持原有语义，可能包含技能说明、附件等程序生成的内容。
`RAW_USER_INPUT` 在聊天输入框提交时、trim 和附件解析及技能拼接之前采集，保留空白、
换行和用户自己输入的协议标签。单纯选择技能且没有键入文字时，它可以是空字符串。

该字段通过 IPC 进入本轮 Hook scope，供 `UserPromptSubmit` 以及使用该 scope
解析的其他 Hook 使用。排队草稿及其编辑、自动发送、运行中引导均传递此字段。
HTTP 直接请求、IM 普通消息、`/goal` 以及活动 Goal 下的用户消息也显式传递原始消息文字。

运行中引导的预处理 Hook 取得该条候选消息的原文，当前正在执行的回合仍保留已接受的
原文。候选消息被拒绝、取消或删除时不会修改运行中的原文；通过检查后，也要等消息
在模型边界实际注入且持久化成功，才更新运行 scope。一次注入多条消息时取最后一条
的原文；若最后一条没有原文字段，则清除旧值，避免误用前一条输入。

字段只用于传递原文，不作为授权凭据，也不会从模型请求里反向剥离标签来猜测原文。
没有该字段的旧草稿或旧调用入口不会回退到加工后的提示词；环境变量会缺省。
运行器会清除宿主进程继承的同名环境变量，避免缺省时读取到其他调用的旧值。
内部通知等没有新用户输入的回合不会新建原文。已有用户回合中使用同一 scope 的后续
Hook 可以继续取得该 scope 保存的用户输入；Worker 继承启动时的原文快照，
不会将自身包含协调标记的任务提示词当作用户原文。

本次没有新增聊天消息数据库字段或 Trace 上传字段。原始字段只随提交请求和现有排队
草稿传递。读取环境变量时，不应把“变量缺省”和“变量值为空字符串”混为一谈。

## 合并上游后的 HTTP 工作区约定

本分支同步最新 `uat-without-mods` 后，项目级 `sessionWorkspacePath` 已由上游移除。
项目创建和修改接口不再接受该字段。创建 Feature 时传入 `workspacePath`，服务端将其
转换为 Feature 级 `sessionWorkspace: { source: "directory", path }`；新建 Feature
会话默认使用当前 Feature 配置的工作区，缺少配置会报错，不再从历史会话猜测目录。

## 验证记录（2026-11-10）

- 合并前置检查：API、工作区和工具策略的 52 项回归通过，两个 IM standalone 套件通过。
- 功能检查：Hook 原文、scope 继承和并发隔离、标准回合、IPC 传输共 23 项通过；
  排队消息 standalone 的 18 项通过。
- `npm run typecheck` 通过；本次修改的 TypeScript 文件执行 ESLint，零错误。
- 全量 `npm test` 的 Vitest 阶段有 4921 项通过、108 项失败（27 个失败文件），
  因此未继续后续 standalone 阶段。失败涉及 shell、浏览器、导出和超时等；
  在独立工作区的开发前合并提交 `09892ca55` 上复跑，确认导出与 Harness 环境
  两组代表性失败也存在。其他全量失败未逐项完成基线归因。
- 全库 lint 未通过，报告 93 个错误及大量 CRLF 格式告警；未将这些跨模块问题
  作为本次 Hook 字段功能的修改范围。

## 检视问题修复验证（2026-11-10）

- 新增候选输入隔离测试，覆盖 Hook 拒绝、异常、失效、延后提交及空输入。
- 新增注入边界测试，覆盖 beforeModel / afterModel、持久化失败、删除、运行替换和
  批量注入末条输入的处理。
- IM Goal bridge 和默认 IM 执行入口均覆盖 `/goal` 与活动 Goal 下普通消息的原文
  传递，并确认内部通知不会携带用户原文。
- 相关 Vitest 32 项、消息队列 standalone 38 项以及两个 IM standalone 套件通过；
  类型检查和本次修改文件的 ESLint 错误检查通过。本轮未重复前次存在失败的全量检查。
- 消息队列源码契约检查已更新 middleware 调用形状，并将固定 5000 字符的截取改为
  按临界区结束标记截取，避免新增字段使断言落到截取范围之外。套件随后在未修改的
  transcript 实现上失败：旧断言仍查找 `appendThreadMessageTextDelta(threadId, messages[0])`。
  本轮没有修改该模块或将这一旧断言失败扩展为产品修复。

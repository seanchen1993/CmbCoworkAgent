# 第三方阶段调试 Mod 接入协议

本协议把阶段调试的发现、方案准备和结果观察开放给 Mod。原生阶段快照、输入保真、来源校验、权限批准、创建和运行继续由原主进程服务负责，不建立第二套流程引擎。

## 第三方能够调用的公共接口

通过 `$.platform.list()` 发现 `native.project-stage-debug/stages@1.0.0`。所有请求的 `target` 仅为 `{kind:"current"}`；工作区、物理会话、会话代际和调用插件身份由主进程绑定。

- `platform.read`：原生快照、候选和分支的数量及可用性摘要。
- `platform.act(...action:"inspect")`：按 `kind:"snapshots"|"drafts"|"branches"` 分页读取，每页最多八条。分支结果来自原服务的实际执行和检查记录，显式保留固定 `candidateDigest` 与 `currentCandidateMatches`。摘要不一致时只可称为对应分支的历史结果，不代表当前候选通过。
- `platform.act(...action:"prepare")`：提交快照标识、候选标识、候选版本与摘要、单阶段或后续重跑模式。原服务重新执行源码、知识、配置边界、校验契约与兼容性检查，返回只读方案和独立 opaque `planId`。
- `platform.act(...action:"review")`：仅提交同一调用插件、同一会话持有的 `planId`，重新校验来源并排送原生复核导航。返回 `requested/queued`；不表示界面已经打开、用户已批准或项目已经运行。

没有 `create/start/approve/advance` 公共动作，也没有接受任意工作区、源码目录、输出路径、宿主回调或检查结果的入口。方案和导航都明确 `executionGranted:false`。模型可以准备方案；实际创建与运行必须经过原生界面操作。

## 原生复核流程

原生跳转记录只保留五分钟，携带本次请求的插件名称、来源摘要与候选选择。界面必须从受信 IPC 回读，主进程重新核对真实创造会话、工作区、会话代际以及当前已授权的插件来源，不能沿用已经完成的 Mod 调用租约。

原生工作区核对实际候选版本、摘要和快照后，只预选参数并清除旧方案及勾选。用户仍需重新点击准备方案、阅读限制、勾选确认，再创建分支；执行阶段另行通过原项目入口确认。来源变化、插件停用、卸载、权限失效、代际变化、未知结果或进程重启均不能恢复旧授权。

此协议不把 `platform.act` 的成功回执当作业务通过。业务通过只能读取原服务的阶段执行记录与原检查凭据。订阅与实时推送尚未开放；示例采用显式刷新，避免把缓存状态称作当前事实。

## 插件侧实现

`examples/sparks-stage-debugger` 为独立插件：通过 `on.capability` 声明侧栏入口，通过 `$.ui.open/resolve` 创建自定义 Pane，再用表格和按钮选择快照、候选、准备方案和请求原生复核。Mod 不导入 Electron、不访问主进程缓存，不申请文件、进程、网络、工具、模型或 MCP 权限。

Mod 运行在原创造控制会话。隔离执行分支仍禁止加载 Mods；本接口不会为调试插件豁免执行策略。当前支持受准入检查的 Host 文件阶段。配置、知识和上下文须有冻结输入并重新绑定；脚本上下文提供器及非空 Hooks 还须声明匹配的 `devclaw.stage-recovery.json` 恢复策略，并经过新的原生确认。行为 SharedMods、MCP、公开动作、带写入副作用的检查及其他未适配依赖仍会阻断。不能删除原 Hook、改写上游依赖或移除检查来复用旧基线。插件自有状态使用另一套显式适配协议，见[插件拥有状态时如何恢复阶段](creator-plugin-workflow.md#插件拥有状态时如何恢复阶段)。

实现时，在真实 UI 按钮动作的 SDK 闭包内调用 `platform.act`；侧栏打开动作仅观察并打开界面。不要将 SDK 对象传入通用外部 helper，以免脱离现有静态来源与权限分析。示例的关键调用如下：

```ts
const ref = { provider: "native.project-stage-debug", id: "stages", version: "1.0.0" }
const response = await $.platform.act({
  ref,
  target: { kind: "current" },
  action: "inspect",
  input: { kind: "snapshots", offset: 0, limit: 8 },
  requestKey: "用户本次明确操作的唯一标识"
})
```

先判断原生动作是否成功，再读取返回值。准备成功只显示可审查方案；`review` 成功只表示导航意图已记录或派送。用户可在插件里改变布局、筛选和展示方式，也可以把这套入口组合进自己的控制面板，但不能据此赋予自身创建、批准或执行权限。

## 验收要求

新增 provider 与短时导航 hub 的边界回归，以及真实 `compileFunctionPlugin → QuickJS → FunctionSession → 自定义 Pane/Button → 原StageDebugSessions.prepare` 集成用例。集成必须使用真实阶段快照与检查记录，验证实际 Mod 动作完成且执行租约结束后，原生入口仍通过新的主进程事实核验回读意图，同时没有创建项目、修改原成果或继承执行授权。

本轮已在正常 Electron 构建中完成示例真实安装、精确来源批准、应用到原创作聊天、侧栏及 Pane 按钮、原生独立回读、唯一面板预选、用户再次准备与勾选创建的联合验收。SDK 准备和复核期间没有创建分支或调用模型；原生确认后，新分支没有继承旧操作、批准或检查结果。

该用例在新分支创建后结束，不声称第三方 Mod 已启动或执行分支。分支实际执行、新文件批准、原检查与冷启动限制由另一条正常应用原生用例验证。示例来源批准使用真实 Renderer API 的明确测试决策，未覆盖通用授权弹窗的 DOM 展示。完整验证状态与剩余范围见 [S6 实施说明](../mods-s6-stage-debug-2026-10-20.md)；不能据此推导任意 Hooks、外部副作用或完整生命周期已支持。

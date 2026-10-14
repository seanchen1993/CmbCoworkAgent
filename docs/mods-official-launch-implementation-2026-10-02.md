# 官方 Mods 发布后的实现与验收

后续 2.1.288、共享 task 与真实系统来源迭代见
[最新说明](mods-task-sources-delivery-2026-10-03.md)。本文保留 287 阶段的历史验收结果。

工作区 `C:\ai\CmbCoworkAgent-mods-v2`，开发分支 `codex/mods-v2`。
调研固定在 2026-10-02 的官方最新版本 2.1.287；2026-10-03 再查 npm latest 仍为 2.1.287。
跨日验收记录实际执行日期。
本报告的运行结果表在最终验证后更新，不能用代码或测试脚本的存在代替通过证据。

## 官方实现与方向判断

官方在 10 月 1 日正式发布 Mods，2.1.287 默认开启。它是 Plugin 内的函数模块：
模块注册 Hook，调用 next 包裹下游，或直接返回替换结果；模型、工具、提示词和界面都是
可接入的能力面。不是必须先画一张流程图，也不是每个旧插件都能自动拆成组件。
官方仍有可信来源顺序和 sec-default，不能把“可替换文本”理解成能删除真实权限控制。

参考：[发布公告](https://claude.com/blog/claude-code-mods)、
[官方 Reference](https://code.claude.com/docs/en/plugins/mods/reference)。
Windows 原版安装包 SRI、SHA256、2384 个模块、内嵌声明及探针见
[二进制审计](mods-latest-launch-binary-audit-2026-10-02.md)。没有修改全局 CLI 或用户原配置。
原版主探针在无旧环境 flag / 有 flag 两种情况下分别 24 项通过；独立 SDK 边界探针 1 项通过。
`$.prompt.section()` 在原版插件 SDK 上实际为 TypeError，不能照测试引擎声明错误开放。

因此需要调整：保留现有 Claw/Flow、权限与证据内核，补真实提示词组合和可信 builtin 管线。
Claw 是本工程降低组合使用成本的界面；Flow 是另外提供的任务编排功能。

## 现在新增的实际效果

| 能力 | 用户能感受到的效果 | 边界 |
| --- | --- | --- |
| prompt.compose | 已授权插件能在实际模型请求中增加、删除、改写或重排系统提示词段 | 不修改供应商凭据、工具 schema、执行权限 |
| prompt.section | 可以替换/删除宿主实际系统消息对应的一段 | 当前不是 Claude 每种 memory/output-style 内部 contributor 的同名拆分 |
| SDK compose | Hook 中读取并继续组合当前真实请求，跳过当前 frame，其他同插件 Hook 仍执行 | 没有活动请求或原请求已结束时明确拒绝；不同模型查询拒绝 |
| Claw 顺序 | 调整已选插件上下顺序，保存、预览、应用后改变 Hook 的包裹顺序 | 没有应用 Claw 的旧默认加载顺序保持原 id 排序 |
| 内置上下文计量 | 无上传插件也可启用本机内置模组；其他插件可替换/包装输入框上方的显示 | 默认关闭；无当前用量不假造；不表示所有内核功能已模块化 |

真实顺序为：宿主模型解析 → 工具描述 → 系统段/组合 Hook → 最终输入预算检查 → 模型发送。
最终提示词预览捕获该组合结果。非法 Hook 结果跳过当前 Hook；已经 next 的合法下游结果
只执行一次。逐 frame 内容保护在上游读取之前完成；未等待 next 也不能隐藏宿主严重错误。

## 用户操作

1. 在“Function Mods”开启应用与项目开关，再在支持的本地项目对话打开右侧“Claw 工作台”，
   进入“我的 Claw”。默认关闭，不会为存量用户自动激活。
2. 可以直接勾选“内置上下文计量”体验，无需上传插件。需要扩展时选择已上传且批准的插件，
   使用上移/下移调整能力顺序。
3. 保存组合，再“应用到当前对话”，核对差异后确认。保存本身不改变当前活动组合。
4. 回聊天发送普通任务。prompt.compose/section 会在模型请求时自动触发，无须手工执行
   一个 slash command。计量模组在真实会话用量可用后显示。
5. Flow 的“发送并执行流程”适用于一次明确的检视/测试/修复任务；完成规则适用于每次任务
   的宿主完成检查。这两种用途不能混成“运行保存版本就永久自动执行所有流程”。

Autobiz 的 ZIP、三预设、跨插件汇报和旧项目使用见
[逐步实操](mods-integrated-hands-on-2026-10-01.md)。

## 作者最小示例

```ts
export function register(on) {
  on("prompt.compose", async ($, facts, next) => {
    const current = await next(facts)
    return {
      sections: [
        ...current.sections,
        {
          id: "my-review:policy",
          text: "任务包含代码修改时，最终回答列出检视结果和实际执行的测试；没有测试证据要直说。",
          scope: "session"
        }
      ]
    }
  })
}
```

放进 Plugin 的 hooks 模块并安装、授权，再加入当前 Claw。这改变真正发给模型的提示词，
所以普通聊天就能触发；它本身不等于已经执行测试或强制检视。需要真实测试和失败拦截，
使用宿主 Flow 的原生检查与完成规则，不能把插件返回一句“PASS”当原生回执。

SDK `$.prompt.compose()` 返回直接 `{sections}`，不包 `{value}`，不发送模型或写草稿。
section 是事件 Hook，插件 SDK 不提供独立 `$.prompt.section()`。

本轮自动提示词组合接入普通对话与独立 Flow 子 Agent 的模型 transport 边界；共享线程
的 task/general-purpose 子 Agent 未宣称完成相同接线。插件显式
`$.model.complete/classify` 使用其独立 `model.*` Hook 与请求参数，不自动套用会话的
compose；`model.fork` 使用宿主捕获的有界会话快照，未增加新的 compose 调用。不能据此
声称所有独立模型 API 都重新执行完整提示词贡献管线。

新增 Autobiz HTTP 验收曾发现 Flow child 的 main-only gate 漏接，本轮已修复。每个真实
main/独立 child 在模型初始化、拉取与正常关闭时使用自己的 authority；失效后的关闭只允许原
provider 清理，保留拒绝 SDK 的关闭 scope，不借用父 Agent。子请求保持完整会话/
授权/配置/发布保护，但不额外触发主会话 turn.step Hook，也不覆盖主模型或提示词
预览。SDK 快照按真实 authority 对象隔离，父子、并行 child 与替换实例不能互借请求。

展示复测还发现 main 的 provider 拉取没有外层执行 scope，导致 SDK compose 的 policy
未进入 HTTP，且原 Skill 日志丢失。修复使用模型 transport 专用 fresh 入口，退出祖先
calls、modCallContext 和文件写入租约；其他 task/FS 入口未改变。新的 main scope 不继承
用户动作授权。保留 void ui.log 与所有原断言，实际展示六项已恢复通过；最终统一验收
结果在下表记录，不能用一次重试掩盖这个真实绑定问题。

## 与官方仍有的差异

本工程默认 facts 来自自己的实际请求：promptModel 等于实际模型，无 Claude 专用提示词
映射；surfaces 为 desktop；traits 为空，因为没有 Claude bare/lean/SDK/teammate 分支；
outputStyle 为本工程实际选中风格或 null，风格保留编码指令。改写其他 facts 不会虚构那些
官方分支，也不会改变真实 provider/tool 权限。共享段只保留排序语义，不承诺所有供应商
具备 Claude 的跨组织 prompt-cache 标记。

可信 builtin 当前只有 context-meter，旧 output-style 等机制保留。未实现所有原生功能的
模块替换、完整终端、多环境 MCP 隔离、prompt.submit/asUser、更广编辑/附件接口、远端/
定时 DIY、任意副作用恢复。普通项目指令没有被冒充为企业 managed 来源。QuickJS 与受限
宿主 API 是本工程适配；官方用户代码虽在隔离 JS 模块运行，宿主文件/进程访问边界不同。
逐项能力以[兼容矩阵](mods-v2-compatibility-matrix.json)为准，历史总数不是对齐百分比。

## 评审与运行证据

- [实施契约](mods-launch-adjustment-contract-2026-10-02.md)
- [独立文档/架构评审](mods-official-launch-review-2026-10-02.md)
- [独立原版/代码评审](mods-latest-launch-binary-audit-2026-10-02.md)

两位独立评审的最终代码评审均已通过：固定实际模型、空段也检查原租约、逐层保护、未等待
next 的严重错误传播、预算后预览、可信来源、旧顺序、缺用量/关闭/重载回收。代码评审通过
与全量测试通过分别记录。

截至 2026-10-03 的最终冻结回检：

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 新调整定向测试 | 20 文件、254 项全部通过，20.76 秒 | `output/mods-launch-final-unit.log` |
| Node/Web 类型检查 | 冻结后的 `npm run typecheck` 通过 | `output/mods-launch-final-freeze-typecheck.log` |
| 真实 Electron | 10 套、81 个检查全部通过 | `output/mods-launch-final-validation/final-selected-report.json` |
| 浏览器交互 | 5 套全部通过，包括窄屏、保存/应用、版本竞态 | 同上及各 browser 原始日志 |
| 性能专项 | 3 套全部通过 | 同上及各 performance 原始报告 |
| 最新全量 `npm test` | 713 文件；5,751 通过、12 失败、5 跳过；无未处理错误，未全绿 | `output/mods-launch-owner-npm-test.log` |
| 首次并发新增失败复核 | 15 文件、233 通过、2 跳过，无失败/未处理错误；原超时预算未变 | `output/mods-launch-failure-rerun.log` |
| Windows 清理与 owner 回归 | 2 文件、20 项通过；含 Windows 原断言 9 项、主/子请求 11 项 | `output/mods-launch-cleanup-regression.log` |
| provider 测试夹具 lint 修复 | 原 provider 协议 14 项通过；该文件 lint 通过 | `output/mods-launch-provider-fixture-regression.log` |
| 九条 standalone 回归链 | adoption/messages/hooks/plugins/task-cards/merge/workflow/desktop-agent-baseline/im-v1 全部通过 | `output/mods-launch-standalone/report.json` |
| 定向 lint | 原 13 文件及后续 3 个测试文件全部通过 | `output/mods-launch-final-scoped-lint.log`、cleanup/provider fixture lint 日志 |
| 全仓 lint | 首次 103 个 error；修复 3 个测试夹具错误后，全仓复核剩 100 个，与既有基线逐项匹配；未全绿 | `output/mods-launch-final-full-lint.json`、`output/mods-launch-full-lint-comparison.json` |
| 最终普通构建 | `npm run build` 通过；确认不存在 E2E 宿主入口 `out/main/mods-e2e.js` | `output/mods-launch-normal-build.log`、`output/mods-launch-final-commands.json` |

Electron 覆盖真实安装和授权、普通对话 provider 请求、子 Agent Flow、Autobiz 原测试和修复、
跨插件输入、旧 Plugin 项目/Feature、Skill/MCP、重启、撤权、取消、builtin UI 包装/替换与顺序。
其中提示词测试证明插件变换进入真实模型 HTTP 请求，并保持原工具 schema 和身份。
模型服务为本地受控 HTTP，验证真实执行协议，不能代替线上模型效果评估。

保留第一次失败的原始记录于 `output/mods-launch-final-validation/initial-failures/`：
内置 wrapper 需刷新当前真实请求而不能使用重载前的计量；旧项目导航使用 tab 的实际角色；
已运行父任务取消应记录 `unknown/MODS_CANCELLED` 而非宣称外部副作用已回滚；伪造 Harness
绑定在 renderer 写入阶段即被拒绝。修正测试后四项均实际重跑通过，未为这些问题放宽生产权限。

性能为本机 Node 22.23.2 的本地测量：64 KiB 提示词实际 QuickJS Hook 组合中位 6.218 ms；
128 个工具描述首次 97.865 ms、热缓存中位 1.103 ms；64 KiB Skill 十页读取只展开一次，
约 1.892 ms。Flow 64 步/256 次执行的平均本地处理约 1.273 ms。512 个 Skill 的真实来源
catalog 首次约 376.8 ms，完整 boundary 校验中位约 259.5 ms；同来源 Flow 只扫描一次，
64 步准备约 385.3 ms、单次有界校验中位 32.727 ms。前述组合数字不含模型/网络/
UI 渲染，Flow 内存存储数字不含 SQLite I/O，不能当作用户任务总耗时或保证所有机器时限。

### 全量回归的实际限制

第一次全量保持原 `npm test` 命令、默认 worker 配置与超时预算，耗时 247.80 秒：711 文件，
5,702 通过、41 失败、5 跳过，另有 2 个未处理错误。11 项
既有失败逐名复现：macOS JetBrains 5 项、缺少 Chrome 扩展资源 5 项、固定色主题策略
1 项。另有运行时回收、完成证据、worker 扫描、Git、历史迁移、trace 等测试在并发运行
超时或出现时间敏感错误，以及一个 worker 上报超时。不能把它们统称为通过。

随后抽取这 15 个新增失败文件，使用 `--maxWorkers=1`，没有修改 5 秒/30 秒等测试或
Hook 超时预算；233 项通过、2 项既有跳过，214.32 秒，无未处理错误。运行时 manager
54 项全部通过，回收循环与 source reload 的原断言均保留。完整首次与复核名单在
`output/mods-launch-full-failure-comparison.json`。这些证据表明新增失败在低并发复核中
未复现，支持资源竞争影响的判断；它不是默认并发全量绿色的证明，也不保证任意负载下
不存在时延问题。本轮没有改大时限、删断言。

主/子请求修复后的最新全量仍运行原 `npm test`，仅以环境变量限制为 2 个 worker，保留
原超时预算，耗时 621.12 秒。713 文件中 708 通过、5 失败；5,751 项通过、12 失败、
5 跳过，无未处理错误。上述 11 项既有失败仍复现；第 12 项为 Windows controller 测试
finally 删除临时 EXE 遇到 EBUSY。缺 bootstrap 的生产分支与 native 源码未改变；历史
`output/mods-flow-forms-npm-test.log` 也记录过同样清理失败。

经两位独立评审确认，测试清理增加 `maxRetries: 5, retryDelay: 100` 的有界重试，与
相邻测试一致，重试耗尽仍抛错。没有吞掉错误或放宽原退出码/空 stdout/缺 bootstrap/
shell 未启动的断言。实际复核该文件 9 项全部通过，另与主/子模型 11 项共同通过。
这闭合了清理问题的定向验证，不能把原全量的 12 个失败改记为 11 个，也不是又一次
完整 `npm test` 已全绿。最新原失败名单与复核结果见
`output/mods-launch-owner-full-comparison.json`。

因为 npm 链首段 Vitest 失败，后续九条 standalone 链未由该命令自动执行。2026-10-03
已按原脚本另行串行执行全部九条链，84 条原子命令全部成功，记录于
`output/mods-launch-standalone/report.json`。workflow 使用本机 Git Bash 原有执行入口；
worker 上限为 2，原测试超时预算不变。不能把这些单独执行写成 `npm test` 自动通过。
旧 Plugin/Harness 项目与 Feature 九项 Electron 回检通过，新的 Notification child scope
另有原命令/http 语义保留的回归。

全仓 `npm run lint` 首次报告 103 个 error、571,967 个 warning，多数 warning 是存量
CRLF/格式问题。三个 provider 测试夹具的空 `assertScope/assertLive` 改为 `vi.fn()`，
保留行为与原协议断言，14 项原测试及定向 lint 实际通过。随后重新运行全仓 error 规则
（`--quiet --format json` 仅省去 warning 输出）：100 个 error 与 2026-09-29 既有基线
按文件、规则、消息逐项匹配，新增为零。该复核不表示 warning 消失，也不能称全仓 lint
通过。比较记录 `output/mods-launch-full-lint-comparison.json`，冻结后的类型检查再次通过。

## 后续兼容优先级

1. 共享线程的 task/general-purpose 子 Agent：验证真正的独立 owner、模型与并行上下文，
   再把相同组合接入其模型边界。当前主对话/独立 Flow 已通过，不等于共享 task 已通过。
2. 本工程 memory、output-style、工具提醒等实际贡献者的稳定 section 身份，以及更多
   trusted builtin，逐项验证可替换范围；没有 contributor 不仿造 Claude 的同名片段。
3. complete/classify/fork 的 prompt 语义仍按独立 API 契约单独验证；不复用别的 Agent
   的快照或把“读取会话”误当自动重跑整套 contributor。

终端、多环境 MCP、远端/定时 DIY 与任意副作用恢复继续保持明确缺口，不为追求表面
百分比开启未受控宿主接口。核心体验的使用说明见上方用户操作和 Autobiz 实操文档。

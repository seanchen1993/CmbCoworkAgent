# Mods 2.1.288 对齐迭代：子任务模型与系统提示词来源

开发位置：`C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
UAT 未改动。本轮没有提交、合并或发布。最终验证记录、使用示例和剩余差距见下文。

## 本轮用户能感受到的变化

以前，普通对话和独立 Flow Agent 已走 Mods 展示链，共享线程的 `task` 子 Agent
还有遗漏。现在受支持的 general-purpose 和 registry task 的真实模型输入也经过
`prompt.compose`、`prompt.section` 和 `tool.describe`。一个已应用的 Claw 能同时作用于
主对话和这些子任务。registry 里指定的模型配置仍决定它实际使用的端点和预算。
两个配置即使有相同公开模型名，也不会因为名字相同而混用端点。

以前系统提示词主要以 `cmb:system:<消息位置>` 的整体段暴露。现在从实际生成处记录
稳定的来源名，例如 `cmb:agents`、`cmb:skills`、`cmb:memory`、`cmb:filesystem`。
插件可以单独调整一段，不必复制或按标题拆解整个系统提示词。空的受支持来源以
`text: null` 提供给 section Hook，插件可以填入自己的文本。

这扩大了组合的实际生效范围。删除一段提示词不删除工具或解除文件权限；写入
“必须检视代码”也不等于自动完成代码检视。需要强制步骤与验收时，仍使用已有 DIY
流程的 Agent、工具、条件和验收步骤。

## 与官方证据的关系

核验 [npm 最新发布元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 和
[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，固定研究包为
2.1.288。官方网页仍说明其表格截至 2.1.287，因此同时检查新版 Windows 原包的内嵌声明。

原包经过 SRI 校验，PE SHA256 为
`84304f7d4b0cd0ebcbe8318695a260151b48991a6659c3366fdd5da290c0ab91`。
提取 2393 个 Bun 模块；2164 个包含 bytecode，没有 sourcemap。这是内嵌资源提取和
局部可读实现分析，不是恢复全部原始 TypeScript。
原版两种启动条件的 24 项探针均通过；单独验证 SDK 没有 `$.prompt.section()`。
288 相对 287 的 prompt compose/section 契约未变，新增的 `$.ui.selection` 单独列为差距。
详细原版依据见 [288 审计](mods-claude-2.1.288-audit-2026-10-03.md)。

## 作者怎样使用

沿用插件安装与授权流程。可以从下面的三个文件开始：

```text
my-claw-policy/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts
```

`plugin.json`：

```json
{"name":"my-claw-policy","version":"1.0.0","description":"项目代码检视规则"}
```

`hooks.json`：

```json
{"modules":["./register.ts"]}
```

`register.ts`：

```ts
export function register(on) {
  on("prompt.section", { name: "cmb:agents" }, async ($, e, next) => {
    const result = await next(e)
    if (result.text === null) return result
    return {
      text: `${result.text}\n\n修改代码后，检视改动并报告测试证据。`
    }
  })

  on("prompt.compose", async ($, e) => {
    const result = await $.prompt.compose()
    return {
      sections: [
        {
          id: "my-claw-policy:review",
          text: "报告结论时区分已验证事实和未验证推测。",
          scope: "shared"
        },
        ...result.sections
      ]
    }
  })
}
```

将目录打包为 ZIP，在插件页面安装并授权 Function 模块；在“我的 Claw”选择该能力和
所需模型，保存组合，再应用到当前对话。之后正常发送任务就会使用组合，不需要每次
输入插件命令。使用已有 DIY 流程时，选择流程并执行；主对话、独立 Flow Agent 和本轮
接入的已知 task 图分别沿自己的实际模型边界执行已授权的模块。

上面的 section Hook 只在实际项目规范存在时追加；compose Hook 无论该段是否存在都会
添加自己的规则。使用 `next(e)` 和 `$.prompt.compose()` 可以让后续模块继续参与组合。
没有 SDK section 方法；段名也不是数值优先级。列表顺序生效，`shared` 段必须在
`session` 段之前，id 必须唯一。

## 来源名称与边界

| 名称 | 本工程真实来源 |
| --- | --- |
| `cmb:environment` | 当前运行环境、路径、时间上下文 |
| `cmb:background-execution` / `cmb:sandbox` | 当前运行模式的命令和沙箱指南 |
| `cmb:agent` / `cmb:base` | 当前角色的实际系统正文和主图基础约束 |
| `cmb:plugin-context` / `cmb:agents` | 实际加载的项目插件上下文、AGENTS 或 Harness 规范 |
| `cmb:extra-context` | 主图额外系统正文，支持当前空槽 |
| `cmb:coordinator` | coordinator 实际替换后的整体系统正文 |
| `cmb:tool-routing` / `cmb:deferred-tools` / `cmb:workflow` | 实际启用的路由、延迟工具和流程指南 |
| `cmb:user-identity` | 本次主图已有的用户身份上下文 |
| `cmb:output-style-identity` / `cmb:output-style` | 已有系统风格身份和正文 |
| `cmb:todos` / `cmb:filesystem` / `cmb:task-guide` | 原生中间件实际追加的工具指南 |
| `cmb:task-completion` | task 图的既有完成和防重复约束 |
| `cmb:task-state` / `cmb:skill-hook-context` | 宿主实际追加的任务图和技能 Hook 上下文 |
| `cmb:skills` / `cmb:memory` | 原生中间件实际加载并追加的目录和记忆内容 |

这些是本工程来源名，不保证与 Claude 内部段名一一相同。不会从主图借内容填补受限角色
的记忆缺口，也不会因用户文本恰好包含类似标题而误切来源。

来源只在当前模型请求内有效。完整内容、block 属性、authority 或请求分支不匹配时，
回退到整体 opaque 消息，丢弃旧来源和旧空槽。未知第三方中间件删改内容、缓存中间件
改变结构属性等，都可能使部分来源无法单独编辑。多个 system 消息保留原来的整体适配。
未改写时保留原消息对象、字节和 block 属性；确有改写时按官方 `\n\n` 连接 sections。
原来源文本中的分隔符不会被猜删，因此改写后可能多出空白。

来源当前全部保守标为 `session`，没有伪造官方 shared cache。风格段只覆盖系统正文，
每轮 Human/Tool 风格提醒仍属于 attachment 的剩余差距。

## 隔离与存量影响

- 私有 task 身份每次由宿主生成 UUID；界面、经典 Hook trace、Command 和 ToolMessage
  继续保留原工具调用 id。相同 id 的并行调用也不能混用取消或授权。
- 只有宿主明确装配的 general-purpose 和 registry 图接入。Opaque Runnable、未知模型
  对象、同名 custom 覆盖不能靠名称取得内置 authority。
- 子任务的模型事实、输入预算、工具和提示词使用它实际的配置；不会调用主对话模型
  activate 或覆盖主预览。子 transport 保留 `dispatchHooks=false`，不新增子任务
  `turn.step` 插件路由承诺。
- 创建时的配置 epoch 和真实 binding 固定到任务生命周期。取消、撤权、关闭后再开启、
  异步模型回调或工具晚结果都必须重新核验原 owner，不借新配置或主 owner 发布结果。
- Mods 冷态关闭时沿用原图。旧 Plugin 项目模式、Harness、经典 Hook、受限读写策略和
  子任务 trace 的功能测试属于本轮回归范围，不以新模块测试代替它们。

## 仍未完整对齐

完整 `prompt.context.instructionFiles`、`prompt.attachment`、官方 section cache 与
invalidate、更多内置模组、288 新增的 `$.ui.selection` 仍未完成。独立 complete/classify/
fork API 的完整会话 compose、任意 custom Runnable、终端、多 MCP 环境和远端 DIY
也没有扩大成完整兼容。已有支持范围继续以兼容矩阵逐项说明，不计算一个对齐百分比。

## 验证记录

方案及最终代码均经过 `official_mods_review`、`latest_mods_binary_review` 两位独立
agent 复核。检视发现并修复了旧 tool-call 身份依赖、分支来源生命周期、配置
disable/re-enable 和异步模型回调期间的续权窗口。生产八文件的冻结 SHA256 用于核对
最终测试期间未改代码。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | Node / Web 通过 |
| 定向 Vitest | 9 文件，149/149 通过，原超时不增加 |
| Electron | 11 场景，87 项检查通过 |
| 浏览器 | 5 场景，27 项检查通过 |
| 性能 | 3 套件通过，缓存复用和扫描次数断言保留 |
| 全仓 `npm test` | 714 文件通过、4 文件失败；5812 项通过、11 项历史失败、5 项跳过；无新增失败、无 unhandled error |
| 后续独立回归链 | 9 条链、84 个子命令全部通过；workflow 测试适配后完整重跑通过，首轮失败保留 |
| 定向 lint | 10 个本轮生产 / 测试文件通过 |
| 全仓 lint | 100 项历史错误，与基线按文件、rule、message 比较；新增错误 0，不能称全仓 lint 通过 |
| 正常构建 | `CMB_MODS_E2E=0` 的 `npm run build` 通过，`out/main/mods-e2e.js` 不存在 |
| 冻结校验 | 8 个生产文件 SHA256 全部一致 |

全仓失败为既有 macOS JetBrains mock 5 项、缺少 Chrome extension 资源 5 项、固定颜色
surface policy 1 项，与上一轮基线逐条同名。此前 Windows 临时 exe 清理占用本次没有复现。
所以不能将 `npm test` 写为全仓绿灯。全量测试保持 2 worker，耗时 634.75 秒。

独立回归首轮发现一项旧测试适配遗漏：`agent-registry.spec.ts` 要求源代码固定使用
`if` 和 `systemPrompt +=`。生产贡献调用的两层 gating 已保留；测试现通过 TS AST 读取
唯一真实 producer 表达式，在 VM 内验证 policy / bridge 的四组合、slot 名和正文，
以及未启用时 renderer 零调用。原标签、排序、空列表断言均保留，43 项窄测通过，两位
评审再次通过。它证明 producer 门控与输出，不单独证明整个 runtime、工具权限推导或
最终 HTTP；图及传输证明来自独立 E2E。首轮失败日志为
`mods-task-sources-standalone/workflow-initial.log`，完整重跑的 `report-workflow.json`
记录 exitCode=0；其余八链首轮通过，不重写第一次失败。

最终 lint 还发现新 E2E helper 两处 `any`，已改为明确的 HTTP 请求类型。类型修正前后
由 TypeScript 生成的 JavaScript SHA256 完全一致，保留全部场景和断言。首轮 lint 102 项
错误和定向两项错误日志单独保留；修正后的全仓 lint 回到历史 100 项，定向 lint 通过。

新的 Electron 旅程安装并授权真实模块，保存、应用 Claw，派出三个并行 GP/registry
task。两个配置使用相同公开模型名 `gpt-4`，真实 HTTP 为主图 2 次、子图 6 次，其中
override 2 次、default 4 次；三个私有 UUID owner、每次实际输入中的 compose marker 和
工具描述、原生 `ls` 成功、项目规范移除及主图空槽填入均有断言。旧 Plugin 项目模式、
Harness adapter、Autobiz、Flow、取消、撤权及重启持久化旅程同时通过。

性能数字仅用于本机复核：128 项工具说明 warm median 1.27 ms、64 KiB compose median
6.17 ms；64 步流程执行 256 次的平均 CPU 编排约 1.29 ms。512 个实际小 SKILL 文件的
catalog / policy 共扫描 2 次，64 个 Flow Agent 同源准备只扫描 1 次，旧 pin 会拒绝。
这些测量各有明确排除范围，不包含外部模型、网络延迟，也不代表绝对 SLA 或整体速度提升。

主要证据保存在本工作区 `output/`，不提交生成内容：

- `mods-task-sources-fence-typecheck.log`、`mods-task-sources-fence-unit.log`
- `mods-task-sources-validation/{electron,browser,performance}.json`
- `mods-task-sources-validation/task-model-288/` 的实际请求、Hook 日志和截图
- `mods-task-sources-npm-test.log`、`mods-task-sources-standalone/`
- `mods-task-sources-full-lint.json`、`mods-task-sources-focused-lint.log`
- `mods-task-sources-production-freeze.json`、`mods-task-sources-final-gates.json`
- `mods-task-sources-final-report.json`、`mods-task-sources-test-emit-check.json`

## 下一轮优先级

1. 接通真实 `prompt.context.instructionFiles`：在原指令文件加载点提供路径、范围及内容，
   保持原授权、大小限制和错误处理，验证禁用、文件更新、重启与子任务各自的实际输入。
2. 接通真实 `prompt.attachment`：先覆盖已有 Human/Tool 风格提醒和当前原生附件，
   验证单独修改、删除和撤权后不残留；不得将 system section 编辑冒称附件接管。
3. 为独立 complete/classify/fork 的受支持请求建立各自 compose frame，保持现有输入与
   结果协议、工具及历史边界；不借主对话快照模拟任意原版模式。
4. 在上述来源与生命周期稳定后设计 section cache / invalidation；`ui.selection` 作为
   独立的只读桌面适配接入，不能为补 API 名而扩大跨对话或外部窗口读取。

# Claude Mods 正式发布版安装包核验与架构评审

日期：2026-10-02。工作区 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
本次只写研究产物和本报告，未修改 UAT、全局 Claude CLI 或产品实现，未运行本工程 build、
Electron 或重型测试，未调用付费模型。已读取四方向统一契约、作者说明和交付记录。

## 结论

检索时官方 npm latest 为 **2.1.287**。同版官方 CHANGELOG 已宣布 Claude Mods；
经过完整 SRI 校验的 Windows x64 原版 `plugin test` 不再要求旧的 function-hooks 启用 flag。
不过内嵌声明及同版公开 Mods README 仍标注 API early access，不能把发布宣布理解为 API
已稳定或本工程已完全兼容。[官方发布记录](https://github.com/anthropics/claude-code/blob/v2.1.287/CHANGELOG.md)、
[官方 Mods README](https://github.com/anthropics/claude-code/blob/v2.1.287/mods/README.md)。

最小正确调整是将发布参考固定到 287，接入真实 provider 请求前的有界 `prompt.compose`，
保留本工程 QuickJS、权限、内容保护和运行租约；用宿主自己的稳定 section ID，按实际应用的
Claw 顺序组合同 tier 插件；以宿主注册表提供第一项可选 AbovePrompt context-meter 内置提供者。
这个方向**有条件通过**：必须满足下文通过条件，不能把设计或原版探针当作本工程验收通过。

## 固定来源与完整性

研究目录：`output/claude-code-2.1.287-launch-analysis-2026-10-02/`。
首次浏览固定时间 `2026-10-02 15:19:23 UTC`；完整元数据保存时间
`2026-10-02T15:20:15.8370836+00:00`，见 `retrieval.json`。
`npm-latest-metadata.json`、`npm-main-fixed-metadata.json`、`npm-native-metadata.json`
保存完整响应，固定包后没有随 latest 漂移。

来源：[npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)、
[固定主包](https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.287)、
[固定 Windows x64 包](https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/2.1.287)。
官方 tag 对象为 commit `816ec211a648f17a411f63a45cfd44ddf8db00d9`，完整 ref/tree 响应另存。

| 产物 | 核验值 |
| --- | --- |
| 主包 `main.tgz` | 28,026 字节；完整 SRI 比对通过，见 `main-integrity.json` |
| 主包 SRI | `sha512-V5WRpA+p41siSlf/Ujxjm//RtYvySxH/p9/rh6zRxNoHeBzqTgSDw3nP8PgtACM/KcVx/g5TFUNdVkq51dfg0g==` |
| native `native-verified.tgz` | 112,274,990 字节；完整 SRI 比对通过，见 `native-integrity.json` |
| native SRI | `sha512-PWFxa2+cd8sIco+W3qDR85GhumGzNNdwgqHkz2u5jNhvoH8i4loBvOMEyrtZo3bYVwNeEt905GImhchv2duQGg==` |
| native tarball SHA256 | `909db6e67dd772ff4e7c7570fb9f630827bb495df5cc9005ea51c1054b171970` |
| `claude.exe` | 247,736,480 字节；原版 `--version` 为 `2.1.287 (Claude Code)` |
| PE SHA256 | `6d5be51f0edfe3429cd1a9885950db31c1e59eb9a2c9a30a47e64179d2ff98b4` |
| Bun manifest | 2,384 模块，44,606,441 字节内容，0 sourcemap，2,155 个 bytecode 非空条目 |
| 内嵌声明资产 | `extracted/claude-code.d.ts-e37ccc4a.txt.zst` |
| 解码声明 | 573,702 字节；SHA256 `850955da76fbae9d8d546c091fa350dbf6968c661e4f22e45368629cc28380fb` |
| 286 → 287 声明差分 | 新增 309 行、删除 105 行，见 `embedded-declarations.diff` |
| 公开 tag 声明 | 文件头仍写 2.1.277；SHA256 `8ae1244d19d4b393261605fe72d517b66be0d7e1c214c378cdec5107e8b0b46c`，不能替代本次内嵌声明 |

首次整包下载停滞并中断，两个未完成文件不用于解包或执行。最终包按 byte range 下载，
检查每段 Content-Range/长度后串接，再对**完整文件**比对固定元数据 SRI。解包检查路径和
链接边界。`extract_bun.py` 复用 286 提取器，只调整输入路径；每个模块保留偏移和 SHA256。
Node 24 只用 zstd 解码声明数据，没有加载提取 JavaScript 或执行提取 bytecode。
这属于 PE/Bun 模块表、发布资产和函数边界的只读恢复，没有恢复原始内部 TypeScript 或原生机器码。

## 287 差分与实现边界

`static-delta.json` 记录模块从 2,349 增至 2,384，225 个当前模块内容与旧包完全一致。
其余模块含打包符号、导入路径和内容变化；这些数量不是语义变化或兼容完成比例。
核心 `skill.prompt`、`tool.describe`、草稿 read/fill 和 model result-v1 保持既有形状，
原版十项基线全部继续通过。287 新增的主要声明变化是：

- `prompt.compose` 明确要求所有 shared sections 在 session sections 之前，乱序会跳过该 Hook。
- `prompt.attachment` 增加按 type 联合的 pinned `detail`，目前涵盖计划模式、退出和重入事实。
  未声明 attachment type 不能伪造 detail。当前宿主仍将 attachment 标为 unavailable。
- 作者类型根改为插件旁 `.claude-plugin/types`，分 engine、builtin tools、MCP 和依赖插件
  合同；不能继续把陈旧公开 `/plugin-types` 示例当作 287 实际布局。
- 声明明确含 `import()` 的 hooks module 不加载；TypeScript matcher 定义优化不等于新增宿主事件。
- 音频资产说明明确 macOS afplay，以及 Windows/Linux terminal 无播放器时跳过，不能由 API 名推断跨平台播放。

feature flag 字符串仍存在于环境变量清单，但静态命中清单不能证明启用 gate 仍在。
原版无 flag / 有 flag 两组运行均通过，证明本次测试入口已无需旧 flag；本报告没有以测试
引擎替代已登录交互会话、组织策略或所有平台的完整验证。

## 原版 prompt.compose 探针

`run_original_probes.py` 使用独立 `CLAUDE_CONFIG_DIR`，清除旧启用变量、模型 token 和插件
目录变量，关闭自动更新及非必要流量。只运行已校验原版 `--version`、`plugin test`。
模型、工具、composer 下层由测试 provider 回答，无真实模型请求。

最终日志：`no-flag-probe.log` 和 `with-flag-probe.log`，**每组 24 pass / 0 fail**。
十项为 286 基线，十四项为新增 compose/section 探针。
另一个独立插件 SDK section 探针 `sdk-section-probe.log` 为 **1 pass / 0 fail**：
实际调用得到 `TypeError: $.prompt.section is not a function`，没有进入下层 section provider。
总计为主套两种 flag 条件各 24 项，加独立 SDK 边界 1 项；不重复累计成独立契约项数。

| 探针 | 实际结果 |
| --- | --- |
| SDK 参数与结果 | 插件 SDK 存在 `$.prompt.compose(facts?)`；Hook/next 和 SDK 均直接 `{ sections }`，无 `{ value }` 外壳 |
| 引擎调用 | 原版 testing Engine dispatch 经过插件 compose Hook 再到下层 |
| 同插件其他 Hook | command.run 调用 SDK compose，仍经过同插件另外的 compose Hook |
| 同一 frame 递归 | compose Hook 内调用 SDK compose，只跳过当前 compose frame，避免自身递归；不能整插件跳过 |
| 非法顺序 | session 后追加 shared：跳过非法 Hook，调用合法下层一次；不会自动归组排序 |
| 非法 ID/shape | 重复 id、空 id、非法 scope、`{ value: { sections } }` 同样跳过该 Hook并返回合法下层结果 |
| 全量替换 | `{ sections: [] }` 是合法清空结果；保护来自宿主/组织策略层，不来自非空校验 |
| downward model 改写 | model pinned，改写无效，下层得到原 ID，调用一次 |
| 其他 facts 改写 | promptModel、tools、traits 可以由官方下行 Hook 改写；本工程固定这些事实属于更严格适配 |
| 无参 SDK，隔离测试引擎 | 下层测试 provider 接收 `{}`；测试没有 live session，不能由此推断生产 default facts |
| section，隔离测试引擎 | 可以独立调用 testing Engine `$.prompt.section({name,text})`，返回直接 `{text}`；这不是插件 SDK 的同名入口 |

首次测试错误假设 SDK 会跳过同插件全部 Hook，出现 18 pass / 1 fail，原日志保存在
`initial-*-probe.log`。补充非法返回探针时，表达式回调返回 `on(...)` 的 registration 被
原版静态分析器拒绝，日志保存在 `probe-analyzer-refusal.log`；改为不返回 registration
的块后重新运行。上述日志保留，未把中间失败回填成通过。

追加边界检查中，对 SDK 方法取 `typeof` 被原版 scanner 拒绝，保留
`probe-sdk-introspection-refusal.log`；对隔离测试引擎误假定存在 live default facts 出现
23 pass / 1 fail，保留 `probe-live-defaults-mismatch.log`。最终探针准确断言隔离引擎收到
空 facts，生产默认值另按下列固定安装包函数核查，没有用空值或测试 stub 冒充真实会话。

### SDK compose 默认事实与 section 调用边界

`composition-boundaries.json` 保存固定模块 SHA256、函数位置及证据。生产 SDK `NAt`
先从当前 caller/session 的真实 tools/model 取得 composer facts，再加当前 surfaces，最后
覆盖调用者明确提供的 args。无 composer 时明确报该进程不合成系统提示词，不能静默用
空段落冒充成功。`gRt` 生成以下默认事实：

| 事实 | 生产默认来源 |
| --- | --- |
| model | 当前会话实际模型 ID |
| promptModel | 引擎模型 prompt 映射；并不保证等于 model |
| tools | 当前会话实际可用工具的 name 列表；底层合成忽略无法匹配真实工具的名字 |
| surfaces | 当前实际显示 surfaces；REPL terminal 在首位，没有显示时为空 |
| outputStyle | 实际选用样式 `{name,isKeepingCodingInstructions}`；默认样式为 null |
| traits | 真实 bare/lean/sdk-preset/teammate/analysis/print/skills/send-user-message 分支组成的列表 |

官方 SDK 支持显式参数覆盖默认 facts，并将覆盖后的 model 固定到该次 compose chain。
本工程候选 SDK 绑定 actual request 并固定事实，属于更严格有界适配；不要把会话当前模型、
实际经过路由后的 provider 模型和固定选择的角色别名混为同一 ID。无绑定时明确报错，且
compose 调用不发模型请求、不写草稿或持久化系统提示词。

插件 SDK 的 `CoreEngineInterface.prompt` 只有 submit/read/fill/suggest/compose；
`prompt.section` 出现在 `EventCalls.prompt` 的 testing Engine 接口，未进入插件 SDK，
独立原版探针也确认其运行时不存在。
宿主应支持 `on("prompt.section", ...)` 并在 core composition 计算单段正文时分发它，
compose 的底层结果再合成全部 section；不能为了同名便利入口声称官方插件 SDK 可独立调用它。
`PromptSectionInput` 是 `{ name, text: string|null }`，结果直接 `{ text: string|null }`，
null 表示省去该段，不是 operation `{ value }`。

与声明一致的函数边界证据保存在 `static-evidence.json`：

- `extracted/chunk-tcd31prf.js`：compose descriptor `Fs`，pinnedKeys 仅 model；
  argument validator `ys`；result validator `gs` 检查 sections、id/text/scope、重复与 shared 顺序；
  `xs` 计量新增 section 文本长度。记录偏移只对本次固定 SHA256 有意义。
- `extracted/chunk-5hdtkwdb.js`：`Cxn` 持有 prompt composer/resolver，`Nxn` 在存在 Hook 时
  分发 compose，`Txn` 构造 shared/session 文本与引擎缓存边界。SDK compose 是只读合成调用，
  并不保存或自动发送会话系统提示词。
- `extracted/chunk-etg1zepw.js`：SDK 方法映射包含 compose；fill 在 SDK 外层另读真实草稿，
  两者不可混用 operation 外壳。

## 内置 Mods 结构与信任层

这三项是实际内置模块，非 README 名单：原版注册器
`extracted/chunk-6zqzb2j9.js` 直接注册 sec-default、agents-md、telemetry，diff 在对应
entrypoint 条件下注册。`chunk-tbd75ny1.js` 保存旧名到 `cc-plugin-*` 名的兼容映射。
只读保存了官方同 tag README 与 register/index 源；不复制这些实现到产品。

| 官方内置 | 核实职责 | 本工程影响 |
| --- | --- | --- |
| diff | 独立 register，Host/Backend、git、PaneState、Views、timer/generation 等模块；session.start 不扫描 Git，首次明确需求后固定仓库，真实编辑/命令触发刷新 | 一项 context-meter 内置提供者不能据此声称已重做 diff 或全部内置能力；宿主 UI 与事件契约独立验收 |
| agents-md | instructionFiles 四模式，真实祖先文件、嵌套 Read、去重和来源 framing；旧 projectInstructions 暂兼容；默认是否启用另有特性开关 | 项目正文适配应维持真实来源与读取时机；这是 prompt.context/工具读取协议，不是 compose 加一段文本即可等价 |
| sec-default | 外层 tier 座位由管理设置/组织事实决定；对 compose/section/context/skill 等 `next.to(e, "append")` 跳过 user tier；managed 来源固定，策略不可读时 fail closed | builtin/prepend/append 身份必须由宿主赋予；用户 manifest 名称、tier 或配置都不能获得该身份；内容保护不等于官方完整组织策略 |

官方源：[diff](https://github.com/anthropics/claude-code/tree/v2.1.287/mods/diff)、
[agents-md](https://github.com/anthropics/claude-code/tree/v2.1.287/mods/agents-md)、
[sec-default](https://github.com/anthropics/claude-code/tree/v2.1.287/mods/sec-default)。

## 最小实施方案及通过条件

候选方案可作为本轮增量；须遵守已签订四方向契约的来源身份、完整包批准、应用快照、
模型解析、运行租约和最终证据，不通过发布新名字扩大已授权能力。

1. **发布参考**：event catalog、兼容矩阵、作者 CLI 和交付说明统一以 287 内嵌声明为参考；
   unavailable 接口仍明确拒绝。已实现范围写 bounded，不写全部 Claude Mods 对齐。
2. **真实请求接线**：实际顺序为 modelresolve → tool.describe → section/compose → 最终
   budget → stream；compose/section 的变换实际进入 provider 接收到的 system message。
   定向 HTTP 验证至少覆盖主运行、标准子 Agent/Flow、模型重试或切换后的真实事实；
   独立 completion/fork 如尚未接线需在调用路径和文档明示，不能仅注册事件计作兼容。
   所有转交路径继续使用各自现有取消、批准和运行租约，取消/撤权不发出迟到 provider 请求。
3. **section 与事实**：使用宿主稳定 IDs，例如 `cmb:system`、`cmb:output-style`，不冒用
   官方 intro/lean_body 的原始实现；唯一非空 ID、字符串 text、合法 scope、shared-first。
   模型/工具/界面事实由真实绑定生成。若固定全部 facts，应注明比官方仅 pin model 更严格。
   session 或个人内容不能进入 shared；scope 不代表权限许可或已有供应商缓存能力。
4. **逐 Hook 非法结果处理**：287 会跳过非法 Hook，继续下层一次；主链应记录可诊断的
   拒绝来源。不得静默排序后接受；若本工程采取显式报错/拒绝整个变换，要记录该差异。
   SDK 调用只能跳过当前 registration frame，同插件其他合规 Hook 仍参与。
5. **保护与预算**：已有 mandatory/system/Skill 内容保护在最终输出再次成立。
   删除、替换、空列表不能拿掉宿主必需指令。变换后重新检查最终消息大小、输入 token/预算；
   原预算通过不授权任意新增提示词。section 变换不可改工具 identity/schema/执行权限。
6. **组合顺序**：同 tier 的生产加载和所有 composition/fold 均按活动 Claw 引用数组顺序，
   不能在 sources() 先按 plugin id 字典序排序导致用户顺序失效；稳定 tier sort 可保留。
   无 Claw 的旧默认路径保持原 id 顺序和结果。测试应交换 A/B 顺序并核对 provider 正文，覆盖
   同包多个组件、重复引用、禁用组件、reload 和按租约固定的运行中快照。
7. **第一项真实 builtin**：AbovePrompt context-meter 来自受信宿主注册表的固定内部模块，
   使用宿主固定 builtin tier，明确 ID/version/digest 与
   功能范围；用户包自报 builtin/prepend/append 一律不能升级信任层。用户可选启用，
   未选择、关闭 Mods 或内置提供者不可用时保持旧输出效果。测试证明它真实参与 composition，
   用户 Mod 能否影响它按本工程策略明确声明，不能靠 manifest 冒充受信来源。
   context-meter 读取真实 session usage/context 事实，无有效数据时显示未知而不伪造百分比。
   验证真实 AbovePrompt 渲染、用户显式启用/停用、数据失效、换线程/撤权后的卸载，避免
   每帧扫描或轮询昂贵上下文。原 output-style 机制先保留，此项不宣称全面改造 core 提供者。
8. **验收**：定向回归先验证实际 system、顺序、非法返回、内容保护、预算、取消/撤权、
   默认回退和信任伪造；统一冻结后由主任务串行执行规定 Node 22 类型检查、构建、全量、
   Electron 和性能。原版 24 项测试只证明官方测试引擎契约，不替代这些宿主验证。

第二独立评审意见：修订方案的方向与 287 证据相符，**批准按以上条件实施**。尤其应保持
authority/取消为 fatal，不得因非法结果 fallback 恢复失效来源；缺少 SDK actual-request
绑定时明确报错；可信内置身份不得来自用户 manifest；原默认机制和无 Claw 行为维持兼容。
全部通过条件得到实际代码和
运行证据前，维持“有条件通过”，不将新方案报告为已完成交付。

## 最终代码评审补记（2026-10-03）

以上“批准按条件实施”是实施前的方案评审。实施后再次只读检查最终生产快照，
**第二独立代码评审通过：本轮实际接入的 prompt 核心、dispatcher 保护边界、可信
context-meter 与 Claw 顺序实现未发现剩余代码阻塞。** 这不是全部交付验证通过的声明。
本次补记仅修改本审计文档，未运行 Electron、npm、构建或重型测试。

- 真实主运行 provider 先解析模型并完成 tool.describe，再运行 section/compose；最终消息和
  工具 schema 重新计入预算。预算通过并检查 authority/取消后才记录发送预览并调用 stream。
  空 section 列表的 core 也执行有效期检查；未改变的系统消息保留原对象和非文本内容，
  涉及非文本系统 block 的文本替换明确拒绝，用户消息和工具身份不由 compose 改写。
- 每个 prompt frame 的输入、返回值和 core 结果均保护并复验，下层新增文本在上层 guest
  读取 next 返回前已保护。非法 Hook 保留合法下层结果或跳过当前 Hook；未等待的 next
  也保留已发起调用的严重失败，authority、取消和保护失败不能被合法返回掩盖。
- 仅提供插件 SDK `$.prompt.compose()`；section 是 Hook，未新增独立 section SDK。
  compose 省略字段读取绑定的实际请求，拒绝替换其 model；没有绑定或请求关闭时明确拒绝。
  stream 生命周期的 abort 使绑定失效并清除保存快照。主动调用只跳过当前 registration，
  同插件的其他 Hook 仍参与，不发送模型请求、不写草稿。
- 内置模块来自宿主固定代码与固定 builtin tier；外部包始终为 user，并拒绝内置名称冲突。
  context-meter 默认关闭，显式应用后零用户插件也能加载；读取同线程宿主 session usage，
  无有效窗口/用量时让出，完成时失效刷新，关闭或换组合释放旧 guest 和绘制。
  用户 Hook 可替换或通过 next 包装它。已应用 Claw 的 capability 数组保持保存顺序，
  同 tier 排序保持该顺序；无 Claw 的旧路径仍按原 plugin id 顺序。

最终 facts 适配必须按实际实现理解，不能把实施前“固定全部事实”的候选描述当成最终接口：

| 字段 | 本工程生产默认值与边界 |
| --- | --- |
| model | 实际解析后的 provider 模型 ID；Hook next 固定，SDK 也拒绝不同 ID |
| promptModel | 默认等于 model；没有移植 Claude 的独立 prompt 模型映射 |
| surfaces | 主运行默认 `["desktop"]`；输入校验枚举为 terminal/desktop/mobile/vscode |
| tools | 实际绑定工具名，包含普通工具与嵌套 function schema 的名称 |
| outputStyle | 默认样式为 null；选择既有样式时提供名称，保留既有编码指令的标志为 true |
| traits | 默认 `[]`；不据此宣称实现 Claude 的 bare/lean/SDK/teammate 等 core 分支 |

其余 facts 可作为 Hook 的有界组合输入进行结构合法的覆盖；core 使用当前实际系统消息，
这些覆盖不会切换真实模型、工具权限、凭据或既有 output-style 机制。SDK 固定实际 model
比官方允许显式 model 参数覆盖的查询入口更严格。section ID 是实际消息边界的
`cmb:system:<index>`，并未把一条系统消息内部的 memory、项目指令、Skill 和 output-style
拆成完整 core 模块。shared/session 保留顺序语义，不承诺 Claude 的缓存边界；普通系统
文本允许删除或整表替换，宿主权限与内容策略仍在 prompt 之外强制执行，未冒称存在
官方 sec-default 的不可移除 managed prompt 层。本次审批不扩大到尚未接线的独立
completion/fork 或其他 provider 路径，也不宣称全部官方内置功能已改造成可替换模块。

验证证据分开记账：官方原版探针实际为无 enable flag **24/24**、两项旧 enable flag
同时开启 **24/24**，另有独立 SDK section 不存在探针 **1/1**。它们验证官方固定包契约，
不是本工程测试。主任务已报告真实 presentation 6 项、builtin 5 项、Autobiz 7 项及
components/composition/flow/forms 回检通过；这是主任务提供的运行结果，本评审未代跑。
本次补记时，主任务 163 项定向验证与其余串行回检仍在最终重跑，不能提前记为通过。

model-http-284 首次失败是 E2E 对已运行父 job 错误等待 cancelled：只读真实隔离库确认
该 job 196 毫秒内回写 unknown/MODS_CANCELLED、无 result，两项 model.complete 均为
unknown/blocked。后端既有契约只有 queued 取消为 cancelled，已执行取消保留 unknown；
主任务仅更正 E2E 终态断言，保留双 HTTP 关闭及后续请求成功验证，复测结果另由主任务记录。
因此最终状态为“本轮代码审批通过，最终运行验收以主任务结果为准”，不继续将代码审批
称为实施前的有条件批准，也不把尚未完成的重跑包装成完整交付通过。

## Flow 独立子运行接线收口评审（2026-10-03）

随后增加的真实 Flow HTTP marker 验收揭示：此前主 provider 的 compose 审批没有覆盖
仍受 main-only gate 排除的独立 Flow child。旧 Flow 检查通过不能证明子模型请求执行了
prompt Hook。主任务保留失败与 marker 断言，按调整契约完成接线后，本评审再次只读复核。
**第二独立静态代码评审通过：本段限定的独立 Flow child provider 和请求归属隔离实现，
未发现剩余代码阻塞。** 这是收口后的代码结论，与此前的实施方案条件批准分开记账。

- 模型边界 factory 强制从宿主 authority 取得 agentId/turnId；独立 child 使用实际解析
  模型、实际描述后的工具和变换后的最终预算，不通过伪装 main 获得接线。child 不回写
  main session 模型或 main 提示词预览。
- child 复用 FunctionSession 的受保护 stream，但宿主固定 dispatchHooks=false，使
  guest turn.step 链为空。session 生命周期 signal、epoch、grant/publication 和原有
  runtime resource fence 保留，关闭、撤权和替换会中止实际 provider transport。
- 宿主 stream facade 在真实 next 拉取时建立 fresh child FunctionExecution；live child
  的 return/throw 进入自身 owner scope，asyncDispose 经同一 return 清理路径。没有改写
  inner.return 的只读属性，保留原 dispatcher 和 provider 的关闭语义。
- authority 失效后的 return/throw 使用仅供宿主清理的 tombstone：active=false、无
  user action、无 lease；清除继承的 calls、modCallContext 和 writeLease。它只关闭捕获
  的原 stream/provider，SDK 访问明确失败为 MODS_CALL_SCOPE_EXPIRED，不回退 main，
  不重新创建 authority，不放行 next，也不借用替代运行的身份。
- SDK 实际请求快照改为按真实 authority 对象保存的 WeakMap。composing ALS 也校验
  同一 owner，父任务或兄弟任务的 store 不能成为查询来源；无 owner/无绑定明确
  unavailable。入口、core 返回和短路结果均检查 owner 与合并的 caller/request signal，
  旧请求 abort 仅删除仍属于自己的 snapshot，不能删除同 owner 的新请求。

本评审仅新增 `src/main/mods/v2/prompt-owner-isolation.test.ts` 的 8 项真实 FunctionSession /
QuickJS / ModRuntimeAuthorities 回归，覆盖并行 Agent 与 turn、代际替换、父子 ALS、
独立请求取消、旧 abort、新 snapshot、无 owner 和发布期间 owner 过期；另明确验证
child 空 turn.step 链保留原 provider frame，Session.close 中止 transport 并执行 finally。
本评审没有运行这些测试、Electron、npm 或构建。主任务报告首轮 55 项定向通过及
29 项实际 authority / factory 回归通过；异步释放的类型问题已补入本次静态快照。
新增第 8 项、最终类型检查和 Flow HTTP marker 的最终运行结果仍以主任务归档日志为准，
本段不代为宣称完成。

审批范围仅为独立 createAgentRuntime 的 Flow child；同 thread 的 task/general-purpose
共享子 Agent 默认模型、独立 complete/classify/fork 和其他尚未接线的 provider 路径
没有据此扩大为完整 compose 覆盖。最终交付通过仍需主任务关闭真实运行验收条件。

## Main / child 统一传输 owner 补记（2026-10-03）

真实展示 E2E 又发现 main 的实际 provider 拉取没有继承 Function owner：section Hook
可以生效，但 SDK compose 因 unavailable 未生成最终 HTTP compose 标记，相应 UI log
也缺失。此失败说明仅检查存在 main authority 或 section 改写不足以证明 SDK 接线完成；
验收断言保留。本段替代此前依赖 main ambient scope 的传输结论，不将失败记录为通过。

修复后的最终静态快照再次获得第二独立代码审批，未发现剩余代码阻塞：

- main 与独立 child 的实际模型 stream 均使用仅供宿主调用的
  withFunctionTransportExecution / withFreshFunctionTransport。由捕获的真实 authority
  建立 fresh scope，清除继承的 calls、modCallContext 和 writeLease；只有这条实际
  provider 路径采用新入口，既有 task / 文件操作入口没有被整体改写。
- scope 固定 userInitiated=false、leased=true、immediate=false。它可以保留实际运行
  身份与当前宿主租约，不能继承或制造用户操作授权；写 SDK 仍由原用户动作、文件租约、
  grant、原生路径和工具权限检查拦截。guest 不能构造此 authority 或调用此宿主入口。
- main / child 统一使用 next / return / throw / asyncDispose facade；真实拉取与 live
  cleanup 都进入自身 owner，失效 cleanup 仍使用前述 active=false tombstone。身份、
  runtime resource fence、原 provider 关闭和严重失败传播没有放宽。
- 是否执行 turn.step guest 链仍由宿主 authority.agentId 决定：main 为 true，独立
  child 为 false。SDK compose 的 WeakMap / composing owner 校验和请求取消检查保留，
  不以放宽无 owner 查询来修复这次 E2E。
- model.fork 仍经过 FunctionModels 的独立 grant、模型守卫、admit、预算与真实 call
  identity 记账，fork snapshot 由宿主 captureFunctionSession 校验。它以及 explicit
  complete/classify 使用原始模型 transport，没有被装进此 wrapper，不因统一 main
  scope 递归触发 turn.step / prompt.compose，也不成为用户操作授权。

本次仅作静态检视并更新本审计文档，没有代跑测试。真实展示 E2E 的 SDK compose 标记
进入 HTTP、UI log、撤权 / 取消以及最终 Flow 子运行结果，在本段写入时仍待主任务归档，
不得据此提前记为通过。范围仍为真实 main provider 和独立 Flow child；共享 task 子
Agent 及独立 completion/fork 的全面 compose 接线没有扩大为已覆盖。

## 主任务最终运行补记（2026-10-03）

以下由主任务根据实际日志补记，区别于本评审 agent 的静态审批，未让评审 agent 代跑。
最终 `output/mods-launch-final-validation/final-selected-report.json` 为
`allSelectedPhasesPassed=true`：10 套 Electron、81 项检查，5 套浏览器交互和 3 套
性能专项均通过。保留主/子接线的第一次失败及断言；真实 HTTP 已含 main SDK compose
与独立 Flow child 的跨插件 marker，Skill/UI log 与撤权取消也通过。

20 文件、254 项定向测试通过。随后 Windows controller 清理/主子 owner 共 20 项与
provider 协议 14 项复核通过。Node/Web typecheck、定向 lint、普通构建均通过；普通
产物无 `out/main/mods-e2e.js`。九条 standalone 链另行实际通过。

完整 `npm test` 仍未全绿：2 worker、原预算下 5,751 通过、12 失败、5 跳过，零未处理
错误；11 项已知旧失败和 1 项历史 Windows 临时 EXE 清理 EBUSY。后者有界重试后 9 项
定向通过，不重写全量失败记录。全仓 lint 的存量错误另列于最终报告。范围仍为真实 main
与独立 Flow child；未扩大到共享 task 或全部独立模型 API。完整交付结果见
[官方发布后的实现与验收](mods-official-launch-implementation-2026-10-02.md)。

## 最终独立静态收口（2026-10-03）

本评审再次核对 `codex/mods-v2` 的最终源码与主任务归档结果，**限定范围内静态评审通过，
没有剩余代码阻塞项**。本次只读复核生产代码并补记本审计文档，没有运行测试或构建。

真实 main provider 与独立 Flow child 均从捕获的宿主 authority 建立 fresh transport
scope，清除祖先 calls、modCallContext 和 writeLease，固定 userInitiated=false。
next / return / throw / asyncDispose 保持自身 owner；失效清理使用 active=false 的
tombstone，不借父身份或重新授权。SDK compose 的请求绑定按真实 authority 对象隔离，
composing ALS、入口和返回检查保留；factory 的 agentId / turnId 来自真实 authority。
实际模型解析、tool.describe、section / compose、最终预算、预览和 provider 请求的
顺序保持正确。main 执行 guest turn.step，独立 child 保留宿主生命周期而跳过该 guest 链。

此前各段写入时待运行的 main SDK compose / UI log 与独立 Flow child HTTP marker，
已由最终真实 E2E 原断言通过关闭，初次失败记录仍保留。归档 report 的 10 套 Electron
共 81 项、5 套浏览器与 3 套性能全部 exitCode=0；日志确认 20 文件 254 项、清理与 owner
20 项、provider 协议 14 项通过。冻结类型检查、普通构建和九条 standalone 的最终通过
结果由主任务归档；普通产物不存在 `out/main/mods-e2e.js`。

本结论不将全量 `npm test` 改记为绿色：5,751 通过、12 失败、5 跳过、零未处理错误的
原记录保留。Windows 历史 EXE 清理失败仅通过有界清理重试和窄测闭合。全仓 error-only
lint 的 100 项错误保留；主任务按文件、规则、消息与 2026-09-29 基线复核，新增错误为 0。
覆盖范围仍限真实 main 与独立 Flow child，未声称共享 task 子 Agent、独立
complete / classify / fork 或所有 provider API 的全面 compose 接线，也未声称与原版
完整兼容；本工程固定请求事实、模型约束与既有 QuickJS / 授权边界的差异继续有效。

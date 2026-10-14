# DIY 参数表单架构与兼容性评审

评审结论：**通过**。以下约束已向主线程提出并获采纳，须作为实现验收条件。当前是实现前独立评审，不预先宣称代码或端到端验证完成。

工作目录为 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本评审只读核查生产代码，保留累计未提交内容，不操作 UAT。

## 核查依据与当前真实调用链

- `shared/mods/claw-actions.ts` 定义显式动作导出、完整来源身份、对象大小界限，以及前步对象与固定输入的合并规则。
- `v2/loader.ts` 从实际 plugin/native manifest 读取动作，校验 inputSchema/outputSchema；完整清单原文已进入 captured sources 和编译摘要。
- `v2/manager.ts` 的 actionCatalog 只展示 ready 来源；prepareAction 核对安装来源、实际 plugin、授权 digest、命令 owner；runAction 重新准备并比较目录/command/grant epoch，随后验证最终 input，再执行 pinned command args。
- `flows/native-host.ts` 在准备时校验无 inputFrom 的静态输入，在执行时先解析实际前步对象再调用 runAction；config 当前只是有界对象。
- `v2/tool-schema.ts` 是已有非执行式有界 JSON Schema 校验器，无默认值填充、类型强制转换、远端引用或 schema 执行。
- FlowEditor 当前动作选择值未含 digest，MCP 说明查询未完整检查 provider 身份；草稿以 stepId/字段保存且编辑器 key 只有 flow id。本轮不能直接拿这些现有查询当新表单 schema 可信来源。

## 必须保持的最小契约

### 可选 configSchema

`ClawActionExport` 与 `ClawActionDescriptor` 增加 `configSchema?: ModObject`。只有显式出现时解析并用现有 validateToolSchema 校验；null、数组、错误字段或超出既有 schema profile 的声明拒绝。省略时不生成隐含 schema，不把所有旧配置变成封闭空对象。

目录与准备结果仅从实际授权快照复制 schema，不接受 FlowDefinition 或渲染器上传的 schema 作为运行权限依据。无需往保存的 Flow 增加 schema 副本，也不修改 Flow 版本或插件 envelope version。

宿主准备与真实调用均把缺失 config 视作当前 envelope 语义的 `{}`，然后在 configSchema 存在时完整校验。**配置校验与 inputFrom 是否存在无关**。runAction 必须先规范化实际 envelope.config 并验证，再组装 args、进入任何插件 command handler；页面通过不能替代这一层。

错误需要区分“步骤配置”与“步骤输入”，页面显示具体步骤与可定位字段；不要把内部 code 当唯一说明，也不把配置原文拼入错误。

### 完整目录身份

插件动作 schema 必须匹配 `pluginId + plugin + digest + actionId`。MCP schema 必须匹配 provider 的 `id + name + digest`，再加 `toolName + schemaDigest`。字符串拼接应使用无歧义序列编码，不能靠带冒号的展示名称代替身份。

旧保存引用在新目录中找不到时显示不可用和重新选择提示，不借同名新动作的 schema 编辑旧步骤。MCP 目录仍只在用户明确加载时发现，表单不自动连接服务或执行插件以猜参数。修改来源时保留参数并呈现类型冲突，不能悄悄删除或改类型。

### 固定输入与前步输入

inputFrom 的实际规则继续为：选定前步输出中的一个对象，再用固定输入覆盖同名字段。提供完整输出和已知对象路径只是编辑提示，不生成逐字段表达式或隐式转换。

**绑定 inputFrom 时，固定 input 中缺少必填项不能直接使流程不可保存**，因为字段可能由前步提供。UI 可验证已填写常量的基本类型并标明必填项可由前步提供；完整 required、对象整体约束与合并后结果仍由宿主验证。config 没有这个延迟来源，必须完整校验。

已知路径必须来自相同完整身份的 outputSchema；只建议明确为对象的路径，正确编码 `~0`、`~1`。未声明输出类型或 MCP 目录没有输出 schema 时保留完整输出与高级 pointer，不伪称能够推导任意结构。MCP 输出还有 `text/isError/structuredContent` 宿主封装，不能把远端输出属性错误地当作封装的顶层属性。

### 无损草稿与表单范围

简单表单仅处理对象根及能够确定类型的顶层原始值/简单枚举。复杂属性和未知值留在原对象中，提供高级 JSON。枚举 option 要保留 JSON 类型，`0` 和 `"0"` 不得混淆；false、0、空串均不同于未设置。schema.default 只可作提示，不自动写值。

无效 JSON、未完成数字、类型不符草稿必须进入整体 validity，禁止静默保存上一份有效对象。切步骤/视图保留草稿；**重新加载、放弃修改或载入同 id 的新版本时必须有明确重置边界**，否则现有 `key=draft.id` 会让旧草稿错误地遮住新加载值。删除步骤的草稿不得永久阻止保存。

## 旧包摘要与行为兼容

核实 loader 后，**不需要新增额外 normalized digest 字段或提升 host revision**：完整原始清单已进入摘要，新增、修改或删除 configSchema 都能使旧授权和 Claw 引用失效。新 schema 只是收紧配置约束，不增加宿主权限。

因此保持现有摘要算法原样；无 configSchema 的包应与改造前得到相同 digest，且 action descriptor 不出现 `configSchema: undefined` 或隐含 `{}`。不改变无绑定/Mods关闭/普通 Plugin/Harness、不改变 MCP 的单次调用和禁止跨节点回放限制。

## 可落地文件与验收

后端可限定到 `shared/mods/claw-actions.ts`、`v2/loader.ts`、`v2/manager.ts`、`flows/native-host.ts` 和对应测试。可加小型统一配置校验 helper，复用 clawActionObject 与现有 schema 校验器，避免准备/执行规则漂移。renderer 独立实现表单组件、完整身份选择、草稿 validity 和输入来源提示；现有 IPC 类型随 descriptor 自然携带可选 schema。

必须覆盖：

- 无 schema 旧包摘要/行为保持；schema 新增和变更使摘要改变；错误/缺失/正确配置；不应用 default。
- actionCatalog 和 prepareAction 复制真实 schema，来源更新不把旧步骤自动转到新 schema。
- 有 inputFrom 的动作同样在 prepare 校验配置，实际 runAction 再校验；错误配置在 handler 前拒绝，真实有效 config 原样交付。
- 前步完整对象/对象路径、常量覆盖、已填写字段类型错误与缺少可继承 required 的区别。
- false/0/空串/未设置、混合类型 enum、未知嵌套值、无效 JSON 和数字草稿、切步骤/模式、显式重载重置。
- 真实浏览器表单、已交付 Autobiz/Review 两动作、MCP 目录身份变更及旧跨插件/Flow/Plugin 回归；累计既有失败与新失败分别记录。

没有需要扩大运行时权限或重构旧执行器的阻断。按上述约束实施后，这一轮能够降低常见动作配置成本，同时维持既有宿主校验边界。


## 后端实施与交叉检视结果

后端实现已完成：configSchema 从真实清单严格解析并经现有工具 schema 校验，目录和 prepared action 复制声明；统一 `validateClawActionConfig` 在准备和真实调用两处执行，不注入 default、不转换类型、不输出错误值。inputFrom 只延迟 input 的完整校验，不延迟 config。保存的流程不能传入声明覆盖已批准快照；伪造 prepared schema 由完整描述比较拒绝。完整原始 manifest 继续进入原有摘要算法，没有引入新的摘要字段或 host revision。

验证记录：

- `output/mods-flow-forms-backend-tests.log`：6 文件 75 项通过，maxWorkers=2。覆盖显式空/错误配置、inputFrom准备、缺省旧包、严格null声明、schema注释变更摘要、恢复旧声明恢复原摘要，真实QuickJS有效调用和非法config零模型边界调用。
- 首次新增 QuickJS fixture 遗漏既有模型请求必填 model，被宿主正确拒绝；只补 fixture 的 `model: "default"` 后通过，未修改生产模型规则。
- `output/mods-flow-forms-node-typecheck.log`：Node TypeScript 检查通过；首次只出现新增测试三元对象隐含undefined的类型推断，显式标注ModObject修正。
- 定向 ESLint 0 errors；累计大文件有既存格式警告，未整文件重排。
- 第二评审者已独立只读确认后端通过，特别核查目录clone、prepared/current完整比较、inputFrom配置门禁与错误不回显值。

本评审者交叉核查 renderer 的参数字段投影、完整来源身份、typed enum、false/0/空串/未设置、未知值保留、JSON与数字未完成草稿、inputFrom必填延迟，以及显式重载/保存的editorSession重置：**通过**。源目录变化时未完成数字草稿仍以独立numberErrors阻断，不会因schema消失被默默忽略；复杂约束仍由宿主判定。主线程真实浏览器反例进一步证实，若对禁用步骤也施加required/type等schema约束，会破坏旧Flow允许禁用未配完动作的保存行为；先前将其视为可保留UI策略的判断已撤回。修复后parameterError先校验未解析JSON与数字原文，再以validateSchema=false跳过禁用步骤的schema约束；FlowEditor聚合与FlowParameterEditor均接入step.enabled。重新只读复核通过：禁用步骤可以暂未配置，但未解析草稿仍不被丢弃。

最终结论：后端实现与本次交叉源码检视通过，无已知阻断。浏览器交互、实际Electron链路及全量回归结果须引用主线程本轮最终交付记录；本段不预先宣称E2E通过。


## 独立九条后续 npm 链验收

在主线程全量 Vitest 完成后，独立串行执行 adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1：**9/9 通过，84 个 package.json 原始顺序命令完成，所有链 exitCode=0，没有失败链**。Node v22.23.2，Vitest min1/max2；只为 workflow 子进程提供本机 GitBash 的 SHELL/GIT_BASH_PATH，不修改用户设置或生产配置。

完整证据在 `output/mods-flow-forms-standalone/report.json`、`report.md` 与各链同名 `.log`。未将不同框架的PASS行、suite数量和断言数混加成总测试用例数。此次独立回归确认存量Plugin、Hooks、Harness/工作流、桌面Agent、消息与IM等对应自动化链通过；全量Vitest的既有和额外失败仍按主线程最终对照记录，不能推论全仓零失败。

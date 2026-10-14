# Claude Code 2.1.288 固定包与 task / contributor 方案独立评审

本轮参考固定为官方原版 **2.1.288**。287 报告保留为历史发布基线，不继续将它称为
latest。工作区为 `C:\ai\CmbCoworkAgent-mods-v2`、分支 `codex/mods-v2`。固定包审计阶段
只读核对固定包、声明、提取文本、已有原版探针日志和实施契约，只新增本审计文档；该阶段
没有运行项目测试、Electron 或构建，也没有执行提取代码。后续来源 helper 的实现及最终
代码复核在本文末尾单独记录，项目验证由主任务串行归档。没有在 UAT 写入或将原版实现
复制进产品。

## 固定包与运行证据

主任务保存的完整固定版本元数据和产物位于
`output/claude-code-2.1.288-alignment-analysis-2026-10-03`：

- `npm-main-fixed-metadata.json` 和 `npm-native-metadata.json` 分别保存主包与 win32-x64
  原始固定元数据。文件落盘 UTC 为 2026-10-03 04:45:38 和 04:45:39；这是本地落盘时间，
  不当作 registry 响应自带的获取时间或发布时刻。
- `native-integrity.json` 记录完整 `native-verified.tgz` 为 112,945,062 字节，
  actualIntegrity 与 expectedIntegrity 相等，verified=true。
- tarball SHA256：`1c3f4aa857914e6801520d566025d2f1970a70842026bfc4c63da306becbcb48`。
- 完整 SRI：`sha512-b6akPIKjrF685qBVo084zYlkdqHD7LZgBV1Dxj84whZjH/WpX8bMdXwed2KJyZ9/LD2ahGcGXV5EDOnsgybTng==`。
- `manifest.json` 记录原 PE 为 249,149,600 字节，SHA256
  `84304f7d4b0cd0ebcbe8318695a260151b48991a6659c3366fdd5da290c0ab91`，2,393 个模块、
  0 source map。
- 内嵌声明为 576,270 字节，SHA256
  `82131ac1421ba4351e1538b1316519d2e2842143a6302f5dd1fd22a3144540f0`。

本评审核对已有原版日志：`no-flag-probe.log` 与 `with-flag-probe.log` 均为
24 pass / 0 fail；`sdk-section-probe.log` 为 1 pass / 0 fail，实际得到
`TypeError: $.prompt.section is not a function`。这些是原版插件测试引擎的契约探针，
不是本工程的新 task / contributor 运行验收，本评审没有重跑它们。

## 288 对 287 的 prompt 差分

`embedded-declarations.diff` 为 70 行新增、13 行删除，新增 `ui.selection`；其他变化
主要细化 UI invalidate、diff fallback、HTTP policy、授权句柄和 compaction 等说明。
没有改变本轮 prompt contributor 的声明契约。本评审直接读取两版声明进行文本比较：

- 从 `PromptComposeArgs` 到 `PromptComposeTrait` 的 5,009 字符声明区间完全相同。
- `PromptSectionInput` / `PromptSectionResult` 的 566 字符声明区间完全相同。
- 插件 SDK 仍只有 `$.prompt.compose`；测试 Engine 的 `EventCalls.prompt.section`
  不能当作插件 SDK 入口。

同时只读检查了 288 的提取实现，而非只依据声明推断：

| 288 提取位置 | 观察到的边界 |
| --- | --- |
| `chunk-p8vbbyj7.js`，`sMt` / `iMt` / `lMt`，约字符 1,469,615 起 | 真实 model、promptModel、工具名称、outputStyle 和 traits 的事实构建，以及完整 / lean / bare 分支 |
| 同文件，`jf` / `lQe` / `eQe`，约字符 137,182 起 | 命名贡献、原 compute 的结果、section 解析及内部缓存键去后缀 |
| 同文件，SDK `POt`，约字符 1,702,165 | 先取得 caller/session 的真实事实，加入 surfaces，再合并显式参数；进入同一 compose 分派 |
| `chunk-x199v9nv.js`，约字符 16,440 / 29,618 | section 唯一 id、shared-before-session 校验，以及 compose 的 model 固定字段 |

两个静态证据文件的 SHA256 分别为
`d7bb91005fed6e52ae16b53a0161c91f750a8586f20ef293c5effed8d510e234` 和
`ece523a7a3d55bc8b8bb71c81bddf1bf64f8838ced7cd9fd83445aa38b0516e7`。
对应的结构与 287 的 `gRt` / `hRt` / `_Rt`、`wf` / `f9e` / `a9e` 和 SDK `NAt`
保持上述边界；这不是两版所有 prompt 模板字节相同或整个原版实现相同的声明。

## 原版 contributor 契约及本工程边界

1. section 名来自贡献定义。内部 `memory:L`、`session_guidance:...` 等键可按模型分支
   缓存，但对 Hook 和 compose 列表通过去后缀得到稳定名称。没有公开的 section 数字
   priority 字段；计算可并行，最终列表的顺序仍由宿主定义。
2. 完整核心开头为 `intro`、`system`、`doing_tasks`、`actions`、`tools`、`tone`；lean
   使用 `lean_body`，bare 使用自己的 `bare`。后续命名 session 贡献包括
   `communication`、`pronouns`、`memory`、`env_info_simple` 等，不存在文本就省略。
   命名 session compute 可以产生 null，section 解析仍可回答文本；输出阶段才省略 null。
3. `shared` 是 prompt cache 前缀，`session` 是可变内容所在侧。全部 shared 必须在
   session 之前；shared 不是信任层或不可删除的权限规则。原版由引擎设置 cache marker，
   Hook 返回 section 列表不等于本工程已经有相同 provider 缓存实现。
4. 原版 outputStyle 事实来自真正选择的样式；core 会据样式改变身份和编码指令分支。
   本工程既有风格机制同时存在系统正文和 Human / Tool 每轮提醒。本轮仅模块化前者，
   不宣称完整风格模块或新 trusted output-style builtin 已接管这些行为。
5. 原版 AGENTS 插件操作 `prompt.context.instructionFiles` 的路径、kind、内容和顺序，
   由引擎按 omission 规则渲染。它不能与 system `memory` section 等同。本工程本轮
   提供其真实 AGENTS 加载器生成的 system 来源，不宣称已经实现官方 context 协议。
6. 原版 reminder / mode transition / 附件由 `prompt.attachment` 控制，可落在非 system
   消息。本工程的工具反馈、loop nudge、完成恢复和风格提醒必须保持各自真实边界；
   system sections 不代表所有这类消息都已经可替换。

本工程来源已按实际生产路径核对：`getSystemPrompt` 生成 environment / shell / sandbox /
agent / memory-guidance；runtime 加入 plugin context、AGENTS、extra context；coordinator
可替换整套 prompt，普通模式加入 tool routing / deferred inventory / workflow，再加入
用户身份；createAgent 加入 base 与系统风格；filesystem、skills、memory、skill lifecycle
和工具 Hook 等 middleware 还会在最终模型调用前追加实际内容。只给早期字符串拆段会
遗漏后面的贡献，coordinator 路径也可能错误保留已被替换的普通来源。

## 第二独立方案结论

对[本轮实施契约](mods-task-contributors-contract-2026-10-03.md)的第二独立方案评审
**通过，无方案阻塞项**。这是对实施方向和约束的批准；新生产代码及实际运行尚未完成
本次最终评审，不能在此预记为通过。

共享 task → 真实来源 sections → 独立模型 API 的优先级保持正确。288 新增
`ui.selection` 不需要抢先于真实 owner、实际请求接线和可验证的提示词替换效果。
实施必须同时满足契约和以下对“严格前缀”的具体解释：

- source seed 只在真实 producer 生成处记录；命名的空 slot 属于当前角色支持的贡献。
  disabled / omitted 的 memory 或 skills 不得通过父 seed、旧 checkpoint 或旧请求复活。
- per-request provenance 绑定真实 authority 与本次请求，不能使用 thread、toolCall.id、
  guest metadata 或公有 model 名作为身份键；host UUID 及真实 provider 配置分别解决
  owner 与 endpoint / 预算归属，不能相互替代。
- 仅为已声明的 pinned native append 观察器赋来源名。字符串必须为完整精确前缀；
  content array 必须核对原 blocks 的顺序、内容与属性，不能仅比较 flatten 后的文本。
  已有来源按记录的拼接规则必须重建出原输入，最终也必须与实际 system 内容一致。
- 非 append、未声明或重建不一致时，清除旧 named provenance，包括原 null slots，
  改为当前完整 opaque 内容。不能保留猜测的 AGENTS / memory 标签，再从旧内容重建。
  对未知内容整体处理，不做标题匹配、不复制依赖包模板、不改变原 middleware 行为。
- 原输出未被 Hook 改写时保留 messages、SystemMessage、content block 属性、字节和
  顺序。变换遇到非文本 system block 仍明确拒绝，不能无声丢附件；最终 budget 计算
  真实变换后的消息和工具，超预算前不启动 HTTP。
- role 最末模型边界包装当前真实 request.model，default / override 各自有可信配置和
  budget；不包 main 的旧 wrapper，不回写 main session 或 preview。真正 provider
  采用 fresh transport scope，其余 task graph 的租约、经典 Hook、trace 和限制保持原语义。
- 不把 section 改写或删除当作权限改变。全部 session scope 是本轮保守适配；新的
  contributor 不能据此声称跨组织共享 cache、section invalidation 或全面 core builtin。

必须保留契约中的真实验收，而非只增加手工 dispatch 测试：重复 / 伪造 toolCall.id、并行
A/B 与嵌套 task、相同模型名不同 endpoint、默认 / override 实际 HTTP、SDK 当前 owner、
取消 / 撤权、原租约与 role 限制；来源方面须验证同标题外部文本、空 slot、coordinator
reset、受限角色 memory omission、destructive middleware opaque 回退、无 Hook 保真、
实际 section 删除 / 替换及变换后预算拒绝。既有 main / 独立 Flow 的真实断言继续重跑。

## 保留的兼容缺口

本轮不声称独立 complete / classify / fork 已重跑全部会话 contributor，也不为
opaque / 自定义 Runnable 推断宿主权限。完整 prompt.context / prompt.attachment、
风格提醒接管、section cache / invalidation、provider cache marker、更多 trusted
builtin、ui.selection、终端和多环境 MCP 仍需逐项接线和真实验证。最终实现、类型、lint、
构建与 E2E 结果由主任务归档后再评审；历史全仓失败记录不因本方案通过而改写。

## 独立来源 helper 的实现核验

本评审独占实现 `mods-prompt-sources.ts` 及 colocated tests，不修改 runtime、compose
或 provider 边界。来源数据只在当前真实 authority、活动请求分支与最终单个纯文本 system
内容同时匹配时返回。seed 和每次下游 handler 调用均复制贡献数组；retry / fan-out 分支
有独立 lifetime，分支结束后即使外层另一次 retry 仍活动，旧回调也不能再读取该来源。
未知或 destructive 改写清除包括 null slots 在内的旧贡献，不能被后续 named append 复活。

22 项针对来源、原生 memory middleware、块属性、并行请求、owner / generation、分支
退出与同步 handler 的窄测通过。最终两文件 ESLint 通过；主任务随后发现的 fixture
类型问题已改为显式确认 AIMessage，Unexpected Command 明确报错，交由主任务串行
复核类型和集成结果。此处不把来源窄测记作共享 task 或整个应用的实际验收通过。

compose 消费方发生实际 section 改写时采用原版的 `join("\n\n")` 输出约定；未改写时
保留实际贡献的原始串联内容及原 messages。producer 记录的分隔符仍属于实际贡献，
改写后可能与统一分隔符叠加，不进行标题猜测、trim 或反推模板。风格附件、完整
prompt.context、section cache / invalidation 及独立模型 API 的覆盖边界仍按上文保留。

## 最终实现复核补记

最终静态复核通过。发现的异步模型 start callback 撤权窗口已通过固定真实注册 binding、
共享任务 entry 和创建 epoch 闭合；cleanup 过期时使用 closed-owner tombstone。新增的
真实回调反例已纳入冻结后 149 项定向测试并通过。主任务完成的 11 组 Electron 场景中，
新的 GP/registry 实际 HTTP 场景通过，未将 helper 窄测等同于集成验收。完整运行记录及
全仓历史失败分类见 [本轮交付报告](mods-task-sources-delivery-2026-10-03.md)。

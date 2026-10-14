# Mods 2.1.288：共享 task 与提示词来源接入契约

工作区 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。不在 UAT 写入。
本轮参考固定为官方原版 2.1.288，原包校验和探针记录位于
`output/claude-code-2.1.288-alignment-analysis-2026-10-03`。

## 要交付的效果

应用 Claw 后，普通对话、独立 Flow 子任务之外，共享线程的 general-purpose 和 registry
task 也执行同一已授权插件的真实 prompt.compose/section 与工具描述链。角色模型 override
仍发往它自己的 endpoint，并使用自己的预算。并行任务不因模型复用或重复 toolCall.id 混用
身份、快照或取消。Opaque/custom Runnable 不自动获得 SDK authority。

系统提示词开始提供真实来源的稳定 `cmb:*` 段，作者能只改项目指令、记忆指南、实际记忆
注入、技能目录或系统风格正文。未知来源保留完整 opaque 段；不从标题猜测用户文本。
这不宣称完整 output-style 模块替换：Human/Tool 的每轮风格提醒仍是独立 attachment 缺口。

## 原版核验

原版无旧 enable flag / 有 flag 主探针分别 24/24；SDK section 独立调用仍为 TypeError，
单独 1/1。内嵌声明相对 287 增加 70 行、删除 13 行；新增 ui.selection，prompt contributor
声明没有因此改契约。原版 section 名由贡献者定义，允许 core 的 text:null 被 Hook 填入；
没有 section 数字 priority，列表顺序生效，shared 在 session 前。AGENTS 的官方入口为
prompt.context.instructionFiles，提醒为 prompt.attachment；本轮系统来源段不冒称这两条
完整公开协议已经实现，也不冒称原版缓存边界。

## 共享 task 的 host 身份

1. task wrapper 每次由宿主 mint `mod-task:<UUID>` 的私有 agentId。原 toolCall.id 保留在
   renderer/trace、Command、stationarity 和 summarization；不使用这些字符串选择 authority。
   嵌套任务的父节点为当前真实 execution.runtimeAuthority，不能回退祖先或 main。
2. 延续 withSharedAgent 的真实父子注册、restriction 并集、readOnly、MCP、取消和 finally。
   general-purpose 和 registry 图是明确受支持的宿主角色；同名 custom 覆盖不获得内置权限。
3. 在每个受支持角色自己的 middleware 最后追加共享模型边界。deepagents 的 default
   middleware 在 role middleware 外层，不能只在 default 数组最后加入，也不能给它主
   modelForAgent。边界每次读取真实 task receipt，验证 role/绑定，再包当前 request.model。
4. 宿主保留 provider 对象对应的不可变模型配置/resolve 事实；default 与 override 各自
   建立基线。初始 override 与动态选择使用现有 Claw fingerprint guard，不按 public model
   名猜 endpoint，也不把 child 重建成 main。未记录的模型对象明确拒绝，避免无预算绕过。
   Claw 初始校验在旧 warn/fallback 的 catch 外执行；不允许将权限拒绝降级为继承 main。
   保留的配置不存在/原生初始化失败 fallback 必须采用实际 default 的事实。
5. 子请求不调用 main activate、不写 main preview；复用原 protected transport，
   dispatchHooks=false，保留 authority/epoch/grant/signal/publication/final budget 检查。
   只有 provider 使用 fresh transport scope；不能把整个 task 图清空写租约/用户上下文。
6. Mods catalog/context/SDK identity 优先采用 authority 的真实三元组。经典 Hook 的 UI/trace
   关联仍可保留 tool-call owner，不能将这份 metadata 重新用作 Mods 授权。
   未接入/冷态关闭的原生 graph 保持原路径；已取得 receipt 的取消/撤权/disable 明确失败，
   不因临时 isActive=false 再裸调用 handler 绕过。
   已接入 task 保存 spawn 配置 epoch；即使关闭后又开启，旧 task 也不能在下一请求或工具
   返回时借新配置续权。

## 来源记录与最终组装

- 在实际生成处记录有序 `{id,text,scope}`：environment、background-execution、sandbox、
  agent、memory-guidance、plugin-context、agents、extra-context、coordinator、tool-routing、
  deferred-tools、workflow、user-identity、base、output-style-identity、output-style。
  空的受支持贡献保留 text:null；coordinator 替换时同时替换来源集，不能残留普通模式贡献。
- 每次模型请求建立独立宿主 provenance frame，绑定真实 authority 和请求。不会把来源数据
  放进 guest 可伪造的 config/metadata，也不存到 checkpoint 或跨 owner 缓存。
  frame 位于所有 default/role producer 外层；每次 handler 调用使用不可变 fork，retry 或
  并行多次 handler 不能复用前一次追加后的可变账本。
- 对 pinned deepagents 的实际 memory/skills/filesystem/task-guidance 输出，以包装现有
  wrapModelCall 的 handler 观察 before/after 内容，记录原生实际新增内容。仅在严格验证
  原内容精确字符串/完整 block 前缀与已有来源重建一致时承认 append，不能仅用 flatten
  文本判断带属性的 block 相同；不复制第三方模板，也不做标题正则拆分。
  未声明/非 append 的改写重置为实际完整 opaque 内容，最终内容不匹配也采用 opaque 回退。
- 所有来源记录只观察，不改变 graph messages。最终 provider 边界核对当前 system 内容后
  在 compose 链的 core 展开 named section，沿用每层内容保护和变换后的预算。无 Hook 改写时保持
  原 messages、SystemMessage、content block 属性和顺序；有非文本 system block 时沿用
  不支持替换的明确拒绝，不丢附件。多个未知 system message 保留整消息适配。
- 默认不改写时沿用实际字节；发生 sections 增删改或重排时，统一以 `\n\n` 连接返回正文，
  与官方 compose 渲染约定一致。不 trim/猜删原来源正文的分隔符，因此改写后的部分段间
  可能有额外空白；这属于本工程原提示词布局适配，不改变权限或来源判断。
- 采用本工程稳定 cmb:* 名，不伪造 Claude intro/memory 的完整同名效果。session 是保守
  来源范围；不重排默认字节以伪造 shared cache。删除提示词不改变原生工具/文件权限。

## 必须通过的反例与验收

1. 重复 toolCall.id、id=main、伪造 metadata、共享 provider、不同 endpoint 同名模型、并行
   A/B task 和嵌套 task：owner 与取消独立；主 session/model/preview 不变。
2. 默认与 override 的真实 HTTP 均含 compose marker；SDK 同 owner 查询读本次请求；过期、
   取消、撤权、disable/re-enable 后无晚发布，原 return/throw/tombstone 断言保留。
3. registry read_only/none、原 shell/写审批、写租约、Command 和 trace 归属不退化；原未知
   Runnable 不获内置 authority；Mods 关闭后仍走旧原生 graph。
4. 稳定来源含 AGENTS/memory/skills/style 正文，空 slot 可填入；coordinator 没有旧普通
   来源；受限 role 没有被重注入 main memory；同标题的外部文本不被误切。
5. 默认 payload 对象/字节与 block 属性保留；未知 destructive middleware 和非文本内容
   明确回退/拒绝；来源不可跨 owner 或过期请求复用；变换后的输入超预算拒绝 HTTP。
6. 定向单元先运行，再类型/lint/build，真实 Electron 默认及 registry task/并行/取消旅程；
   重跑原 presentation、Flow/Autobiz、旧 Plugin/Harness、sources 及性能相关场景。重型命令
   串行，原 timeout 不增加，失败原日志保留。全仓已知失败与本轮新增失败分开记账。

## 不扩大的声明

本轮不开放独立 complete/classify/fork 的整套会话 compose，不开放任意自定义模型或
Opaque Runnable 的权限推断。更多 trusted builtin、完整 prompt.context/attachment、
prompt section cache/invalidations、ui.selection、终端/MCP 多环境与远端 DIY 继续逐项
列明。后续优先级以官方 288 审计和本轮真实验证为准，不用 API 数量计算对齐百分比。

两位独立方案评审已通过上述范围，附加的 cold/fenced、Claw catch、完整 block 前缀和
不可变 handler fork 条件已纳入契约。

## 最终代码复核

`official_mods_review` 和 `latest_mods_binary_review` 均已通过最终静态复核，原阻塞项
已经闭合。前者要求薄 adapter 使用真实 manager binding guard，后者要求在真实模型的
异步 start callback 之后仍核验任务创建 epoch，不能使用重新捕获的新 epoch 续权。
两项要求均进入生产代码，过期 finally 使用 closed-owner tombstone。

冻结后的类型检查及 9 文件 149 项定向测试通过，包含上述两组真实反例；11 组 Electron
场景 87 项检查、5 组浏览器场景 27 项检查、3 组性能套件均通过。执行过程中没有扩大
原 timeout，没有并发启动重型套件。全仓回归和历史失败比较以
[本轮交付报告](mods-task-sources-delivery-2026-10-03.md)的最终验证记录为准。后续 9 条
独立回归链共 84 个子命令均已通过，含旧源码文本断言适配后的整条 workflow 重跑。
两位评审复核了新的 producer 门控测试，未削弱原断言。正常构建及测试入口移除通过；
全仓仍保留 11 项历史测试失败和 100 项历史 lint 错误，本轮新增均为零。

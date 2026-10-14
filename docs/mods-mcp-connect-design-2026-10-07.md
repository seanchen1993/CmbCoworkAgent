# 插件连接自己声明的 MCP 服务

工作目录：`C:/ai/CmbCoworkAgent-mods-v2`；分支：`codex/mods-v2`。
本稿仅为设计，不代表源码已接通、实际连接通过或整体能力目标完成。

## 对应能力与固定依据

固定 Claude 2.1.290 声明的 `$.mcp.connect(server)` 接收调用插件自己 manifest
声明的服务器键。成功返回 `{ isConnected: true, server }`；普通拒绝返回
`{ isConnected: false, reason, message }`。`reason` 的声明集合为
`unlisted | unapproved | disabled | policy | auth | failed`。

本地固定依据为：

- `output/claude-code-2.1.290-alignment-analysis-2026-10-06/readable/claude-code.d.ts`
  第 2628–2663、5777–5817、6655–6659 行。
- 当前 `src/main/mods/v2/mcp-sdk.ts` 已有真实 `mcp.call` 参数、工具来源及结果适配。
- `src/main/mcp/capability-service.ts` 第 48 行的插件来源，以及第 230 行后的真实连接池。

目标是组件可以先连接自己配置的服务，再用现有 `$.mcp.call` 调用。连接不授予
工具执行权限，不取代 Claw 选择、原 MCP 工具审批、运行身份或内容保护。无需复制
原产品的私有对象、内部调用次数、OAuth 服务或服务器命名规则。

## 既有池的实际限制

当前 `ManagedMcpCapabilityService.ensureInitialized/rebuild` 会构建全部启用的
连接器和插件来源，并调用 `initializeConnections`。已安装的
`@langchain/mcp-adapters/dist/client.js` 第 183 行 `getClient(serverName)` 也先
调用全部服务器的 `initializeConnections`，并非只连接这个键。

`restrictClawMcpService` 现在限制本次可以调用的来源，不拥有全局池，也不保证
未选服务器从未被池初始化。现有 `claw-selection.integration.test.ts` 的真实
stdio 用例明确保留这一行为。本窗保留池的创建职责，不能宣称只物理启动一个服务。
如以后需要按服务器隔离建连，须另行设计连接池，不调用适配库私有方法或假设现有
`getClient` 已实现它。

新 `connect` 对未声明或未选择来源的检查必须在进入池初始化前完成。允许的请求
随后使用原池；这一区分不能被新接口绕过。

## SDK 与处理链合同

`$.mcp.connect(server)` 仅接收一个非空、有界字符串，代表自己的服务器键。
不接受插件 ID、完整配置、URL、可执行命令、环境、凭据或宿主连接对象。
`mcp.connect` 输入只有 `server`，该字段在处理链中固定，不能被中间组件改成
另一个服务器。输入和结果使用普通 JSON 验证，不增加权限凭据或来源注册表。

沿原动态 SDK 生成方式，在 `SESSION_CAPABILITIES` 和核心成员中登记方法，
经过原 `FunctionSession.dispatch`、调用插件 skip、操作结果验证、取消及活动跟踪。
连接不冒充 `tool.call`，也不执行工具；真正工具调用仍经过现有完整流程。

普通拒绝按声明结构返回，说明采用固定安全文字，不能带出 URL、命令、环境或
底层含凭据错误。可以可靠识别的宿主状态才映射到对应 reason；不能辨认的连接
失败归为 `failed`，不通过匹配底层错误文字猜测 `auth`。无效参数仍拒绝；宿主
取消、撤权、旧运行失效仍沿原错误路径，不转换成连接成功。

处理组件可以拒绝本次连接，但不能通过短路返回 `isConnected: true` 伪造宿主
事实。SDK 最终成功必须对应本次 core 实际取得的连接，且返回的 server 与原
宿主结果一致；交付前再执行下面的 B 门。该关联只在本次调用的局部变量和既有
绑定中保存，不增加表、token 或权限正缓存。

## 两阶段检查

### A：进入实际连接前

1. 由当前 v2 session 的真实 snapshot 取得安装来源 ID、原 sourcePath、
   已批准的 compiled.root 和 grant。
   可以在既有 Snapshot 记录保存 source.id，不根据插件自报名称或 Guest 参数
   认领另一安装。当前实际安装 owner 的规范路径须与该 compiled.root 相同，
   原 sourcePath/来源身份亦须仍一致；不能借任意安装插件的 same-name 配置。
   可信内置组件没有插件 manifest 时返回 `unlisted`。
2. 沿原 FunctionManager 的 `assertLive`、当前来源/批准检查与 Main
   `functionMcpBinding`。保留 workspace、线程身份、物理运行、lease、取消与
   原调度。后台或命令入口复用现有 `withFunctionMcpCommand`，不直连全局单例。
3. 只查该安装的 `.mcp.json` 精确 own key，形成原
   `plugin:<installedId>/<serverKey>` providerKey。不把 displayName、别名或
   相似路径当作 manifest 所有权，也不让 Guest 提供配置。
4. 连接方法逐层经过原 scoped service 和 Claw service。selected 模式必须命中
   当前实际来源及原 digest；空选择或未选来源直接返回 `policy`，不初始化池。
   普通 disable、missing、approval 和实际连接错误分别按真实状态处理。

MCP 配置仍来自原宿主注册与原连接配置生成流程。此处不会因为登记 SDK 事件
而批准任意命令、服务器、凭据或其它插件，也不把编译类型声明当作安装证明。

宿主 callback 必须包住本次完整 connect dispatch/core 和 Hook 后的 B 门，
不能只在 core 中创建临时 command binding，再把已释放 binding 的 guard 交回
外层。内部 closure 不跨 JSON；最终只返回普通结果。处理组件内的合法 mcp.call
等 SDK 按原 currentFunctionExecution 的 leased/turn 分支复用同一 binding，
不能再次入队等待自己持有的 lease。沿原 scheduleFunctionTool 的用户动作和写门；
若 timer 首次连接不属于原允许范围，诚实拒绝并保留后续适配项，不偷改工具分类。

### B：所有等待和处理组件之后，交付成功前

实际连接使用原 `cache.client.getClient(exactProviderKey)`，取得成功完成 MCP
初始化的 client。工具列表数量不是连接判据；真正连接但没有工具也能成功。

在实际初始化和 getClient 等待前后核对调用资格、取消、来源配置指纹及本次池
实例。成功交付前继续核对：

- 原安装、manifest 对应来源和 Claw 选择仍有效，当前配置未被删除、禁用或替换；
- 仍是本次真实 binding、cache/client 和 providerKey，不能借旧代连接返回成功；
- 当前真实 client 仍有原 transport。SDK Protocol 的公开 `transport` 在 close 时
  清除；本次 client 必须来自完成 initialize 的原连接记录，不以 transport 配置
  或 tools 元数据伪造；
- 本次调用的 signal、grant 和原运行仍有效。

`getClient` 非空但 transport 已清除时不得返回成功。需要恢复连接时只沿原池
机制处理，不另造重复池。真实 ping 可作断线回归或故障诊断，不作为每次复用
已连接服务的额外 RPC，也不把一次旧 ping 结果缓存成之后的许可。

处理组件、保护发布或任何 await 后的最后检查不能省。配置在初始化过程中变化
时，不发布旧连接为当前成功；原池重建/失效清理负责旧资源。若复用原 rebuild
发现它能把失效期间的候选重新发布，须在该候选发布处补本次配置/失效代检查，
不能用新 SDK 外层包装宣称池内问题已经解决。

## 返回名称与 `mcp.call` 互通

现有 `resolveFunctionMcpTool` 只匹配 providerAlias/displayName，同名来源会拒绝。
新接口不能简单返回原始 manifest 名，亦不能将当前 resolver 不接受的 providerKey
称作可调用 server。

推荐返回实际 providerKey，并在 `mcp-sdk.ts` 的现有 resolver 中增加
exact-providerKey 优先分支；旧 alias/displayName 分支及歧义拒绝保持。必须使用
当前受限 catalog，不能凭字符串构造工具、跨过 Claw 选择或绕过工具权限。

自己的输入 key 上限可沿用 256 字符；返回的 canonical server 要覆盖原安装 ID
与 key 的有界合成长度。当前 `mcp.call` 的 server 上限是 256，实现须相应接纳
真实 canonical key（建议上限 1024），保留工具名及 args 原上限。不能截断名字或
要求成功后无法调用。没有工具的连接也返回稳定 canonical 名；后续 `call` 是否
有工具仍由真实 catalog 决定。

## 取消、重载和资源责任

连接池属于应用，不属于一次插件请求。一个请求取消不能关闭别的任务正在借用
的全局池。本次等待沿原 signal/活动跟踪处理，迟到结果不向旧调用交付，也不
成为下一任务许可；下一次调用仍重新核对实际来源、连接与工具权限。

当前适配库的建连不是逐请求可取消传输。不能声称调用取消已经终止共享池正在
执行的握手。宿主保留实际建连的完成/错误观察，避免悬空拒绝；原配置失效和
应用退出仍通过 invalidate/close 回收池。需要独占建连取消属于后续资源改造，
不通过关闭全局池冒充本次清理。

不增加无界重试、自动签入、任意认证提供者或新的超时。复用原连接/RPC及 SDK
外层期限；不改旧 MCP 调用、取消、写入丢回复不重试等边界。

## 最小源码接点

| 文件 | 变更责任 |
| --- | --- |
| `src/main/mods/v2/mcp-sdk.ts` | connect 数据验证、结果结构、canonical server 与 call resolver 互通 |
| `src/main/mods/v2/session.ts` | capability、原 dispatch/core 接线、A/B 与成功不可伪造 |
| `src/main/mods/v2/manager.ts` | 真实 snapshot 安装来源、session host callback、原前后 live 检查 |
| `src/main/ipc/mods.ts` | 复用原 MCP 调度/命令 binding，不增加公开 IPC |
| `src/main/mods/manager.ts` | 原 mcpBindings 增连接委托、原 grant/runtime 入口、Shared child 委托继承 |
| `src/main/mcp/capability-types.ts` | 内部有界连接接口及结果，不向 Guest 暴露 client/凭据 |
| `src/main/mcp/capability-service.ts` | 精确来源、真实连接与配置/池/transport 当前检查 |
| `src/main/mods/claw-mcp.ts` | 选择前置拒绝和原来源 digest 前后检查 |
| `src/main/agent/runtime.ts` | scoped service 委托并把同一限制方法绑定给 Mods |
| `src/shared/mods/v2/event-catalog.ts`、`pinned-input.ts`、`compatibility-catalog.ts` | 登记真实 operation/core 成员、固定 server、准确说明限制 |

不需要改 SDK 安装补丁、生产 Electron/preload 接口、Main 权限工厂或另建来源表。
最终具体签名与改动数量在两位设计评审后冻结；不能为了表内数量遗漏实际接线。

## 最少真实验证

优先复用既有 `tests/support/legacy-plugin-mcp-server.mjs` 和 MCP 测试基础，不
造连接结果或放宽旧断言：

1. validator/Guest：一个 server 参数、额外参数和配置拒绝、pinned server 不可
   改写、无 next 假成功拒绝，合法 refusal 和当前动态 SDK 方法实际可调用。
2. 实际 service：stdio 完成 MCP initialize 后成功，随后原 `mcp.call` 返回完整
   真实结果；已连接重复请求不重复启动；零工具服务也能真实连接。
3. 两插件同名 key：每次连接归自己实际安装；返回 canonical 名可唯一调用。
   未声明的其它来源与空/未选 Claw 来源在池初始化前拒绝。
4. 等待时真实 disable、修改配置、invalidate/rebuild、撤权和取消：旧调用不能
   返回成功，当前其它借用者不被取消方关闭；资源最后沿真实 pool close 退出。
5. 保原 MCP call/result/protection、Claw 选择、同名碰撞、连接 generation、
   已批准工具及丢失写回复不重试回归。不能只做 stub 返回 `{isConnected:true}`。

建议窄测试放在现 `mcp-sdk.test.ts`、`claw-selection.integration.test.ts` 和
新的 `mcp-connect.integration.test.ts`；完整 Guest 接线补在原 session/manager
测试。真实桌面 helper 可以放 `tests/support/mods-mcp-connect-e2e.ts`，由原 Mods
E2E focus 调用：实际安装/批准自己的 MCP 插件、打开组件操作 connect/call、
观察真实服务器请求与完整回执，再核未选来源和关闭。不得 store 注入、额外
模型、假 connected 或将延长测试预算称作性能改善。

实现前两位独立设计评审；生产与测试冻结后独立源码评审。所有实际执行由 Root
负责。本稿不宣称平台探针、旧工具列表或旧 Plugin 安装成功已经证明新接口。

## 当前实现冻结与交付边界

用户已将优先级收窄为先交付主要能力。本窗到生产接线与专项测试源码为止，
不再增加 MCP 桌面 helper、认证适配或新的池机制。冻结时尚未执行类型检查、
测试或真实桌面验证；随后已完成的专项证据见下节，仍不计入面客开放能力。

冻结文件为上表的 12 个生产文件，加本设计、原
`src/main/mods/v2/mcp-sdk.test.ts` 和新增
`src/main/mods/v2/mcp-connect.integration.test.ts`。前者新增 5 个定义，后者
新增 7 个展开定义，覆盖真实 stdio 初始化、零工具、同名来源、失效/配置变更
期间的候选发布和实际断连。旧 SDK 测试定义未删除。桌面全链、真实批准插件
和 Shared child 调用均待运行验证。

本窗没有编辑前逐文件快照，不能以 Git HEAD 代替当前工程基线回退公共文件。
若不随核心版本交付，应按上述新增接线逐 hunk 撤回，保留已有 MCP call、
组件/Claw 权限与原运行 binding；新增测试文件及本稿可作为未验收候选保存。

## 主版本的实际处理与证据

生产 `SESSION_CAPABILITIES` 保留原 `mcp.call`，不含新 `mcp.connect`，
兼容列表也将后者标记当前不可用。生产 Manager 使用原默认集合构建 Session，
没有使用测试显式授权的集合。专项包含默认 Guest 无该接口且主机回调零次的检查。
新接口底层材料保留供后续使用，不对客户承诺主动连接能力。

附近九个文件 40 项先通过；SDK 文件暴露了新连接结果的重复包装，修正后完整
重跑该文件 11 项通过。类型检查也已通过。日志为
`output/stage27-main-release-nearby-current.log`、
`output/stage27-main-release-mcp-fixed-current.log` 和
`output/stage27-main-release-type-node-fixed-current.log`。
真实 stdio 七项已通过，覆盖零工具、同名来源、失效、配置变化与实际关闭。
旧调用名称 `plugin:mail` 和 `plugin_mail` 也有通过的回归。

本轮跨组件来源、显式工具流程和旧 Plugin 项目模式真实桌面回检均通过。
这能作为原 MCP 调用与主版本兼容的证据；不能替代新接口的真实安装授权、
Shared 子任务和主动连接桌面验收。上述范围留到主版本稳定后。

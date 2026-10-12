# 实施顺序与验收

**当前部署基线（按用户 2026-10-02 补充）：首版支持 macOS 与纯 Windows 原生本机运行；Windows 禁止依赖 WSL2/Linux 容器，后续服务端为 Linux K8s。** 平台适配、存储与迁移以 [当前实施基线](12-windows-local-first.md) 为准；公共执行、恢复和授权契约继续适用。本文全量扩展保留为后续参考，不自动纳入本机首版。

当前实施顺序按第 12 文档 G1～G4 与本机 CJ 验收执行；本文件 P4 和远程集群工作包保留为后续全量范围。

本文件保留研发与验收计划，产品已进入实现。已运行的验证、对应版本与未完成项见 [实施记录](15-implementation-status.md)；本清单中的“应通过”不表示“已通过”。

**核心执行覆盖层：** 本文 P0～P5/J01～J10/F01～F42 保留全量基线。当前交付以 [core-scope.json](core-scope.json) 的需求、故障、旅程映射，以及 [最终复核](11-core-final-review.md) 的 G1～G4、CJ01～CJ12 为准；不等待 P4 可选端，也不能漏掉原来放在 P5 的权限/运维基础。核心验收通过只能称“核心范围完成”，不等于全端复刻完成。

## 1. 工作组织与依赖

实施采用 [代码复用与移植计划](08-code-reuse-plan.md)。每个工作包先确定可用源文件、需要一起带入的依赖和测试、目标适配接口，再编写缺口；下面的“建/新增”表示形成可交付能力，并非全部从零写。选择新写时应记录现成实现为何不适用，不能仅以“更统一”作为整段重写的理由。

用户可以一次性交办完整实现。P0～P5 是内部依赖与检查点，不要求用户逐阶段重新发起或确认；实现应持续推进到完整范围验收。代码量估算和交付边界见 [代码量与完整交付估算](09-code-size-estimate.md)。

建议按六条工作线安排责任：运行内核与数据、电脑与基础设施、桌面交互、协作与业务能力、移动端与语音、企业控制面与质量。人员可以兼任，但每条线需有明确负责人。

关键路径是：**固定原版基准 → 抽出独立 Host → 持久运行与远程电脑 → 协作/技能/事件 → 团队/多端 → 全功能验收。** UI 原型、连接器目录核实和移动音视频原型可以提前并行开展，最终仍以同一协议和数据模型接入。

本方案不凭文件数量给出工期承诺。P0 完成原型并统计现有代码可复用比例后，按下面的工作包估算人周；不能将 P2 的单人可用版本称作完整复刻。

## 2. 分阶段工作包

### P0：冻结功能、交互和高风险方案

| 工作包 | 必须产出 | 完成门槛 |
| --- | --- | --- |
| B00 原版行为基准 | 当前桌面和手机版本、账号开关、页面/菜单/卡片状态、录屏与任务样本 | 每个矩阵条目有来源、实测计划；无法观察的条目保留明确状态 |
| B01 源码边界清点 | 工具/RPC/UI 回调到实现的映射、Host 传递依赖、现有测试入口 | 没有把接口声明或空回调当作实现完成 |
| B02 电脑原型 | 持久盘、多 Bot 屏幕、共享浏览器 profile、接管、重启与恢复 | 两 Bot 并行访问同一已登录应用，互不抢焦点，重启后可继续 |
| B03 服务化原型 | 最小无 Electron 执行、事件流、持久审批恢复 | CLI/服务端运行不需要 Electron/桌面会话，审批后能继续同一任务 |
| B04 Team/媒体原型 | 成员私聊与共享资源上下文、移动查看/接管、实时语音链路 | 私聊/账号不串用；媒体通过部署环境代理；确认关键供应商可接入 |
| B05 版本和生态基线 | 原版连接器/技能/模板分类清单、平台限制、权限与计费适配记录 | 目录逐项登记，OBS 有核实方法，不以“支持 MCP”代替生态覆盖 |
| B06 代码移植验证 | 各模块来源、依赖闭包、适配改动、原有测试与缺口清单 | 在候选代码基础上跑通最小接入；确认哪些可直接用、哪些改后用、哪些需要补写 |

P0 可以先处理可独立核实的事项，不因某个账户开关不可用而停掉整项设计。未核实项若影响功能/数据模型，必须在对应阶段合并前解决；若影响体验声明，则阻断最终“完整一致”结论。

### P1：独立 Host、持久状态与协议

1. B10 建 `src/shared/bot/` 协议与 schema；定义身份、Bot、会话、运行、电脑、交互、事件和错误码。
2. B11 从当前 IPC 注册实现抽出 Host Runtime，接入 HostPorts；桌面/IM 保持同一标准 turn 准备链。
3. B12 首版建 Host SQLite 迁移、共享事务与 CommandReceipt、消息/Run、outbox/inbox、lease/fence、对账器；后续 Linux K8s 提供 PostgreSQL 适配。
4. B13 实现 checkpoint 引用和事件 sink；恢复、取消、子任务和 Goal 不依赖 renderer 回调。
5. B14 新增独立构建、启动与健康检查；限制服务端传递依赖，验证桌面基线没有退化。

**门槛：** 已接收任务不因进程重启丢失；旧 worker 不能回写；同 nonce 不产生第二次执行；同一 thread 不被桌面和服务端双重拥有。对自动化外部动作明确保留 uncertain 状态。

### P2：个人 Bot、持久电脑和桌面完整主流程

1. B20 Bot Registry、资料、复制/隐藏/删除、分区与数量限制。
2. B21 ComputerProvider 与用户电脑、屏幕分配、Browser Broker、Shell、文件、viewer 和人工接管。
3. B22 Bot 工作区和多端事件投影，长历史、卡片、分支、未读、发送回执和离线恢复。
4. B23 持久问题/审批/安全输入、本地执行桥、WebAuthn、授权撤回和真实动作结算。
5. B24 上传与成果存储、预览/下载、明确的旧 Thread 关联/迁移流程。

**门槛：** 在远端 Host 上运行，关闭桌面后继续推进；重新登录可看见同一结果；接管与审批不重复；共享文件和登录符合个人 Bot 模型。依赖用户本机执行/出口的任务必须准确显示设备离线等待。

### P3：协作、长期记忆、技能和自动化

1. B30 持久 Bot 信箱、结果回传、群聊 responder、成员版本、轮次/预算/停止限制。
2. B31 个人 Bot 记忆、证据提炼、明确事实优先、删除防再生和作用域检索。
3. B32 Skills 版本、启用、编辑/发布；Teach 视频/事件采集、学习任务、草稿与异输入试跑。
4. B33 时间调度、Slack/GitHub/Linear/Sentry/PagerDuty/邮件/Webhook 事件适配、消费去重和恢复。
5. B34 插件安装/OAuth/多账号/工具开关，邮件和消息草稿真实编辑/发送；云端编码委托。

**门槛：** 三个 Bot 能完成有依赖的共同任务并收束；断线后交接不丢；示范技能换输入能完成；计划与事件在无人打开客户端时产生结果。每个已纳入的供应商连接器有真实或官方沙箱授权与操作记录。

### P4：Team Bots、移动端、语音、模板与完整交互

1. B40 Team Bot 创建、个人转副本、资源发布、发现、私聊、共同记忆、个人账号 Allow、运行/费用归属。
2. B41 Slack 团队通道、管理员授权、成员身份绑定、群聊、撤回和删除。
3. B42 听写、实时通话、便笺与通话全局状态；转写、设置、中断和工具执行联动。
4. B43 iOS/iPadOS/Android 客户端，推送、系统分享、电脑接管、卡片、OAuth 和后台恢复。
5. B44 模板/市场、搜索、语言主题、键盘/触控/读屏、OBS 原版能力补齐。

**门槛：** 团队发布者、成员 A、成员 B 的交叉检查全部通过；手机能接续桌面任务；挂断不丢任务；模板与共享 Bot 行为不混淆。未核实 OBS 不可默认为已完成。

### P5：企业交付与全功能一致性

1. B50 SSO/SCIM、访问/组策略、强制审核、网络、代理、插件、设备、Admin API。
2. B51 Team Setup/Secrets、批量电脑操作、空闲回收、管理员 Bot 分发。
3. B52 用量/预算、动作记录/审计/OTel、备份恢复、滚动升级、容量及发布渠道。
4. B53 桌面六种 OS/架构组合和移动平台构建验证；Linux 包类型、签名/更新/最低版本。
5. B54 按矩阵逐条收集证据，完成原版路径/截图/任务对照、故障注入与现有 Cmb 回归。

**门槛：** 正式范围没有未实现项、占位按钮、未验证关键权限或恢复流程。所有差异都有明确记录；已经确认存在的原版功能不能因排期不足标为“不适用”。

## 3. 现有文件改造落点

| 现有代码 | 改造方式 | 重点回归 |
| --- | --- | --- |
| [agent-run-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/agent-run-service.ts:1) / [IPC agent](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/ipc/agent.ts:5735) | 服务实现脱离 IPC 注册；旧 API 成为适配器 | invoke/resume/cancel/interrupt 及事件顺序 |
| [standard-thread-turn.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/standard-thread-turn.ts:1) | 注入 Bot/成员/资源/作用域上下文 | 模型、技能、权限、项目准备一致 |
| [runtime.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/runtime.ts:159) | Electron、路径、工具、通知和输出依赖端口化 | 同一模型任务不丢现有工具/中间件 |
| [managed-transport-delivery.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/managed-transport-delivery.ts:1) | 保留消息转换，新增真正无窗口 EventSink | 消息 ID、子任务、时间戳和终态 |
| [thread-run-lease.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/thread-run-lease.ts:1) | 新增持久 lease adapter；桌面旧路径逐步迁移 | 重入、队列、取消与所有权切换 |
| [scheduler.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/scheduler.ts:1) | 将云端定义/发生记录/执行分派放服务端 | 桌面旧例程、Goal、重复触发 |
| [coordinator-worker-manager.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/coordinator-worker-manager.ts:1) | 保留运行内 workers，外层增加长期 peer Bots | 父子权限、恢复索引、取消/结果返回 |
| [approval-decision-broker.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/approval-decision-broker.ts:1) | 云端 Interaction 存储、CAS 消费、恢复适配 | 多端竞争、动作绑定与过期 |
| [memory paths](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/memory/paths.ts:1) / [maintenance](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/post-run-memory-maintenance.ts:1) | 显式 scope 参数，增加 Bot/成员/团队作用域 | 原 global/project 与新私聊互不泄漏 |
| [browser-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:1) | 保留本地实现，抽 browser/computer port | Electron 页面行为与远端账号状态 |
| [script-recording-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/record/script-record/script-recording-service.ts:1) | 语义事件接入 Teach；增加视频及安全过滤 | 敏感字段、暂停/停止、输入法 |
| [IM manager](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/im/manager.ts:1) | 同一 Inbox/Interaction 服务接入，可选执行位置 | 招乎 Feature 授权、远程审批和反馈 |
| [Mods host-call](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/mods/v2/host-call.ts:1) | 服务端 Authority 与收据适配 | grant epoch、scope、unknown 和撤销 |
| [App.tsx](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/App.tsx:1) / [store.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/lib/store.ts:1) | Bot 工作区和远端状态投影，复用消息组件 | 项目/Feature 导航、窗口与消息唯一性 |
| [electron-transport.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/lib/electron-transport.ts:1) | 保留桌面传输；新增 Bot transport 实现同一消费契约 | 流事件、重连、取消、未知消息降级 |
| [package.json](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/package.json:1) / 构建配置 | 独立 server/host/computer build 与各平台发行 | 当前桌面包、原生依赖、签名与更新 |

新建目录和职责见 [架构 M01–M19](03-architecture.md)。以上是改造位置，不意味着现有大文件要一次整体迁走。每步先提取接口，再切换单一入口，保持可回退。

## 4. 部署工作包

首版本机包交付 Windows Host/Worker、SQLite/对象目录、协议握手、启停/升级与恢复。公共内核增加 Linux 构建/启动检查；不要求用户装容器、数据库服务或密钥服务器。下列 API 多副本、PostgreSQL、对象存储与容器镜像工作包属于后续 Linux K8s 部署。

开发环境采用独立 API、PostgreSQL、S3 兼容存储、密钥服务适配、一个 Host/电脑，提供 `deploy/bot/dev/` 可复现启动说明。容器电脑只用于开发，不用它证明生产隔离完成。

集成环境至少部署两个 API 实例和两个 Host 节点，能够真正执行断网、杀进程、重领和迁移测试。第三方连接器使用批准的沙箱或专用测试账号；真实模型、语音和电脑链路纳入专项验证。

生产环境交付 `deploy/bot/production/`：

- 镜像与依赖清单、签名、版本/渠道及回滚目标。
- API/WS、电脑显示、语音媒体、对象存储的域名、代理与证书配置。
- DB 迁移、主备/备份、恢复演练、对象保留与删除机制。
- 用户电脑 provisioning、持久盘、配额、休眠唤醒、镜像升级、健康检查。
- 密钥服务、受限服务身份、网络策略和审计出口。
- 自动化、租约/对账、Webhook 和供应商重试/限流配置。
- 告警、容量基线、费用监测与运维操作手册。

上线前在目标内网验证完整路径。只验证 API 可访问，不能证明画面、语音、OAuth 回调或供应商 Webhook 可用。外网无法回调的环境应有可审计的入口网关/受控轮询方案，并记录与原版即时触发的差异。

## 5. 数据迁移、灰度和回退

1. 增量增加表与字段。客户端先支持旧数据读取，再开启新写入；协议版本协商和未知卡片降级先行。
2. Bot 工作区独立 feature flag；旧桌面项目/Thread 保持原所有权，选择关联 Bot 后才进入明确迁移流程。
3. 迁移先冻结旧 owner → 保存 checkpoint/文件 manifest → 校验目标 → 原子切换 owner/generation → 新侧领取。失败则保留旧 owner；不能两边同时运行。
4. 本地项目、聊天、凭据不会因开启 Bot 功能自动上传。用户选择资源后分项迁移，连接器重新授权或走受支持的安全迁移通道。
5. 回退是停止新入口并恢复兼容版本；已产生的服务端会话和外部动作不删除、不伪装撤销。数据迁移必须有前向修复策略。
6. 灰度按团队/用户逐步开放，监测完成率、重复效果、审批等待、恢复失败与成本；扩大前先做恢复演练。

## 6. 贯穿全产品的验收旅程

每个旅程在原版与 Cmb 使用同样输入、同样资源权限和完成条件，保存动作轨迹、结果、人工介入和差异说明。不能要求获取原版不可公开的 prompt 或模型配置。

| 编号 | 旅程 | 完成证据 |
| --- | --- | --- |
| J01 | 新建 Bot，授权应用，收集资料并交付文档 | 资料来源、文件内容、电脑登录、对话和重开后连续性 |
| J02 | 三 Bot 群聊：收集、制作、审查，主 Bot 汇总 | 依赖顺序、交接消息、审查修改、最终产物和停止条件 |
| J03 | 教一次跨系统流程，换输入执行，再设为周期任务 | 原录制、生成技能、异输入试跑、下一次自动执行结果 |
| J04 | GitHub/工单事件触发处理，人工批准后回写 | 事件去重、任务记录、修改依据、批准动作与外部收据 |
| J05 | 桌面交办，退出桌面，手机收到审批并接管登录 | 后台连续性、手机卡片、控制权、任务恢复和成果 |
| J06 | 发布 Team Bot，两成员私聊并分别授权个人账号 | 资源来源、私聊隔离、共同记忆、计费归属与撤回 |
| J07 | 实时语音交办并修改目标，挂断后完成任务 | 转写、工具行为、指令优先、挂断后结果、无重复执行 |
| J08 | 电脑/Host 升级期间有任务和待审批，重连继续 | 单一 owner、恢复点、审批失效规则、结果与文件完整性 |
| J09 | 管理员限制连接器/网络、分发 Bot、批量重建电脑 | 策略传播、受限提示、每成员结果、失败重试和审计 |
| J10 | 模板分享、导入、补授权、更新作者模板、撤回 | 副本身份独立、无历史/凭据泄漏、版本和失效链接 |

## 7. 必须覆盖的故障和边界

下面是集成场景；每条关联矩阵中的功能验收，不为凑数量写镜像实现的单元测试。

| 编号 | 注入/边界 | 预期 |
| --- | --- | --- |
| F01 | 数据库提交后、客户端收回执前断网 | 重发只有一条消息和一个 Run |
| F02 | 同 nonce 发送不同正文 | 明确冲突，不覆盖旧任务 |
| F03 | Run 领取后 worker 崩溃 | lease 过期后恢复，旧 worker 迟到写入被拒 |
| F04 | API 通知丢失但任务事务已提交 | 对账器从 DB 找到任务并调度 |
| F05 | 外部发送已成功、回执保存前崩溃 | 有幂等 API 则核对；无幂等则 uncertain，不盲重发 |
| F06 | 桌面和手机同时回答审批 | 一次 CAS 生效，另一端显示已处理 |
| F07 | 批准后模型改收件人/URL/文件路径 | 旧批准不生效，重新检查具体动作 |
| F08 | 用户改口、电脑重建或权限撤销 | 旧 epoch/generation/策略批准失效 |
| F09 | 本地设备断开或出口被撤回 | 依赖该设备的动作停止/等待，不偷偷换执行环境 |
| F10 | 人类控制电脑时后台 Bot 尝试输入 | 网关拒绝；归还后重新观察 |
| F11 | 两 Bot 并发登录/切换同站点窗口 | 不抢控制、无 profile 锁崩溃；共享状态变化可解释 |
| F12 | 两 Bot 修改同文件/Git 索引 | 锁或版本冲突可见；不会静默覆盖 |
| F13 | Bot 被删但消息/例程/worker 迟到 | 不复活 Bot，不执行新动作 |
| F14 | 群聊移出成员时仍有运行 | 旧成员不得读取后续消息或按旧授权提交 |
| F15 | Bot A↔B 循环交接 | hop/轮次/预算收束，有清楚的阻断原因 |
| F16 | 接收 Bot 失败或结果回传断线 | 原任务能看到状态；恢复不重复做工作 |
| F17 | 删除记忆后自动提炼旧历史 | tombstone 防止未经确认的恢复 |
| F18 | 成员 A 引导 Team Bot 读取 B/owner 私聊 | 存储、搜索、工具和文件层均拒绝 |
| F19 | A 允许个人插件，B 请求同插件 | 不复用 A 的授权或令牌 |
| F20 | 私聊信息被提议写入团队记忆 | 范围核验和用户告知；敏感私有内容不进入共享记忆 |
| F21 | Team Bot 非 owner 请求需 owner 审批动作 | 不创建无人可答的假流程，不自动批准 |
| F22 | Teach 停止后服务崩溃 | 录制与学习任务恢复，不重复创建技能版本 |
| F23 | 示范进入受控密码/OTP/敏感输入；另注入未知敏感页面 | 受控步骤在输入前暂停所有模型/教学采集；未知页面可暂停、丢弃和学习前预览，不声称任意内容均自动识别 |
| F24 | 示例成功但换输入/页面结构变化 | 校验失败可定位，不以录制回放成功代替学会 |
| F25 | 定时跨时区/DST、停机错过发生点 | 按明确规则 skip/coalesce/catch-up，无重复触发 |
| F26 | Webhook 重试/伪造/乱序，供应商限流 | 认证、去重、有限重试和游标恢复正确 |
| F27 | 暂停例程时已有排队和运行项 | 未领取项不执行；已启动项真实结算 |
| F28 | 插件安装成功但 OAuth 取消/过期 | 状态可区分，工具不可假装已可用 |
| F29 | 邮件草稿改完后双击发送、切设备 | 最后确认版本只外发一次或明确 uncertain |
| F30 | 语音断流后重拨、重复转写片段 | 不生成第二次已交办任务 |
| F31 | 切 Bot/系统来电/挂后台/麦克风撤权 | 全局通话状态与系统权限一致，可恢复或明确结束 |
| F32 | 隐藏 Bot 后完成例程 | 工作仍完成，不发该 Bot 通知；恢复可见记录 |
| F33 | 推送点击时账号已切换或 Bot 删除 | 不越权打开历史，正确切换/提示失效 |
| F34 | 恢复点较旧或工作盘同步失败 | 明示恢复时间和可能缺失；不宣称零丢失 |
| F35 | 升级无法安全暂停、迁移半途失败 | 保留旧可用环境，不产生两套活跃 owner |
| F36 | 批量重建重复提交、页面关闭、部分成员离组 | 任务继续、幂等、逐成员状态和有限重试 |
| F37 | 多组策略冲突、管理员锁定、个人更严格规则 | effective policy 可解释，并与动作结果一致 |
| F38 | Team Setup 超时/非零、含秘密输出 | 按规则启动/重试，日志脱敏，秘密范围正确 |
| F39 | 大附件、上传取消、恶意 HTML、无权限下载 | 拒绝/隔离/可恢复，不跨域取得宿主权限 |
| F40 | 旧客户端接收新卡片、长历史事件过期 | 可读降级或升级提示，snapshot 恢复无重复 |
| F41 | 服务日志/OTel 导出失败，打开内容导出 | 关键记录可追踪；仅按明确范围导出，无历史误补 |
| F42 | 预算边界与成员/频道用量归属 | 准入、运行中结算和 UI 账本一致 |

## 8. 性能与任务效果标准

以下是 **建议的 Cmb 工程门槛**，不是声称原版达到这些数值。P0 原型与目标部署环境实测后冻结，并记录样本、负载与网络条件。

| 项目 | 初始建议 |
| --- | --- |
| 消息持久接收 | 健康同区域网络下 p95 ≤ 500 ms，不含模型生成时间 |
| 缓存 Bot 切换 | 标准测试机 p95 ≤ 150 ms，不以等待远端响应阻塞已有内容 |
| 持久事件到 UI | 正常连接 p95 ≤ 1 s；最终持久状态必达 |
| 断网恢复 | 网络恢复后 5 s 内开始补事件；完整历史量大时显示同步进度 |
| lease 故障恢复 | 初始目标 3 分钟内进入恢复/待核对；不保证外部任务 3 分钟完成 |
| 已确认消息可靠性 | 应用进程/单节点故障下不丢已持久确认消息；区域灾难 RPO 由备份架构明确 |
| 文件恢复 | 初始快照目标间隔 ≤ 5 分钟；对外展示实际可恢复点，不把目标间隔当保证 |
| 权限与副作用 | 越权、跨成员泄漏、确定重复外发为发布阻断，不能用平均成功率抵消 |
| 容量 | 按用户/Bot/屏幕/并发模型/媒体/磁盘分别压测，给出饱和点及队列等待；不预先编造每 VM 容量 |

任务效果评测至少覆盖：网页操作、跨系统资料整理、代码修改验证、技能泛化、长任务恢复、群聊协作和语音交办。每类包含正常和受阻样本，重复运行，记录模型/版本、人工介入、实际结果、时长、成本和失败原因。

“使用体验相同”和“完成能力不弱于原版”分别判断。闭源原版模型与提示词无法保证一致，应比较最终任务结果。先冻结样本与成功条件，再约定可接受差距；未做对照数据前不宣称超越。

## 9. 测试入口与证据归档

源码抽离阶段优先使用仓库已有的 `test:desktop-agent-baseline`；涉及消息、调度/Workflow、IM、Goal、Mods 时运行对应的 `test:messages`、`test:workflow`、`test:im-v1`、`test:goal:unit`、`test:mods` 或更窄的相关测试，并遵守对应 AGENTS.md。跨运行时变更通过 `typecheck:node`、`typecheck:web` 和必要构建。

新增 Bot 测试按协议/存储、Host 集成、电脑集成、UI 对照、真实供应商五层组织。数据库竞争、故障恢复和跨进程副作用使用当前部署的真实存储与进程边界：首版为 SQLite/Windows 进程，后续为 PostgreSQL/Linux 进程；mock 不能证明 lease、隔离或外部效果正确。真实模型测试按仓库 opt-in 规则执行。

本轮只写方案，没有运行上述产品测试。现有 `package.json` 要求 Node `>=18 <24`，后续应使用满足仓库约束的运行时，不用当前系统 Node 版本不匹配的失败判断产品代码有问题。

建议证据结构：`test-results/bot-parity/<baseline>/<requirement-id>/`，保存测试条件、步骤、期望/实际、日志关联 ID、脱敏截图/录像、产物摘要、缺陷和复验记录。不得放真实 token、业务秘密或无权共享的对话。

`requirements.json` 中每个 `T-<ID>` 对应一个验收条目；可挂多个具体自动化或人工用例。只有证据齐备才从 planned → implemented → verified；不以 PR 合并自动标 verified。

## 10. 尚需核实的问题和解决方式

| 问题 | 当前已知 | 下一步核实与阻断范围 |
| --- | --- | --- |
| 当前原版版本与实际开关 | 源码 0.18；已实测官方 0.57.1 部分路径，见第 13 文档 | 固定真机版本/账户/平台，录制全状态；阻断最终体验一致声明 |
| Local Bots、共享房间、Network、广播 | 部分仅源码或帮助旁证 | 按 OBS-01～08 观察入口与行为；存在则纳入正式实现，不直接删项 |
| 共享 profile + 独立屏幕 | 原版文档有行为要求，现有 Cmb 为 Electron profile | P0 双 Bot 原型；不通过会阻断 P2 电脑验收 |
| Team Bot 公共通道使用个人插件 | 专项帮助描述存在歧义 | 用 owner/A/B/Slack 账号实测；阻断相关授权设计合并 |
| Team Bot 特殊电脑与计费 | 私聊与通道已明确有差别，异常路径仍需观察 | 记录各场景 placement/payer 与错误；阻断 TEAM-09/10/14 |
| 例程错过时点、复制后启用与数值上限 | 0.18 与现行帮助不完全重合 | 跨时区、复制、恢复和达到上限试验；阻断对应 AUT/BOT 验收 |
| 闭源模型、实时语音/图像供应商 | 本地源码不足以复制托管模型服务 | 适配可用模型并执行任务/媒体评测；阻断能力等效结论 |
| 最新连接器目录与供应商准入 | 文档/市场能列出能力，但不能证明 Cmb 已有授权应用 | 冻结目录、授权应用注册与每项验收；无凭据标 blocked 而非 completed |
| 企业网络列表数量冲突 | 文档无上限，Admin API 限 500 | 核实当前 UI/API 限制并保存版本；不写死“无限” |
| 权益与商业分发 | Cmb 内部账号不同于 Cursor/Grok/X 订阅 | 交付 Cmb 权益等价流程；若要求公开商店收费，必须追加真实支付实现并验收 |
| 目标生产平台/容量 | 首版纯 Windows 本机，后续 Linux K8s 已确定；容量尚未压测 | Windows G2A/G2B 原型、资源压测及恢复验收；后续 Linux Provider 单独核验 |
| 真实跨平台表现 | 当前工作区主要是桌面源码 | 平台设备/构建 CI 与实际媒体测试；阻断对应平台通过 |

这些问题没有被用来缩小目标。方案保留全部建设范围，并给出解除不确定性的具体步骤；“源码存在”与“产品可用”、“已设计”与“已验证”始终分开记录。

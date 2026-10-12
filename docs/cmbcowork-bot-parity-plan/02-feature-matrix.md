# 功能与验收矩阵

这是建设与验收清单，不是已实现功能表。每行 `T-<编号>` 是对应验收用例编号；当前状态均为 planned。

这是原全量矩阵。当前桌面核心的逐项纳入范围、混合条目替代验收和条件依赖以 [core-scope.json](core-scope.json) 为准；新增工程契约与核心验收见 [最终复核](11-core-final-review.md)。不能按章节或 P0～P5 整块删减。

来源编号在 [来源索引](sources.json) 中解析；GR/RK/OB/CM 分别代表重建源码、Rakazo、OpenBot 和 CmbCowork，W 代表官方页面。各项源码结论见 [源码分析](01-source-findings.md)。

清单含原版功能、为实现这些行为所需的工程要求，以及明确标出的 Cmb 适配；不代表每条技术实现都是官方内部设计。仅源码可见且发布情况不明的项目列在 OBS。部分数值来自 0.18，需要 P0 原版验证。账号品牌、收费渠道、企业默认限制采用文末适配规则。

共 **260 项**，其中 252 项建设需求、8 项待观察能力。清单总数表示本次拆分粒度，不表示对闭源产品的绝对穷举证明。

## ACC 账号、接入与首次使用

现有基础：现有登录/设置可适配；Bot 账号同步需新建。实现模块：**M01 身份与接入**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| ACC-01 | 统一身份 | 使用 Cmb 账号登录；浏览器授权回调绑定发起设备和账号；取消、超时、失败可恢复 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-02 | 首次引导 | 解释职责、电脑和任务；创建 Bot、准备电脑与推荐首项工作有明确进度；未连插件不显示已授权 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-03 | 多账号 | 添加/切换/移除本机账号时，草稿、缓存、通知、连接和权限不串账号 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-04 | 多端同账号 | 桌面与手机看到同一 Bot 列表和已持久化消息；一端退出不删除服务端工作 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-05 | 访问受限 | 未开通、被管理员禁用、额度不足、身份过期各有不同状态和恢复入口 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-06 | 设备与会话撤销 | 撤销设备后旧 token、WS 和电脑票据不可继续使用；其他有效设备按权限继续 | P2 | W-get-started, W-sign-in, CM11 |
| ACC-07 | 账户注销 | 提供重新认证、删除范围和状态；Cmb 员工账号停用与 Bot 数据删除分别处理 | P5 | W-delete-account, CM11 |
| ACC-08 | 试用和权益关联 | 保留权益接入/用量入口；Cursor、Grok、X 的品牌订阅关系映射为 Cmb 权益服务，不能宣称复用了官方账户 | P5 | W-plans |
| ACC-09 | 默认模型体验 | Bot 创建和执行不要求用户选择模型；管理端的路由、失败切换仍可追踪 | P2 | W-security, CM02 |

## BOT 个人 Bot 生命周期

现有基础：需要长期 Bot 实体；已有会话/子任务只能部分复用。实现模块：**M01 Bot Registry**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| BOT-01 | 自然语言建立职责 | 新建后直接聊天说明职责，不强制填写工具编排表 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-02 | 资料维护 | 姓名、标签、描述、头像可编辑；原图选择与生成头像都进入一致的保存流程 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-03 | 稳定身份 | 重启、跨设备、连续多次任务仍为同一 Bot；修改名称不改变 ID | P2 | W-bots, GR01, GR06, CM04 |
| BOT-04 | Bot 创建 Bot | 经数量与权限检查可建立新职责 Bot；新实体在侧边栏可见且可继续交谈 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-05 | 置顶与排序 | 置顶、取消、拖动排序、快捷键目标一致；重启与同步后顺序正确 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-06 | 自定义分区 | 新增、改名、折叠、移动、删除分区；删除分区只把 Bot 移回未分区 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-07 | 隐藏与恢复 | 隐藏保留任务、历史和例程，停止该 Bot 通知；隐藏列表能恢复 | P2 | W-how-to, GR15 |
| BOT-08 | 手动已读未读 | 读取位置与人工未读标记独立，重新打开能定位未读内容 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-09 | 复制 Bot | 生成新 ID；复制资料、配置、启用技能和例程；不复制历史、记忆、附件和秘密；该用户已有共享电脑登录仍可能可用 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-10 | 复制例程状态 | 明确展示复制后的例程与触发条件；若引入重新启用确认，标为 Cmb 差异并核对原版 | P2 | GR06, W-bots |
| BOT-11 | 删除 Bot | 确认后停止未来任务、取消待处理交互、移出群聊；保留共享电脑文件/登录的行为明确 | P2 | W-bots, GR01, GR06, CM04 |
| BOT-12 | 删除正在运行的 Bot | 晚到消息、worker 结果、后台唤醒不能复活已删除 Bot | P2 | W-bots, GR01, GR06, CM04 |
| BOT-13 | Bot 数量上限 | 配置上限与提示一致；以 0.18 的 50 为核实起点，不写死为当前官方所有计划上限 | P2 | GR01 |
| BOT-14 | 批量组织操作 | 多选/范围选择、批量移动或删除有数量确认，失败逐项返回 | P2 | GR15 |

## MSG 对话、消息和结果卡片

现有基础：已有消息渲染/流转换；Bot 协议与卡片需扩展。实现模块：**M03 消息同步 / M13 UI**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| MSG-01 | 消息收发 | 文本、链接、粘贴图片可发送；输入草稿按账号和会话保存 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-02 | 发送接收回执 | nonce 与 payload 摘要入库后才显示已接收；超时可查询接收状态 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-03 | 重复发送 | 同 nonce 同内容仅执行一次；同 nonce 不同内容拒绝，重连不会多出一条任务 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-04 | 执行中补充指令 | 用户新消息在安全边界优先处理；展示排队/已采纳，不静默吞掉或强断外部提交 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-05 | 停止任务 | 停止未来动作并结算已开始动作；显示已做和未做事项；不宣称撤销已产生效果 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-06 | 回复分支 | 对指定消息回复；主线与分支历史、计数、未读、深链接一致 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-07 | 表情回应 | 表情与消息绑定并同步；点赞不会被视为批准外部动作 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-08 | 技能命令 | 输入 / 搜索和插入可用技能，禁用或无权限技能不可调用 | P3 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-09 | 对象提及 | @ 可区分 Bot、群聊、例程、连接器；保存稳定实体 ID | P3 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-10 | 活动流 | 文字、工具、电脑操作、后台任务、问题与成果按稳定 ID 更新，不重复闪动 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-11 | 问题卡片 | 单选/多选/文字回答与取消均恢复对应运行；旧问题不能驱动新任务 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-12 | 审批卡片 | 展示准确目标、参数、原因和状态；批准/拒绝/过期/已处理明确 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-13 | 本地权限卡片 | 准确显示目标设备和命令；一次允许/始终/从不/本次拒绝语义不同 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-14 | 安全输入卡片 | 秘密不进入聊天或模型上下文；填充失败可重试且不回显明文 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-15 | 普通表单卡片 | 多字段校验、必填、取消和提交归属正确；秘密字段走单独安全通道 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-16 | 邮件草稿 | 可修改收件人、主题和正文；只发送最后确认版本；发送与丢弃真实改变状态 | P3 | W-chat, GR15, RK04 |
| MSG-17 | 消息草稿 | Slack 或对应通道草稿可编辑、发送、丢弃；防止重复点击导致重复外发 | P3 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-18 | 附件与成果卡 | 展示预览、下载、来源、版本；后续修改可关联原成果 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-19 | 错误通知 | 错误可关闭/清除/复制请求 ID；清除不删执行历史 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-20 | 全局搜索 | 检索 Bots/群聊/消息/文件/链接/例程并跳到位置；结果先过滤权限 | P4 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-21 | 长历史与滚动 | 分页、分支、展开工具、切换 Bot 后位置稳定；流式输出不抢用户正在阅读的位置 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |
| MSG-22 | 未知卡片兼容 | 旧客户端遇到新消息类型可读降级，不白屏且不提供不可执行按钮 | P2 | W-chat, GR01, GR02, GR15, GR16, CM10, CM11 |

## FIL 文件、产物与工作区

现有基础：现有解析与预览可复用；需云端存储/授权。实现模块：**M11 Artifact Service**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| FIL-01 | 上传限制 | 默认对齐 6 个附件、普通文件 25 MiB、视频 200 MiB；边界与超限提示可验收 | P2 | W-files, GR01, CM08 |
| FIL-02 | 格式处理 | 覆盖图片/音视频/PDF/文本/Office/CSV/JSON/YAML/代码/HTML/邮件/ipynb；不支持或加密内容明确报错 | P2 | W-files, GR01, CM08 |
| FIL-03 | 上传完成再发送 | 上传中、取消、失败、重试状态明确；未就绪附件不可进入已接收任务 | P2 | W-files, GR01, CM08 |
| FIL-04 | 多端访问产物 | 成果先入对象存储再发可用链接；跨设备下载有效且不可越权 | P2 | W-files, GR01, CM08 |
| FIL-05 | 文件预览 | 受控预览 HTML/Office/PDF/图像，不执行产物内宿主代码；文本可复制 | P2 | W-files, GR01, CM08 |
| FIL-06 | 产物修订 | 后续修改产生新版本或明确覆盖记录；旧消息不能下载到不相干的新文件 | P2 | W-files, GR01, CM08 |
| FIL-07 | 共享工作盘 | 个人 Bots 可访问同一 /workspace；重启文件仍在；并发写入有锁或版本冲突提示 | P2 | W-files, GR01, CM08 |
| FIL-08 | 外部链接 | 预览只读取允许的 URL；点击外链交给系统浏览器；内部深链接定位正确 | P2 | W-files, GR01, CM08 |
| FIL-09 | 文件来源与清理 | 区分上传、生成、临时、共享资源；删 Bot 不误删其他 Bot 使用的共享文件 | P2 | W-files, GR01, CM08 |

## CPU 持久电脑与人机交接

现有基础：现有本地浏览器部分可用；远程完整电脑需新建。实现模块：**M04 Computer Service**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| CPU-01 | 按用户持久电脑 | 个人 Bots 共用文件与登录态；不同用户的磁盘、内存、网络和显示会话隔离 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-02 | Bot 独立屏幕 | 不同 Bot 可在各自屏幕工作；同屏最多一个电脑操作持有者；创建/销毁不抢其他屏幕 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-03 | 共享浏览器登录 | 一次登录能供该用户其他 Bot 使用；不能并发启动多个进程写同一 Chrome profile | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-04 | 浏览器与桌面应用 | 既支持语义浏览器操作，也能截图/点按/键盘/滚动/拖拽操控桌面应用 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-05 | Shell 与后台命令 | 执行、标准输出、超时、取消、持续进程和完成唤醒在无桌面客户端时工作 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-06 | 观看电脑 | 打开预览、展开、全屏、切换屏幕；关闭 viewer 不停止任务 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-07 | 人工接管 | 同屏 Bot 暂停发新动作，用户独占控制；归还后重新观察再继续 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-08 | 登录与人工步骤 | 登录/MFA/验证码/支付等进入明确接管状态，完成、跳过、取消各自可返回任务 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-09 | 查看器故障 | 区分电脑离线、鉴权过期、画面连接失败与任务失败；重试不会创建第二台电脑 | P2 | W-computer, W-computers, GR12, CM08 |
| CPU-10 | 电脑休眠唤醒 | 空闲可休眠；消息、例程、事件可唤醒；持久盘和任务状态保留 | P3 | W-computer, W-computers, GR12, CM08 |
| CPU-11 | 电脑更新 | 先准备新环境，在可恢复边界交接；无法安全暂停则失败并保留旧环境 | P5 | W-computer, W-computers, GR12, CM08 |
| CPU-12 | 电脑恢复 | 展示可用恢复点与可能损失的近期状态；原环境不可达时不宣称已保存所有内容 | P5 | W-computer, W-computers, GR12, CM08 |
| CPU-13 | 电脑重置 | 独立于更新/恢复，明确使用哪个持久快照；实际重建完成后再报告成功 | P5 | W-computer, W-computers, GR12, CM08 |
| CPU-14 | 软件安装与配置 | 支持在电脑安装工具；重建后由 Team Setup 重装受管软件，持久数据边界清楚 | P5 | W-computer, W-computers, GR12, CM08 |
| CPU-15 | 磁盘容量和 Disk Saver | 云盘不足显示告警，专用清理 Bot 分析并提出删除方案；批准前不清理 | P5 | W-faqs, GR01 |
| CPU-16 | 电脑状态诊断 | 容量、版本、连接、同步时间、更新进度与请求 ID 可查看 | P5 | W-computer, W-computers, GR12, CM08 |
| CPU-17 | 分辨率与输入映射 | 窗口缩放、高 DPI、全屏、中文输入、快捷键不产生点击坐标偏移 | P4 | W-computer, W-computers, GR12, CM08 |
| CPU-18 | 跨端接管竞争 | 手机和桌面同时接管时只有一方持有有效 lease，另一方得到可解释状态 | P4 | W-computer, W-computers, GR12, CM08 |

## DEV 本地电脑与网络桥

现有基础：已有本地执行工具；设备桥与远程策略需扩展。实现模块：**M19 Device Bridge**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| DEV-01 | 本地设备注册 | 服务端列出已注册电脑、名称和在线状态；只在设备授权范围内派发命令 | P3 | W-settings, W-security, GR11 |
| DEV-02 | 本地执行策略 | 每台设备支持询问/始终允许/从不允许；用户更严格设置不能被团队上限放宽 | P3 | W-settings, W-security, GR11 |
| DEV-03 | 本地执行生命周期 | 设备离线可解释等待/失败；重连不得重跑结果不明的外部动作 | P3 | W-settings, W-security, GR11 |
| DEV-04 | 设备出口代理 | 可选择通过在线桌面访问网络；断开后不静默绕过策略切换到其他出口 | P3 | W-settings, W-security, GR11 |
| DEV-05 | 管理员禁止出口 | 关闭策略后旧 tunnel 在限定窗口内停止；保留用户偏好供重新允许后恢复 | P5 | W-settings, W-security, GR11 |
| DEV-06 | WebAuthn 代理 | macOS/Windows 支持本机密钥确认；每次请求绑定 origin/challenge/设备；Linux 显示不可用 | P4 | W-settings, W-security, GR11 |
| DEV-07 | 私有网络接入 | 受管电脑可安装网络客户端；网络策略单独生效，不将插件授权视为网络授权 | P5 | W-settings, W-security, GR11 |
| DEV-08 | 本地 Bot 运行位置 | 预留 placement 和本地宿主；当前完整 Local Bot 的创建/迁移/离线行为待原版实测，不冒充已确认能力 | P4 | W-team-bots, GR11 |

## COL 多 Bot 协作

现有基础：有任务型 workers；长期同级 Bot 通信需新建。实现模块：**M05 Collaboration**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| COL-01 | Bot 直接通信 | 发送/接收与结果可追溯，可展开独立只读 Bot 交流记录；接收方不依赖其聊天窗口打开而被唤醒。 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-02 | 交接与结果返回 | 区分 request/question/status/result；持久关联原请求，结果回到正确会话/分支 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-03 | 重复与失败投递 | 发送后断线、接收前重启、回执丢失均可恢复；同 delivery key 不重复唤醒 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-04 | 循环控制 | 限制消息链深度、并发与预算；到界限向用户报告卡点，不无限互相唤醒 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-05 | 创建群聊 | 2–6 个 Bots，支持名称、描述和成员编辑；无权成员不能加入 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-06 | 群聊路由 | 普通发言选 responder；@单人/@多人/@everyone 确定目标；群指令不泄露到无关会话 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-07 | 发言范围 | 群内答复留在群内，私下 Bot 交接留在对应私聊；能从群看到必要的协作进展 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-08 | 群聊停止与改口 | 新用户指令使旧编排 epoch 失效；迟到发言不继续触发旧任务 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-09 | 协作附件 | 用户群消息能附文件；Bot→群按已确认 text-only 边界；直接 Bot 消息支持图像 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-10 | 并行工作与资源冲突 | 独立工作可并行；共享文件、屏幕、同一外部记录的修改按资源协调 | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-11 | 任务型子代理 | 短期子任务继续复用 coordinator/workflow，返回状态/产物；不伪装为常驻 Bot | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |
| COL-12 | 编码任务委托 | 独立工作区执行、查询、补充、取消；结果携带代码差异/验证证据和可选 PR | P3 | W-chat, W-group-chats, GR04, GR05, RK03, CM04 |

## MEM 长期记忆与上下文

现有基础：global/project 记忆可复用；Bot/成员作用域需扩展。实现模块：**M06 Memory**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| MEM-01 | 长期职责记忆 | 新任务和重启后使用角色、偏好和已确认经验，不要求重放全部聊天 | P3 | W-bots, GR07, CM07 |
| MEM-02 | 记忆作用域 | 个人 Bot、用户共享、项目、Team Bot 公共、成员私聊可明确区分并按权限检索 | P3 | W-bots, GR07, CM07 |
| MEM-03 | 显式记忆 | 用户要求记住的事实带来源和显式标记；自动整理不能覆盖 | P3 | W-bots, GR07, CM07 |
| MEM-04 | 自动整理 | 从已结束任务提炼事实，附证据 ID 并独立核验；失败不损坏旧记忆 | P3 | W-bots, GR07, CM07 |
| MEM-05 | 纠错与删除 | 改正旧事实或删除记忆后，旧会话的汇总不能再次写回被删除内容 | P3 | W-bots, GR07, CM07 |
| MEM-06 | 时效管理 | 过期计划只能标为过去，不能推断已经完成；重要决策重新查源系统 | P3 | W-bots, GR07, CM07 |
| MEM-07 | 协作上下文 | 共享资料和消息传递相关证据；不把所有 Bot 私聊直接塞入每个 Bot | P3 | W-bots, GR07, CM07 |
| MEM-08 | 记忆更新冲突 | 异步提炼使用版本/CAS；快照过期重算，不覆盖最新人工修订 | P3 | W-bots, GR07, CM07 |

## SKL Skills 与示范学习

现有基础：已有技能与浏览器录制；缺学习/验证产品链路。实现模块：**M07 Skills & Teach**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| SKL-01 | 私有技能库 | 用户技能跨个人 Bots 可用；支持启停、更新、删除及文本/URL/本地技能导入，检查依赖并定位固定版本 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-02 | 技能定义 | 技能包含适用条件、输入、步骤、分支、完成检查、产物和授权边界 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-03 | 插件技能同步 | 安装/更新/卸载插件时技能目录与实际可调用能力一致 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-04 | 开始教学 | 一对一电脑视图明确目标 Bot/屏幕，点击 Teach 可开始录制；目标可从演示和上下文理解，歧义时追问，不强制前置目标表单。 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-05 | 录制行为 | 记录可见屏幕及操作事件，最多 10 分钟，不录麦克风；中途退出可保存或丢弃 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-06 | 教学隐私 | 登录和秘密输入经安全通道；录制中出现敏感界面可暂停/遮挡，并提醒用户确认草稿 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-07 | 生成技能草稿 | 结合目标、视频和事件提取参数、定位、判断、验证；不是机械回放坐标 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-08 | 技能审阅与修改 | 生成技能后提供可打开的名称、描述和步骤/参数内容，支持修改保存；区分已保存与已验证，不强制增加未观察到的独立草稿向导。 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-09 | 技能真实验证 | 换一份输入试跑，检查目标系统与产物，给出成功/失败证据；测试本身仍需动作授权 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-10 | 学习任务恢复 | 录制完成后服务崩溃可继续生成草稿；不能产生重复技能或丢失视频 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-11 | 技能转例程 | 验证后的技能可交由 Bot 按计划或事件运行；技能升级不静默扩大原授权 | P3 | W-skills, GR08, RK05, CM08 |
| SKL-12 | 团队技能发布 | 发布/更新/撤回使用版本与范围；私有技能不会自动公开 | P4 | GR01, GR13, W-skills |

## AUT 计划、事件和后台持续运行

现有基础：本地 scheduler 有基础；需服务端调度与外部事件。实现模块：**M08 Automation**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| AUT-01 | 自然语言创建 | 用户说何时做什么，Bot 形成例程；从已提交配置回读 Instruction、触发类型、时区与 revision，聊天事件、列表及详情一致；不增加原版未出现的必经确认表单 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-02 | 编辑入口 | Edit 预填修改消息，由 Bot 修改原例程；打开中的详情同步更新，重连补齐最新 revision；不强制暴露 cron 配置 | P3 | W-routines |
| AUT-03 | 计划与时区 | 日/周/月/年/间隔/单次和 IANA 时区可表达；单次与年度重复分开；验证未来两个触发点、夏令时和换时区语义，不能静默改成单次 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-04 | 创建不立即执行 | 新计划等下个时点；立即执行由用户明确 Test 发起 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-05 | 暂停与恢复 | 暂停阻止未来发生；恢复重新计算下次时间；不默认撤销已开始动作 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-06 | 测试例程 | Test 按例程能力显示；支持时真实执行并记录独立 occurrence、运行状态及同 Bot 结果，失败可定位；不能假设原版每条任务均有 Test | P3 | W-routines, GR09, CM05, RK02 |
| AUT-07 | 执行历史 | 提供分页执行历史，展示运行状态、触发原因、时间和错误；这是 Cmb 验收要求，当前原版样本未显示历史控件 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-08 | 删除例程 | 按当前专项帮助显示确认；删除后未来事件不执行，旧记录/在途动作有明确结算 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-09 | 例程数量 | 每 Bot 上限按配置校验，0.18 的 50 作为兼容基线；服务端与 UI 一致 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-10 | Slack 触发 | 提及、关键词、反应、消息与频道过滤可配置；触发授权与调用 Slack 插件分开 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-11 | GitHub 触发 | 仓库/事件范围可约束；重复通知合并或去重，结果在任务内有来源 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-12 | Linear/Sentry/PagerDuty 触发 | 实现官方专项帮助所列事件；配置、验签、测试和失败状态完整 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-13 | 邮件触发 | 限定邮箱、匹配条件、游标与去重；不把邮件正文中的指令当系统授权 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-14 | Webhook 触发 | 显示 URL/key/header；验证 Bearer key；HTTP 200 只表示已接收启动，不表示完成 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-15 | 触发密钥管理 | 可替换并撤销旧 key；日志、聊天和复制提示不泄露无关密钥 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-16 | 复合触发 | 源码支持多个触发条件组合；明确 OR/合并窗口与最大数量，配置回读不丢条件 | P3 | GR09 |
| AUT-17 | 断电与漏触发恢复 | 调度落库，宿主离线后恢复；同 occurrence 只生成一个运行，漏跑采用明确策略 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-18 | 用户久未使用 | 支持确认持续运行及暂停状态，说明原因，用户恢复后继续 | P3 | W-routines, GR09, CM05, RK02 |
| AUT-19 | 触发风暴与用量 | 限流、预算、去重和失败告警；停止后不因已有队列立即无限重启 | P3 | W-routines, GR09, CM05, RK02 |

## PLG 插件、连接器与市场

现有基础：已有 MCP/插件框架；云端凭据和 Bot 市场需扩展。实现模块：**M09 Connector Service**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| PLG-01 | 插件发现 | 可浏览、搜索、查看详情、安装与移除；团队禁用状态明确 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-02 | 授权生命周期 | 安装/需认证/等待授权/已连接/失效分开；可 Reopen/取消/重试 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-03 | 账号范围 | 个人安装作用于该用户 Bots；Team Bot 使用个人账号需另行授权 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-04 | 多账号差异 | 按 provider 声明能力显示添加账号；Gmail 单账号与 Notion 可多账号不混淆 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-05 | 工具级控制 | 查看工具列表、逐项禁用及自定义说明，服务端执行时再检查 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-06 | 远程与 stdio MCP | 后台托管连接器与用户电脑进程分别管理，均可在无 UI 时执行 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-07 | 凭据保管 | OAuth token 保存在连接器服务，刷新与撤销可用；模型只接收工具结果 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-08 | 插件依赖变量 | 必填变量和授权齐全才可用；敏感值不放入模型提示或普通配置导出 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-09 | 第三方权限限制 | 目标服务无权限/管理员待批准/速率限制提供真实原因，不把 Added 当作 Authenticated | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-10 | 技能与资源 | 插件提供工具、Skills 和 MCP resources，实际目录与服务端可调用范围一致 | P3 | W-connect-plugins, GR13, CM02, CM12 |
| PLG-11 | 断开与卸载 | 撤销后在途调用按边界结算，后续调用拒绝；清理引用且不破坏其他插件 | P3 | W-connect-plugins, GR13, CM02, CM12 |

## APR 审批、秘密与动作执行

现有基础：已有权限和 Mods 边界；需持久交互与云端策略。实现模块：**M10 Policy / Interaction**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| APR-01 | 自动审核 | 独立审查动作相对用户请求的风险；对 Shell/MCP/电脑/例程变更/委托均覆盖 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-02 | 允许一次/始终/拒绝 | 始终允许只产生可解释的窄规则；拒绝动作后不能自动换通道重做同一外部行为 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-03 | 规则优先级 | Ask first 优先；Allow automatically 仍接受其他检查；管理员锁定项不可编辑 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-04 | 精确动作绑定 | 批准绑定最终参数摘要、账号、目标资源、版本、run generation；改参数须重新决策 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-05 | 多端竞争 | 两端同时回答只一个成功；另一端显示已处理；不能执行两次 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-06 | 过期与改口 | 超时、用户新指令、环境重建、权限变化均可废止旧卡；自动任务可持久等待 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-07 | 动作结果不明 | 外部提交后断线进入 uncertain；查询外部状态或人工核对后再决定重试 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-08 | 真实目标解析 | 从服务端快照解析元素/资源，拒绝过期 ref；不接受模型自报目标名称替代 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-09 | 接管互斥 | 人工持有电脑时所有 Bot 输入通路都被网关阻止，非只禁用 UI 按钮 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-10 | 秘密录入 | 卡片掩码；存储成功有确认，聊天/日志/模型中不可见原值 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-11 | Bot 秘密管理 | 仅显示名称与说明，支持新增/替换/删除；不提供读取旧值给 Bot 的工具 | P3 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-12 | 安全页面填充 | 秘密直接交给受限填充器；页面变化时失败，不把值退回 Bot | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-13 | 模板与复制秘密 | 默认不导出秘密；Team Bot 发布迁移资源必须逐项选择并明示共享范围 | P4 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-14 | 规则不是权限 | 描述/记忆/群消息只能提供任务上下文，不能扩大签名执行上下文的权限 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-15 | 权限撤回 | 账号、插件、Bot、成员、设备授权撤回后新动作立刻检查有效版本 | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |
| APR-16 | 审计前置 | 记录动作意图和授权决定后执行，再写结果；事件脱敏且可关联 run/actor | P2 | W-approvals, W-secrets, GR10, GR11, RK04, OB02, CM09, CM12 |

## SHR 模板与分享

现有基础：已有插件市场概念；Bot 模板产品需新建。实现模块：**M18 Template Catalog**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| SHR-01 | 创建模板 | 保存 Bot 资料、描述、技能和例程配置的可发布快照 | P4 | W-bots, W-marketplace, GR01 |
| SHR-02 | 分享范围 | 公共链接/团队链接分别检查；企业默认团队范围，并服从管理员公开分享设置 | P4 | W-bots, W-marketplace, GR01 |
| SHR-03 | 模板预览 | 未安装也可看范围内的资料、创建者、所需插件与技能；无权模板不可泄露详情 | P4 | W-bots, W-marketplace, GR01 |
| SHR-04 | 从模板创建 | 生成自己拥有的新 Bot；不复制作者历史、电脑、登录与附件 | P4 | W-bots, W-marketplace, GR01 |
| SHR-05 | 模板更新 | 更新已发布配置有版本；既有导入副本不静默改变职责和权限 | P4 | W-bots, W-marketplace, GR01 |
| SHR-06 | 撤回与链接失效 | 撤回后新用户不可导入；现有副本保留其自有身份与数据 | P4 | W-bots, W-marketplace, GR01 |
| SHR-07 | 市场浏览 | 分类、搜索创建者/Bot 名、精选和详情到创建完整可用 | P4 | W-bots, W-marketplace, GR01 |
| SHR-08 | 依赖补齐 | 导入后缺插件/权限/技能给出设置步骤；未就绪例程不能误执行 | P4 | W-bots, W-marketplace, GR01 |

## TEAM Team Bots：多人使用同一 Bot

现有基础：需要新共享 Bot 领域；不得以模板复制代替。实现模块：**M17 Team Bot Service**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| TEAM-01 | 创建团队 Bot | 专门新建入口，默认未发布；按插件、秘密、文件完成团队可用资源设置 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-02 | 个人转团队副本 | 原 Bot 继续存在；选择迁移记忆/秘密/例程；不移动个人聊天 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-03 | 发布与撤回 | 名称/描述就绪后发布；撤回立即阻止成员新执行，原主人仍可管理 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-04 | 发现与链接 | 团队列表、名称搜索和链接进入同一共享 Bot，不生成个人副本 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-05 | 成员私聊 | 各成员有独立会话；发布者及其他成员不能读取彼此私聊和个人记忆 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-06 | 团队共同记忆 | 提炼团队通用知识时告知用户；个人偏好和私聊信息不得直接写入公共记忆 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-07 | 发布者资源 | 所选插件、秘密、技能、文件能供团队任务使用；读取范围和来源明确 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-08 | 个人连接器授权 | 一次允许/对该 Bot 永久/对所有 Team Bots 永久/跳过；可清除偏好 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-09 | 凭据选择 | 运行上下文同时记录 Bot owner、发起人、账号 owner 和计费人；成员 A 账号不用于 B | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-10 | 电脑选择 | 私聊通常用发起人成员电脑；群聊/Slack 用 Team Bot 专用电脑；隐私不兼容走独立分配或明确拒绝 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-11 | 团队场景审批 | 发布者私聊可回答动作审批；其他表面仅在预授权范围内执行，无人可审批不等于自动批准 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-12 | Slack 接入 | 发布后连接、管理员待审批、成员账号绑定、私信和频道提及均完整 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-13 | 成员群聊 | 发布 Team Bot 可入群，不能与不兼容的本地 Bot 混组；身份和资源隔离仍成立 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-14 | 用量归属 | 成员私聊计入该成员；其他通道的计费主体需冻结规则，界面与账本一致 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-15 | 管理权限 | 仅 owner 可修改/删除；成员可隐藏，强制分发的 Team Bot 不可隐藏 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-16 | 删除影响 | 确认影响全团队，关闭新访问/例程，按保留策略处理各成员私聊；不泄露给 owner | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-17 | 手机使用 | 能聊天及回答连接器 Allow 卡；创建/发布/Slack 设置在桌面；同事 Team Bot 不提供语音通话 | P4 | W-team-bots, W-cursor-teams, W-secrets |
| TEAM-18 | 管理员分发 | 按全团队/指定组/无分发同步侧边栏，撤回与用户离组及时生效 | P5 | W-team-bots, W-cursor-teams, W-secrets |

## VOC 语音能力

现有基础：未发现完整现成链路；需语音服务和客户端。实现模块：**M12 Voice**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| VOC-01 | 听写 | 录音后转文字进入草稿可编辑；快捷键、取消、无麦克风、权限拒绝和失败重试明确 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-02 | 实时语音 | 空输入框入口，连接/通话/静音/挂断完整；模型可经同一任务服务调用工具 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-03 | 语音设置 | 音色、速度、语言自动检测与麦克风选择生效且保存 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-04 | 跨页面通话 | 切换聊天不挂断；可返回正在通话的 Bot；开始另一通话先确认结束前一个 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-05 | 通话转写 | 可展开实时文字，结束后显示时长、完整通话记录与可选评价，不重复生成文本任务 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-06 | 通话后续任务 | 挂断不会丢掉已交办任务；结果可稍后回到同一会话 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-07 | 语音便笺 | Bot 可发音频，支持播放/暂停/展开转写，多端可用 | P4 | W-voice-chat, W-chat, GR15 |
| VOC-08 | 通话限制与故障 | 群聊和同事 Team Bot 不显示通话；断线说明原因，重新发起不自动重复已执行动作 | P4 | W-voice-chat, W-chat, GR15 |

## UI 桌面体验与可访问性

现有基础：现有桌面壳可复用；新增专门 Bot 工作区。实现模块：**M13 Desktop UI**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| UI-01 | Bot 工作区入口 | 与现有项目/Feature 工作台衔接；进入 Bot 后创建/聊天/电脑的主要操作路径一致 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-02 | Bot 详情 | 资料、Tasks/例程、Skills、文件、秘密、分享入口有统一位置和返回路径 | P3 | W-settings, W-how-to, GR15, CM11 |
| UI-03 | 状态区分 | 工作中、未读、待审批、待回答、待接管、错误独立，不用一个红点表示所有情况 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-04 | 通知行为 | Bot 完成/需输入时通知；隐藏和静音生效；前台抑制桌面系统提醒但保留未读 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-05 | 全局快捷键 | 按平台对齐聊天、切换、查找、市场、详情、设置、缩放、全屏；无快捷键冲突 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-06 | 主题与语言 | 系统/浅/深主题；语言切换、字体、长文案、时区，桌面全语言目录按基准验证 | P4 | W-settings, W-how-to, GR15, CM11 |
| UI-07 | 焦点和可访问性 | Tab 顺序、焦点恢复、屏幕阅读器、缩放、高对比和减少动画不破坏操作 | P4 | W-settings, W-how-to, GR15, CM11 |
| UI-08 | 菜单细节 | 右键、悬停、复制会话 ID、复制请求 ID、重命名/隐藏/删除按实际权限显示 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-09 | 错误与离线态 | 保留未发送草稿，区分 API 断线、电脑断线、模型失败与账户禁用 | P2 | W-settings, W-how-to, GR15, CM11 |
| UI-10 | 视觉一致性 | 固定版本/窗口尺寸/字体对照截图；空态、菜单、卡片、loading、error 均验收 | P5 | W-settings, W-how-to, GR15, CM11 |
| UI-11 | 应用更新 | 检查/下载/重启/失败重试和最低版本拦截；客户端更新不停止云端工作 | P5 | W-settings, W-how-to, GR15, CM11 |
| UI-12 | 关于与帮助 | 版本、发布通道、系统信息、帮助和反馈可获取；诊断包先脱敏 | P5 | W-settings, W-how-to, GR15, CM11 |

## MOB 移动客户端

现有基础：需新移动客户端；招乎只作补充入口。实现模块：**M14 Mobile**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| MOB-01 | 平台与登录 | iOS/iPadOS 18+、Android 9+；统一账号、首次引导和会话续期 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-02 | Bot 与群聊 | 创建、资料、成员、置顶、隐藏、删除；按平台支持的分区手势同步桌面 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-03 | 消息草稿 | 文本、分支、表情、草稿恢复、发送去重与桌面一致 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-04 | 照片和文件 | 相机/相册/文件选择、上传进度、预览和下载；系统权限失败有恢复路径 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-05 | 系统分享 | iOS 文本/链接/照片/文件进入指定会话草稿；Android 至少覆盖已确认文本分享 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-06 | 电脑观看和接管 | 手机看画面并操作，适应触屏/键盘；控制 lease 与桌面互斥 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-07 | 审批与安全输入 | 批准/拒绝/账号 Allow/秘密卡准确回到原任务，多端竞争只消费一次 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-08 | 草稿发送 | 邮件/Slack 草稿可编辑与确认发送，手机不落掉必填字段 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-09 | 听写/语音/便笺 | 完整接入语音服务；后台/来电/耳机切换后状态可恢复 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-10 | 例程管理 | 查看/暂停/恢复/删除/运行历史与 Add routine 预填消息；编辑/测试入口按官方平台范围 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-11 | 插件和设置 | 安装/授权回跳、主题、语言、时区范围、用量和通知设置符合移动端能力 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-12 | 推送与深链接 | 推送权限、Bot 开关、隐藏状态均生效；点击打开准确消息且不跨账号 | P4 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-13 | 退出与账号删除 | 退出清理本机敏感缓存；删除走重新认证和明确的数据范围 | P5 | W-mobile, W-cursor-mobile, W-team-bots |
| MOB-14 | 电脑维护限制 | 手机不伪装已有更新/恢复/重置电脑入口；有清楚的桌面处理指引 | P4 | W-mobile, W-cursor-mobile, W-team-bots |

## ADM 团队与企业管理

现有基础：已有受管配置概念；完整 Bot 控制面需新建。实现模块：**M15 Admin**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| ADM-01 | 启用与访问范围 | 全组织开关及成员组访问，禁用立即阻止新任务而不误删持久盘 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-02 | SSO/SCIM | 接企业身份，自动入组/离组与会话撤销；登录客户端与电脑内业务系统登录分开 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-03 | 成员和组织角色 | 组织管理员、团队管理员、Bot owner、普通成员权限分开；电脑跨团队操作需组织权限 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-04 | 能力策略 | 云端编码委托、公开模板、本地执行上限、出口代理分别控制 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-05 | 团队/组规则 | 团队基线、组例外、锁定及多组组合给出 effective policy，用户界面可解释 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-06 | Auto-review 强制 | 管理员规则与个人规则组合，Ask first 优先；只在有效强制策略下应用相应团队规则 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-07 | 连接器策略 | 允许/禁止插件与网络访问分别执行；不把禁止插件误称为完全阻断目标网站 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-08 | 网络策略 | 四种模式、域名/IP/CIDR/端口、组覆盖与锁定；运行中更新可在约定时间生效 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-09 | TLS/代理兼容 | 验证 HTTP 流、WS、画面及证书链；API 可通而电脑不可通要能诊断 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-10 | Team Setup 清单 | 脚本 ID/setup/check，串行执行；check 成功跳过安装；启动、周期刷新、重装可用 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-11 | Setup 超时和失败 | 单脚本 30 分钟限时；失败不阻止整台电脑启动，后续可重试并显示结果 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-12 | Team Secrets | 只写、替换、删除；注入安装脚本进程且日志脱敏，不能混为 Bot Secrets | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-13 | 多团队秘密边界 | 多个团队的 setup 共用一台电脑时按原版规则不注入团队秘密，避免跨团队混用 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-14 | 批量电脑操作 | 选择成员执行 recreate/terminate/delete-data；进度按成员返回，关闭页面不停止后台操作 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-15 | 批量操作幂等 | 重复 Start 不重复重建，单团队操作互斥，无电脑/成员离组/重建冲突分别报告 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-16 | 空闲电脑回收 | 支持 30 天无使用后的 terminate，默认关闭；保留持久盘，再次使用可恢复 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-17 | 控制面审计 | 创建 Bot、授权、成员、插件、例程、管理操作有 actor 与时间，能查询和导出 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-18 | 动作记录 | 工具、Shell、电脑、文件、消息、例程、委托有执行元数据；默认脱敏不导出完整内容 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-19 | OTel 与内容导出 | 元数据导出和内容/工具 I/O 导出分开开关，不回填历史；收集器故障不丢关键记录 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-20 | 用量和预算 | 成员/Bot/模型/任务用量可归因；周额度、额外用量和月上限分开，运行中超额策略明确 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-21 | Admin API | 版本化的启用/能力/审核/访问/网络/规则/Setup API，分页、冲突、权限和幂等有契约 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |
| ADM-22 | 数据保留与删除 | 成员停用、Bot 删除、账号删除、电脑 terminate 与 delete-data 分开；删除状态可核验 | P5 | W-cursor-teams, W-security, W-private-networks, W-admin-api |

## OPS 可靠性、部署与运行质量

现有基础：需在现有内核外建设服务端保障。实现模块：**M02 Runtime / M16 Operations**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| OPS-01 | 无客户端执行 | 云端已接收任务、例程和 Bot 协作不依赖客户端在线；依赖本地执行/设备出口的步骤在设备离线时明确等待 | P2 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-02 | 原子任务接收 | 消息、运行、outbox 同事务提交；HTTP/WS 应答丢失可以查询，不出现假成功 | P1 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-03 | 跨进程租约 | DB 时间、fence、heartbeat 控制所有写入和工具派发；旧 worker 不可继续提交 | P1 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-04 | 故障恢复 | 杀进程/网络分区/节点迁移后按 checkpoint 和动作收据恢复，unknown 不盲重放 | P2 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-05 | 备份与恢复演练 | 数据库、工作盘、浏览器持久状态和附件有一致 manifest；随机抽样实际恢复 | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-06 | 升级与回滚 | 协议向后兼容，读旧写新迁移可回滚，旧宿主不能被启动成第二个活跃 owner | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-07 | 容量与公平调度 | 同一用户/团队的高频 Bot 不饿死其他任务；多屏、模型、内存、磁盘分别限额 | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-08 | 端到端可观测 | 从 clientNonce 到 run/lease/tool/approval/artifact 有关联 ID 和可定位时间线 | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-09 | 全平台分发 | mac 双架构、Win 双架构、Linux 双架构及 deb/rpm/AppImage；签名、升级和安装恢复 | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-10 | 任务能力评测 | 原版与 Cmb 相同任务、输入、账号权限下重复评测成功率/介入/时延/成本 | P5 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-11 | 现有功能回归 | 桌面会话/项目/Feature/IM/Goals/Coordinator/Workflow/Mods 不因抽宿主失效 | P1 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |
| OPS-12 | 数据迁移 | 旧 Thread 和本地记录可按明确选择关联 Bot；不自动上传全部历史、凭据或项目文件 | P2 | GR02, GR12, RK01, RK02, OB01, CM01, CM05 |

## OBS 源码出现或产品文档未充分确定的能力

现有基础：保留任务与核实入口，不能标记完成。实现模块：**M13 / M17 / M19**。

| 编号 | 功能 | 验收检查 | 阶段 | 来源 |
| --- | --- | --- | --- | --- |
| OBS-01 | 跨用户共享房间 | 验证邀请/加入审批/退出/移出和远端 Bot 镜像；与 Team Bot、模板分开 | P4 | GR01, GR15 |
| OBS-02 | Agent Network 图 | 核实当前开关与界面是否公开；若目标版本可见则复刻节点、关系和跳转 | P4 | GR01, GR15 |
| OBS-03 | 广播消息 | 核实群发目标、内容、确认及回执；不以普通群聊模拟私聊广播 | P4 | GR01, GR15 |
| OBS-04 | 侧边栏异步任务入口 | 核实任务、Shell、云代理状态列表和跳转，覆盖源协议 getAsyncTasks | P4 | GR01, GR15 |
| OBS-05 | 技能发布目标管理 | 核实发布/重新同步/撤回和团队目标；当前源接口不能证明所有账户可用 | P4 | GR01, GR15 |
| OBS-06 | 当前 Local Bots | 验证完整本地 Bot 入口、创建/迁移、跨设备可见性及不能进入 Team 群的限制 | P4 | GR01, GR15 |
| OBS-07 | Team Bot 私聊资源混用 | 核实个人插件在群聊/Slack 的允许范围及隐私不兼容电脑选择 | P4 | GR01, GR15 |
| OBS-08 | 模型生成媒体工具 | 协议存在图像生成/录屏；核对实际工具可调用范围，不能把整个 Grok Imagine 当 Bot 功能 | P4 | GR01, GR15 |

## Cmb 适配项：显式差异，不算原版已复刻

1. **账号/品牌/商业权益：** 使用 Cmb 账号、组织开通与预算。保留登录、用量、权益不足、升级申请和停用流程；不提供假的 Cursor/SuperGrok 关联或 Apple/Google 付费成功。若面向外部商业发行，另实现真实订阅/支付、恢复购买、取消入口和账单服务，届时逐项验收。
2. **网络和策略：** 可由管理员选择更严格的内部部署策略，但必须向用户明确受限能力；默认体验与可用功能分别评审，不能把禁用功能记成实现完成。
3. **连接器生态：** 先提供框架和经核实的目标连接器目录；每个连接器必须有真实授权、工具和失败处理。企业内部系统适配属于增强，不能用其替代官方同名连接器而不说明。
4. **Local Bots 等 OBS：** 待观察项始终留在发布跟踪中。P0 若证明目标版本存在则转正式需求，若证实为未发布/不可用则保留证据后标为该版本不适用，不能靠实现困难关闭。
5. **测试证据：** 每行验收需要实际记录或自动化报告；只有代码、截图或按钮占位都不能标为通过。

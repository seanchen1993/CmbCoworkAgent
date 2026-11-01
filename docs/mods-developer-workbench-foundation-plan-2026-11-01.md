# 开发者工作台基础补齐与最终验收

用户在第三阶段真实验收中要求再次审查软件开发场景的基础扩展能力，补齐后才进行最终性能测试。本计划承接既有工作，不替换原项目创建、配置、Feature 和执行流程，不增加 AutoBiz 平台分支，多模态暂不做。版本保持2.0.0，只提交和推送开发分支，不打包或触发 Actions。

状态：两路独立 medium 源码审计及具体方案双审通过。第一审的3项P1和第二审的2项P2均已写入下列实现、验收条件，两位对最终文本确认无剩余阻断，开始开发。自有 ZIP 再派生协议修复已单独双审通过，正在实施。此前真实模型、失败及已完成节点保留，不能因新工作而抹去，也不重复整套业务。

## 审计结论

方法数量不能证明工作台可用。按“作者可发现→当前来源授权→真实生产者→用户入口→结果、取消和撤权”的路径核查。

| 开发场景 | 已有底座 | 还需接通 |
| --- | --- | --- |
| 文件、搜索和修改 | 原生 read/write/edit/ls/glob/grep、文件权限、真实写回回执 | 复用物理 watcher，提供有界变化订阅，不新造扫描器 |
| 代码理解 | 原生 LSP 定义、引用、悬停、符号、诊断和调用层级服务 | Mods 的只读能力桥及准确可发现契约 |
| 文件查看与定位 | 原文件预览、文件查看器、原生 IDE 打开入口 | 当前工作区的来源绑定导航意图和实际接收回执 |
| 测试、构建和后台命令 | process.run/spawn、原生工具、输出、取消、workflow 和真实退出信息 | 通用示例把命令配置、真实任务状态及输出连成面板；不加 npm/Maven 业务运行器 |
| Git 与工作树 | 原生仓库检查、目录授权、workflow 与 owned worktree ledger | 在示例和能力说明中接通；不把只读仓库权限升级为提交、合并权限 |
| 页面、状态与动作 | 五种 surface、Box/Form/Table/Chart/Client、命令、局部快捷键、store/state、通知 | 清楚标注入口位置和能力范围，示例展示完整开发工作台组合 |
| 再次派生 | 作者源、原插件上传、真实项目执行 | 自家 packer 报告与派生 reader 的元数据协议闭环 |

独立审计主要证据：`tool-sdk.ts`、`process-sdk.ts`、`platform-native-providers.ts`、`platform-git-provider.ts`、`src/main/lsp/index.ts`、`platform-native-file-edits.ts`、`workspace-change-events.ts`、`workspace-watcher.ts`、`PlatformWorkspace.tsx`、`project-from-plugin.ts` 和 `project-tooling.ts`。固定上游参考为实际2.1.316分发包的声明，SHA256为88e84a587572f4fe97df0f378d29d441ef267142b1ea8394aa95eb80ef08a14d。

## 1. 修复交付包再次派生

真实故障：packer 为12份作者文件添加 `devclaw.package-report.json`，新包可安装、运行；reader 将唯一报告记入 excluded，from-plugin 随即拒绝。实际未知文件、额外注册均不存在，不能归为模型或环境问题。

共享报告v1协议由 producer 和 consumer 共同使用。报告通过独立非执行元数据通道有界读取，校验严格 UTF-8、普通单链接文件、schema、实际包身份、canonical 唯一文件集合、作者 bundle digest、真实依赖引用和 tests 结构。报告只描述历史检查，不授予权限，也不能替代新编译或试用。

仅该精确根路径且验证成功的报告可从当前 excluded 中分域处理。历史 report.excluded 不得用来忽略实际文件，未知资源、Hook、MCP 和额外 manifest 注册继续拒绝。原安装文件不删改；作者摘要、安装全树摘要与候选摘要各守原协议，origin 另记报告 SHA。报告纳入 pin 和第二次读取，等价 JSON 重写也应判来源变化。重打包重新生成当前报告，不自引用、不递归沿用旧报告。

验收：真实 pack→原上传安装→派生→编译→再次 pack；坏报告、额外文件、源变化与双读竞态负测。随后只补此前第二代派生未到达节点。

## 2. 接通只读代码能力

以原生 versioned platform capability 复用现有 LSP 服务，不新增语言服务器、索引器或语言业务规则。提供当前工作区的状态及现有只读操作：定义、引用、悬停、实现、文档/工作区符号、诊断及现有调用层级查询。实际语言和服务状态如实返回；未安装或未启动返回不可用，不自动下载、启动、修改全局配置或模型设置。

所有请求绑定当前 thread/workspace/incarnation/source generation。文件使用规范化相对路径，校验目录边界及原文件访问策略；位置、查询和返回量有界。结果中的文件位置再次过滤到被允许的范围。文件或来源在等待期间改变时，拒绝旧结果或明确标为陈旧；诊断是语言服务当前保留的观察，不冒称对应某个未核实的文件版本。真实取消能力不足时不得把停止等待写作底层取消完成。

第一审P1细化：当前原生服务实际为Java，状态必须标明语言、现有client实例和支持methods。不得直接调用会在main同步读取10MiB的高层包装；桥采用经原策略授权的异步有界文件快照，再进入同一client的真实openFile/query；该过程会更新LSP文档缓存，不称纯缓存读取。位置为1-based行/UTF-16列；等待结束核对client实例、文件及来源，服务重启或版本变化拒绝陈旧结果。诊断缓存没有可靠文档version，明确 `cached/versionUnknown`，空列表不表示该文件版本已无错误。停止等待后，底层未结算请求继续占用有界inflight额度，晚回不发布；不得以超时立刻释放额度制造无穷并发。工作区符号/调用层级结果有界并标截断，查询非空，不扫描补全。

不复制文件编辑器，不把类型声明当作真实语言支持。原有写入、编辑和审批继续沿 fs/tool/process。原 LSP 初始化与查询服务仍归原宿主管理。

## 3. 接通原生文件导航

提供当前工作区的文件预览、行列定位及原生 IDE 打开意图。复用原文件查看器、resource preview 和 IDE 服务；路径及权限复核与当前来源绑定。导航请求、renderer 已接收、目标界面已打开分别有实际状态，不以发送 IPC 冒称完成。无对应界面或原生 IDE 配置时如实不可用。

不接收任意 URL、系统协议、命令或 renderer 脚本。打开文件不等于读取内容已授权，不把导航入口变成文件写入或项目执行入口。切换聊天、关闭、重载或撤权后，陈旧意图不能在新聊天打开文件；原草稿和项目页面保留。

第二审P2细化：外部IDE现有实现只确认启动请求，不能证明窗口或行定位已显示；明确区分 requested、renderer-accepted、preview-loaded/failed 与 external-launch-requested/unknown-display。内置预览需增加小型当前来源绑定的行列目标，在实际定位后回执，不能把openFile调用当定位成功。插件默认使用安全源文本预览，不能沿原HTML `workspace-scripted` 模式自动执行脚本、加载外部依赖或由插件指定preview policy；原普通预览流程保持。

追加双审：30秒只约束 offer、accept 和实际定位 ACK 握手。成功加载后保持同窗一个有界只读快照，明确标注非实时，不能因普通 Hook/command 的 RPC 正常结束而退场。实际 Guest frame 正常结束也会 abort 原 signal，因此不能只清计时器，也不能沿用捕获旧 signal 的 authority 闭包。

使用 main-only 只读 presentation lease，在原 native context 创建时捕获整条 caller/delegate 的精确来源、权限、ref、native access scope 及 action selector/access identity。ACK 前始终复核原操作、路径、字节和期限；ACK 异步验证先占位，随后用独立 runtime lifetime 的新只读 context 逐层重新核验原 access identity，不重放动作。全部验证完成且原请求仍有效才原子移交，关闭旧 abort listener 和握手 timer。新 context 禁止 publish/invoke，不能递归 capture；不能安全脱离的 query、native open/cleanup、原生项目或 workflow verification 特殊上下文明确拒绝保留，不能跳过祖先边界。

重复 accept/ACK 不复活预览，晚到 lease 立即回收。外部 IDE 按钮仍单次执行，并用保留的只读来源链、原路径策略和原文件字节重新验证；来源撤销、切换 thread/root、关闭、重载及主机退出仍回收。补普通 command RPC 结束后的真实 FunctionSession 正测、祖先撤权和同名新源码负测、超过31秒的加载后阅读正测、未加载超时和异步 ACK 竞态负测。

## 4. 接通真实工作区变化

复用已有物理 watcher 的 main-process bounded patch/rescan 广播，以本地版本化 workspace capability 提供状态、订阅及失效通知。只发布匹配实际 workspace/thread 的有界路径事实，仍执行来源、路径及权限检查；不把文件正文、凭据、其他会话状态带入事件。

真实 payload 的 upsert 没有可靠 add/change 区分，rescan 没有精确文件列表，因此协议保留 patch/invalidate 语义，不伪造 classic.FileChanged、DirectoryAdded 或删除证明。未知或溢出要求重新读取权威状态。发现能力不启动扫描；订阅沿原 watcher 生命周期，不新建平行监听系统。暂停、不可观察或失效如实表示，撤权清订阅，无 Mods 时没有新增周期性工作。

第一审P1细化：原watcher有6个物理目录/16个thread上限及LRU，必须核实际watcher仍对应canonical workspace；停止、淘汰或worker失败后不能保持ready。订阅只挂原事件，不调用startWatching或扫描。删除项只表示观察到的路径事实，经当前root、最近存在父目录和原read策略过滤；不存在时不能跳过权限。单次条目/字节及异步过滤队列有上限，发生溢出/coalescing只发invalidate/resync；不能把async监听直接塞进同步emitter而泄漏rejection。状态重新读取要反映真实是否仍在观察。

## 5. 让开发者实际组合工作台

新增一个小型通用工作台示例，组合已有 Git/workflow/process/UI/store/通知与上述代码、文件导航、变化能力。示例显示真实服务状态、文件与诊断、可配置检查命令、任务回执和有界输出；停止请求、未知结果、未运行与成功区分。平台不内置 npm、Maven、AutoBiz 的业务判断。

五类 placement 和局部 Button hotkey 已有真实实现。本轮清楚说明当前宿主布局与入口，不引入 dock、多编辑器或全局快捷键引擎，不抢原保存、发送和审批快捷键。配置与布局偏好可使用既有插件 store；公开目录标注 provider、scope、查询/动作、权限、原生确认和不可用原因。创造者能定向发现新接口及示例，不向每轮模型灌入整份 SDK。

新增主机可读/导航能力需要更新宿主能力修订及对应授权摘要。旧确认不能自动取得新范围，当前版本按真实能力集中确认，原权限规则不绕过。

全量回归追加双审：模块准入后的编译器新增 `hookModules` 导出及聚合字段，现有被动显示证明器仍只识别旧包装，会让合法界面退回持续挂载。补充识别两种实际生产包装的精确 AST，不删除原白名单或把 metadata 当作执行证明。逐项绑定唯一 literal module id、真实 register 引用、调用顺序与配置；旧无 metadata 包装继续兼容。实际注册列表、来源摘要和主机签发品牌的核验继续保留，动态或不匹配情况仍 fallback。

配置仅接受无执行的纯 JSON AST、有限数及完整数组；spread、computed、getter、重复 key、额外字段/导出、初始化副作用和后续修改均拒绝。对象 literal 的 `__proto__`（含嵌套）与 `JSON.parse` 的 prototype 语义不同，必须 fallback，不能靠 JSON.stringify 判成同值；非有限数不能归一化为 null 后混过。补真实 compile/aggregate 正测和上述篡改负测，复验真实显示36项后才进入最终性能。

后续实际 producer 核查再补三项并经两位 medium 通过：注册列表逐项绑定真实 `module` 身份，身份进入准备和路由缓存键；独立 Surface 的模块导出只增加 `writable:true` 供严格模式注册器清空入口，共享 JSX 只读和注册 gate 不变；流式消息游标只读原 runtime scope 投影，可见消息才查询，避免每个 chunk 读取完整文件历史，保留数据库 identity、incarnation、原 owner guard、tail fallback 和坏 JSON 的原语义。测试使用真实 helper/VM，不以 noop 或删断言掩盖断点。

第一审P1细化：修订必须实际进入host contracts与loader source digest，并回归旧grant拒绝、新版本确认、reload/revoke/跨thread/root。检查命令只在明确用户动作中执行，发现、渲染和订阅不执行；started、exit、close、unknown和cancel-requested分别保存，实际close前不能宣称停止完成。输出有界，失败、取消、重载后不自动重放。

第二审普通用户验收链：安装示例→确认实际新增摘要→由明确界面/命令入口打开→设置保存并重载读回→选择当前工作区文件并查询真实诊断→安全预览及实际行定位回执/外IDE仅启动回执→配置无副作用检查命令→沿原process确认→真实输出/退出或未知状态→撤权后入口与订阅失效→原项目/Feature和聊天草稿仍可使用。LSP不可用时指向原服务设置/启动入口，由用户显式操作，示例不后台自启。

## 不伪装为基础开放的内容

- 现有 `terminal:create` 实际启动独立 Claude Code，并可配置模型环境，不是当前聊天的通用 Shell。不能直接桥出它的输入、输出和凭据。通用开发命令及后台面板沿已有 process/tool；交互 PTY 的跨重载恢复是另一个生命周期契约，不冒称本轮已有。
- 上游 DirectoryAdded 指授权目录加入，不是 mkdir；CwdChanged 需实际会话根切换；TaskCreated/Completed 是任务图，不是进程退出。WorktreeCreate 可接管路径，不能只发创建后通知宣称等价。
- 信任身份、上游内部遥测、终端 Raster/blit 及媒体仍守原限制。跨项目 MCP/子助手不能复制父来源授权；复杂企业业务、新语言服务器或调试引擎可由开发者在已有 process、工具、MCP、UI 和公共 capability 上实现。

## 开发、回检与最终性能顺序

1. 两位独立 medium 对具体工作台方案评审，通过后按互不冲突的文件边界开发。ZIP修复已单独双审，不等待扩展审计才处理真实断点。
2. 每项用真实宿主适配器、边界/取消/撤权/重载测试和小型浏览器链验证。Node/Web类型、改动lint及相关回归通过后，由非作者 medium 交叉回检；缺陷修完再确认。
3. 新源码候选验收，再补真实交付包派生及必要模型闭环；已完成业务节点不重跑。Git、系统审批和未达节点分别记录，不能把测试夹具或受控 provider 当成商业通过。
4. 所有计划内基础能力及回检结束、代码和driver冻结后，统一做最终基线对比、聊天性能和两小时自然heap长稳。此前短测/并发样本不替代最终性能。
5. 同步D盘说明、范围及实际验收，核对原项目文件和模板ZIP保护，只推送 `codex/mods-v2`。

性能门槛保持既有值：单插件p95≤15ms，关闭Mods入口p95≤基线105%，idle CPU增量≤0.5个百分点，桌面TTFT p95增量≤40ms、吞吐比≥0.95；300秒idle、两小时和至少10000事件。自然heap首尾各10分钟、同实际renderer身份及暖状态，增长≤max(10MiB,初始中位数10%)，全时段采样间隔及进程身份需合格，不以强制GC制造通过。

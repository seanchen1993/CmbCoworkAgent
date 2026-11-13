# Mods v2 性能与存量会话整改

本轮已将性能修复、存量兼容及架构整改整合到 `codex/mods-v2` 工作区，版本保持 `2.0.0`。上游 `uat-without-mods` 的 `6ef3a78d8c43f4fa8eeff86c606105050744544c` 已实际合入并解决冲突，merge 尚未提交。原用户改动、文档和 output 删除均保留。验证使用隔离候选和受控 profile。

## 根因与修复

| 用户现象 | 已确认根因 | 当前修复 |
| --- | --- | --- |
| 切换后历史卡顿、显示慢提示 | 离开会话后的显示物理请求和 SDK timer 未及时取消；新旧 scope 争用有限通道 | 取消贯穿 renderer、Main、SDK；逻辑取消与实际物理退出分别结算，保留有界在途额度 |
| 提问灰色、回答延迟 | 长正文处理、显示授权、缓存与来源撤销交错；全历史投影和重复序列化加重流式成本 | 呈现以已提交事实为准；前缀及缓存严格核来源，时间数据增量更新，复用已有输入身份并过滤无关目录通知 |
| 长历史滚动出现暂时无正文 | 原生虚拟列表向上补偿反馈、竖直 auto margin 与过期巨行高度共同影响 range | 保留原 owner；补反馈、竖直状态镜像和 margin 条件；在实际 range commit 后，通过原公开接口进行一次受保护的测量 |
| 旧会话 recovery required、索引不完整、fork 失败 | 旧排序索引错误使用 checkpoint ID；初始化并发绕过未就绪 schema；普通旧 tuple 被新协议过度拒绝；部分导入未固定原 source | 从真实 checkpoint ts 修复索引且不改正文；共享初始化；普通历史按原 Saver 证据准入；V1 续传绑定原 checkpoint/namespace/chain，不猜最新 summary、不重复 shift |
| 大旧会话首次打开阻塞 | 冷 schema/时间维护同步；Worker 与 Main 在 AppDB 上争写；不必要地多准备一份正文 | 默认 codec 的维护放到真实 Worker，加入同库准入及物理排空；Worker 准备有界页，Main 原连接为 AppDB 唯一写者，收缩重复正文准备 |
| 主动压缩后中断导致后续保守拒绝 | checkpoint COMMIT、delivery ACK 与控制账本跨存储的中断窗口 | 仅为该实际窗口保留私有 prepared receipt 与 compaction journal，真实 SDK/OS crash 用例验证恢复 |
| Actions ZIP 丢文件 | 隐藏文件未进入上传范围，上传前校验不能证明下载后仍完整 | 隐藏文件上传限定产物目录；下载同一 artifact 后重新校验文件/ASAR 与启动完整性，再进入发布步骤 |

本轮撤回新增 V2 spool、持久 jobs 与导入 triggers，保留无 Mods 基线已有的 V1 历史桥接。旧历史按原 checkpoint、namespace、chain 和 marker 补齐既有展示索引，沿用原消息格式。早期升级与 fork 验证使用从原种子恢复的合成档案。C12 则运行两版实际旧程序，分别新建合成隔离档案后再验证升级和 fork。用户实际会话数据未被读取或改写。原始数据已经被旧策略裁剪时，保留可用的部分数据和对应诊断。

## C8 / R10 的历史源码与真实回归

运行证据位于 `C:/ai/mods-review-temp/perf-remediation-20261109/`。历史隔离候选 `architecture-source-candidate-final-r8` 由生产 Main、preload 和 renderer 源码编译，用于本地验证。manifest SHA-256 为 `f1a8b04ac08b20617a0e3d30b5d8a2a7d756703adc96a5b86cae06a731ee8c36`，核对 4863 个运行时源文件、963 个编译输出和 21 个已安装依赖文件。`all-delivery-source-equivalence-final-r10.json` 的 SHA-256 为 `d81b4c765092cd800b5bf20dbafb30f5978921347e60bdeed8bbc33753afff6e`。该收据核对两工作区 6566 项受控文件，保留原顶层 README 的既有 EOL 例外。原 114 项保留记录以本次报告更新前的内容为核对基准。

| 验证 | 历史实际结果 | 证据 |
| --- | --- | --- |
| 显示取消 | 通过。切换约 490.3ms，4 个读取和对应的 4 个真实 timer 均观察到取消 | `architecture-display-cancel-final-r8/run-7ZRKpI/display-cancel-acceptance.json`、`architecture-display-cancel-final-r8.exit=0` |
| 普通流式交互 | 18 轮 rich SSE，就绪后采样无正文事件 0，切换 p95/最大值 436/446ms，各交互原门槛通过 | `architecture-running-ordinary-final-r8/run-k0KkKq/running-workload.json`、`.exit=0` |
| 启用 Mods 流式交互 | 18 轮 rich SSE，就绪后采样无正文事件 0，切换 p95/最大值 668/678ms，各交互原门槛通过 | `architecture-running-guest-final-r8/run-mpYt5L/running-workload.json`、`.exit=0` |
| 万条历史 | ordinary、protected、unrelated-approved-guest 各 3 次，9/9 通过。三组最长连续无正文时间分别为 0、194.5、1444.4ms，均满足原 1500ms 门槛。松手后最迟可读分别约 10.6、38.4、47.7ms | `architecture-history-10000-final-r8/run-*/acceptance.json`、`.exit=0` |
| 真实旧版升级 | 1.5.12 和 1.5.5 合成 profile 均通过升级、普通续聊、历史 checkpoint fork、启用 Mods 后续聊与 fork。各有 4 次本地模型请求，旧 ID、正文及上下文核对通过 | `upgrade/run-0NOwwA/legacy-upgrade-verify.json`、`upgrade-1.5.5/run-djFkAi/legacy-upgrade-verify.json`、两份 `architecture-legacy-*-final-r8.exit=0` |
| range 精确回归 | 新单元 34 项与原 prepend 7 项通过；真实原生浏览器三场均零观测 blank、一次 refresh，包含自然双 wheel 及受控延后 checkpoint | `architecture-range-overlap-final-proof-r1.json` |
| 真实 IPC fork 与 SDK 补丁检验 | 独立 IPC fork 和 SDK patch checkout 实际退出 0，源码和依赖核对一致 | `reviewed-c8-actual-ipc-fork-r1.receipt.json`、`reviewed-c8-patch-checkout-r1.receipt.json` |
| 完整聊天专项链 | 原始 32 脚本全部通过，npm 和 runner 均退出 0，R10 受控文件、C8 的 963 个输出、21 个依赖文件及 5 个链接前后核对一致 | `architecture-chat-performance-final-r8.log`、`.exit`、`.runner.exit`、`-after.json`（SHA-256 `063f9559f55497264311467baef4d2447395503e03457abb4d8bcaea840f3d94`） |
| C8 / R10 类型与 Lint | 当时的 Node/Web 类型检查和 ESLint 均退出 0。Lint 为 0 errors、720942 warnings | `reviewed-managed-policy-final-typecheck-r1.receipt.json`、`reviewed-managed-policy-final-lint-r1.receipt.json` 和同名日志 |
| 本地产物契约 | 工作流契约 3 文件 28 项及独立末端契约 1 文件 4 项均通过。托管 Actions 和新发布包未运行 | `workflow-final-contract.*`、`workflow-last-contract.*` |
| 原始完整 npm test | R4 实际退出 1，21824 通过、24 失败、105 跳过，另有 3 项 RPC 超时。原链未进入独立 22 项。 | `architecture-final-full-r4-npm-test.log`、实际 `.exit` 和 `architecture-final-full-r4-verification.json` |

流式验收按每类交互 p95 小于 1500ms 及零采样 post-ready blank 判断，最大值另列。万条历史测试使用原生 Electron 和真实拖动，结果限于本地功能烟测与有界 DOM/定时采样。

历史失败证据继续保留。C5 普通切换曾录得 p95 1095ms、最大 2722ms。C6 原启用 Mods 流式验收录得 5 次就绪后无正文样本。C7 万条历史的无关已批准 guest 场景录得连续不可读 1722ms，超过原 1500ms 门槛。C5 原始整仓回归已实际退出 1。对应证据为 `architecture-running-ordinary-final-r5/run-zKg495/running-workload.json`、`architecture-running-guest-final-r6/run-mvYxgB/running-workload.json`、`architecture-history-10000-final-r7/run-jZbCYk/acceptance.json` 和 `architecture-final-full-r1-verification.json`。

## C9 至 C11 的交付与验收

当前 R13 核对了 Stage 与交付的 6567 项受控文件，保留原 README 换行例外。R13 在 R12 上只更新 Worker 与集成测试两文件，原件备份和 114 项保护记录、21 项安装依赖及 Git、索引和 UAT 核对均通过。凭证为 all-delivery-source-equivalence-final-r13-membership-fingerprint-r2.json，SHA-256 为 4ad5ab6bdcca853282da25b807785e77b4f44dc45ca088531b139f1ff2f94a6e。

R12 已同步冷文本读取相关四文件，备份四份原件。四个定向文件 89 项、Node/Web 类型检查和 Lint 均通过。对应 R12 核对为 all-delivery-source-equivalence-final-r12-cold-owned-text.json。

R13 的四个定向文件 121 项全部通过，Node/Web 类型检查退出 0。两文件 Lint 为 0 errors、769 warnings。首次定向运行的 120/121 和对应退出 1 留档。单项失败来自 SQLite 测试夹具用 REAL 绑定值拼出带 .0 的合成 UUID。只在夹具 CTE 种子显式转换整数，生产 Worker 与所有断言、时限保持原样。

C9 正式桌面链退出 1。普通和启用 Mods 的流式各 18 轮通过。首轮普通与受保护历史通过，首轮无关已批准 guest 的万条历史最长连续无可读正文 1527.7ms，超过原 1500ms 门槛，后续轮未运行。两版新建隔离档案也均通过实际升级、普通续聊、历史 fork 及原生登记后 fork。

C10 正式桌面链的启用 Mods 流式阶段在 18 轮内累计发现两次就绪后滚动无正文，按原零容忍门槛退出 1。两次发生在 39451.3 和 43807.1 ms，后续分别在 54.0 和 18.5 ms 首次采到正文。普通流式及显示取消通过，链内未进入万条历史。原万条历史套件随后单独运行并退出 1。已执行的 6 例有 5 例通过，前两轮普通和受保护模式均通过。无关已批准 guest 第一轮最长无正文采样为 1465.1 ms，通过原门槛。第二轮为 1576.3 ms，超过原 1500 ms 门槛，第三轮未执行。该指标记录无可读正文的采样区间，画面可能仍有占位元素。

C10 诊断 R3 在同一合成会话再次采到两处空窗。实际 IPC 观察器已恢复，482 个唯一读取请求无丢失或观察错误，418 次返回已挂载的真实站点，64 次拒绝。两处均有实际挂载行。第一处行 131、132 的占位与视口相交，行 133 的占位在视口外。第二处行 128–130 的占位均与视口相交。第一处在 20051.8 ms，行 131–133 对应的 Main 请求分别在采样后 17.1、29.5、50.4 ms 完成，22.0 ms 后首次采到正文。第二处在 24150.4 ms，行 128 的请求在采样前约 0.6 ms 完成，行 129、130 在采样后 32.0、39.2 ms 完成，3.4 ms 后首次采到正文。按同一会话、合成行及呈现序号匹配，支持空窗与实际挂载读取尚未交付有关。单次 DOM 采样无法确定哪次提交产生正文，也不能量化观察器开销。

C10 用 1.5.5 和 1.5.12 各自新建的隔离档案实际升级。两版准备与验证均退出 0，升级后均读到两条旧历史，完成普通续聊和历史检查点 fork，以及原生登记后保留历史并 fork 成可用会话。每版记录四次模型请求。两份通过凭证归属 C10。

对应证据为 architecture-final-app-chain-r10.exit、architecture-running-guest-final-r10/run-KxkUGb/running-workload.json、architecture-history-10000-final-r10-standalone-r1/、architecture-running-guest-c10-site-read-timing-r3/run-oVqBNT/ 和 architecture-legacy-fresh-final-r10/。

| 当前候选验收 | 实际结果 | 对应凭证 |
| --- | --- | --- |
| C11 正式桌面链与万条历史 | 正式链退出 1。显示取消通过，普通流式 18 轮、552 个流式块、126 个交互样本，未采到就绪后滚动无正文，切换 p95/最大 1005/1192 ms。Guest 流式 18 轮、1099 个块、126 个交互样本，第 15 个阶段代次采到一次就绪后滚动无正文。9 个挂载行中 3 个相交行仍在等待，39.6 ms 后首次采到正文，超过零次的原门槛。Guest 切换 682/689 ms 为样本统计，失败后未执行正式切换判定。链内万条历史未运行，原套件独立运行退出 1，首轮普通 0 ms、受保护 111.2 ms 通过，无关已批准 guest 1506.8 ms 超过 1500 ms，首轮 2/3 后余轮未执行。 | architecture-final-app-chain-r11.exit；architecture-running-ordinary-final-r11/run-GZqqQY/ 与 architecture-running-guest-final-r11/run-l4dm3o/ 的 running-workload.json；architecture-history-10000-final-r11-standalone-r1/ 下首轮三份 acceptance.json 及实际 .exit。 |
| C11 两版旧档案升级及 fork | 1.5.12 与 1.5.5 各用新建的合成隔离档案，准备与验证均退出 0。两份旧历史均实际加载，普通续聊与历史检查点 fork、原生登记后的保留历史与 fork 均通过。每版四次模型请求。独立实际 IPC fork 和 SDK 补丁 checkout 也均退出 0。 | architecture-legacy-fresh-final-r11/1.5.12/run-44k339/ 与 1.5.5/run-D5Fa66/ 的 legacy-upgrade-verify.json；reviewed-c11-actual-ipc-fork-r1.receipt.json；reviewed-c11-patch-checkout-r1.receipt.json。 |
| C11 原始 32 项聊天专项 | 原始 32 项全部通过，npm 和 runner 均实际退出 0。前后核对一致，覆盖 R13 的 6567 项文件、C11 的 4863 个运行时源文件和 963 个编译输出，以及 21 个依赖、20 项补丁证据、5 个 QA 别名和命令顺序。 | architecture-chat-performance-final-r11-r2 的 .log、.exit、.runner.exit、-checks.log、-before.json（00f8d8b8…）和 -after.json（4f28bc6d…）。 |
| 原始完整 npm test R7 r2 | 原始完整 npm test 实际退出 1。原生阶段 269 通过、4 失败，后续并行阶段 21582 通过、3 失败、105 跳过。7 例均触发原 5 秒时限，涉及四个原生修复用例、目录缓存上限、迟到来源替换和旧导入分支策略。原命令的 && 链因此未进入 22 项独立脚本。前后校验中，两个工作树各自纳入的 6563 项文件和 C11 的 963 项输出均保持一致，R13 的 6567 项交付清单另有独立凭证。 | architecture-final-full-r7-r2-npm-test.log、.exit、-verification.json（e02af2fa…）及前后代码、候选快照。 |
| 原始链未启动时的独立 22 项补充 | 原补充运行 20/22 通过，实际退出 1。22 个子进程均实际关闭，只有 workflow 和 desktop-agent-baseline 因源码断言仍引用旧调用形态而退出 1，前后校验无错误。两个定向复跑已退出 0。两个原 npm 脚本的完整复跑结果为 desktop-agent-baseline R2 通过全部 7 个串联脚本。workflow R1 越过 sandbox 88/88 后在原 Saver 并发兼容用例失败，修订后 R2 从头执行原 32 段并退出 0。 | architecture-final-standalone-tail-r3-r2/receipt.json（2ce98cc5…）及 07、08 日志与退出回执。定向回执为 source-assertions-narrow-sandbox-r1.receipt.json、source-assertions-narrow-desktop-r1.receipt.json。原脚本复跑回执为 source-assertions-original-desktop-r2.receipt.json、source-assertions-original-workflow-r1.receipt.json 和 source-assertions-original-workflow-r2.receipt.json。 |

C10 的定点观测和 C11 的正式采样都记录到可见行等待读取。下一步可在同一冷读内分别测量来源发现、会话准备、挂载和发布阶段，核对真正占用的时间后再选择可省工作。若要减少挂载，范围限于可信声明明确覆盖、且现有实时来源与权限校验均通过的消息。沿用原门槛、历史存储和拒绝规则。

C11 原补充运行的两处首轮修订只涉及测试源码断言。工作流用例在实际删除实现内检查先等待有界取消，再等待带来源守卫的目录清理。桌面用例检查绑定元数据与缺失绑定早退，再验证实际归因入口收到项目与功能参数。桌面原链复跑还发现过时的解析调用总数断言，后续按 11 个已核入口逐项核对。R14 因此包含三份源码断言测试的修订。后续复跑与原补充 20/22、原始完整 npm test 退出 1 分别记录。

## C12 / R14 交付与验收

R14 更新五份现有文件并备份五份原件。变更包含 Saver、就近并发回归和三份源码断言测试。两工作树各 6567 项、114 项保护记录、21 项已安装依赖及 Git、索引和 UAT 核对一致，保留 README 的原换行例外。R14 交付凭证为 all-delivery-source-equivalence-final-r14-saver-and-test-assertions.json，SHA-256 为 b1f02718a5e19045a10c8bc0f7ac5ae9f58884ce86c8cd3fa5b174b199cc1a22。

Saver 定向四文件 33/33，原独立 Saver 17 个场景与七个真实压缩崩溃窗口通过。Node/Web 类型检查退出 0。五文件 Lint 为 0 errors、7637 warnings。原并发失败及退役后的兼容失败均保留各自原始凭证。对应证据为 reviewed-saver-close-vitest-r2、standalone-r2、crash-r1、typecheck-node-r1、typecheck-web-r1、lint-r1 的日志与回执。

C12 正式链实际退出 1。显示取消退出 0，普通和 Guest 各 18 轮流式均退出 0，两个样本均无就绪后滚动无正文。普通为 515 个流式块、126 个交互样本，切换 p95/最大 442/480 ms。Guest 为 1107 个块、126 个样本，切换为 703/709 ms。原万条历史六例通过五例。第一轮普通、受保护、无关已批准 Guest 最长无正文区间为 0、118.1、1444.4 ms。第二轮分别为 0、180.5、1520.8 ms。第六例超过原 1500 ms 门槛，第三轮未执行。该指标基于可读正文采样，不能据此断言具体屏幕像素或 Saver 修订造成变化。

对应记录为 architecture-final-app-chain-r12.exit、architecture-running-ordinary-final-r12/run-LrYKUo/、architecture-running-guest-final-r12/run-Qq6zHz/ 和 architecture-history-10000-final-r12/run-x5PbS9/。C11 的结果在前节独立保留。

| C12 后续验收 | 实际结果 | 对应凭证 |
| --- | --- | --- |
| 两版旧档案升级与 fork | 1.5.12 和 1.5.5 分别用新建的合成隔离档案，准备与验证均退出 0。两份旧历史均实际加载，普通续聊与历史检查点 fork、原生登记后保留历史与 fork 均通过。每版记录四次模型请求。独立实际 IPC fork 和 SDK 补丁 checkout 均退出 0。 | architecture-legacy-fresh-final-r12/1.5.12/run-IZIaKb/ 与 1.5.5/run-V9D2tg/ 的 legacy-upgrade-verify.json 及各自 prepare/verify 退出文件；reviewed-c12-actual-ipc-fork-r1.receipt.json、reviewed-c12-patch-checkout-r1.receipt.json。 |
| 原始 32 项聊天专项 | 32/32 条原命令全部通过，npm 与运行器均实际退出 0。前后 6,567 个交付文件、4,863 个运行时源文件、963 个候选输出及已安装依赖证据一致。 | `architecture-chat-performance-final-r12-r1` 的 before `8f354292…`、after `fe0961ed…` 及两份退出码。真实 App 单独见上。 |
| 原始完整 npm test R8 | 原始完整 npm test 实际退出 1。原生阶段 269 通过、4 失败，并行阶段 21,589 通过、5 失败、105 跳过，合计 21,858 通过。八例触发原 5 秒时限，分别为四例原生修复、旧普通 checkpoint 直通准入（fork=false）、目录配置缓存上限、锁定提供方迟到替换和旧导入分支策略。附加审计的真实 Host 交接触发原 60 秒时限。原命令未进入 22 项独立脚本。原运行前后两个工作树各 6,563 项及 C12 的 963 项候选输出保持一致。 | `architecture-final-full-r8-npm-test.log`（`d0f39ffd…`）、`-npm-test.exit` 与 `-verification.json`（`ad3d755f…`）。R14 的 6,567 项交付核对另有上文凭证。 |
| 原 22 项独立脚本补充运行 | 原命令按原顺序单独运行，22/22 通过。全部子进程实际退出 0，前后源码、候选产物和依赖核对一致。完整 R8 仍退出 1。 | `architecture-final-standalone-tail-r4/receipt.json`（`c5d280df…`）及 `01`–`22` 的独立日志和退出回执。 |

C12 万条历史诊断 R4 另跑一轮无关已批准 Guest，共六次真实拖拽，沿用原门槛并实际退出 1。第三次拖拽在移动至松手间录得 1506.9 ms 连续无可读正文，松手后 39.0 ms 首次采到正文，全轮最长等待占位采样 166.6 ms。12 处诊断快照均有已挂载且与视口相交的行。相交行都含等待站点，未采到正文标记或相交的分页间隔。Main 观察器记录了同一会话的 327 个唯一读取，84 个返回真实挂载站点，243 个拒绝，最长单次约 115.3 ms。观察器已恢复，无丢失、观察错误或无效合成标识。

第三次拖拽的快照中，行 9853、9854 有对应的 Assistant、User 读取。Main 开始时间相对 DOM 快照约为 −11.3、+2.2 ms，分别在 +68.9、+72.1 ms 拒绝。跨进程时钟存在偏差，快照没有渲染代次或读取 ID，因此近同时刻只能说明真实挂载读取与可见等待重叠。记录不含拒绝原因，单次读取也无法解释整个 1506.9 ms 区间。该诊断开启有界 DOM 与 IPC 观测，观察开销未单独量化。对应证据为 `architecture-history-10000-c12-site-read-diagnostic-r4/run-73OLSi/` 的 `interaction.ndjson`、`site-read-timing.json`、`acceptance.json` 与 `reviewed-c12-history-site-read-diagnostic-r4.receipt.json`。正式第六例 1520.8 ms 的失败另见上文。

C12 的 Main 分阶段诊断另跑一轮无关已批准 Guest，仍沿用原门槛并实际退出 1。第一次拖拽从移动到松手录得 1520.8 ms 连续无可读正文，全轮最长等待占位采样为 160.1 ms。两套观察器按同一读取 ID 对齐 315 次实际请求和 2,327 条阶段记录，96 次返回真实挂载站点，219 次拒绝。观察器均已恢复，无丢失或观察错误。96 次成功挂载读取中，外层 Main 调用、挂载生命周期和 `FunctionUiSites.render` 的中位数分别为 65.10、7.22、55.31 ms。逐次对渲染窗口内的 `policy.filter` 区间取并集后，其中位数为 11.67 ms，渲染窗口扣除该并集后的中位数为 41.08 ms。各阶段相互包含，不能把中位数相加。剩余区间未细分到 guest matcher、绘制或来源与权限检查，拒绝原因也未测。该诊断在内存挂钩并用同一候选产物另起预览服务，结果单独记录。证据为 `architecture-history-10000-c12-site-read-stage-diagnostic-r4/run-BgteoW/` 的 `site-read-stage-spans.json`、`site-read-timing.json`、`interaction.ndjson`、`acceptance.json` 与 `reviewed-c12-history-site-read-stage-diagnostic-r4.receipt.json`。

C12 原完整测试的九个超时用例随后按原时限定向复跑，三例通过、六例仍超时。旧导入分支策略通过，附加审计 Host 交接与旧普通 checkpoint 直通（`fork=false`）分别用时约 55.621 秒和 0.952 秒。四例原生修复、目录配置缓存上限和锁定提供方迟到替换仍触发原 5 秒时限。超时归类以对应原始 Vitest 日志的失败标题和错误文本为准，JSON 报告的失败字段未带上该文本。定向结果保留原完整 R8 退出 1。凭证为 `architecture-final-focused-residual-c12-r8-raw-post-r1.json`（`e3c5be93…`）及其引用的六份进程日志、JSON 结果和三份批次回执。

代码复核确认，原生参数保护、窗格元数据与绘制树发布、过滤后树的引用校验分别处理不同数据。同一绘制在一次发布内已复用通过保护的相同引用。现有阶段样本尚未定位到可安全省略的重复操作，因此保留来源、权限、取消和发布前的实时校验。

## 压力结果与剩余边界

`legacy-v1-mainport-final-wal-KFqsiY/result.json` 中，10k 小行场景 Main 最大 tick gap 43.22ms；已有 78.125MiB target 正文场景为 492.39ms，原子 ordinal reservation 466.32ms。该 UPDATE 及 COMMIT 仍有同步成本，不能以 64 行页预算宣称全部 SQL 都有界。WAL 策略只在原连接 reserve 生命周期临时调整并恢复，后台 PASSIVE 不保证 truncate 或清空。

`legacy-v1-source80-mQfFZE/result.json` 覆盖 78.125MiB 旧 source，核对完整正文、顺序、tail 和 marker，未发生 OOM。旧 V1 桥接 DTO 最大 542925B，实际历史首页为 114 行、941940B，分别计量。两次 fresh-process 全进程采样 RSS 峰为 680677376B 和 519827456B，Worker heap 预算不变，未强制 GC。约 520MB 冷峰和约 3 秒冷初始化属于这组独立旧历史测试。证据为 `legacy-v1-source80-fresh-memory-5vNomS/result.json` 与 `legacy-v1-source80-fresh-memory-4htbcY/result.json`。

另一个真实 prepared-native Worker 用例读取 10000 条合成消息（序列化 83708891B）。在原 256/32/4MiB Worker 资源限制及 5 秒请求预算内，请求耗时 1411.665ms，排空并关闭耗时 11.681ms。整进程采样 RSS 峰值 722063360B，调用进程最大 tick 间隔 26.755ms。请求测量不含夹具生成、输入序列化、黄金摘要或编译，不经过 Main AppDB 事务，不能与上面的旧 V1 source 或目标 ordinal 更新合并计量，也不能据此宣称常量内存。证据为 `prepared-native-worker-cost-bounded-green-r1-proof.json` 及 `prepared-native-worker-cost-output-r3/10k-80MiB/result.json`。

竖直 margin 修复未改变 horizontal。range 测量针对已证实的高度失配场景，在实际保留 key/index 行的提交时受限触发；准入不预先假定是否失配，无交集的任意冷跳和有其他逻辑 owner 的导航保持原路径，不能从三场精确回归推广成全部虚拟化场景无风险。

用户原 ZIP 的只读校验验证 568 个 unpacked 文件，缺少 ASAR 声明的 12 个，退出 1。独立补全对照验证 580/580 个 unpacked 文件及 685 个目录文件。工作流增加限定产物目录的隐藏文件上传，并在下载同一 artifact 后复核完整性。托管 Actions、发布安装包、提交和推送均未执行，版本保持 2.0.0。证据为 `original-actions-zip-integrity.json` 与 `complete-package-control-integrity-final.json`。

原 Manager 过度设计报告也属于历史阶段记录，其中约681MB测量已由上述fresh-process复测取代；该原文未修改。早期重构前 `final-source-candidate-r4`、27 脚本以及 1987 文件通过/1 文件失败的全仓日志均保留，不能用来替代本节最终候选。最终设计与代码检视状态见[检视台账](./mods-v2-remediation-review-ledger-2026-11-09.md)，过度设计取舍见[复核](./mods-v2-overdesign-review-2026-11-09.md)。

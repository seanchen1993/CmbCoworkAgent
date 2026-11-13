# Mods v2 架构审查与整改结果

本报告对照 `uat-without-mods`，记录已完成的结构整改及剩余边界。功能核心分层可以保留；已发现的问题集中在普通/Mods 准入耦合、显示状态多处写入、跨存储恢复、数据库物理生命周期及重复热路径工作。一次性重写、替换存储或更换虚拟列表库风险高，本轮采用逐项设计审查、实施和独立回检的窄改。

下表记录已整合的实现。交付为 `C:/ai/CmbCoworkAgent-mods-v2` 的 `codex/mods-v2` 工作区，版本 2.0.0，上游 merge 尚未提交。R14 核对 Stage 与交付的 6567 项受控文件，保留原顶层 README 的既有 EOL 例外。

| 初审风险 | 当前边界与实现 | 保留的风险/限制 |
| --- | --- | --- |
| 新协议影响普通旧会话 | 普通 canonical miss 直接返回；只有真实 native/receipt 才进入对应恢复；旧 tuple 由真实 Saver 验证 | 普通历史仍有原 SQL/IPC/Worker，损坏或 orphan 不能静默降级 |
| checkpoint COMMIT、delivery ACK、压缩账本跨存储 | 主动压缩使用固定 journal 与实际序列化的私有 receipt。共享对话的已提交点、仅 prepared 点、保留数据行及终止回放分别有真实 OS 中断验证 | 压缩 journal 的作用域限于主动压缩。新提交的 ACK 归实际新点。没有新提交的终止回放须以原点的真实证明完成 ACK |
| render 会推进共享缓存和历史状态 | 呈现区分临时 plan 与已提交事实；exact entry 的退休闭包在提交时封存；来源撤销同步生效 | 仍需维护完整 facts、prefix、epoch、ticket 和 ABA，不以缓存命中代替授权 |
| Manager 策略靠人工入口名单 | 公共入口策略类型穷尽与实际集合契约；AutoBiz 计划和固定 IO 适配移出通用编排 | 旧配置、已持久化回执及运行语义保留，未机械删字段/改名 |
| 同库 Worker/Main 争写与取消后过早释放 | checkpoint shared/exclusive gate、file/incarnation pin；逻辑取消与真实 exit/drain 分离；AppDB 固定 Main 单写端口 | 默认 codec 的冷维护可移 Worker；custom serde 单次同步调用及原子 SQL 仍不可抢占 |
| 完整正文/来源重复计算 | 复用已有 exact facts key，按受影响 turn 增量 timing；删除无实际回调关系的全局 identity 热读轮询 | 真实 callback、NativeAdapter/Statement、文件身份、原子采用边界保留，未取消安全核对 |
| 目录通知全量清空与迟到 reply 复活 | typed hint、相关字段协调、定向失效；pending publisher 有界且在删除入口/提交撤销 | 不是任意 payload 可直接加入目录；所有迟到回复仍核 scope/身份 |
| 原生 Graph 装配散落 | 固定工厂、安装和 invocation 适配边界，保留真实 conversation/source 证明及原工具目录时机 | 无 Saver/绑定不制造历史权限，异常不回退普通图 |
| 分层调度诊断不足 | 有界脱敏诊断、等待/执行/物理结束及运行故障域分别记录 | 不持久化提示词/插件正文，不自动重放未知业务，不无限增并发 |
| 虚拟列表内部补偿及测量时机 | 固定补丁安装器/manifest/整包校验；竖直 viewport 状态镜像、auto margin 条件；range 真提交后一次公开 refresh | 没有新增滚动 owner/位置校正；在限定保留行commit时测量，针对已证实失配场景，horizontal/其他 owner 保持原行为 |

## 历史存储为什么收缩

无 Mods 原分支已存在 `checkpoint_message_snapshots`、runtime projection、`thread_messages` 与 V1 legacy bridge，用于分页、搜索、fork 等。Mods 本身不需要全历史迁库或新消息格式。本轮拟新增的 normalized spool、持久 jobs、降级 trigger 以及自动 enrollment/delete 新协议，经三方必要性复审已撤回，外部归档保留其源哈希。

当前异步生产路径由 Worker 规范化旧 source，经固定 Main writer 发送有界页。Main 在原连接验证 scope 后执行原 V1 reserve/copy/finish。旧同步兼容入口仍存在。部分续传绑定 marker 的原 checkpoint、namespace 和 chain，源已裁剪时保留部分结果与诊断。这里补齐既有展示索引，沿用原消息格式。

共享对话的运行历史以 SDK checkpoint 与 writes 为准。AppDB 保留已提交的展示行和 Mods note 索引。没有被 SDK 引用的额外行不会自动进入恢复或 fork 的运行历史，也不会授予读取或确认权限。跨库 COMMIT 与 ACK 分别结算，恢复沿用原任务的重放规则。模型与工具的外部副作用仍可能再次执行，不能据此宣称跨库 exactly-once。

“单 writer”消除了两个写者争锁的特定路径，不意味着全部 Main SQL 无阻塞。80MiB 既有 target 的实际 Main 最大 tick 仍约 492ms，reservation 约 466ms；这是原子 ordinal 更新边界。临时 WAL 政策在同连接恢复后才 ACK，后台 PASSIVE 等真实退出并不保证文件截断。source80 冷读测量与 target80 reserve 压力不是同一用例。

## 没有机械删除的保障

incarnation 区分同 ID 的删除重建。真实 path/file pin 检查 rename 和 inode 替换。私有 request/receipt 约束伪造与一次性采用。物理额度按真实退出结算。主动压缩 journal 保留 COMMIT/ACK 间隙的恢复事实。这些约束分别对应实际反例。

渲染测量也没有另建队列或滚动系统。原同一 rangeTask 在 microtask 后测量，保留到一次 rAF checkpoint，后续相关 commit 共用该预算；取消、scope、owner、ref、handle、key/index 与 presented body 都重新核验。受控延后 checkpoint 与自然 aggregate wheel 各有独立资格断言，不能把受控时序称作自然同帧证明。

投影 Worker 在实际请求未排空时保持进程存活，空闲后恢复原退出行为。真实子进程回归先确认了进程能到达预定的崩溃点，随后定位到另外三处主动压缩恢复冲突。同一份已认证压缩切点现在按原字段顺序写入，恢复继续核对新鲜来源、切点和原提交边界。最终 7 个原崩溃窗口及普通子进程自然退出均通过，原数据无需迁移。证据为 `projection-worker-liveness-r2-physical.*`、`projection-worker-liveness-r2-crash.*` 和 `compaction-cut-order-r1-crash.*`。

C9 的真实万条历史测试显示，拖动中可能多次替换仍在读取的可见行。323 次实际 Main 消息读取中，238 次拒绝，85 次成功均交付真实站点所有者，未走被动投影。真实内置 `function-commands` 的离线编译与注册检查在 `top-level-initializer` 返回未知，未执行 guest 事件。现有静态证明和旧挂载路径保留。原生文本读取现在把已认证的取消信号传给原有受保护的挂载入口，在发现、共享启动或排队实际结算后阻止已取消读取进入下一阶段。所有原活性、来源与权限检查继续执行，已分配所有者仍走原清理，信号不进入共享初始化或已交付所有者的长期校验。

证据为 `architecture-history-10000-c9-main-ipc-cpu-diagnostic-r2/run-ZGnV2c/site-read-timing.json`、`candidate9-function-commands-offline-display-proof-r1-result.log` 及 `cold-owned-text-mount-cancel-r3/freeze-r1.json`。

原生检查点展示 Worker 原先每扫描一条成员，就重哈希含全体成员的收据 JSON。R13 把指纹输入量降为收据字节与成员字节之和，一次写入四个原始收据字段，再按原 SQL 顺序分 64 项流式写入原始成员字段。Worker 在原只读事务中生成临时指纹，Main 保留两次新鲜复核。混用两种算法会在现有比较处拒绝。存量收据、持久摘要、非 Worker 校验和来源权限规则沿用原实现。

Saver 的可复用 close 保留原先撤权和物理排空顺序。flush 与可复用 close 重叠时等待同一次关闭。若 flush 已持有物理租约，先退出实际维护并释放租约。与该 close 重叠的严格 flush 要求同一数据库已实际完成 WAL TRUNCATE，或 close 开始时数据库本就空闲。未重叠的严格 flush 仍可执行自己的 FULL 检查点。替换、初始化失败、在途退役和嵌套调用仍拒绝。退役后无句柄且无在途初始化或 close 时，旧的 best-effort flush 是无副作用空操作。

## 验收与风险判断

重点批次的设计与实际代码均经过独立回检。首次阻塞、撤回及失败收据保留在外部证据和[台账](./mods-v2-remediation-review-ledger-2026-11-09.md)。C8 通过普通和启用 Mods 各 18 轮流式验收、万条历史 9 次验收、两旧版本升级与 fork、独立 IPC fork，以及原始 32 项聊天专项。旧完整回归 r1 已退出 1。较早的完整 npm test r4 实际退出 1。Vitest 21953 项中 21824 通过、24 失败、105 跳过，另有 3 项 onTaskUpdate RPC 超时。原命令链未进入后续 22 项独立脚本。凭证为 architecture-final-full-r4-npm-test.log 和 architecture-final-full-r4-verification.json。最新候选各门槛与完整结果见[整改报告](./mods-v2-performance-remediation-2026-11-09.md)。

C8 普通切换 p95/最大值为 436/446ms，启用 Mods 为 668/678ms。C5 普通切换 2722ms 峰值保留为历史结果。约 520MB 旧历史冷进程采样峰、约 466ms 原子 reservation 和已裁剪历史不可恢复属于独立边界。结果与证据见[整改报告](./mods-v2-performance-remediation-2026-11-09.md)。

本地没有新发布包或新 Actions 产物；Actions 代码与完整性契约已修复，但发行验证须由后续实际构建执行。本任务不自动触发打包、提交或推送。

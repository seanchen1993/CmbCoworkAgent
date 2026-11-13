# Mods v2 整改检视台账

重点设计经独立检视后实施，实施后再按实际字节回检。原报告、设计意见、失败和重新放行证据保留在外部记录，原报告快照位于 `root-reports-before-final-refresh-r1/`。

交付为 `codex/mods-v2`、版本 2.0.0。上游 6ef3a78 已实际 merge，尚未提交。R3 同步 10 个已审文件，R14 通过 6567 项受控文件核对，保留原顶层 README EOL 例外。原 114 项保留记录已按本次报告更新前的内容核对。

| 批次 | 范围 | 设计检视与实现后回检 | 当前状态 |
| --- | --- | --- | --- |
| A01 | ordinary/legacy/native 准入分流 | main_performance实施，display_queue及message_continuity检视 | 已整合；普通canonical miss不进入额外恢复；真实旧版最终回归通过 |
| A02/B1/B2 | delivery、compaction恢复、私有prepared receipt与journal | 多批设计修订后实施，display_queue独立回检；真实SDK/OS crash | 已整合，七场真实crash及84项定向组合通过；原失败证据保留 |
| A03/C01–09 | checkpoint维护、重入拒绝、初始化、IOgate、关闭/退役、Worker物理额度 | main_performance/Root/display_queue交叉检视设计与实际代码 | 已整合；拒绝维护重入/自等close，capture真实file/incarnation，真实exit/drain后释放；默认codec冷维护Worker |
| C07a | client物理请求与逻辑取消分离、全类型额度/原源核验 | 独立设计与多轮代码回检 | 已整合；import/factory/late exit/同物理别名均有反例 |
| C07b原草稿 | normalized spool/V2 jobs/triggers/新enrollment协议 | 三方必要性复审决定撤回；撤回后独立回检 | WITHDRAWN，外部哈希归档；不是待实施事项 |
| V1 writer/WAL | 原V1桥、Main单写固定端口、原source续传、reserve/WAL物理恢复 | main_performance、display_queue、Root逐批设计和实现后检视 | 已整合；真Worker/Main-port、异常drain、压力、source80及fresh memory通过；保留466ms原子SQL边界 |
| A04/A07 | Manager类型穷尽、AutoBiz固定适配 | display_queue实施，main_performance独立设计与代码检视 | 已整合，实际入口集合/Manager定向回归通过 |
| A05/A06 | 有界显示DTO、typed目录hint、脱敏runtime故障域 | display_queue实施，Main/UI交叉检视 | 已整合；真实显示取消与流式最终回归通过 |
| A08/UI01–04 | committed presentation、exact cache identity、退休闭包、同步来源撤销 | message_continuity实施，display_queue独立设计及实际回检 | 已整合；弃置render/旧closure/ABA/host回访等保留反例 |
| A09/T01/D | 增量timing、消息版本、定向通知、pending publisher撤销 | UI实施，display_queue/Main交叉检视 | 已整合；全扫描草案撤回，真实store/Provider及10000消息oracle通过 |
| A10/A11 | scroll owner边界、完整输入身份与冗余序列化 | UI实施，两位独立设计/代码检视 | 已整合；不以mtime/摘要替代原来源，不新增owner |
| A12 | Graph工厂、安装、invoke固定适配 | Root实施，Main/UI设计检视、Main代码回检 | 已整合，10项单元已通过；不是待跑草稿 |
| A13 | 上游Hook/沙箱/项目查询merge冲突 | Root实施，display_queue与Main分别检视 | 已解决冲突，无未合并项；组合测试仍纳入原完整回归 |
| S01–05 | ordinary快路、目录过滤、facts key复用、全局热检收缩、撤回V2 | 三方对照UAT审必要性，逐项独立回检 | 已整合；限定计数/微测不冒充全应用提速 |
| V-scroll | 原补偿反馈、竖直auto margin/同步viewport镜像、固定安装器 | 初次直接读取无状态stream的方案被实际审查阻断；修订后Main/Queue设计与代码再次通过 | 已整合；28场原生shrink定向通过，horizontal未改 |
| V-range | 真commit中retained(key,index)、microtask公开测量与单task预算 | Main/Queue分别审设计及实际代码；Root发现X交集、双wheel资格问题后重新审改 | 已整合；新34+原7单元、自然single/受控late/自然aggregate三浏览器场通过 |
| Main FS / Claw / 暖站点 | 去除重复 FS 探测和同一 Claw scope 查询，合格暖站点先试真实来源 | Root 与 Queue 独立设计和代码回检，暖站点另由 Main 实际回检 | 两项 FS 反例及 Claw、暖站点独立反例保留，最终相关十文件 130 项通过 |
| TurnDuration | 首次 offscreen 读取等待原可见性信号，保持在途物理额度 | Root 与 Queue 独立设计、代码和实际差异核验 | 原浏览器几何及新增真实调度用例通过，普通正文原路径保留 |
| 受管 policy 取消 | 只调整应用内置纯过滤的派发前和结算后取消，真实故障和工具准入保持原路径 | Main 实施，Root 与 Queue 独立设计及实际回检 | 3 项定向反例保留，最终十文件 188 项通过 |
| NativeDestination / marker / SSE | 去重 SQL JOIN 与过期别名探测、空候选快路、增量 UTF-8 计数 | 各批独立设计、实际代码和失败反例回检 | 原身份与错误顺序保留，相关六文件 205 项通过 |
| Actions | 隐藏文件上传、同 artifact 下载重检及启动完整性 | Root 实施并独立契约检视 | 本地 28 项及独立末端 4 项通过。原 ZIP 缺 12 个，补全对照 580/580。托管 Actions 未运行 |

| 后续批次 | 实际改动及原有边界 | 验证结果 |
| --- | --- | --- |
| 产品 Worker 与压缩恢复 | 保持在途 Worker 的物理生命周期。压缩切点沿用已认证字段顺序。原恢复核对和空闲退出保持 | 56 项生命周期回归和 7 个原崩溃窗口通过 |
| 产品来源检查与目录 | 去除同步阶段内的重复读取和空动作的无用读取。分页按实际 UTF-8 字节增量计数。保留后续新鲜校验 | prepared 121、Host 117、原生配置 36 项定向通过。目录和分支 62 项断言通过，同次命令仍有 RPC 超时 |
| 测试进程隔离与清理 | 原生 Vitest 文件串行运行，每文件使用独立 fork。普通并行配置、原用例与时限及 22 项命令链保留。三个测试文件在原清理完成后让出一次事件循环 | 对照复现证实共享 fork 的 esbuild 停止会打断另一个构建，独立 fork 对照通过。三文件复跑 66/67，无 RPC 错误，旧导入用例仍超时。现有证据不足以确认全仓 RPC 已消除 |
| R11 实际交付 | 按已审 SHA 应用 27 项变化，备份 26 份原件，核对两工作区完整清单 | 准备、应用、复核均实际退出 0，两个工作区各 6567 项 |

运行及审查依据为 `vitest-esbuild-cross-file-output-r2/`、`parallel-test-cleanup-turn-r1-original-focused.*`、`reviewed-stage-final-overlay-r4-cleanup-result.json` 和 `all-delivery-source-equivalence-final-r11-cleanup.json`。

| 批次 | 独立检视结果 | 实际状态 |
| --- | --- | --- |
| 冷文本读取 R1/R2 | 直接调用私有挂载绕过原包装入口内的 Host 来源准入与 catalog guard | 拒绝应用。R3 恢复原包装入口，只转发已认证的现代文本读取信号 |
| R3 定向初稿 | 86/89。新增测试直接取消已经完成的首次绘制信号，碰到原绘制对象保留该信号的行为。真实 IPC 在成功回复前移除已完成请求的控制器 | 保留失败凭证。R4 单独取消已完成挂载的信号，用独立绘制验证同一实际所有者，生产代码不改 |
| R5 与 R12 | 显式参数分支修复原类型推断失败，无信号调用保留原参数数量。同步前后独立核对四文件和备份 | 定向 89/89、类型与 Lint 通过。R12 交付已核实，C10 桌面链失败仍保留，完整测试待凭证 |

| 批次 | 独立检视结果 | 实际状态 |
| --- | --- | --- |
| C10 真实验收与诊断 | 原应用链和独立万条历史保留各自原门槛。诊断 R1 在应用启动前失败，R2 重现门槛失败但未取得计时文件，R3 取得完整计时文件并复现两处空窗 | 原应用链退出 1，独立万条历史 5/6 后退出 1，两版独立旧档案验收退出 0。诊断与正式通过项分别记录 |
| R13 临时成员指纹 | 预审和 Stage 应用后均核对两份文件字节。回归覆盖分页、原始 JSON 变化、异常值和空成员，Main 的索引候选撤回 | R4 只把新增 SQLite 测试夹具的 CTE 种子转为整数，生产 Worker、原断言及时限照旧。定向 121/121、Node/Web 退出 0，两文件 Lint 为 0 errors、769 warnings。R13 已同步两份文件并核对 6567 项 |
| Windows 原生路径探针 | Node 22 离线对照与清理通过，真实 Electron 路径契约仍待验证 | 诊断独立留档，当前产品路径保持原样 |

R3 与 R4 的冻结清单及应用回执分别位于 canonical-worker-membership-fingerprint-r3/ 和 canonical-worker-membership-fingerprint-r4/。R13 交付凭证为 all-delivery-source-equivalence-final-r13-membership-fingerprint-r2.json，SHA-256 为 4ad5ab6bdcca853282da25b807785e77b4f44dc45ca088531b139f1ff2f94a6e。当前 C11 各项实测见[整改报告](./mods-v2-performance-remediation-2026-11-09.md#c9-至-c11-的交付与验收)。Windows 凭证为 reviewed-c9-windows-resolver-parity-cost-r2.log 及对应退出回执。

| 后续批次 | 独立检视结果 | 实际状态 |
| --- | --- | --- |
| 原补充运行的源码断言 | 三个测试文件跟随现行删除守卫、执行阶段归因和入口内共享解析。生产路径与时限沿用原实现 | 原补充 20/22 留档。desktop-agent-baseline R2 原命令通过。workflow R1 发现实际 Saver 兼容失败，R2 原命令通过 |
| Saver 与 R14 | 保留原撤权、物理排空与失效检查。定向、原独立脚本和原七个真实崩溃窗口均通过 | 五文件已交付并逐项备份。两工作树核对 6567 项，114 项保护状态和 21 项依赖一致 |

R14 交付凭证为 all-delivery-source-equivalence-final-r14-saver-and-test-assertions.json，SHA-256 为 b1f02718a5e19045a10c8bc0f7ac5ae9f58884ce86c8cd3fa5b174b199cc1a22。

## 阻塞意见如何关闭

- C01/C06 的维护重入及自身close死锁未用可重入lease绕过，而是在任何状态改变前拒绝；外部close仍等待真正物理排空。
- C07 不因已有实现投入继续扩展存储。V2体系撤回，保留原V1；旧source续传及AppDB单writer另行设计/验证。撤回不等于原争锁问题自动关闭。
- B2 按实际序列化生成私有 receipt。主动压缩 journal 恢复限于原账本与实际 COMMIT/ACK 边界，不执行新的模型或工具调用。共享对话的 SDK task 重放仍为至少一次，AppDB 未被 SDK 引用的行不自动进入运行历史或授予权限。
- UI退休闭包、exact entry、弃置render和增量timing均由真实反例推动修订；原全扫描/仅共享cache去副作用方案没有强行放行。
- App3真实流式暴露auto margin空洞；App4仍暴露cached巨行失配。两次失败均保留，不能拿先前浏览器绿替代。直接child didUpdate refresh被证明在父layout listener重装前丢事件，改为同task microtask；自然aggregate旧可见正文为0但有retained行的反例也纳入最终精确回归。
- “直接读viewportHeight”初稿读取无状态stream，被独立实际回检阻断；最终为一份同步O(1)镜像。没有增大overscan、放宽blank门槛或主动跳到底部。

## 最终验收状态

历史候选 C8 的固定 manifest 为 `f1a8b04ac08b20617a0e3d30b5d8a2a7d756703adc96a5b86cae06a731ee8c36`。显示取消通过。普通和 Mods 各 18 轮 rich SSE 均为零采样 post-ready blank，切换 p95/最大值分别为 436/446ms 和 668/678ms。三种万条历史各三次均通过原门槛。1.5.12 和 1.5.5 的合成 profile 均通过实际升级、续聊及 fork，另有独立 IPC fork 和 SDK 补丁验证通过。

历史 C8 的 32 项原始聊天专项中，npm 和 runner 均实际退出 0，R10、C8 编译输出、SDK/Virtuoso 依赖及 5 个链接的前后核对一致。较早完整 npm test r4 实际退出 1，原链未进入独立 22 项。最新候选的真实应用、旧档案、32 项及完整结果以[整改报告](./mods-v2-performance-remediation-2026-11-09.md)的回执表为准。npm 的实际退出用于结算命令，具体子进程清理以各用例自己的实际证据为准。

历史失败收据继续保留。C6 原 guest 流式验收有 5 次就绪后空白采样，C7 原 10k unrelated-approved-guest 连续不可读 1722ms，早期完整回归 r1 退出 1。旧候选的通过记录保留为各自范围内的历史证据。R14 的 Node/Web 类型检查和五文件 ESLint 退出 0。C12 正式桌面链仍因万条历史第六例超门槛退出 1，其他结果见整改报告。本地包契约的历史验证另见报告。托管 Actions、发布安装包、自动 commit 和 push 均未执行。详见[整改报告](./mods-v2-performance-remediation-2026-11-09.md)。

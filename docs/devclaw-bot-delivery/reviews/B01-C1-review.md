# B01-C1 主代理审查与验收检查点

2026-10-06 · preflight，尚无C1代码接受

## 实际起点

用户授权B01六接口、无物理FK、开发/测试任务schema全部权限，手动继续；自动触发PAUSED。B1已正常合入70f5aed6并完成主代理独立及集成新编译产物数据库验证。

原唯一gpt-6.1-sol/high写者已从clean/stopped正常FF到ready文档基线 `9f2c33bf504b382ad609e551bdaa9006e9bbbdfb`，正式C1 followup成功。child实际确认同HEAD/clean、必读材料已读，尚未builder/DB/新句柄或实际quota错误，正在检查冻结错误映射/DTO/Boundary并准备小设计checkpoint。这里只是派单/收到证据，不是六操作实现或通过。

## 主代理必须核对

1. 应用入口在可信context内用原ContractBoundary消费输入与输出；不能因手工typed DTO或数据库账号schemaALL绕过主体/空间/当前资源权限。无HTTP/C2、无外部调用，原B1/config/DDL/source/deps不改。
2. command_scope先串行化主体命令，目标与引用行固定锁序、space限定；当前权限先于receipt，receipt先于CAS/新写语义。创建回执的目标来自服务端记录，不由新请求成员定义操作者。
3. receipt不可变状态/body及DBUTC期限，canonical fingerprint的键顺序/等值整数与数组顺序、expectedVersion规则正确；重放body的space/target/旧BotVersion归属与服务端metadata一致。损坏持久行fail-closed；历史成功不重跑新配置关联/ceiling语义。
4. 无FK关系由同事务查验，而不是Schema的字段结构或裸SQL替代。合法specialist-only、未变Bot引用、固定旧版本、自移除后撤权、version上限及Unicode边界均须实际证明。
5. 同commandId跨JVM竞争同主体；**不同commandId/同CAS使用两个不同共同维护者或admin**，避免主体锁串行化掩盖对象锁问题。受控同步点证明调用重叠，记录两个PID/实际结果/SQL事实，不靠进程mutex或内存参考模型。
6. 真正rollback与unknown commit：四写业务/response验证/receipt/outbox同commit；部分写、receipt/commit前故障全回滚；commit后丢响应同ID取回。秘密与输入正文不进outbox、stdout或safe错误，commit未知不声称retryable=true。
7. 新Java子进程启动/秘密发送前查已abort，parent实际SIGTERM收尾全部child；精确finally后Docker/目录真实absence。两顺序真实MySQL、实际JDK8、旧20JUnit/20Node/24F03/1107parity与固定34库不减，不把B1生命周期通过当新harness证明。

第5项及持久receipt检查已通过直接协作消息交给同child；不扩大任务范围、不修改worker协调文件、不并行实施。

## 接受门槛

等child最终code/report-only SHA、clean停写、全部句柄确切闭合；主代理读取实际完整diff、独立跑完整构建/原契约/真实六操作/跨JVM/rollback/权限/未知结果/故障清理后才接受并集成。当前不接受任何C1实现，不进入HTTP/C2或产品后续路线。

## 首个设计checkpoint已实际审查

主代理实际读 `cfa73372236f0a85a7e3950b08c97013a156a6f5` 全增量：仅A02报告10行，execute/可信Context+Policy/new固定JdbcStore、权限在receipt语义前/receipt在CAS前、Group→排序Bot→排序Version、无Bot→Group反向、immutable bytes/DBUTC/typed canonical和跨JVM/取消测试分组符合任务方向。没有代码、测试或资源结果，不作实现接受。

已核冻结OpenAPI `x-error-status`：OUTCOME_UNKNOWN确为409且retryable=false，不是503；每operation还须声明对应status，GET不可借写409。原bytes超过1MiB用已有PAYLOAD_TOO_LARGE413，其他语法/Schema为400，不改原Boundary或做HTTP。创建历史receipt只先作服务端目标定位、再当前授权，之后expiry/conflict/body；腐坏/悬空服务端receipt不能返回跨空间内容或创建接口未声明404。以上窄澄清已发送同child，整体设计可继续。

## 额度中断后的实际恢复核对

2026-10-06 11:26:34UTC：main actual09e93d0d/worker cfa、tracked diff空与九新Java未跟踪SHA核对ae4dd7；原errored写者已停，fresh2985d4 process为空。当前ordinaryUsageAllowed=true且旧16:46local已过，不购买/reset/换模型账号。正常仅协调文档merge53b038到worker49f8e0f，ef0ba2证明九源码哈希完全不变、只四coorddocs，formal followup同原high/B01-A02成功。尚无C1代码接受/构建/数据库验证，不把source保存与派单当完成。

九源草稿实际增量审查点已纳recovery任务并给同child：operation错误status不能越过原声明；stored number/current指针明确查实际版本事实；严格持久JSON不得DTO强制转换隐藏坏类型/重复键/非法UTF8；历史body与服务端metadata一致、当前授权优先；最大Text emoji/codepoint实际证明后才考虑原parser最小适配，原validation当前不授权修改。不同命令同CAS仍两个不同授权主体/两JVM，新增application harness必须真正取消收尾。

原dev MySQL actualOOM/exited137是等待期间环境变化，不是C1失败或成功。child仅已授权原任务容器归属校验与start-once/健康端口恢复；main未执行restart，不改B00/权限/数据/内存/digest/root，await实证。再OOM停止新资源测试而非循环重启或跳过真库门槛。

11:30:10UTC child32259 exit0/592fe5原container start-once恢复；main55bf21实际独立inspect/listener确认原三容器同ID/image/owner/daemon健康，MySQL现在12732893单listener，原ES/S3端口不变。没有C1业务测试通过。main57af34 actual checkpoint6ec00f21只九保留Java513行＋A02八行，全部读d9ab8d/a641cf/abcb15；实现尚未build/test，原已知status/currentnumber/strictJSON负例仍必须落实，不以checkpoint提交为接受。

main完整读085ac307增量047ea7：operation声明status已修、current safe整数/最高版本pointer由固定SQL+父锁核对；stored config/limits固定合法envelope消费原始字节→原Schema/typed DTO，不能先coerce再校验，原Boundary/B1未改。新五unit与build suite追加完整保留旧20/parity/资源审计；最大Text按原源16384而非摘要错误65536，未改parser。builder44567实际启动但结果未知；单元/真库均未接受。历史Bot.header.version须等body BotVersion.number，Bot.name/createdAt、Group.createdAt等不可变头字段查持久事实，不能比历史mutable version/updatedAt/status/members与current；samechild已确认在builder关闭后补新类+真实corrupt-receipt负例。仍须全部真库/JVM/事务/取消自测与main独立复验。

11:39UTC结果更新：worker44567确切exit0/85e0a4，085新编18main/6test、25JUnit/0fail-error-skip、1107同9bbde16b零diff/50own52/34libs/原artifact资源与probe通过；只是worker整套构建证据，main1b00ae仅读实际新unit5/0/0/0，不冒充独立执行。main完整读1999c826小diffbef504（仅newBotApplication两行receipt check+A02）：不可变头字段检查符合历史语义，但修后尚未build，真库/并发/rollback/取消未做。保留实际版本对应关系，不用085构建担保新diff或六接口JDBC成功。

11:54:30UTC新增JDBC/harness checkpoint8fc3/bdf9 main680678/6801df完整读新Node三类+spec和prod bindings union：旧/新Bot及版本全部确定排序锁、旧持久关系腐坏不能被删除绑定掩盖；在capacity等待后/runtime前后再查abort避免取消后开新步骤，原B1/B00不改。初版268JavaProbe31b433/61c66f已全读；最终301行全读留冻结候选阶段。50159实际workerbuild25JUnit/1107零diff/class52/34libs通过；不是main独立。

62868实际两库core全部通过（准确SQLfacts/PID/stats在state/A02）但总exit1/d98bdb，最后devsnapshot失败而lifecycle未执行，不接受partial。child连续三次真实inspect e14c92证实同ID/health/port/mount映射、Mount数组顺序不稳定；main完整读cdf6ce20/da05修正7362ef/aa6961，仅canonical唯一Destination/服务键序，保留全部Mount字段且已有validator仍实际检查；changedRW/source/duplicate缺dest负例不被掩盖。只新harness/spec，无原环境修改。新的33935整套复验运行未知，必须真两库+实际新harness故障/SIGTERM总通过和最终回归/freeze，再main独立后才能接受。

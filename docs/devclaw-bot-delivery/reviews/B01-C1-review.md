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

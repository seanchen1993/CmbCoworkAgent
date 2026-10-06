# B01-B1 v2主代理审查记录

2026-10-06 · incremental review · 尚未独立验收或接受B1

最新用户无外键/开发环境全部权限决定已写设计v2；仅task schema-ALL，无global/GRANT OPTION/其他库，不改现存dev。A2b已验收；本片B1还在原high唯一写者实施，不派C1/HTTP。

## 已实际读取的代码快照

- b582147cfc371c5c771c3aae666c15a759683cdf：完整root-free registered-test metadata adapter、固定schema-ALL官方初始化、原container/security/network/loopback/currentready检查、完整Java权限探针和Node stdin/ownedProcess/finally。新权限已成功落地，旧1142/拒绝留历史。worker10513确切exit0/清理只先决自测，main664b99只读原三服务同ID健康，不能当main独立DB验收。
- 5fbfa5b6541472ec7d70e9a9fdbcc2714388e285：完整九表V1 SQL、LocalDatabaseConfig、MigrationRunner、DatabaseReadiness、StorageCodec、DatabaseFailure、DatabaseCommand、新PersistenceBoundaryTest、POM与builder/audit实际diff。无FK/空间前缀PKunique和关联索引、stableordinal；name内部ASCII escape、MEDIUMBLOB原JSON字节，不改变原Schema。Hikari固定小池/READ_COMMITTED/连接及锁时间、closed local transport、安全异常无cause/stack、只migrate/readiness、无clean/repair/rootfallback。
- POM新增main resources且artifact audit读取实际fatjar迁移/log配置字节，旧三契约源/DTO/依赖/15suite保持，新增5suite不掩盖旧计数。Flyway只ignore pending供显式空库migrate，future/missing不忽略；readiness要求精确version1/SUCCESS/script/checksum和十表/零FK。当前builder46585运行中，结果未知，不读取旧target结果冒充本轮通过。
- 结果更新：report-only b1741a4d实际读回，46585 exit0/ac55b5；实际Java8重编main9/test4，20JUnit零fail/error/skip、同4f3bc703的1107parity/0mismatch、36class52/35库、fatjar原资源和migrationbytes/hash通过。只是该worker快照自测，未main独立复验/真实迁移接受；后续新增probe/编排变更仍须新最终快照验证。

## 已提出的审查点

1. SIGTERM若在ready/appPassword期间已触发，必须在ownedProcess启动和秘密stdin发送前检查已abort，不能只事后加abort listener；finally清理不被signal取消。child仍需窄修及真实测试，不认定已解决。
2. 实际打包迁移与日志资源纳入审计已在5fb落实，仍须真实Java8构建/解析和两库验证，不能只源文本匹配。
3. 合法Unicode/emoji/NUL/孤立surrogate、最大边界、原JSON/不可变receipt字节和stableordinal必须真实JDBC重开往返；当前离线codec源码/用例不替代数据库证据。
4. 无FK的跨空间/版本/成员关系责任留C/D应用事务，B1只结构检查，不伪造SQL关系拒绝。C1草案已经明确同事务查验与锁序，但仍draft/未派发。

## 接受前仍需

冻结最终code/report SHA、clean停写与全部builder/测试退出；主代理读最终完整diff和实际验收harness，独立运行Node边界、F03、完整JDK8构建、两顺序空MySQL5.7 migration/noop/history/catalog/权限/字符串、checksum/缺坏配置/离线/超时、未ready失败与真实SIGTERM清理，核对原dev3与volume/runtime无测试残留。无main DB通过、无B1接受、无先合入未验收实现。

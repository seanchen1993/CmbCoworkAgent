# B01-B1 v2主代理审查记录

2026-10-06 · incremental review · 尚未独立验收或接受B1

最新用户无外键/开发环境全部权限决定已写设计v2；仅task schema-ALL，无global/GRANT OPTION/其他库，不改现存dev。A2b已验收；本片B1还在原high唯一写者实施，不派C1/HTTP。

## 已实际读取的代码快照

- b582147cfc371c5c771c3aae666c15a759683cdf：完整root-free registered-test metadata adapter、固定schema-ALL官方初始化、原container/security/network/loopback/currentready检查、完整Java权限探针和Node stdin/ownedProcess/finally。新权限已成功落地，旧1142/拒绝留历史。worker10513确切exit0/清理只先决自测，main664b99只读原三服务同ID健康，不能当main独立DB验收。
- 5fbfa5b6541472ec7d70e9a9fdbcc2714388e285：完整九表V1 SQL、LocalDatabaseConfig、MigrationRunner、DatabaseReadiness、StorageCodec、DatabaseFailure、DatabaseCommand、新PersistenceBoundaryTest、POM与builder/audit实际diff。无FK/空间前缀PKunique和关联索引、stableordinal；name内部ASCII escape、MEDIUMBLOB原JSON字节，不改变原Schema。Hikari固定小池/READ_COMMITTED/连接及锁时间、closed local transport、安全异常无cause/stack、只migrate/readiness、无clean/repair/rootfallback。
- POM新增main resources且artifact audit读取实际fatjar迁移/log配置字节，旧三契约源/DTO/依赖/15suite保持，新增5suite不掩盖旧计数。Flyway只ignore pending供显式空库migrate，future/missing不忽略；readiness要求精确version1/SUCCESS/script/checksum和十表/零FK。当前builder46585运行中，结果未知，不读取旧target结果冒充本轮通过。
- 结果更新：report-only b1741a4d实际读回，46585 exit0/ac55b5；实际Java8重编main9/test4，20JUnit零fail/error/skip、同4f3bc703的1107parity/0mismatch、36class52/35库、fatjar原资源和migrationbytes/hash通过。只是该worker快照自测，未main独立复验/真实迁移接受；后续新增probe/编排变更仍须新最终快照验证。
- 2910e65d78fb5d26b86ec5e570a7da24703a4752：完整211行JDBC probe、database-java/check两helper、adapter/原privilege probe/metadata五测试diff实读；取消在ready、spawn及stdin前检查已abort已落实，真实SIGTERM仍待。实际fatjar classes/libs执行，JDBC裸结构fixture不是六业务API；十表全列/22索引/零FK、公共原Schema接受的1MiB config/receipt与name escape、max ID/Long和ordinal重开、history同Connection未提交fixture回滚、实际querytimeout/错密码/停库拒绝测试。82377 worker报exit0，35236真实两库运行未知，无main独立通过。

## 已提出的审查点

### 04:17UTC实测依赖失败与窄技术决定

实际worker35236与95334两轮均exit1且finally回收，第二轮safe阶段已明确first-migrate为MIGRATION_INVALID。main本地javap chunkc24490和worker独立javap确认固定8.5.13对MySQL5.7实际抛商业版门槛异常。不能把之前20JUnit/1107parity构建通过说成数据库可用；没有B1接受。

main核对官方7.15.0源码后批准唯一core7.15.0/移除mysql模块与Community配置API适配，详见tasks/B01-B1-flyway-decision.md；其余版本不变，无许可证绕过/付费/数据库升级。worker保留停点f4b6b548/report2d6a1599，clean停写、全部句柄闭合、实际lifecycle代码尚未执行。后续新artifact/hash/tree及所有实际测试须重新验证。history负例还须检查fixture前后完整history事实相等，不能仅凭rollback调用假设Flyway未隐式提交。

04:26UTC实际读13cb0d94b9f99fb6944153edad923513ab185904全部五实现文件diff（chunk551236）：POM单core7.15.0、Community四ignore开关严格值、build拒绝任何其他flyway模块；新配置JUnit断言完整。每个history fixture取十列全行事实前后比较并再次readiness，真实query只捕SQLTimeoutException且750..3999ms，避免任意SQL失败误通过。唯一builder39337由worker启动，当前结果未知，主代理不竞争构建/DB，也未把代码断言当真实通过。

04:27UTC结果：39337/12873真实编译失败（7.15 getter名差异），b18ebf37仅一行getCreateSchemas适配已main读9c5cf8；新builder67960 workerexit0/14e559，20JUnit/1107同14ebb38c/零差异、36class52/34库和actualfatjar/source/V1/logexact。report35c67270/951db5实际读回；当前真实DB30892运行未知，尚非数据库或main独立接受。旧getter失败保存，不污染接受的真实结果。

04:30UTC 30892实际失败：migration1/noop0/store/reload（含严格超时）真正成功，history比较失败捕获Flyway将autocommit true的真实行为；finally全回收，不计B1完成。worker reportcfea/codeb18冻结停写clean/nohandles；无生产selector。main选择v2.2仅test-main固定history commit、runner真正拒绝且mutated facts不变、准确原单V1行tear-down后十列facts/ready；不用半模拟历史副本或新运行时table配置，不隐藏失败/自动repair。详见tasks/B01-B1-history-fixtures.md，后续全套重新验证，main独立尚待。

1. SIGTERM若在ready/appPassword期间已触发，必须在ownedProcess启动和秘密stdin发送前检查已abort，不能只事后加abort listener；finally清理不被signal取消。child仍需窄修及真实测试，不认定已解决。
2. 实际打包迁移与日志资源纳入审计已在5fb落实，仍须真实Java8构建/解析和两库验证，不能只源文本匹配。
3. 合法Unicode/emoji/NUL/孤立surrogate、最大边界、原JSON/不可变receipt字节和stableordinal必须真实JDBC重开往返；当前离线codec源码/用例不替代数据库证据。
4. 无FK的跨空间/版本/成员关系责任留C/D应用事务，B1只结构检查，不伪造SQL关系拒绝。C1草案已经明确同事务查验与锁序，但仍draft/未派发。

## 接受前仍需

冻结最终code/report SHA、clean停写与全部builder/测试退出；主代理读最终完整diff和实际验收harness，独立运行Node边界、F03、完整JDK8构建、两顺序空MySQL5.7 migration/noop/history/catalog/权限/字符串、checksum/缺坏配置/离线/超时、未ready失败与真实SIGTERM清理，核对原dev3与volume/runtime无测试残留。无main DB通过、无B1接受、无先合入未验收实现。

# B01-B1 v2.1：免费迁移依赖兼容性窄修

2026-10-06 04:17 UTC · 主代理技术决定 · ready · 仍限已授权B01-B1

## 实证与决定

worker真实database-check35236和95334均exit1且各自精确finally回收；第二轮已明确empty-readiness正确MIGRATION_INVALID、首次migrate仍MIGRATION_INVALID，未到no-op/存储/第二库。主代理本地javap chunkc24490与worker独立javap均确认Flyway8.5.13的MySQL版本门槛8.0会对5.7实际抛FlywayEditionUpgradeRequiredException，不是仅warning。JDK8构建及JSON parity通过从未代表实际迁移通过，失败记录保留。

为遵守用户JDK8/MySQL5.7、免费本地开发和既有实现授权，本片唯一允许依赖调整为官方Maven Central的 **org.flywaydb:flyway-core:7.15.0 Community**，移除独立flyway-mysql8.5.13。该版本MySQL支持在core。不能升级MySQL/JDK、购买许可证/试用商业功能、修改第三方库/许可证检查或调用付费API；不新增B02/HTTP/业务范围。

主代理已核对官方tag源码：[Java8 POM](https://github.com/flyway/flyway/blob/flyway-7.15.0/pom.xml)、[MySQLDatabase](https://github.com/flyway/flyway/blob/flyway-7.15.0/flyway-core/src/main/java/org/flywaydb/core/internal/database/mysql/MySQLDatabase.java)、[配置API](https://github.com/flyway/flyway/blob/flyway-7.15.0/flyway-core/src/main/java/org/flywaydb/core/api/configuration/FluentConfiguration.java)。POM target8、MySQL免费门槛5.7及Apache2头可见，但尚不算本工程真实通过，也不表示旧版本当前安全维护/生产认证。

## 唯一实施范围与前置快照

- 沿用原gpt-6.1-sol/high `/root/b01_contracts_high`、同B01-A02，无派生/第二写者。工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`，分支codex/devclaw-bot-local，当前保留code f4b6b548849850becc6a9f44a84decf031487f7f / report2d6a1599200514d6502cc1d126768c1ef8a24dbb。先核对实际clean/无运行句柄及主代理新文档，不能reset/删除成果。
- 只允许services/bot-control/**、deploy/dev/service/**、tests/bot/service/**、必要两README末尾/精确package脚本及本人attempts/B01-A02.md。主代理独占tasks/state/HANDOFF/reviews。原冻结源、生成DTO、TS/src/锁、B00/F05和现存dev三服务/权限/数据不改。
- POM flyway.version及直接依赖统一7.15.0，移除mysql模块；其余版本和单SLF4J2/Log4j provider固定。对应构建/audit/兼容与配置测试只做必要适配，不能因库数/hash变化取消审计。记录新的真实dependency tree、全部runtime libs和产物hash，旧35库/hash只历史不作新期待。
- MigrationRunner不用7.15的Teams-only ignoreMigrationPatterns；Community显式ignorePendingMigrations(true)、ignoreFutureMigrations(false)、ignoreMissingMigrations(false)、ignoreIgnoredMigrations(false)。保留fixedclasspath/history、validate前置、missing location失败、cleanDisabled/cleanOnValidationError false、baseline false/createSchemas false/outOfOrder false、无env/defaultsettings、短连接/锁等待、safe errors。readiness严格单V1/SUCCESS/script/checksum；不为通过测试放宽未来/旧/漂移/失败检查。

## 必须重新验证

1. 真实Corretto8/Maven完整构建（不是audit-only）：原A1/A2与新Persistence tests、1107同轮Java/Ajv parity零差异、class52、单日志provider、实际fatjar三冻结资源/manifest/V1/log配置bytes检查。公开可信下载允许，但继续任务专用private settings/cache和Central HTTPS，不读取用户settings/认证。不复用旧20tests通过当新快照通过。
2. 两个新的owner-checked隔离MySQL5.7项目顺序真实migration/no-op/readiness/catalog/原Unicode与1MiB原JSON bytes/稳定顺序/max-safe Long/permissions；固定新空库schema-ALL且无FK/global/GRANT OPTION/其他库。不能读旧root/改现存dev/livegrant。失败不自动repair/drop/reset。
3. history旧/未知/漂移/失败/缺项的fixture，必须核对运行时拒绝前后mutated完整事实相等，不只假设rollback生效；按后续[B1 v2.2固定夹具决定](B01-B1-history-fixtures.md)显式commit和仅测试main的准确tear-down，每次恢复后原history事实相等+readiness。不开生产selector或repair。真实SQL超时、错密码/离线、metadata负例、未ready故障及OS SIGTERM（含ready→secret检查期间已abort必须0数据库子JVM/0秘密发送）全部有界、精确finally回收。
4. 先核对已失败两轮与全部句柄闭合，再启动新轮；本片不并发两空库、不竞争builder。报告失败阶段只固定command/status/category，不输出任意驱动异常/SQL/URL/凭据。资源归属/原dev3健康/无测试残留都实际核对。

最终freeze代码/report SHA、clean停写和确定全部命令关闭交主代理；主代理真实diff和独立复验接受之前不进C1/HTTP。定时自动续跑保持PAUSED。此决定是实现兼容性修正，不能代替任何新增外部/付费/系统权限授权。

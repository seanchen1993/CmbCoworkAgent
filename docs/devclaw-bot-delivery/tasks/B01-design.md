# B01 设计决定：本地六接口服务

2026-10-03 · v1 · 主代理设计，尚未实现／验证，不代表生产技术基线

## 1. 产品与模块边界

Bot是带不可变版本的领域配置；Group是成员与伙伴的协作团队，与招乎群、Thread和Runtime独立。B01只让配置可被安全共享和持久化，不编排智能体、不调用模型、不读取真实仓库。需求／原型／项目模式保持原入口。

Java服务按`http → application → domain + ports → persistence/dev adapters`分层，不拆微服务。身份、空间成员资格、资源引用授权保留适配口，当前只实现显式dev fixture。HTTP、数据库行、生成DTO不能充当授权凭证。

为保证这六接口的事务完整，包含最小命令回执和内部mutation outbox。它只记录伙伴／团队变更引用，无派发器、消息投递、Task/Run、公共事件API或外部副作用；不提前建设B02调度体系。

## 2. 本地开发技术选择

- 实际JDK8编译、测试、运行，产物class major52；用新JDK编译source8不算通过，不使用Java9+ API。
- 本地公开Spring Boot **2.7.18** + MVC/JDBC/HikariCP，Maven **3.9.6**。这是可替换的开发基线，不是内部增强2.7.2的安全认证替代；禁止公网监听／远程部署。
- Connector/J **8.0.33**、Flyway core + mysql **8.5.13**；真实Docker MySQL5.7，H2／mock SQL不能替代集成验证。
- JSON Schema validator **networknt1.5.9**（Draft2020-12），Jackson BOM **2.18.3**。显式开启format assertions，关闭宽松类型转换和远程schema加载。
- 避免Boot默认SLF4J1.7与validator的SLF4J2混用：排除默认logging starter，固定SLF4J API **2.0.17**，Log4j2 API/core/slf4j2-impl **2.25.3**，只有一个provider。无log4j-to-slf4j回环／Logback／SLF4J1.x混入。A步出现实证不兼容须报告并由主代理调整，不能自行升级JDK／Boot主版本或隐瞒linkage error。
- 下载仅走Maven Central HTTPS mirror；使用空的任务专用user/global settings和任务专用local repository，不读取用户settings.xml、私服认证／代理凭据／extensions。可离线复用已核对的公开缓存包，记录实际dependency tree与打包内容。
- 不加Actuator、Swagger UI、注册发现、云配置、ES/S3／模型／招乎SDK、生产认证替身。框架默认登录页／错误页／datasource猜测不作为有效服务。

依据：[Boot Java8要求](https://docs.spring.io/spring-boot/docs/2.7.18/reference/html/getting-started.html)；[该分支公开支持已结束](https://spring.io/blog/2023/11/23/spring-boot-2-7-18-available-now/)，不能宣称生产安全维护。[networknt1.5.9说明](https://github.com/networknt/json-schema-validator/blob/1.5.9/README.md)及[固定POM](https://github.com/networknt/json-schema-validator/blob/1.5.9/pom.xml)给出Java8、2020-12、format行为和依赖版本；[Flyway8.5.13 POM](https://github.com/flyway/flyway/blob/flyway-8.5.13/pom.xml)给出Java8 target；[Log4j安装说明](https://logging.apache.org/log4j/2.x/manual/installation.html)说明Java8 runtime和SLF4J2 binding。兼容文档不等于本工程已通过，必须真实运行。

## 3. 同一契约源，两层验证

只读源：`contracts/bot/v1/schemas.json`、`state-transitions.json`、`openapi.json`。不得另写字段／错误码／路径规范，不降成OpenAPI3.0/Swagger2。

Java生成器只遍历六operation请求／成功响应、ErrorResponse、space header与路径ID的可达定义，产生typed POJO、enum、List、Long等封闭结构。不得以Object/原始Map兜底；可选字段省略，非可空字段不接受null。明确支持有限标量、封闭对象、数组、引用、枚举和本图内条件约束；不宣称生成了Runtime／全部API。可达图出现未知关键字、远程引用、开放对象必须失败非零，不能静默跳过。

DTO不替代边界校验：运行时从构建时复制的原始Schema离线解析并校验请求和响应。生成头记录输入摘要，`--check`只比较不覆盖；构建不能靠自动重生掩盖漂移。Java与Node/Ajv对同组fixtures结论一致，覆盖pattern终结换行、中文／emoji字符数、safe integer、未知字段、optional/null、日期和ErrorResponse条件。

严格JSON parser拒绝重复键、尾随JSON、不合法UTF8、非JSON数字、宽松注释；合法整数1/1.0/1e0指纹相同，不丢精度。version用Long但仍受1..9007199254740991约束，不能因Java范围更大而放宽。

## 4. 本地身份与入口安全

- 仅明确local-dev模式、实际监听字面127.0.0.1时可启用dev身份，不因缺认证自动降级。HTTP仅为本机开发例外，F03生产HTTPS要求未变。
- 每个开发实例随机bearer token，通过0700目录／0600文件给测试客户端；不得进入源码、报告、启动argv、日志或错误。缺文件／权限过宽／链接或未知归属／坏内容必须失败，不扫描已有凭据。
- dev registry明确主体active状态、空间成员资格、bot.create/group.create管理能力、可配置能力上限、可关联knowledge/repository/skill ID。这些是本地策略字段，不加入公网DTO。token只解析主体；space header／目标principalId／自然语言都不能定义当前操作者。
- registry是启动时读的完整可信快照，本轮不做热更新或公网身份管理；变更后重启。Group／maintainer权限每次从持久记录读取，不能无限缓存。
- 缺／重复／畸形Authorization为401；缺／重复／非法space头和路径ID为400；已认证无空间资格为403；同空间无对象权限为403；跨空间／不存在为404，不带真实归属或当前版本。
- 请求总字节上限1MiB，头部／JSON深度／字符串／数字和连接／读取／SQL时间有界，包括chunked和重复命令。只接受六个method/path，拒绝畸形／双重编码／编码斜线／点段／未知query，不把框架自动规范化当授权。
- 无Cookie/session/body身份，拒绝不期望Origin；关闭CORS、forwarded头信任、请求体/access/debug日志、默认HTML错误。不能只相信Content-Length。
- ErrorResponse按冻结错误表映射，requestId服务端生成，不回显输入、SQL、连接串、异常／堆栈。正常API失败必须一致JSON；框架在应用前拒绝的畸形传输以连接安全、不泄密为准，不伪造成功。

## 5. 最小授权矩阵

| 操作 | 当前主体权限 | 新写语义检查 |
| --- | --- | --- |
| createBot | active空间成员且具bot.create | maintainers包含自己且全为同空间active成员；主体可关联配置引用；ceiling不超主体可配置范围 |
| getBot | active空间成员且为Bot当前维护者 | 一致读取Bot与currentVersion |
| createBotVersion | 同上且Bot active | 新配置重新查引用／ceiling，CAS递增实体version和配置number |
| createGroup | active空间成员且具group.create | 自己以admin在成员中；所有成员active同空间；各版本确属指定Bot和空间，Bot active且主体是维护者 |
| getGroup | active空间成员且在当前Group成员表 | 知道groupId/botId不产生权限 |
| updateGroupMembers | active空间成员且为当前Group admin | 新集合至少一admin、目标成员active同空间；新增／更换Bot版本按createGroup查关联权；未变的合法既有引用不要求每个admin都成为Bot维护者 |

按principalId／botId语义去重，不能以同ID不同role/version绕过uniqueItems。角色只用F03枚举；不额外要求恰好一个coordinator，不自动补负责人，只有specialist的团队合法但不代表已具调度能力。

更新完整替换members/bots，不改name/limits。允许移除自己但至少保留一admin；移除／降级后重放旧管理命令也按当前权限拒绝，幂等不恢复撤销权限。Group成员不自动成为Bot维护者，不能因固定了旧版本而读取未共享的新current版本；B01的getBot保守限维护者，Group只暴露版本引用。

这些是本地首片规则，不宣称完整企业RBAC／资源分享。引用可关联不代表转授底层资源给Group成员；本轮不fetch。未知／无权关联统一403，不能探测其他空间目录。配置写入不执行任何capability。

## 6. SQL、版本与迁移

- InnoDB、utf8mb4、UTC/DATETIME(3)；ID/命令键为ASCII二进制比较，实测大小写ID不互命中，并注意MySQL5.7索引长度。
- 表覆盖Bot、BotVersion、maintainers、Group、group_members、group_bots、command_scope锁、command_receipts、mutation_outbox。所有查询／唯一约束限定spaceId；关联外键含spaceId，版本必须属于Bot。创建循环外键确需省略时以同事务与不变量检查保证currentVersion存在且正确。
- BotVersion append-only，Group保存准确botVersionId，不跟随currentVersion变化。读取使用一致事务／对象行共享锁，避免header和成员／版本跨快照。
- 初始version=1；CAS只+1，到契约上限拒绝不溢出；仅向已授权主体回冲突currentVersion。
- config/回执JSON使用有界足够列（如MEDIUMTEXT），入库／出库均原Schema校验，不截断TEXT／丢emoji。SQL参数化，用户内容不拼接为表名／SQL。
- Flyway增量迁移，禁clean／baselineOnMigrate、校验checksum，再执行no-op。5.7 DDL不保证回滚，失败保留现场、报错，不自动repair/drop/recreate。启动校验已迁移版本，HTTP请求不跑DDL。
- 本地CLI先显式migrate再serve，仅连接B00已核验归属的回环端口/schema，不接受任意扩展JDBC URL。服务使用schema限定账号，不读root秘密，不回退root／匿名，不访问其他schema。生产迁移账号分离/轮换后续接入，不把schema级dev账号宣称为生产最小权限。

## 7. 写命令事务顺序

1. 有界解析／Schema校验，服务端解析身份、当前空间资格及操作权限。
2. READ_COMMITTED短事务，通过(spaceId,principalId)数据库锁行串行化该主体命令；锁超时／死锁全回滚，不靠应用内mutex冒充跨进程保证。
3. 对现有目标加行锁并查当前资源权限；创建操作先查create权。再查(spaceId,principalId,commandId)回执。创建接口的历史目标从服务端回执元数据解析，回旧body前再查该目标当前权限，不按新请求成员表鉴权。
4. 已有回执先按DB UTC检查过期，再比指纹；异操作／路径／内容为COMMAND_CONFLICT。同内容且当前有权返回原HTTP状态及不可变body，不再查当前CAS／新写语义，不新增outbox。
5. 无回执才查CAS与新配置／引用／成员，原子写业务、验证输出、保存一份成功回执及一份mutation_outbox，然后commit才返回。outbox只含安全对象引用／版本／主体／操作，无配置正文／秘密。失败无半成品版本、成员集、回执或outbox。

指纹包含认证空间／主体、规范method/path、移除commandId后的规范JSON；对象键排序，合法等值整数归一，数组顺序保留，expectedVersion仍参与。另一主体／空间同commandId独立；不同ID同body不能误去重。

成功回执本地默认有效7天，使用DB UTC；B01不物理清理，过期仍保留tombstone，返回COMMAND_EXPIRED而非新写重放。未知commit结果不声称确定失败／retryable=true，可回OUTCOME_UNKNOWN并保留同ID对账能力，不自动换ID重试。DB唯一作用域和事务事实决定后续结果，内存状态不是唯一依据。

命令锁／对象锁次序固定，多引用按确定顺序，不在事务内调模型／网络／Runtime。CAS落实到SQL条件或受锁权威version，禁止旧值读取后无条件覆盖。

## 8. 可执行验收

集成测试使用唯一B00测试project/volume/schema，停止服务后只回收自身资源，开发数据不清空；失败／OS SIGTERM有准确进程和资源证据，不skip伪报通过。

1. **构建/契约**：真实JDK8、DTO编译消费、生成漂移/未知关键字/远程ref失败；Java/Node同组正负fixture一致；六operation实际响应经F03验证。
2. **HTTP全链路**：Bot v1→读→v2→读，旧v1未变；Group固定v1→成员/伙伴更新→读，Bot新版本不自动切Group；服务重启后仍成立。
3. **权限**：匿名／畸形认证／重复头；两空间、同空间维护者/非维护者、admin/participant/移除成员；伪造actorId/spaceId、错BotVersion、重复ID、无admin、角色提升、未知/无权引用、ceiling越界均无写入。
4. **幂等**：四写接口重放原状态/body/ID/version；键序/等值整数不误冲突；同ID改body/path/method冲突；跨主体/空间ID独立；CAS前进仍可回原成功；撤权拒绝；过期不重复创建。
5. **并发**：两个独立JVM同库，同ID并发只有一次业务更新/版本/outbox；不同ID同expectedVersion仅一成功另一409，无半写。不能只测单进程顺序调用。
6. **事务/未知结果**：测试专用注入点在写版本／部分成员后、写回执／提交前失败，所有相关表回滚；提交后模拟响应丢失，再重启以原命令取回结果。注入只在测试构造器/port，无公网header／生产env开关。
7. **迁移/账号**：两空环境、再迁移、checksum漂移拒绝、重启/UTC/emoji/大小写ID；不能访问其他schema/mysql表/CREATE USER；坏版本／DB不可用／缺秘密启动失败，无root回退。
8. **入口/日志**：超大/慢请求、深度/重复键/坏UTF8/路径/query、chunked限额、Origin、秘密哨兵；输出/日志/错误无token/password/输入原文／堆栈；真实daemon/SQL/JVM异常也安全映射。
9. **回归**：F03统一入口（当前24项及生成/type消费），F05 mock（当前15项），B00关键离线/真实入口，node/web类型检查；src、锁文件、冻结契约、原scripts语义未改。

每项给出代码快照、命令/exit/计数及真实资源证据。主代理至少独立运行一次完整服务集成与关键负例，阅读实际diff及授权/事务顺序后才能接受。

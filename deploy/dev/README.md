# F05 本地开发替身与兼容探针

这里只交付 dev 工具，不是伙伴生产服务。生产方向仍是 **Java 模块化单体 / JDK 8 / MySQL 5.7**；Node 22 仅用于现有仓库的离线开发编排。没有 Spring Boot 服务骨架、Bot CRUD、企业登录、正式招乎协议、持久任务/Outbox、Runtime、发布、S3 或 ES 联调。

支持具备 `/tmp`、Unix socket 的 POSIX macOS/Linux；本轮实测 macOS。Java classpath 使用 POSIX `:`，不宣称 Windows 已验证。不要联网安装依赖、拉镜像或启动系统服务。缺工具、错误版本、驱动不匹配必须退出非 0，不能 skip 后报告通过。

## 入口

所有入口使用 **Node 22**，所有子 Node 使用相同 `process.execPath`；不调用 npx 或 npm 安装。

```sh
node deploy/dev/cli.mjs mock --profile dev
node deploy/dev/cli.mjs serve --profile dev --lifetime-ms 60000
node deploy/dev/cli.mjs doctor --profile dev <工具选项>
node deploy/dev/cli.mjs real --profile dev <工具选项>
node deploy/dev/cli.mjs check --profile dev <工具选项>
```

`mock`：离线配置、HTTP 负向安全、同实例隔离、故障和独立进程生命周期测试。`doctor`：执行工具版本与真实 Java 编译/运行，不启动数据库。`real`：doctor 后运行两个独立空 MySQL 实例、事务探针和失败/中断矩阵。`check`：统一串联 mock → doctor → real，严格区分分类，不把 mock 当 real。

追加的 npm scripts：`test:bot-dev`、`test:bot-dev-real`、`check:bot-dev`、`dev:bot-doctor`、`dev:bot-mocks`。原 scripts 和依赖没有更改；使用 npm 时也必须确保它由 Node22 启动。可用 `--config deploy/dev/config.example.json` 代替 `--profile dev`；缺失、prod、未知 profile/字段、非字面量 `127.0.0.1`、开启真实 S3/ES 均失败，无环境变量自动降级。

## 工具清单与本机实测命令

2026-10-02 UTC 实际执行：Node22.22.2、Corretto Java/Javac1.8.0_482、MySQL 客户端/服务端5.7.24、Connector/J8.0.33、可选 Maven3.9.6。JDBC jar 仅为已有开发缓存的兼容探针依赖，不据此批准生产维护版本。

必传绝对路径：`--java`、`--javac`、`--mysql`、`--mysqld`、`--jdbc`。`--maven` 可选，不提供时明确 unavailable/optional；提供但不可用时失败。`--mysql-messages` 可选，供消息资源默认位置失效的已有安装使用，传包含 `english/errmsg.sys` 的父目录；本机 conda 安装必须传该选项。程序未硬编码以下开发者路径。

```sh
F05_NODE=/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node
F05_JDK8=/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home
F05_JDBC=/Users/heyirui/.m2/repository/com/mysql/mysql-connector-j/8.0.33/mysql-connector-j-8.0.33.jar
F05_MAVEN=/Users/heyirui/.m2/wrapper/dists/apache-maven-3.9.6-bin/439sdfsg2nbdob9ciift5h5nse/apache-maven-3.9.6/bin/mvn
"$F05_NODE" deploy/dev/cli.mjs check --profile dev \
  --java "$F05_JDK8/bin/java" --javac "$F05_JDK8/bin/javac" \
  --mysql /opt/anaconda3/bin/mysql --mysqld /opt/anaconda3/bin/mysqld \
  --mysql-messages /opt/anaconda3/share/mysql --jdbc "$F05_JDBC" \
  --maven "$F05_MAVEN"
"$F05_NODE" tests/bot/check-contracts.mjs
"$F05_NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
"$F05_NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
```

在仓库根目录执行；不要用 java_home 列表中不带 `-1` 的残留 Corretto 目录。本轮检查点、真实退出码和候选 SHA 见 [F05-A01](../../docs/devclaw-bot-delivery/attempts/F05-A01.md)；本地通过不等于主代理接受。

## 分类与后续接入边界

| 项目 | 分类 | 实际证明 / 尚未实现 |
| --- | --- | --- |
| Node/JDK/Javac/MySQL binary/JDBC | verified（成功时） | 实际执行；JDK8 编译及运行，class major52；错误版本 unavailable 并失败 |
| MySQL/JDBC 事务 | real/verified（成功时） | 新建独占5.7实例，utf8mb4中文/emoji、UTC、DATETIME(3)、双连接 READ_COMMITTED、commit/rollback、唯一索引、expectedVersion CAS、有限权限 |
| 身份 / 招乎 / 模型 | mock | 固定合成成员与fixtures，无真实平台连接，无生产授权保证 |
| S3 / ES | disabled | 不探测地址、不读取账号、不发请求 |
| Maven（不提供） | unavailable/optional | 不下载；不是未确认内部 BOM 的替代品 |
| Spring Boot / 正式网关 | 尚未接入 | 内部 parent/BOM、补丁、维护方和正式群协议待提供；不引入公开 Boot 替代 |

后续生产接入需要平台方确认内部 Spring BOM、MySQL 内网补丁/连接/备份策略、S3 产品及签名/TLS/版本化能力、ES 版本/ACL/分析器、Java 网关与正式招乎协议。这里不要求提供真实账号或 Token，不推进 B01。

## 替身协议（非 Bot OpenAPI / 非正式招乎协议）

`serve` 仅监听字面量 `127.0.0.1` 的随机空闲端口，寿命100～60000ms，默认60s。每次启动生成两枚独立随机 Bearer，只写入本次私有目录0700内的 `session.json`（0600），stdout只输出 URL、文件路径和期限。可信开发 harness 可读取该文件；不要把它发到聊天、提交Git或浏览器页面。期限结束或 SIGINT/SIGTERM 后删除；SIGKILL/断电无法保证 finally，不宣称跨进程恢复。

也可从 `mock-server.mjs` 导入 `startMockServer(config)`，在可信测试程序中使用返回的 `url/credentials`，并在 finally `await server.close()`。没有匿名身份签发接口，请求中的 actor/space/header 不能扩权。

| 合成身份 | 默认私有空间/任务 | 显式共同任务 |
| --- | --- | --- |
| alice / principal-1 | space-1 / group-private-1 / T-1024 | group-shared / T-3001、T-3002（space-1） |
| bob / principal-2 | space-2 / group-private-2 / T-2024 | 同上，仅固定成员授权；不是任意跨空间访问 |

适配器业务响应带 `mock:true`（HTTP解析器自身的错误响应不属于dev包络），使用 `Authorization: Bearer <本次凭据>`。GET `/dev/v1/session` 返回合成身份；GET `/dev/v1/tasks` 只列当前身份有权任务；GET `/dev/v1/tasks/T-1024/messages` 按任务成员校验。Task/TaskMessage 克隆已冻结 F03 合成 fixtures，测试继续用原 Schema 验证；dev 包络、附件元信息和回执不是新增正式 DTO。

POST `/dev/v1/zhaohu` 的 JSON：

```json
{"groupId":"group-shared","taskNumber":"T-3001","text":"Synthetic business input","attachments":[{"name":"synthetic.pdf","mediaType":"application/pdf","sizeBytes":20}]}
```

必须显式任务号；缺失时409 `SELECT_EXPLICIT_TASK`，不选最近任务。非成员、私有空间交叉或不属于该群的任务号拒绝；附件只有有限名称/MIME/大小元信息，不接收 URL、本地路径或文件内容。只维护有界、进程内合成消息，没有数据库持久业务或幂等回执保证。

POST `/dev/v1/model`：`{"taskNumber":"T-3001","kind":"analysis"}`（或 clarification），返回确定性带 `[MOCK]` 文案，`tools:[]`。可加 `"fault":"failure"` 返回503，或 `"fault":"timeout"` 在120ms后返回504。拒绝未知字段、任意 URL/文件路径/工具；不调用任何模型网关。

HTTP边界：正文8192字节、文本512字符、附件4条/单个元信息大小≤1MiB、每任务消息16条、同时请求8个、连接16个、头字节8192/完整头数量32、body等待300ms、未完整headers约1s（检查周期50ms）。Host必须是本实例 `127.0.0.1:port`；拒绝所有 Origin（包括同源浏览器 Origin）、非none Sec-Fetch-Site、转发/身份头、重复安全头。不设 CORS，面向可信非浏览器开发 harness。解析器不截断头数量，防后置 Origin 被隐藏。

## 真实实例的隔离与收尾

每次 realProbe 只使用 helper新建的 realpath(/tmp)/dcb-f05-* 私有目录，登记路径/inode/dev归属；不凭前缀删除外来目录。独立 data/socket/pid/log，`--no-defaults`，精简子环境清除继承凭据；MySQL5.7以 `MYSQL_TEST_LOGIN_FILE` 指向本次不存在文件禁用用户登录路径（不使用8.2才有的 `--no-login-paths`）。不改HOME、默认库、全局配置或用户登录文件。

先初始化和启动 `--skip-networking` 实例，用新socket的无密码root设置随机root密码及仅127.0.0.1的有限测试账号，只授权本次 `f05_compat` schema；密码通过stdin，不在argv/env/普通日志。停止该本人子进程后才开启随机非3306端口、`--bind-address=127.0.0.1` 的 JDBC。就绪要求本人进程存活、PID文件匹配、独立socket和真实SELECT1，不以目录存在/日志文字替代。

探针只创建 `f05_probe` 测试表。JDBC不提供外部URL选项，固定127.0.0.1、f05_compat；Java socket/connect超时与编排启动/执行截止时间均有限。一般子命令15s、初始化30s、就绪20s，正常/异常/中断先关闭本人持有子进程（TERM后2s可KILL）再删除本人目录；绝不按进程名或未经认领的PID停止服务。失败只报告allowlist阶段/原因/退出码，不转储含SQL/完整或半截密码的原始输出。

`real` 每次实际跑两空实例及 after-initialize/bootstrap/listen、真实mysqld启动失败和独立Node进程OS SIGTERM。测试只对已记录本人PID做 signal0 存活检查，不以PID执行kill；核对目录ENOENT、已监听端口ECONNREFUSED。诊断文件、class和数据库数据只在临时目录，finally删除，不留在仓库。无法证明收尾时入口失败，不输出通过。

## B00 Docker 三服务本地依赖（独立入口）

本入口提供 MySQL5.7.44、Elasticsearch8.19.22（Basic，容器自带JDK）及 SeaweedFS4.48 的 S3 兼容服务。应用仍只用 JDK8；不实现 Java ES/S3 业务适配器，不启动登录服务。上方 F05 的 S3/ES `disabled` 不变。最新真实结果与未完成项以 [B00-A01](../../docs/devclaw-bot-delivery/attempts/B00-A01.md) 为准；本段不是主代理已接受的声明。

要求 macOS arm64、Rosetta、Node22、稳定 Homebrew Colima/Docker CLI/Compose（不用 Docker Desktop）、显式 JDK8 java/javac 和 Connector/J8.0.33。本任务已安装 Colima0.10.3/Lima2.2.0/Docker CLI29.8.2/Compose5.6.0；daemon29.5.2。工具缺失即失败，不静默换原生 MySQL、远程daemon或其他数据库。重新安装/下载不属于日常 `start`：它只接受已缓存的固定镜像。

镜像来自已核对官方源，固定对应平台的 manifest/实际 Docker29 ID（不是 `latest`）：

- MySQL `docker.io/library/mysql:5.7.44@sha256:dab0a802b44617303694fb17d166501de279c3031ddeb28c56ecf7fcab5ef0da`，linux/amd64，经 Rosetta；不可替换8.x/MariaDB。
- [Elasticsearch官方8.19文档](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/docker.html)：`docker.elastic.co/elasticsearch/elasticsearch:8.19.22@sha256:c2a3ed5f968be6d59c960aa0c60cfdaee667b6bc8211142021a41d0e85b43237`，linux/arm64；认证开启，不开trial。
- [SeaweedFS官方4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48)：`docker.io/chrislusf/seaweedfs:4.48@sha256:f1f303474940e9e088edbd2c1658f7ac38cb0dd90f91a2b0a51916d74b8575a1`，linux/arm64。

私有 client/profile/state 位于当前用户 `~/.devclaw-bot-b00`，目录0700，文件凭据0600；默认 Docker/Colima/Lima 配置不改。专用 profile `devclaw-bot` 为2CPU/4GiB，30GiB稀疏数据盘加20GiB稀疏系统盘（上限不是立即占用量），仅本任务 runtime 目录只读映射给VM，无HOME/根目录/SSH agent/host network/privileged/socket挂载。容器内存上限分别768MiB/1280MiB/512MiB，总2560MiB；CPU上限1/1/.75、PID128/512/128、日志每服务5MiB×2、restart=no。S3入口root仅准备精确volume子目录后exec降UID501（实际当前用户UID）；长期进程非root，秘密不改权限、不进argv/env。

三服务分别用独立named volume，只有API映射到字面量127.0.0.1的随机非默认端口；不发布ES transport或S3 admin/filer/master。唯一任务自定义bridge `internal:false`、host_binding_ipv4=127.0.0.1：资源/入站隔离，**不是禁止出网的沙箱**，不因此授权真实内网/AWS/外部业务访问。检查会核对实际Docker网络成员/全部挂载/发布端口和宿主lsof，客户端无外部URL选项、不读AWS默认profile、不使用代理或重定向。

在仓库根目录设置自己已存在的绝对工具路径（不填密码）：

```sh
B00_NODE=/absolute/path/to/node22
B00_JAVA=/absolute/path/to/jdk8/bin/java
B00_JAVAC=/absolute/path/to/jdk8/bin/javac
B00_JDBC=/absolute/path/to/mysql-connector-j-8.0.33.jar
"$B00_NODE" deploy/dev/docker/cli.mjs vm-status
"$B00_NODE" deploy/dev/docker/cli.mjs start --java "$B00_JAVA" --javac "$B00_JAVAC" --jdbc "$B00_JDBC"
"$B00_NODE" deploy/dev/docker/cli.mjs status
"$B00_NODE" deploy/dev/docker/cli.mjs stop
"$B00_NODE" deploy/dev/docker/cli.mjs test --java "$B00_JAVA" --javac "$B00_JAVAC" --jdbc "$B00_JDBC"
"$B00_NODE" --test tests/bot/docker/*.spec.mjs
"$B00_NODE" tests/bot/docker/lifecycle-real.mjs
```

`start` 幂等，一次启动三服务并用真实Java8/JDBC和认证HTTP检查；stdout仅地址/版本/资源名/私有凭据目录，不打印密码。root仅localhost，app账号仅devclaw schema的SELECT/INSERT/UPDATE/DELETE/CREATE/INDEX；随机root/app/ES/S3凭据互不复用。可信程序从报告的 `credentialDirectory` 读取 `app-client.cnf`、`es-client.cnf`、`s3-client.json`（均0600），不要把内容复制到聊天/Git/命令行。`status` 检查实际健康和回环监听；`stop` 只停止该dev项目且保留三volume/凭据。需要释放VM内存时先stop，再显式`vm-stop`；已有profile的`vm-start`保留数据、最长1800s，禁止delete/覆盖其他配置。

`test` 总截止600s，串行两个64bit随机后缀的独立项目，实际Java8/class52/容器MySQL5.7.44：UTF8MB4中文emoji、UTC/DATETIME(3)、有限权限、双连接READ_COMMITTED、commit/rollback/唯一索引/CAS、重启数据及第二空库。ES测试Unicode写读搜索/删除、匿名和错密码401、Basic版本、重启保留；S3只用本地SigV4签名PUT/GET字节hash/LIST/DELETE、匿名/坏签名403、重启保留。`lifecycle-real` 是另外串行的启动失败与OS SIGTERM精确清理验收。失败码只报告固定阶段/状态，不输出原始服务日志；日志读取失败仍尝试owner-checked停止，停止失败有显式标记。

测试finally只回收当次进程认领对象、规范目录和inode、标签一致的精确容器/网络/卷；无prune/down-v/全局删除。SIGKILL/断电不保证finally，不能仅凭名称自动认领旧测试资源；报告明确资源交由授权恢复者核对。S3尚不认证AWS所有高级语义（multipart/versioning/ACL策略/TLS/跨区域一致性），HTTP仅本机开发用，不作生产认证。

Compose健康后，`start`（包括`restart`）、`status`及真实测试使用同一绝对30s就绪窗口，涵盖资源核对、认证S3 LIST、全部已有`.dat`卷在本容器固定loopback master上的注册和ES Basic检查；空环境不要求凭空出现卷。已观察ES初启许可404及S3重启卷注册滞后，仅对这些未就绪状态有界等待，认证/结构错误立即拒绝，取消可中断；持久化GET/hash仍一次严格断言，不重写数据或靠重试掩盖失败。`stop`后随机端口可能重新分配，使用新的`status`结果。

2026-10-05 macOS15.4/arm64实测：两独立空环境的完整Java8/MySQL/ES/S3流程、故障及OS SIGTERM清理均通过；dev CLI重复启动未新增容器，stop保留三卷和凭据，重开后健康，MySQL实际执行x86_64 5.7.44且Rosetta enabled/OCF。当前供开发使用的一套服务以`status`为准；这只是B00自测结果，主代理独立验收尚待进行，不等于生产或内部平台兼容认证。可重复检查dev生命周期：`"$B00_NODE" tests/bot/docker/dev-cli-real.mjs "$B00_JAVA" "$B00_JAVAC" "$B00_JDBC"`（需已有dev项目，结束保留健康服务）。

## B01-A1：Java8依赖兼容构建（尚无API服务）

`services/bot-control`当前只是四组兼容测试及可执行probe，不监听HTTP、不连接数据库、不执行迁移，不代表六接口已实现。固定Boot2.7.18/MVC/JDBC/Hikari4.0.3、ConnectorJ8.0.33、Flyway8.5.13、networknt1.5.9、Jackson2.18.3、SLF4J2.0.17/Log4j2.25.3单provider。非生产维护基线，也不是内部增强Boot兼容认证；DTO与完整F03 parity等待下一片授权。

本机已核对Corretto1.8.0_482、Maven3.9.6的准确路径固定在`deploy/dev/service/build.mjs`（其他机器需明确适配并重新验收，不自动猜测全局配置）。用Node22运行`node deploy/dev/service/build.mjs`：直接Java/Classworlds入口、真实Java8编译/测试/fatjar运行，然后审计实际BOOT-INF/lib、自有class52和4项/0skip。首轮公开依赖仅Central HTTPS下载，构建600s、fatjar运行30s上限；`--audit-only`只检查现有产物，不替代构建及运行。

独立状态/仓库在`~/.devclaw-bot-b01-a1`（owner标记、目录0700/文件0600），空global settings及无server/proxy的Central-only mirror，私有HOME/user.home/local repo。不会读取用户settings/mvnrc/.mvn或继承Java/Maven注入变量，不操作B00环境。产物`services/bot-control/target/`精确忽略；缓存保留，没有清理全局Maven或删除任何开发数据。
### B01-A2a Java contract consumption

`npm run generate:bot-java-contracts` explicitly regenerates the six-operation reachable DTO graph; `npm run check:bot-java-contracts` never writes. `npm run test:bot-java-generator` runs Node22 controlled temporary-fixture rejection/drift tests without changing frozen contracts. `npm run test:bot-service-build` uses the existing isolated Java8/Maven entry point: checks committed DTO drift first, compiles typed consumers, preserves the four compatibility groups and audits every recursively packaged application class as major52 plus the fixed runtime dependencies. No generator runs automatically during Maven compilation, and this slice starts no HTTP listener, database or Docker operation. DTOs do not replace original runtime Schema validation (A2b).

### B01-A2b 离线Schema验证

用Node22执行`npm run test:bot-service-contracts`：新增Node生成/比较支持测试→原Schema资源exact bytes/manifest构建→实际JDK8四兼容+五DTO+六边界组→Java/既有Ajv同runId逐例比较→fatjar源字节/manifest/class52/固定依赖审计。资源、合成fixtures和逐例报告只写服务精确ignored target，保留缓存和失败证据，不连接Docker/HTTP/DB。运行时仅可信classpath和六操作映射，不能由请求指定文件/URL；Schema数据值parity与严格JSON字节层精度分开报告，不冒充生产鉴权、业务/CAS或任意原字节的JS等价。

### B01-B1 本地存储探针（无HTTP业务）

本片迁移九张业务表及固定history，保持MySQL5.7.44/真实Corretto8，唯一兼容依赖调整为Flyway **Community core7.15.0**（移除8.5.13 mysql模块）。8.5.13在真实5.7迁移要求商业版，未绕过许可；7.15仅受控本地基线，不声明生产安全维护。其余固定版本不变；完整构建现在20JUnit/同轮1107parity、全自有class52/实际34库，打包三原源/manifest/V1/log字节审计均保留。

用Node22按顺序执行：`node deploy/dev/service/build.mjs`、`node deploy/dev/service/database-check.mjs`、`node deploy/dev/service/database-lifecycle.mjs`。两空库测试总600s；取消/故障子测试每项240s（父250s），只创建当前进程登记的随机test project，Compose仅mysql/pull never，实际owner/daemon/metadata/容器/回环listener先于app秘密stdin。新空库官方bootstrap固定ALL ON devclaw.*、无GRANT OPTION/global/其他库；root初始化秘密只新生成写给官方入口，程序不读取内容或用root JDBC。不接管旧test/dev，不改B00或现存dev有限账号/数据；现存dev尚未由本片迁移或提供serve口。

无物理FK/CHECK，保留space PK/unique/关联索引及显式ordinal；后续应用事务负责关系/权限/CAS/版本和不可变语义。本片只实测存储：内部ASCII JSON-escaped name保留合法NUL/孤立surrogate，MEDIUMBLOB保留有界原config/receipt字节，UTC/Long/binary ID/顺序在独立JVM重开后不变。固定生产迁移口禁clean/repair/baseline/createSchemas、严格future/missing/ignored拒绝。五损坏history负例仅在可回收测试库显式commit，实际runner拒绝且不改完整事实；test-main仅对准确已知单V1行做预定义参数化tear-down并核对原十列全行+ready，意外变化不盲恢复。SIGTERM/失败finally仅精确回收登记test容器/网络/卷/目录，原dev三服务、缓存和target保留；SIGKILL/断电不能保证finally，不自动认领遗留资源。

### B01-C1 离线六操作应用内核（没有HTTP服务）

`BotApplication.execute`只接受固定六Operation、构造时可信IdentityPolicy/DataSource与可信space/principal上下文；原请求字节先严格原Schema再typed消费，响应和历史receipt再经原Schema。Policy只判断当前空间/成员/create/引用/ceiling资格，不访问模型、IM或仓库。无FK关系在READ_COMMITTED同事务核对，锁顺序command scope→Group父（如有）→排序Bot父→排序BotVersion；输入ordinal顺序与锁排序分开。当前权限先于receipt语义，receipt先于新CAS/配置授权，历史成功字节不重新生成；四写同事务保存唯一receipt与一条仅安全引用的outbox，没有投递器。OUTCOME_UNKNOWN固定409/false，复用原commandId对账；不声明生产exactly-once或HTTP可用。

用Node22顺序执行`node --test tests/bot/service/*.spec.mjs`、`node tests/bot/check-contracts.mjs`、`node deploy/dev/service/build.mjs`、`node deploy/dev/service/application-check.mjs`、`node deploy/dev/service/database-check.mjs`、`node deploy/dev/service/database-lifecycle.mjs`。新application检查只在两个顺序新空owned MySQL测试库执行六操作、重开、完整九表facts拒绝/rollback/immutable replay、两个独立JVM同命令与不同主体同CAS；CAS双方scope锁受控握手而非进程mutex。新增故障/OS SIGTERM检查自己的Java PID实际不存在后再精确清理项目，原dev三服务/秘密/数据不改。应用检查外层1200s、Java90s、每个生命周期子测试240s；原B1入口不改，原20JUnit/1107parity/34固定库审计保留并追加5应用JUnit。Docker inspect的Mounts集合只按Destination稳定排序，保留完整字段且仍执行原安全/归属/实际回环listener检查。

### B01-C2 本机HTTP适配（待完整独立验收）

**当前B02最小切片：** B01已验收记录保留，现仅增加createTask/getTask/createTaskMessage/getEvents，复用同一Java8本机入口/可信身份/MySQL5.7。V1原样，显式V2增四个Task/Message/head/cursor表及原Outbox可空活动列，无外键/新服务/事件派发器。Task继承Group当前成员权限、消息CAS及原命令回执，活动只含实体引用。GET Task返回快照而非消息正文列表；非空成果引用明确409 INPUT_CHANGED，无附件服务/Run/模型/Runtime/UI/招乎实现。

B02比例化验证：先运行`node --test tests/bot/service/*.spec.mjs`、`node tests/bot/check-contracts.mjs`、`node deploy/dev/service/build.mjs`，再运行`node deploy/dev/service/task-check.mjs`。后者只创建两个顺序ownerchecked隔离测试库，分别验证空库V1+V2、真实V1旧数据增量升级/零次重复迁移、四任务HTTP与原六操作烟测、并发/回滚/撤权/分页/重启回执和游标；精准收尾并确认原三服务未变。原limited/unmigrated开发库不自动升级，凭据不读取。旧八入口矩阵为历史B01验收，不要求每次B02重演无关链路。最终通过/未完成项仍以B02报告和主代理实际验收为准。

以上A1/A2/B1/C1段保留各历史切片的范围和当时计数；当前C2新增封闭的六个Bot/Group HTTP入口，不表示旧dev账号已提升、旧库已迁移或原三服务已提供Bot HTTP。固定Java8/Boot MVC/Tomcat及34库沿用，构建仍审计原三源、manifest、V1、日志字节和全部自有class52。最新实测/未完成项以B01-A02及主代理验收记录为准，不用此文档代替接受。

仅显式local-dev、字面127.0.0.1/随机port0：可信启动JSON从私有stdin一次完整读至EOF，关闭环境配置猜测；完整身份和原DB readiness先于监听。不可变local bearer registry只将随机token映射为主体，空间头只是selector，active/成员/create/引用/能力来自可信启动快照，Group/maintainer权仍每次查DB。测试程序在每次读/发秘密前复核本进程登记的0700/0600单链接私有文件、当前owned数据库、实际Java PID及127 listener；秘密不进argv/env/日志。没有企业SSO、Cookie身份、招乎/IM、Runtime、模型/仓库调用、身份管理新API或outbox发送器，不开放公网，不把现存limited/unmigrated dev库拿来serve。

Node22在根目录顺序运行，任一失败先保存证据，不并行数据库或构建：

```sh
node --test tests/bot/service/*.spec.mjs
node tests/bot/check-contracts.mjs
node deploy/dev/service/build.mjs
node deploy/dev/service/http-check.mjs
node deploy/dev/service/http-lifecycle.mjs
node deploy/dev/service/application-check.mjs
node deploy/dev/service/database-check.mjs
node deploy/dev/service/database-lifecycle.mjs
```

HTTP检查仅两个顺序新登记隔离MySQL5.7空库：先迁移，root-free应用凭据stdin，再实际TCP六操作、原Ajv/九表完整facts、双独立JVM握手竞争、rollback及commit后丢响应原ID对账。HTTP生命周期另外实测故障/OS SIGTERM/秘密检查取消；先实际own JVM与listener退出再精确回收自己的容器/网络/卷/私有目录，保留原dev与缓存。SIGKILL/断电不能保证finally，未知资源不自动收养或重放。

普通API成功/错误必须非空原Schema JSON；固定Tomcat9.0.83的三个有证据transport类别单独报告，绝不冒充Ajv通过：被拒HEAD仅400/close/零wire实体；前置URI解析错误只允许严格唯一400/close/noCL/TEchunked/恰5字节零chunk；唯一incomplete-body-idle/createBot固定案例只允许一帧400/CL字面0/完全无TE/close/空实体/1200–4500ms且九表不变、同server正常404恢复。慢滴body绝对截止仍要求非空400原Ajv与恢复，不泛化空响应豁免、不重置容器错误状态。头视图只读当前有界窗口且不是原wire副本，不声称恢复所有被覆盖的折叠头；header 2s是idle而非持续滴头的absolute截止，连接/worker/queue仍有限。

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

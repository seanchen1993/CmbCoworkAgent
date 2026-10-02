# F05 主代理审查与复验

2026-10-02～03 · 历史审查与检查点记录；最终已验收集成，见 `F05-acceptance.md`

## 基线与分工

- 已验收 F02/F03 代码保持不变；F05 基线 `92bf93f111045fd3550a5e0e433c5d2555d592c6`。
- 实施者 `/root/f05_dev_environment`，gpt-6.1-sol / xhigh，唯一写者，独立树 `/Users/heyirui/.codex/worktrees/devclaw-bot-f05/cmbCowork`。
- 主代理只读代码、独立测试、写任务/协调/审查记录，不写实现。实施者不得自行 accepted。
- F05 初始 attempt 报告已在真实树中核对存在；没有根据基线中的 ready 状态重复派发。

## 已执行的主代理基线检查

- 集成树 HEAD `a0efb2b2`：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node tests/bot/check-contracts.mjs`，句柄 `79112` 最终 exit 0；24/24、生成器 --check、正负类型消费均通过。尚不能证明未来 F05 候选通过。
- 真实 `java -version` 和 `javac -version` 均为 1.8.0_482；Maven 3.9.6 在该 Java 8 下 `-v` 成功；MySQL 客户端与 mysqld 版本均 5.7.24。
- JDBC 8.0.33 jar 可以由 JDK8 jar 工具读取；尚不是 JDBC 连通验收。
- 新建工作树 clean、旧实施代理 completed，精确目录进程核对无旧写者；依赖克隆句柄 32427 已 exit 0。

## 冻结候选后必检

| 边界 | 独立复验重点 |
| --- | --- |
| 配置 | dev 显式开启；prod/未知 profile、远程地址、未知字段或缺少工具拒绝，不能静默换技术栈 |
| 身份 | 401/403 真正拒绝；body/query/header 的 actor/space 注入不能获取权限；每次实例新凭据，凭据不输出普通日志 |
| 同实例隔离 | 两用户私有空间拒绝交叉读写；显式共同任务双方可见；列表、回执与附件元信息也检查权限 |
| 招乎路由 | 两个任务存在时无编号需选择；明确编号只写指定任务；非成员或跨空间任务号不能侧漏 |
| 假模型 | 确定性、mock 标记、有限输入、超时/错误注入，不发生联网/工具调用 |
| 本地 HTTP | literal 127.0.0.1、随机端口、Host/Origin 拒绝路径、大小/数量/时间上限、异常后能关闭 |
| 原有契约 | 不改 F03/IM V1 和 src；F03 入口/node/web tsc 复跑；package 原 scripts 不变 |
| 真实基础设施 | 真 Java8/class52/MySQL5.7/JDBC；UTC、utf8mb4、DATETIME(3)、READ_COMMITTED、commit/rollback/唯一键/CAS 实际断言 |
| 进程与文件 | 独占新建私有目录、无默认库、无旧凭据、无默认3306、无公网；启动失败/中断/正常退出只回收本次子进程；从空环境二次运行 |
| 宣称边界 | mock、真实兼容探针、disabled 资源分开；不声称生产身份/API/事务系统/Runtime/S3/ES 已交付 |

## 已提示的兼容陷阱

MySQL 5.7 客户端即使 `--no-defaults` 仍可能读取登录路径；`--no-login-paths` 是 8.2 新增。应在子进程的精简环境中以 `MYSQL_TEST_LOGIN_FILE` 指向本次私有临时目录的不存在路径，不修改 HOME 或用户登录文件。已发给实施者，待检查真实实现与负向测试。[5.7 环境变量](https://dev.mysql.com/doc/mysql-installation-excerpt/5.7/en/environment-variables.html)，[选项版本说明](https://dev.mysql.com/blog-archive/new-client-option-no-login-paths-turn-off-login-path-file-processing/)。

本文件当前仅记录基线和审查计划，没有 F05 候选提交或通过结论。后续记录必须绑定实际代码 SHA/dirty 状态和命令退出码。

## A 阶段独立检查（15:42 UTC）

实际提交 `8d08dca4cf1024bb166a783198ffb41d3cf60ddf`，测试前后 clean。主代理阅读 config/process/doctor 与 config.spec，使用 Node22 执行 `--test tests/bot/dev/config.spec.mjs`，3/3、skip 0、exit 0，无运行句柄。仅配置测试通过，不是 F05 最终验收。

已向实施者提出 R1：`removePrivateTemp` 只靠路径前缀正则不能证明本次创建归属；需登记持有目录并拒绝外来同前缀目录，加入执行型负向测试。另提醒 macOS `/private/tmp` 的可移植性和 MySQL Unix socket 长度限制，以及异常/中断时先停自己子进程再清理。R1 待实现与主代理复验。

## B 阶段独立检查（15:47 UTC）

实际提交 `4ec5f78ffd3ff5800306bb4105c68f47c20ee5a7`，检查时 clean。主代理阅读 mock-server/process/mock.spec，Node22 执行 `--test tests/bot/dev/config.spec.mjs tests/bot/dev/mock.spec.mjs`，8/8、skip 0、exit 0；仅 loopback 随机端口，全部关闭。

R1 实现已改为登记路径/inode/dev 并校验目录类型，临时根目录为 realpath(/tmp)。主代理独立新建一个非 helper 持有但同前缀的空临时目录，确认 helper 拒删且目录仍存在；helper 自建目录可以正常删除，exit 0。测试仅清理这两个合成空目录。仍待最终持久回归覆盖。

**R2 尚未关闭：原始 HTTP 头部过量导致安全字段被截断。** 独立 raw TCP 发送合法 `GET /dev/v1/session`、Host 与本实例合成 Bearer，随后 35 个 `X-Pad-N: a`，最后放 `Origin: https://evil.invalid`。当前 `maxHeadersCount=32` 使解析后的 `req.headers.origin` 消失，实际返回 **200**，预期拒绝，断言 exit 1。不是外部联网；URL 只作头部值，测试 server 在 finally 关闭。

已发实施者：路由前拒绝超量/截断头部并为 Origin、身份头位于截断边界之后加入 raw TCP 回归。建议独立明确 431/400/403 拒绝均可，不能将 200 视为正确。不要仅增加计数上限而保留可绕过点。另建议显式 `MAVEN_SKIP_RC` 防止可选 Maven 版本检查读取全局 rc。该阶段还没有真实 MySQL/JDBC 结果。

## C 中途独立复验（15:53～15:59 UTC，未冻结）

本节原写入因自动审批工具额度失败而未执行；2026-10-02 23:28 UTC 恢复后依据本会话实际工具结果补录，不能混同为新的当前候选结果。

- R2 首次修正仅检查 rawHeaders 数量，主代理 15:53 再测返回200、exit1，mock-server blob `87b94be369836779f81ab5f16629d9bcda0e93c0`。此前推断 rawHeaders 完整不成立，Node22 实际同时截断；已纠正并要求取消解析器 count 截断后自行限数量。
- 随后修正保留 maxHeaderSize 字节上限，maxHeadersCount=0，完整 rawHeaders 在路由前超过32条即431；另显式50ms检查周期，使不完整headers约1秒退出。
- 主代理 Node22 `deploy/dev/cli.mjs mock --profile dev`，3298 exit0，14/14、skip0，含R1持久负向用例、R2后置Origin/身份头、不完整headers期限、独立进程有限生命周期/SIGTERM和凭据轮换。执行时 mock-server blob `6fb41fdd5c7693f17a5b1bfd657d82b4a4fd9720`，process `992e009204319ef8aaab8e3b850605b8b73a1e35`，cli `aa5a00879eb3010694ff02dfe4f78560ad7c0344`，HEAD仍B提交且C dirty。R1/R2在该快照已复验，最终冻结后仍须重跑。
- 主代理 `deploy/dev/cli.mjs doctor --profile dev` 加显式工具路径，10652 exit0，实际 Java/Javac1.8.0_482、Node22.22.2、MySQL5.7.24、Maven3.9.6、Connector/J8.0.33，class52真实编译运行。S3/ES disabled，身份/招乎/模型 mock 分类明确。
- 实施者真实数据库探针尚在排障，不据doctor版本检查标为连接/事务验收。已允许显式 --mysql-messages，要求本人PID/socket/真实SQL就绪。新 process.mjs 已开始拆分stdout/stderr，但未完成最终验证。

## 额度中断后核对（23:28 UTC）

集成树 `ab9927d4` clean，证实前次受阻的记录写入/提交没有发生。F05仍为 `4ec5f78f`，7个已跟踪文件修改及6个未跟踪文件全部保留；原代理明确errored额度状态，相关ps只命中检查自身，精确cwd lsof无存活命令。旧句柄21784、18562均 Unknown process id，结果不可补记通过；后续需复跑这些纯本地合成验证。新额度 ordinaryUsageAllowed=true，primary1%、secondary0%；不购买/重置/更换账号或模型。

### R3：故障诊断不得保留原始凭据输出（恢复后代码审查）

当前dirty的process.mjs将子进程原始输出附于error.childOutput；mysql-probe只对diagnostic脱敏，随后仍抛出带原始属性的同一Error。直接调用/测试框架打印错误时可能绕过CLI的安全输出。另diagnostic先截断4096再替换完整秘密，若截断发生在口令中间则前缀残留。已交原实施者修正：最终抛出的对象不得含raw输出，先脱敏后截断；涉及凭据的bootstrap错误不转储部分口令/原始SQL，使用安全阶段/退出码；stdout/stderr也要分别有界，并补合成错误回归。本项尚待独立复验，不表示发生了真实凭据外泄。

### R3 中途独立复验（恢复后，仍未冻结）

主代理已阅读新的 process/mysql-probe/probe-error/Java/CLI/mock 与测试实现。`run` 不再向 Error 附加原始输出；真实探针只重建 allowlist 阶段/原因/退出码，既不引用原 Error/cause，也不转储 SQL，双路输出共享字节预算。Node22 `--test tests/bot/dev/lifecycle.spec.mjs`，句柄28787 exit0，5/5、skip0，覆盖完整/截断合成秘密在 String/inspect/JSON 中不可见、临时目录归属、输出上限、失败编译、serve TTL/SIGTERM 清理。对应 blob：process `d33a8d7bfbfee78ec3730699c4296950dd77f327`，mysql-probe `d9b22c34b6e745407b237b900cc44d67e61f00c3`，probe-error `695c81de513b0031aac4612aa8b5f9d1ab7ec2ff`，lifecycle.spec `90485cb70c5f04cf70fb0f524f7ea8d12e08e56d`。

另已通知实施者修正 CLI after-listen 注入故障仍比较旧 message，以及 compileProbe JSON 输出未使用 stdoutOnly；这些是当前在制阶段问题，最终真实入口必须独立复验。R3 中途负向测试通过不替代最终候选验收。

## C2 独立整体验证启动

实施快照 `1b2c8b45be9abb3ff24a8ce82615df7f5bb12391`，主代理已阅读新增 real-checks/real-child、Java 回环/字符集/CAS 断言及 CLI 结构化故障处理，旧 message 和 stdout 分流问题已修正。已要求实施者只补 README/报告、自测，代码变更须通知使本次结果失效。

主代理启动：Node22 `deploy/dev/cli.mjs check --profile dev`＋显式 Java8/Javac/MySQL/mysqld/messages/JDBC/Maven 路径，句柄53256；F03入口61004；node tsc32580；web tsc1889。均为本地执行，尚待收齐最终退出码，不根据部分输出判定成功。检查期间没有交付 accepted 或集成。

### C2 独立结果已收齐

- 53256 exit0：mock15/15、skip0；doctor真实版本与class52均verified；两次独立空实例真实SQL全项通过（utf8mb4中文/emoji、UTC、DATETIME(3)、双连接RC/commit/rollback/唯一键/CAS/有限账号）；不是只看日志或版本。
- 实例1本人PID32920/32924均退出，端口49856拒绝；实例2 PID32932/32945退出，端口49866拒绝，目录均ENOENT。after-initialize、after-bootstrap（32959）、after-listen（32967/32971，49874）、真实mysqld非法选项启动失败（32979）、OS SIGTERM（33002）均经真实进程与目录/端口独立断言通过。只清理本次合成临时资源。
- 61004 exit0：F03 24/24、生成器--check、正负类型消费；32580 node tsc exit0；1889 web tsc exit0。全部主代理句柄关闭。
- 仍待最终 README/报告候选确认、文件范围/脚本保留检查、写者停止和本地合入；不能以中途测试提前宣称完整产品已交付。

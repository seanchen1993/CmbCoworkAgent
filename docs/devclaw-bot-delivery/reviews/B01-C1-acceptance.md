# B01-C1 主代理独立验收

2026-10-06 · accepted_merged · 主代理独立审查、正常合入及集成真实新编/复验全部完成

## 范围与准确版本

用户已授权本地B01六接口、JDK8/MySQL5.7、无物理外键和任务库开发权限；本片仅应用/JDBC事务层，没有HTTP监听或后续产品模块。定时续跑继续PAUSED。实施是同原gpt-6.1-sol/high、B01-A02，未新增写者或派生。

- 代码：`3987a832d198b79350d69764b3d0dd57adf95526`。
- 报告-only：`4019d088a6c9bcb0f10e6baed52b1846e155df6d`；实施树`/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`。
- 已接受B1基线：`70f5aed6a5c19f4cde10e70c8db037d4e8d42a70`。恢复文档基线`49f8e0f`之后只有19允许文件（18实现/测试/README＋本人报告）；原Schema/OpenAPI/state、DTO/生成器/Boundary、B1六类及入口、V1/POM/依赖、B00/F05/src/锁文件未改。
- 主代理完整实际读取九新生产类（application270行/store190行）、unit、最终309行真实JDBC probe、三个新Node helper/spec、build单行suite追加和两个README。读取证据4025aa/c80575/276f52/d432d6/856b05；134d26最终clean/code..report非本人报告diff为空，diffcheck通过，子代理completed停写。

## 关键审查结论

可信构造器IdentityPolicy/context是身份与资格边界，原请求/响应Schema在应用入口内部执行。command scope→目标父对象→排序Bot→排序BotVersion的数据库锁顺序明确，引用空间/版本归属在同事务验证，不依赖进程mutex或物理FK；组保存固定版本，合法specialist-only及未变绑定的非Bot维护者管理员可管理。

当前资格与目标权限先于回执语义，回执先于新CAS/配置授权。四写canonical包含空间/主体/方法/路径及去commandId的规范请求；整数等值/键序归一，数组和expectedVersion参与。成功业务、不可变原响应字节、7天DB UTC回执和reference-only单条outbox同commit；未知commit保持OUTCOME_UNKNOWN409/retryable=false，复用原命令对账。腐坏持久JSON/版本指针/回执metadata及原响应fail-closed，撤权不能由历史命令恢复。

本地新空库schemaALL仅devclaw.*，无全局/其他库/GRANT OPTION/root回退。原dev账号、数据、初始化脚本和私有凭据不改；newtest root只为官方初始化生成写文件，未读取原root或用root JDBC。

## 主代理独立执行（不是子代理自测转述）

| 检查 | 实际句柄 / 最终输出 | 结果 |
| --- | --- | --- |
| `node --test tests/bot/service/*.spec.mjs` | 92056 / abcb2a | exit0，26/26，旧20保留，新6；无skip |
| `node tests/bot/check-contracts.mjs` | 48065 / 92b4f4 | exit0，原24/24＋TS漂移与生成类型消费 |
| `node deploy/dev/service/build.mjs` | 59123 / 716f46 | exit0，真实Corretto8运行，25JUnit无fail/error/skip，1107双方同536b0d8c零diff，50class52/34实际固定库、原资源与fatjar兼容probe |
| `node deploy/dev/service/application-check.mjs` | 86591 / 51396f | exit0，两个顺序真实MySQL库六操作及新增故障/真实SIGTERM全部通过 |
| `node deploy/dev/service/database-check.mjs` | 72676 / b2d615 | exit0，两个顺序真实MySQL库原B1完整回归 |
| `node deploy/dev/service/database-lifecycle.mjs` | 55442 / 0c9ba9 | exit0，三次原B1失败/真实SIGTERM及实际absence |

本次候选构建使用已编class，但JUnit/parity/打包/审计实际重新执行；不得冒充freshcompile。随后集成树已实际重新编译18main/7test并完成真实产物复验（见下节）。候选jar：`f26a8422bfd03e0445886e9fa87351660f344730e6f8b812816adf46b6cdb110`；dependency tree：`c6eeac9cad3a0209dc4ef80d5b0a1e33ca638dbe4f0e1b49f2018020a38317f6`。

实际C1两库7c83d965/c3759d03…/12732907、7e47ed53/798508af…/12732908，各376断言/52九表完整facts拒绝/21重放/7完整回滚/12腐坏receipt/6真实原Ajv响应。重开、固定v1、当前资格、最大合法Text/Unicode/NUL/孤立surrogate、上限/损坏指针、unknowncommit对账均通过。same-command JVM43308/43319及43499/43510=201/201同bodyhash；不同命令同CAS两个不同授权主体JVM43330/43341及43521/43532，双方实际scope行锁握手后释放=201/409，最终SQL版本/receipt/outbox事实正确。16应用JVM闭合，项目精确回收并实际absence。

新harness故障6b479cec/b8590528…/32909/JVM43664与真实SIGTERM cbeac9c3/a8097e90…/32910/JVM43795各child1、实际Java PID不存在、所有项目容器/网络/卷/runtime不存在，原dev完整身份/挂载/网络/端口前后相等且健康。

原B1两库8cc1f4dc/e07e2c14…/32911与461c4be8/0cabaf96…/32912：迁移1/noop0、10表零FK、原字节/UTC/ordinal/binary版本重开、每库5history真实拒绝且完整事实不变/准确单V1 tear-down、3越权拒绝、坏密码/停止与过时端口拒绝、SQLTimeoutException1019/1027ms全通过。原B1生命周期9a9aec61/af39ad7b…/portnull、923a7b45/475c4309…/portnull、6732fc34/da406588…/32913均child1、JDBC starts0、实际资源absence。完整IDs/PID/命令与结果保存state。

## 最终审计与接受边界

实际c2dc81：daemon75050694、原三完整ID/正确owner1f9a09d0健康/OOMfalse/12732893-32877-32876，仅原三个数据卷与原私有network；b0dc27 runtime仅dev、inode68511080、0700。9b61cd只读escalated pgrep exit1空，没有Java/Maven/编排命令；134d26 worker clean/原字节未改。所有主代理测试句柄确切闭合，无未知副作用。

首次62868整套失败、实际额度中断及原MySQL OOM恢复历史保留。Mount排序修正仅new-harness按唯一Destination/服务键归一，完整字段保留、变化与重复负例拒绝；不是忽略原环境变化或降低安全检查。仅回收本轮可重建测试资源，不删除原dev或用户数据。

C1已独立接受、正常merge并完成集成真实新编与全量要求复验，状态accepted_merged。没有HTTP、真实身份平台、招乎/模型/仓库调用、outbox发送器、Runtime、UI、B02/B03或生产exactly-once保证；原dev未迁移，不能称已可serve。B01总体仍未完成，后续HTTP切片仍须明确ready任务、实际核对及正式派单，不能由本验收自动启动或恢复定时。

## 集成产物独立复验（最终）

正常merge `da9293173af426d41dd6582dfddc580219e28d52`（3112c2），没有reset或冲突覆盖；0eec29与最终6d49c2均确认源码除协调文档与4019准确字节相等。主代理在集成树实际执行以下六入口，不沿用候选或子代理结果：

| 检查 | 集成实际句柄 / 最终输出 | 结果 |
| --- | --- | --- |
| 服务Node测试 | 65170 / 5dae19 | exit0，26/26，无skip |
| 原F03/check/types | 77364 / 463ecf | exit0，原24/24及漂移/类型消费 |
| Java8 build | 51537 / c6c3fe | exit0，**实际重新编译18main/7test**；25JUnit零fail/error/skip，1107同5373825e零diff，50class52/34固定库、原资源/fatjar通过 |
| 新application-check | 60137 / 307726（core396cfa） | exit0，真实两库六操作及新故障/真实SIGTERM完整通过 |
| 原database-check | 53506 / 989b28（首库1e89b2） | exit0，真实两库原B1完整回归 |
| 原database-lifecycle | 63498 / cf0853 | exit0，三次故障/真实SIGTERM、实际absence |

新jar `aeda6c5f48cb07c01de1c9456bacfb73ac990c30a7eaa731f2fe930974dc8c5b`，tree `c6eeac9cad3a0209dc4ef80d5b0a1e33ca638dbe4f0e1b49f2018020a38317f6`；最终db9bfd直接重新计算与新编产物一致。

application两库3d129433/7c10b028…/32914与f263a023/b6d08ace…/32915各376断言、52九表完整facts拒绝、21重放、7回滚、12腐坏回执、6原Ajv响应。重开、同command双JVM44873/44884及45076/45087=201/201同hash；不同主体双方scope握手CAS44901/44915及45107/45118=201/409，最终SQLfacts全通过。16应用JVM闭合。新增故障c260da45/49009fad…/32916/JVM45282与真实SIGTERM787e7453/6f30d838…/32917/JVM45383各child1，Java及精确项目资源实际不存在，原dev完整事实相等且健康。

原B1两库fdbe4d1f/950bf33f…/32918与b49524ca/41d4b475…/32919，各迁移1/noop0、10表零FK、Unicode原字节重开、5history真实拒绝且完整facts不变/准确tear-down、3越权拒绝、坏密码offline-stale及SQLTimeoutException1026/1034ms全通过，精确finally回收。原三lifecycle49e83574/b715c008…/portnull、b0722c12/5384ad79…/portnull、9975057e/df89880f…/32920均child1/JDBC starts0，父实际证明容器/卷/网络/runtime不存在。完整IDs/PID和结果在state。

最终只读05b062/ad0b45/cffe0d/a0d894/29a670/cb0ed9/7076ca确认原daemon、正确owner和三容器全身份/挂载/网络不变且healthy/OOMfalse，仅原三卷/私有网络、runtime全名devclaw-bot-dev/inode68511080/0700，三个127端口各一个原ssh57957 listener。ed45b5实际pgrep为空；1f3d6c/a566bd双树clean，4d71b2 code..report只A02，d68872冻结五source哈希全部匹配；6176ef实际自动配置PAUSED。所有main句柄闭合，childcompleted停写，没有未知副作用。只清理可重建隔离测试资源，原dev数据/有限账号/凭据/target/cache保留；没有HTTP/C2或后续路线派单。

# B01-C1 主代理独立验收

2026-10-06 · 候选已接受，正常合入与集成工作树重新编译/复验仍待完成

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

本次候选构建使用已编class，但JUnit/parity/打包/审计实际重新执行；不得冒充freshcompile。集成树合入后须实际重新编译18main/7test。候选jar：`f26a8422bfd03e0445886e9fa87351660f344730e6f8b812816adf46b6cdb110`；dependency tree：`c6eeac9cad3a0209dc4ef80d5b0a1e33ca638dbe4f0e1b49f2018020a38317f6`。

实际C1两库7c83d965/c3759d03…/12732907、7e47ed53/798508af…/12732908，各376断言/52九表完整facts拒绝/21重放/7完整回滚/12腐坏receipt/6真实原Ajv响应。重开、固定v1、当前资格、最大合法Text/Unicode/NUL/孤立surrogate、上限/损坏指针、unknowncommit对账均通过。same-command JVM43308/43319及43499/43510=201/201同bodyhash；不同命令同CAS两个不同授权主体JVM43330/43341及43521/43532，双方实际scope行锁握手后释放=201/409，最终SQL版本/receipt/outbox事实正确。16应用JVM闭合，项目精确回收并实际absence。

新harness故障6b479cec/b8590528…/32909/JVM43664与真实SIGTERM cbeac9c3/a8097e90…/32910/JVM43795各child1、实际Java PID不存在、所有项目容器/网络/卷/runtime不存在，原dev完整身份/挂载/网络/端口前后相等且健康。

原B1两库8cc1f4dc/e07e2c14…/32911与461c4be8/0cabaf96…/32912：迁移1/noop0、10表零FK、原字节/UTC/ordinal/binary版本重开、每库5history真实拒绝且完整事实不变/准确单V1 tear-down、3越权拒绝、坏密码/停止与过时端口拒绝、SQLTimeoutException1019/1027ms全通过。原B1生命周期9a9aec61/af39ad7b…/portnull、923a7b45/475c4309…/portnull、6732fc34/da406588…/32913均child1、JDBC starts0、实际资源absence。完整IDs/PID/命令与结果保存state。

## 最终审计与接受边界

实际c2dc81：daemon75050694、原三完整ID/正确owner1f9a09d0健康/OOMfalse/12732893-32877-32876，仅原三个数据卷与原私有network；b0dc27 runtime仅dev、inode68511080、0700。9b61cd只读escalated pgrep exit1空，没有Java/Maven/编排命令；134d26 worker clean/原字节未改。所有主代理测试句柄确切闭合，无未知副作用。

首次62868整套失败、实际额度中断及原MySQL OOM恢复历史保留。Mount排序修正仅new-harness按唯一Destination/服务键归一，完整字段保留、变化与重复负例拒绝；不是忽略原环境变化或降低安全检查。仅回收本轮可重建测试资源，不删除原dev或用户数据。

候选C1可接受并正常merge；集成新编/真实产物复验完成前不标accepted_merged。没有HTTP、真实身份平台、招乎/模型/仓库调用、outbox发送器、Runtime、UI、B02/B03或生产exactly-once保证；原dev未迁移，不能称已可serve。后续切片仍须ready任务和正式派单，不能由本验收自动启动。

## 集成复验检查点

正常merge `da9293173af426d41dd6582dfddc580219e28d52`（3112c2）；0eec29除协调文档源码与4019准确相等、clean。集成Node65170/5dae19共26与F0377364/463ecf原24/check/types均exit0；新build51537/c6c3fe实际重新Java8编译18main/7test，25JUnit无fail/error/skip，1107同5373825e零diff、50class52/34库/原资源/fatjar通过。新jar `aeda6c5f48cb07c01de1c9456bacfb73ac990c30a7eaa731f2fe930974dc8c5b`，tree同上。唯一集成application60137运行未知，真两库/新生命周期及原B1集成回归/最终审计仍待，不先标完整集成接受。

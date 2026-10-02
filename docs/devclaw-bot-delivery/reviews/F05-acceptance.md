# F05 独立验收

2026-10-03（Asia/Shanghai）· 已独立验收并本地集成

## 结论与范围

F05 本地开发环境、测试身份/假招乎/假模型、真实 JDK8/MySQL5.7 兼容探针达到本轮验收门槛。F04 只确认本地技术基线，内部 BOM、真实平台版本/能力及责任人仍待确认，不能宣称 F04 全部平台确认完成。

实施由唯一 `/root/f05_dev_environment`（gpt-6.1-sol / xhigh）完成；主代理只负责任务/接口、审查、独立执行测试与集成。没有进入 B01，没有推送、部署、连接内网、真实模型或用户数据库，也没有安装/下载依赖、购买或重置额度。

## 精确代码与文件范围

- F05 工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-f05/cmbCowork`，分支 `codex/devclaw-bot-f05`。
- 基线：`92bf93f111045fd3550a5e0e433c5d2555d592c6`。
- 实施代码：`1b2c8b45be9abb3ff24a8ce82615df7f5bb12391`。
- 最终候选（仅增加 README）：`bb9e9441b6b26eb70533cb178ad51f646fe972d2`。
- 最终 HEAD（仅 attempt 报告）：`56c93c71eca11b22d024e3d318b2beaf35640109`。
- 主代理 `git diff --exit-code` 证实代码提交到最终 HEAD 只有 README/attempt 报告差异。最终工作树 clean，实施者明确停止写入；精确工作树 lsof 无存活命令，进程检查仅匹配检查自身，没有 F05 数据库、Java、HTTP 或 real-child 遗留进程。
- 从基线检查全部差异，仅 `deploy/dev/**`、`tests/bot/dev/**`、`package.json` 的五个新增脚本及 F05-A01。原脚本逐项相等，除 scripts 增项外完整 package 对象 deepEqual；src、contracts、原测试、锁文件和依赖无变化。`git diff --check` 通过。

## 主代理审查

已阅读全部新实现、SQL、测试、README 和实际 diff：dev 显式配置/loopback 限制、合成凭据与同实例空间/共享任务授权、禁止隐式最后任务路由、请求大小/数量/期限、无网络/工具能力的模型替身、真实工具链/Java class52、独占 MySQL 生命周期与只清理本人资源。

R1～R3 经实施者返工与主代理独立复验关闭：

1. 临时目录不能仅凭名字前缀认领，实际登记路径/inode/dev、拒绝非本人创建目录。
2. 禁止 Node 头部数量截断隐藏后置 Origin/身份字段；完整 rawHeaders 限制及真实头部超时均有 TCP 测试。
3. 故障 Error 不保留 raw 子输出/cause/SQL，使用 allowlist 诊断；完整/截断合成秘密均不出现在错误对象或日志格式中，stdout/stderr 有界并正确分流。

另修复在制阶段 CLI 旧错误字符串比较、JSON stdout 分流；最终入口已覆盖，未遗留开放审查项。故障诊断收紧是预防性修复，不表示发生真实凭据泄露。

## 主代理独立复验

全部在 F05 实施代码 `1b2c8b45` 上执行；最终候选代码字节完全一致。

| 验证 | 句柄 | 结果 |
| --- | --- | --- |
| 统一 dev check | 53256 | exit0；mock15/15、skip0；doctor、真实 SQL 与完整失败/中断矩阵通过 |
| F03 契约统一入口 | 61004 | exit0；24/24、生成器--check、正负类型消费通过 |
| node tsc | 32580 | exit0 |
| web tsc | 1889 | exit0 |
| R3/R1/lifecycle 中途独立验证 | 28787 | exit0；5/5，最终 check 再覆盖 |

实际工具：Node22.22.2，Corretto Java/Javac1.8.0_482，MySQL 客户端/服务端5.7.24，Connector/J8.0.33，Maven3.9.6；Java 编译后 class major52，确实在 Java8 下加载驱动、执行 SQL。

两次独立新实例实际断言 utf8mb4中文/emoji、UTC、DATETIME(3)、双连接 READ_COMMITTED、commit/rollback、唯一索引、expectedVersion 胜者/stale CAS及只增加一次、有限账号不能读取 mysql.user；同时验证实例的回环地址/端口/字符集。不是以日志或二进制版本检查代替连接和事务测试。

资源收尾证据：实例1 PID32920/32924退出、端口49856拒绝；实例2 PID32932/32945退出、端口49866拒绝。after-initialize、after-bootstrap（32959）、after-listen（32967/32971，49874）、实际启动失败（32979）、OS SIGTERM（33002）均通过。每次目录ENOENT、本人PID signal0=ESRCH、监听过的端口ECONNREFUSED。只删除本次生成的合成临时资源，未移除用户文件或工作树。所有主代理句柄已关闭。

## 精确复跑命令

在候选或集成仓库根目录执行，工具路径必须为本机已有缓存；不隐式下载。

```sh
F05_NODE=/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node
F05_JDK8=/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home
F05_JDBC=/Users/heyirui/.m2/repository/com/mysql/mysql-connector-j/8.0.33/mysql-connector-j-8.0.33.jar
F05_MAVEN=/Users/heyirui/.m2/wrapper/dists/apache-maven-3.9.6-bin/439sdfsg2nbdob9ciift5h5nse/apache-maven-3.9.6/bin/mvn
"$F05_NODE" deploy/dev/cli.mjs check --profile dev \
  --java "$F05_JDK8/bin/java" --javac "$F05_JDK8/bin/javac" \
  --mysql /opt/anaconda3/bin/mysql --mysqld /opt/anaconda3/bin/mysqld \
  --mysql-messages /opt/anaconda3/share/mysql --jdbc "$F05_JDBC" --maven "$F05_MAVEN"
"$F05_NODE" tests/bot/check-contracts.mjs
"$F05_NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
"$F05_NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
```

## 仍然不代表什么

- 测试身份、招乎、模型是 mock；S3/ES disabled。没有生产身份、Bot CRUD、正式群协议、持久任务/Outbox、Runtime、发布、S3/ES 联调。
- Node22 仅开发编排，未改变 Java 模块化单体/JDK8/MySQL5.7 的服务端方向。没有引入未经确认的公开 Spring Boot 替代内部 BOM。
- 只实测当前 macOS/POSIX 工具组合；不宣称 Windows、内网真实版本/安全补丁或生产高可用通过。SIGKILL/断电不保证 finally 或自动恢复。
- 内部平台待确认项见 `../tasks/F04.md`；下一阶段需用户确认，不自动执行 B01。

## 集成与续跑

本地合入为 `54a58f856286e90e554d72f1ccdb9dc5fe1166eb`，无冲突。`git diff --exit-code 56c93c71 HEAD -- . ':(exclude)docs/**'` exit0，全部实现/测试/配置/package/deploy README 字节与验收候选相同。最初仅排除 delivery 文档的比较exit1，原因是集成树已有主代理 F04 技术栈确认文档 `docs/devclaw-bot-implementation-plan.md`；已实际检查该差异，并证实它相对合入前d39d8eb8没有变化，非实现冲突或代码遗漏。

集成树再次执行 mock统一入口，71066 exit0（15/15、skip0）；F03入口直接结束exit0（24/24、生成器--check、正负类型消费）。真实数据库与node/web使用上方候选独立结果，因集成字节相同未重复整套运行；不宣称额外未执行的测试。所有句柄关闭。

2026-10-02 23:54:03 UTC，原 `devclaw-bot` heartbeat 经 App 工具原位更新为PAUSED，工具回执及实际配置均确认；保留原名称、prompt、会话与每4小时频率，无重复任务。因本轮本地里程碑完成按既有约定暂停，不是用户撤销项目授权。管理方式经[官方定时任务说明](https://learn.chatgpt.com/docs/automations)核对；暂停事实以本次工具回执为证。不自动进入B01，等待用户决定下一阶段。

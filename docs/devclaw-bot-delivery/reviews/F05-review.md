# F05 主代理审查与复验

2026-10-02 · 初始检查点，尚未验收

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

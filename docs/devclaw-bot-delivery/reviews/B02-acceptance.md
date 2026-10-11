# B02 最小任务协作切片验收

2026-10-11 · accepted_merged · 主代理串行实施、审查与复验

## 交付范围

本轮完成四个真实 HTTP 接口：createTask、getTask、createTaskMessage、getEvents。任务归属 AI 团队 Group，成员可创建任务、追加文本澄清并读取任务快照和增量活动；身份取可信本地上下文，权限按当前团队成员关系检查。

复用 Java 8 单体、MySQL 5.7、命令回执和事务 Outbox。五个初始阶段仅作为任务数据，不引入工作流引擎。V2 迁移增加四张任务相关表及原 Outbox 活动列，没有物理外键；V1、冻结接口 JSON、POM/锁文件、原 IM/F05/B00 均保持不变。

不包含 Run/Runtime、模型调用、阶段切换、UI、招乎接入、附件上传或搜索。非空成果引用明确拒绝，targetBotId 仅验证并保存，不触发执行。getTask 返回任务与游标，不宣称已提供消息历史列表或完整协作界面。

## 代码与产物

- 实施候选：`e54d3fb0e9d3d9d1f7504d7f8ae39e79946542de`，原工作树保留且干净。
- 正常集成：`f65446633517c1ccafe2f4de9a314976df069158`，产品代码与候选字节一致。
- 集成后 `ad9ded7a138f0c2874034506d7705f10592605b4` 只纠正测试摘要的旧 history 行数：使用已经断言为两行的实际 fixture 字段。没有更改断言、Java 源码或运行语义。
- 真正 JDK 8 新编 34 个 main / 14 个 test 源文件，37 JUnit、class major 52、原 34 个运行依赖。
- Jar SHA-256：`81922056e5a04e1ded00eac335e9c3dabc19c69eb74763081c0703f4769f2c76`。
- V1 SHA-256：`6c9a109af0b0ef4d6c5b260672379190beb00bcc6c9137a8377bbecb363f276f`。
- V2 SHA-256：`db5822c729f342ca4d78b407d5ba81563ea138340019924ed0d18263679b56b2`。

## 独立检查与集成复验

| 命令 | 集成结果 |
| --- | --- |
| `node deploy/dev/service/build.mjs` | 29030/512ba3 exit 0；37 JUnit 零失败；1884 个 Java/Ajv 同组结论零差异，533 正例/1351 反例；原资源与依赖审计通过 |
| `node --test tests/bot/service/*.spec.mjs` | 18161/348ace exit 0；诊断字段修正后 40/40 通过 |
| `node tests/bot/check-contracts.mjs` | 75695/343e0e exit 0；24/24、生成漂移检查及类型消费通过 |
| `node deploy/dev/service/task-check.mjs` | 52935/1a5e95 exit 0；两个顺序隔离数据库、真实四接口及原六接口烟测通过 |
| `node deploy/dev/service/database-check.mjs` | 81545/ec692a exit 0；两个隔离库迁移、14 表零外键、字节重开、历史校验和权限/超时/离线拒绝通过 |
| `node deploy/dev/service/http-lifecycle.mjs` | 46932/1ddb68 exit 0；注入异常、HTTP 启动后 SIGTERM、发送秘密前 SIGTERM 三种清理通过 |

集成 Task 验证首库从空库显式迁移 V1+V2（2，重复为 0）；次库真实建立 V1 伙伴、团队及绑定后升级 V2（1，重复为 0），旧九表 facts 和 Group pin 保留。每库均通过 30 个拒绝场景、4 次原字节重放、最大 Unicode 文本、当前授权/撤权、快照和持久游标分页。

每库使用独立 JVM 验证两主体 Task CAS 只有一次提交、同 commandId 只有一组 Task/Receipt/Outbox；四个注入点完整回滚。提交后响应尚未发送（wire bytes=0）即断开，重开进程返回已提交的原字节与 ID，不产生重复副作用。首库复用原 13 个启动负例，所有拒绝均无 HTTP listener；两行迁移历史 checksum 异常被拒绝，运行时不修复，测试显式恢复全部原 facts。

主代理已实际阅读 Task 应用、SQL、共享回执授权、增量迁移、路由与边界消费及测试 diff。修复 nullable cursor 的三元表达式拆箱导致错误 503，加入事务路径 410/rollback/no-commit 回归；保留三个 JUL 父 logger 的强引用，消除闭合 launcher 输出中的 Tomcat 非 JSON 日志。临时启动诊断已撤回。

## 收尾与限制

52935 共 24 次 HTTP 启动/24 次受控凭据发送，active=0。全部测试项目的容器、卷、网络及私有 fixture 精确回收；生命周期验证也确认 PID/端口/文件实际消失。640c55 最终审计仅原 MySQL/ES/S3 三容器与三数据卷，ID、镜像、owner、mounts 保留，均 healthy/OOM=false，发布端口仅回环；无相关测试进程。2b83db/1e9c19 源码与产物核对通过。原开发库没有偷偷迁移或修改账号/凭据。

本轮旧回归 71051 的最终输出在上下文边界丢失，不能算通过；确认进程及资源闭合后，以新集成产物完整重新验证的 81545 作为验收证据。状态文件中误落在 B00 的本轮检查点字段已归位到 B02；544fd5 实际比较原 F01～B01 验收记录与 92edbf00 完全一致，所有 live_commands 为空。

原 MySQL 曾 OOM 退出，已启动同一容器且当前健康；没有擅自修改 VM/内存/宿主设置，环境容量风险保留。未推送、部署、连接真实内网或执行付费操作。定时续跑实际保持 PAUSED；本轮仅 B02 最小切片完成，下一范围待用户明确，不自动进入后续路线。

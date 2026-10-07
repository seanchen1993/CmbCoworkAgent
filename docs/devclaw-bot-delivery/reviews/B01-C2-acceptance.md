# B01-C2 验收记录

2026-10-07 · 候选已独立验收并正常合入，集成产物复验中 · 未部署

## 范围

仅六个伙伴/团队 HTTP 操作：createBot、getBot、createBotVersion、createGroup、getGroup、updateGroupMembers。JDK 8 / MySQL 5.7、无物理外键；Group 独立于招乎群和 Thread，Bot 是版本化领域上下文，不执行任务。沿用 C1/B1、冻结契约与固定 34 个运行依赖，新增本机可信身份适配与封闭 HTTP 入口。

唯一实施者为原 `/root/b01_contracts_high`、gpt-6.1-sol/high、B01-A02。主代理负责实际 diff、独立检查、集成和验收。定时自动续跑保持 PAUSED；本记录不授权下一阶段、推送、部署、真实内网或付费操作。

## 当前确证与缺口

- 正常 no-ff merge `107e35481053e0a49528feff54b2581ec798dc0e`（`a4b35f` ort 成功，无冲突/reset），`7e9632` 确认除协调记录外与 worker8d 全部字节相等，`7b314f` clean。唯一集成 build `5344/78d627` 已启动，后续真正重新编译/产物逐项比较和八入口集成复验尚待；不因合入成功提前最终接受。

- **11:31:36 UTC 最新出口优先于下方历史：主代理八个独立入口全部实际 exit0/closed，候选 `8d743627` 独立接受。** 最后数据库生命周期 `61509/e3923b` 三模式：23bac/6f78fe完整ID、dfe5/7402f7完整ID均ready前port null；d0fe/acc396完整ID/32954秘密发送前真实SIGTERM，child均expected1/databaseChildStarts0，精确资源实际absence。完整真实结果见矩阵和state，不由worker结论代替。
- 中断的 functions431 只读核对已从实际结果恢复：main/worker clean，worker exact8d/stopped；当前 `4a1e71` pgrep exit1/空，daemon75050694，`baeac6/12a02e` 原三个完整ID/owner/digest/mount/12732893-32877-32876健康且OOMfalse，`03965f/529f0e/37ee50` 只原网络/三卷/runtime仅dev/inode68511080/无私有fixture。第一次freeze过滤误用了两个README路径，`c87532` 实际只返回两个允许README，未伪称空；按真实 `contracts/bot/v1/README.md`、`deploy/dev/README.md` 修正后的 `e0c4be` 实际源diff空，`900897` 最终37允许文件/2013新增行，无新产品源码。无未知副作用重放。
- 现在全部main句柄闭合、唯一worker持续停写；仅候选独立接受。正常merge、集成树真实新编及全部八入口新产物复验尚待，不能称accepted_merged或生产可用。

- 11:14:46 UTC 实际核对：原 high 已 completed/stopped，最终 worker `8d743627528d65466320b9614a1e5eff53b2a7f8` clean；生产实现保持 `204303`，仅两个 README 后续追加。实际最终 diff 共 37 个允许文件，旧 C1/B1/POM/契约/资源无变化。剩余三 worker 报告已完整实读：application `33636/4d67bf`、database `22712/8087a9`、database-lifecycle `12726/35544b` 均 exit0/closed，八个自测入口齐备；不等于主代理验收。
- 主代理独立 Node `3375bd` 35/35、F03 `13d161` 24/24、build `39591/995169` 32JUnit 零 fail/error/skip、1107 parity 同轮 `dbce15bb-18cf-4b54-9246-49c4af187511` 零差异、69 自有 class major52 / 34 固定依赖均 exit0。Maven 本轮 up-to-date，不冒充新编；jar `9c20661eb6c63200dbe9fd2b5dfa200f0a777e0ad53bc05515b522032192f4fb`。`eabc3e` 已捕获全部 182 非目录 entry 内容哈希，aggregate `2c5fee0a0ed546b101b91e0eb1670d93cda457a6b4f730e369a88ac0591a440b`，供正常合入后的实际重新编译逐项比较。
- 当前唯一主代理 HTTP `12957 / 0f32e8`，1800s 上限，完整输出未截断。`6e29aa/2d7389` 第一库 `48f3ebbf8aa58e2d` 全套真实 HTTP 证明及精确清理已通过；第二库 `2f149044677abd93` 已 ready、startup13 通过并继续业务断言。全句柄结果未知，不能称两库完整验收；准确 container/PID/port 在 state。其后四入口与集成复验仍待。

- 产品代码检查点 `204303d673ed9c5225b614fbae47371e227f3824`：此前所有新增 Java/Node 文件和增量已实际读取；普通六操作错误仍须非空原 Schema/Ajv，生产 C1/B1/依赖/冻结资源未改变。
- 主代理 `cc0ea6` 独立执行两个新增 framing/body-idle spec，5 tests / 5 pass / 0 fail / 0 skip；这不是完整八入口验收。
- 原子代理自己的 `19326 / a1649e` 确切 exit 0 / closed / verified，顺序两个隔离数据库、30 starts / 30 secret sends / 0 active。其 `51ac9abd` 报告已主代理 `dc7c41` 完整实际读取。每库权限、原字节重放、严格两帧 pipeline、49 transport、两独立 JVM 明确握手的命令/CAS 竞争、六组 rollback、提交后真实 TCP 丢响应与原 command 重启恢复、完整九表事实及精确 finally 通过，仍属于 worker 证据。
- 旧工具结果中段被输出上限截断，第二库 container 全 ID / DB port / 首生产 PID 等元数据未恢复；结束时刻未知。不得猜测或为补旧日志盲重放。主代理最终独立全验必须完整保存新的两库归属与完成结果。
- 两 README 的追加 code `6480495ba45283218a2c6a306c21fc355fea8eef`（31 行）已由主代理 `fbb0a2` 全 diff 实读，保留旧段落并明确最新本机能力/限制/八入口，生产实现仍 `204303`。`5f88d206 / 272ea5` 实读第 1 入口 `c5ca19` worker 35 tests / 35 pass / 0 fail / 0 skip / 0 cancel，原26 + HTTP9。其余六入口及最终 clean/停写待，完整独立全验、正常 merge、集成 fresh compile/产物复验均待；不把协调文档提交当生产源码变化。

## 最终验证矩阵（待填真实结果）

| 固定入口 | Worker | 主代理独立 | 集成复验 |
| --- | --- | --- | --- |
| `node --test tests/bot/service/*.spec.mjs` | c5ca19 / exit0，35/35 | 3375bd / exit0，35/35 | a9045d / exit0，35/35 |
| `node tests/bot/check-contracts.mjs` | 62353/be43a0 exit0，24/24；be666b实读报告 | 13d161 / exit0，24/24 | 59056/a868cc exit0，24/24/type-drift |
| `node deploy/dev/service/build.mjs` | 78758/337baa exit0，32JUnit/1107零差异/69class52/34库；up-to-date非fresh | 39591/995169 exit0，32/1107/69/34；up-to-date非fresh | 5344/4820c3 exit0，真实31main/11test新编，32/1107零差异/69class52/34库；fa546f182内容逐项相同 |
| `node deploy/dev/service/http-check.mjs` | 19326 / exit0，两库；旧元数据缺口见上 | 12957/49011b exit0，两库完整证明/资源精确清理/原dev健康；304 safe facts 未截断 | 74345/eeb77f exit0，新jar7c两库全套/30starts30secret0active/精确清理及原dev健康，完整安全输出 |
| `node deploy/dev/service/http-lifecycle.mjs` | 28401/c32e5a exit0，三新模式/真实absence；968d12实读报告 | 70240/5de693 exit0，3case/实际PID-listener-project-privatefiles absence，原dev健康 | 52076/d8f8ea exit0，3case/实际PID-listener-project-privatefiles absence/原dev健康 |
| `node deploy/dev/service/application-check.mjs` | 33636/4d67bf exit0，两库＋注入/SIGTERM；e5f5db实读报告 | 80206/061ae1 exit0，两库各376/52/21/7/12/6及双JVM竞争，注入/SIGTERM实际清理 | 22875/9ddbb4 exit0，两库各376/52/21/7/12/6＋双JVM竞争，注入/SIGTERM实际清理 |
| `node deploy/dev/service/database-check.mjs` | 22712/8087a9 exit0，两库/10表/0FK；d8347d实读报告 | 23594/d62c8f exit0，两库完整证明/0FK/迁移与历史拒绝/实际SQLTimeout/精确清理 | 唯一78601/741976运行，结果未知 |
| `node deploy/dev/service/database-lifecycle.mjs` | 12726/35544b exit0，3case/实际cleanup；235ef5实读报告 | 61509/e3923b exit0，注入与两个SIGTERM/实际absence，JDBC starts0 | 待 |

每项必须有实际代码 SHA、命令、句柄、exit、计数和清理证据；不能由旧结果/参考模型代替。原 Node26 / JUnit25 / F03 24 / 同轮 1107 parity / class major52 / 34 固定库与冻结原字节均需保留回归。记录 actual totals，不推测新总数。

## 传输类别与产品边界

HEAD 安全拒绝的无实体、Coyote 前置 URI closing 400 的精确五字节零 chunk、固定 incomplete-body-idle 的 closing 400 / CL 字面 0 / 无 TE / 空实体必须分别报告，不伪称 wire JSON/Ajv 通过。所有正常业务成功和普通错误仍实际原 Schema/Ajv；slow-drip body 仍须有界非空 400 和请求恢复。只读当前 Tomcat header 窗口不是原始 wire copy，不能夸称已恢复被容器覆盖的 folded bytes 或逐一观测内部 queue 槽。

身份仅固定本地开发快照，不是企业 SSO、招乎成员同步或生产授权。仅字面 127.0.0.1 / 随机端口 / 私有 stdin；旧 dev 账号、容器、三卷、网络和凭据不读不改，本轮仅新认领可回收库。没有 UI、Runtime、模型执行、搜索/上传 API、IM/Thread 绑定、新公共接口或 outbox 投递器。

## 最终结论

候选 `8d743627528d65466320b9614a1e5eff53b2a7f8` 已完成实际源码全审、主代理八入口独立全验与终末资源审计，clean/所有句柄闭合/唯一写者停止。下一只正常合入和集成真实新编/全部八入口产物复验，通过后才填写最终 accepted_merged；不自动进入后续产品路线。

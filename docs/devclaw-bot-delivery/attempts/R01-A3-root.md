# R01-A3 / root 串行报告

2026-10-11，bce5de48 clean接续。实际仅root，无Java/Maven/tsx测试进程，自动实际PAUSED。最新用户“继续实现”授权本地下一切片；先实现节点/负责人授权与需求可派发判定，不开放模型/群执行。

方案：复用Java单体/JDBC事务和Group/Task/专家固定版本；V3增两表，节点owner来自可信独立凭据上下文、Group显式grant与CAS/撤销；工作区只存引用，无宿主路径/凭据。需求模式只读、缺权限拒绝、指定节点无新鲜心跳等待。内部READINESS不是Run/lease/已执行，后续队列/执行器要再验证。旧生成契约不变。

已实现V3/两可信端口/JDBC存储/内部应用四方法、6个JUnit与固定真库probe。旧目录/history/Task验收只追加V3与新两表，原V1/V2不改。当前尚未验收，不是实际Run/群执行。

首次build 23932/67c76a→fec563 exit1。用相同JDK8/Maven私有配置诊断24110/98207b→1d0226 exit1，实因新增test通配java.security与java.sql使Timestamp歧义；已改明确两项security import，待新编复验。不声称首次编译通过。命令均闭合、未创建DB或重启原服务。

修正后72844/a078b8→ab5ffa exit0：43JUnit/1884parity零差异、原34libs/冻结sourcehash/V1/V2同、包内V3/class52审计通过，jar80e151fc。test16真重编，main首次失败build已编、本轮显示up-to-date，不冒称本次main新编。Node b945f6 42/42通过；最后仅新runner finally全清理窄补，待最终重跑。开始唯一runtime-node-check：两个顺序新owned MySQL库（空库/真实V2数据及V1V2history哈希），两独立JVM CAS及重开，尚未知。

80335/ecf364→c91090 exit1/closed：首10a6a934/be3df02b/32989迁移后直到phase-boundary出现探针预期错误。实际JdbcTaskStore只支持初始需求状态，注入assessment应被其现有存储校验503拒绝，而非新service INPUT_CHANGED；测试修正为503并注释，无产品放宽/改旧TaskStore。该库exactremoved、原三samehealthy/秘密未读。第二库/CAS/reopen尚未到，不称通过。F03 60313/37afce全24及类型消费exit0；伙伴f6ebb7 30/30exit0。接下来新编、重跑同固定两个顺序库；没有活动旧句柄。

28104/e2110d→d58eb4 exit0：真实Java8新编38main/16test、43JUnit零失败/skip、1884零差异、V1/V2/V3打包/52major/34libs通过，jarbb872e2f。旧入口/生成Schema/DTO/TaskStore/依赖未变。开始新的唯一两个顺序库node-check，结果待；不能沿用上次未走到的case为通过。

70710/a8d33c→98c765 actualexit0：两新库f9b79cff/07750e7f/32990与9c853848/038e7cbc/32991顺序完整通过，第二是真实V2旧Bot/Group/Task十三表及V1V2历史精确SHA未变后仅增V3。每库32拒绝、两提交前回滚、afterCommit OUTCOME_UNKNOWN读回4再旧CAS拒绝、两独立JVM恰一CAS赢家后新JVM节点/授权重开；指定node61秒过期等待、other-node在线不fallback、撤权后心跳不复权通过。每库exactremoved/httpAbsent、activeNodeChildren0、原三sameID-mount-networkhealthy/credentialsReadfalse。尚待旧DB/Task受影响回归、终末审查，不提前accepted。

旧DB唯一55548/e2d2d7运行中：第一2cc0697b/061df3f2/32992已3migrate/noop0、real queryTimeout1028ms、5history拒绝/不改/完整restore，尚待最后结果/第二库。所有旧当前migration helper application/http/lifecycle也仅期望2→3；Task facts15、history3追加，未削弱原断言。下一闭合后Task-check，禁止竞争DB或重编活跃产物。8559d1已实测旧task objects exact unchanged/current唯一A3。

55548/618ee0已exit0：两库2cc0697b/061df3f2/32992、78b4abd7/08a8dc34/32993，16表无FK、3migrate/noop0、原Unicode与大字节重开、5坏history不改与完整恢复/3权限拒绝/坏密码/stale/stop全通过，queryTimeout1028/1019ms；both exactremoved。新runner和spec172e78只格式化，17f444 Node42/42 exit0且frozen/source范围diff-empty与diffcheck0。当前唯一59414/aa8edd Task旧生产HTTP/真实V1升级/事务/重开回归，待结果；未最终accepted。

root f9f28f/7f24ac已实际补读新service/store/SQL/格式化runner审查：Group→Task/Bot→grant→node锁顺序，心跳仅node；身份/当前成员管理员/双人执行和工作区ACL/固定专家cap/阶段/授权到期先于离线等待，READY非lease且禁止缓存直接执行，JSON原字节拒绝未知/重复cap、version安全整数、UTC3，错误不带SQL/cause。V3仅两表无FK/无secret，现有HTTP/TaskStore/生成契约/依赖和旧Runtime不变。6cd62a格式/syntax/diffcheck0，实际automation.toml仍PAUSED。Task第一1f2bc2bf/f74e9795/32994/46293:61297已13startup、30拒绝4重放、两独立JVM races/四rollback/commit后wire0与重开字节；d58de7首库exactremoved，第二库和最终exit仍待。不是整轮已过。

59414/ff6e14于11:49:56UTC确认actualexit0：第二ec6f6370/2c1a134d/32995/53450:61652真实V1数据→V2+V3两迁移，旧九表facts原字节相同，完整旧六与新四HTTP、每库30拒绝4重放、两独立JVM races、四rollback、真实afterCommit TCP0byte失包/新JVM恢复旧字节与cursor皆过；both exactremoved、starts24/secretSends24/active0、原三samehealthy/no credentials read。Task回归完整，不是只probe。最后唯一http-lifecycle三模式清理验证待；无新编或资源竞争、不扩大产品。

## 验收出口

2026-10-11 11:52UTC，accepted。代码de266e8333318cf09706b5f166b4aad44695472f（59ee41显式22个代码/测试文件本地提交）；未推送或部署。97978/949bf6真实exit0，injected/after-http-SIGTERM/secret-SIGTERM三case，PID/listener/project/privatefiles实际absence、secret取消0starts/sends、原三samehealthy。当前无活跃命令；bea34d相关pgrep exit1为空表示absence，不是失败测试。2f8d51/04c82d专用daemon only原三sameID healthy、原三卷/devnetwork无test资源；a7aa1c私有runtime只有dev，实际automation.toml PAUSED。原dev不读取秘密、不迁移数据或改权限。Root独立读取/复验全部，本轮无子代理；旧task对象8559d1 exact preserved。

本轮范围只含内部四方法和持久化判定，真实认证适配器/Run队列/lease/模型工具执行/专用Thread/工作区隔离/群绑定/真实招乎/App UI没有交付。配置权限不代表执行权限，提示词与READY快照不代表授权。后续须从当前代码接有限Run控制与实际启动前重验，再接原编程引擎；本轮停止，不自动扩大或恢复定时。所有历史失败如实保留，上文running/pending被此出口覆盖。

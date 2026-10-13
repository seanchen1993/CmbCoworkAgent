# R01-A8 · 团队长期记忆审查与验收

状态：accepted（2026-10-13，代码f1067cc3b56312adbf1ebe620b1daaa779b64cef）。用户明确按Astra建议实施并手动接续；正确树integration、源基线0a711b31/起点HEAD2f914995。主代理已完成实际源码审查和下列独立复验，全部测试资源闭合。无已知可复现阻断问题；历史未定位失败保留，不据后续通过伪称其原因已查明。

## 实现边界

- Group记忆权威存于Java/MySQL5.7；SQLite只保留Task Thread/attempt/回执。同Bot服务不同Group不共享可变记忆，BotVersion继续管理稳定配置。
- 只手工发布、修改、停用/重新启用。当前成员读、当前Group admin写；受限manual/Task版本/已结算结果来源，认证身份提供作者；应用层关联核对、父Group锁、CAS与持久command回执，无物理FK。
- 首次start同事务冻结实际内容、版本、来源与独立revision；相同attempt重复读取同快照。有效策略无记忆也为revision0空数组，disabled明确null。
- 在途显式记忆revision变化时renew/首次settle提交终态failed/MEMORY_CHANGED，释放容量；App经当前认证inspect+完整attempt核对后abort，不自动重跑。已成功结果当前授权下同结果重交不重算，真正租约过期仍unknown，不借记忆编辑掩盖。
- 新专家显式opt-in；旧专家发布不可变版本并由当前Group明确采用。原计划/命令/CAS加密持久，失回执重试原载荷；最新专家与绑定不同时拒绝偷偷升级。旧A7默认disabled创建指纹保持兼容。
- 小规模全有效条目固定ID顺序注入，100存储/10有效/512 UTF16/10000转义JSON预算，两端校验，不静默截断。App显示策略/来源/状态/修改人/历史使用快照；候选仅预填，必须人确认。
- 继续固定模拟模型、零工具、不借个人记忆/身份/Thread。Partner默认MySQL-only；ES/S3原可选环境与测试没有删除。无自动提炼/跨团队学习/向量搜索/到期调度/真实模型招乎/WSS/源码/云/正式审批。

## 主代理实际独立检查

| 项目 | 当前实际证据 |
| --- | --- |
| Java源码/迁移 | 已读3个新core、执行/HTTP/readiness/migration改动、V6、测试探针及所有受影响旧probe；public/POM/DTO/V1..5实际diff空75ad3b |
| JDK8新编 | 97365/1c6fbe exit0，真49main/23test新编，67JUnit/1884Java-Ajv parity零差异/Class52/34libs/六迁移与源bytes审计；jar d7c4e1ca |
| App/边界/图 | 31824/2b93ff最终93项全过，包括旧A7指纹兼容；main+受影响test16019/c8aea3零诊断、web21789/9780a4零诊断；IPC30804/e1cec6 10 |
| 服务/契约 | 683aab最终58service guards，F03dc2fc4全24/漂移/类型消费通过；安全诊断13个durable分类不泄露原日志/密钥 |
| 真实页面 | 77988/0ab302真实React/Electron Chromium，但IPC明确stub；显式策略、Task候选/确认、编辑停用、历史快照/停止重连errors0 |
| 全App构建 | 16819/e9540e最终main/preload/renderer均exit0（包含旧pending指纹窄修）；不宣称打包安装/部署 |
| 真跨层记忆旅程 | 7155/3e2b73 actualJavaHTTP+隔离MySQL5.7+AppWorker+SQLite+既有DeepAgent：fake4calls/tools0，两Task复用、revision更新、停用取消旧图/释放容量、手动新Taskempty、不自动重跑、全新SQLite保留记忆/历史；owned058813/b455/33060/Java52742:55997 exactcleanup |
| 最终产物再复验 | 1526/128ea7真23test重编，main源未变（前次97365真49新编），最终67JUnit/1884parity0/sixmigration audit，jar76e6447ea65bce27dd337f03c9002d76d47a3f0b028e40fd7b46a4484ca677a4；91341/0459d8再次实际跨层旅程fake4tools0全过，fccc823c/9384ab0c/33070/Java65274:53248 exactremoved |
| 真数据库目录/历史 | 53990/b82cf3 两新库22tables/zeroFK/6migrate-noop/5bad-history原facts保持/Unicodebytes重开/受限账号/timeouts1024/1025ms/badpassword/offline/stale；a6ac/7fa96a/33061与5cf12/32f6/33062均removed |
| 真记忆权限/迁移矩阵 | root26816/791fea exit0：真实V5upgrade42/empty41拒绝，SpaceB同ID/同Bot跨Group隔离、Source/currentTaskVersion/result、CAS/回滚/失回执、重复start、renew+settle失效容量、disabled/expiredunknown、100stored/10active/预算、Java重开/撤权全过；9664/bb5b/33065、dd79/a227/33066均removed |
| 持久launcher/旧PartnerHTTP | root2831/7e3634真Java+MySQL停重启记忆full-list/凭据/container/volume/owner一致，08d31e14removed；53288/10172f旧PartnerHTTP25/auth/4methods/poll8/Runroundtrip过，96bf/454c/33069/Java65051:53157removed；original3samehealthy |

## 失败与环境事件，不隐去

- 2026-10-13 humancontinue，旧子代理quotaerrored已确认停止且Java进程空；17464旧结果unknown。独立root39428在testCompile失败，安全诊断89516定位J2 fixture的Timestamp import歧义，仅补全java.sql.Timestamp，重编待1526。未用旧67JUnit XML冒充新结果，未创建代理/换模型/购买/reset绕限。

- 初main tsc推断policy为string已加精确联合返回类型，最终零诊断。初React13892发现首次team刷新清空刚准备的候选，窄修后72854及最终77988通过。
- 首93前92测试中1负例仅期待FORBIDDEN，fence2实际先被既有验证器拒绝PARTNER_RUN_INPUT_INVALID；保留完整attempt拒绝，精确两码都接受，最终93通过。
- Worker11086容量负例的queued包装强制200，修test后续两库通过；92097聚合阶段失败原因仍未知，后续通过不是定位证明。
- Root18056/02a178 command-cas GROUP_MEMORY_BOUNDARY，已有严格helper丢掉具体flag；只补安全布尔/退出码/行数诊断，未放宽秘密/异常/输出约束。该失败原因仍未知，测试资源已闭合。
- Root70749/23f7b3 V5历史运行返回409 OUTCOME_UNKNOWN：旧synthetic fixture在迁移/JVM准备期间超过30秒租约。仅固定隔离迁移fixture补有界存活窗口，生产30秒租约和独立expiredunknown负例不改；最终root复验待。未将它当产品成功或去掉断言。
- 原开发MySQL693a1c3在2026-10-12T14:26:44.796998112Z被OOM杀停（readonlyb6d447），persistent586132与memorya94a99因此在注册前失败。恢复预检4e3a32误猜卷名被assert拦住，未执行操作；按实际dev-data及owner/daemon精确复核，fa19a0只重启原容器。780075原3恢复健康、sameIDs/volumes/mounts/network/daemon，MySQL回环端口32969→33063。没有重建、删数据/卷、读原秘密或扩大VM。不能据OOM反推先前所有失败的原因。

## 出口条件

J2 test-only重编/source核对、真实记忆两库/持久重启/旧PartnerHTTP/最终跨层旅程及资源核对均已主代理实际通过。58源文件按path+NUL+bytes+NUL SHA256=ee5619243e45de216c01a63912a9203c0b19c529401b13d89ed569cd220ab0d5；正常本地提交f1067cc3，未绕过repo hooks。a8013c实际Java进程空，59f87a原3健康同ID/3卷/原network/runtimeonlydev、测试容器网络卷目录0、默认Partner未创建。实际scheduler2ff1e3 PAUSED；原15任务对象SHA256仍0fbb35328b09820b694e8de9032af0f7c0fffc956c13f5b8b5268b3ea96b643f。原MySQL恢复后端口33063，如实记录，不宣称从未发生环境变化。

不自动下一路线、不push/deploy/intranet/付费。当前仅本地模拟模型版，真实模型/群适配与自动提炼须另定范围；停止记忆不是历史内容彻底擦除。此片没有剩余验收工作。

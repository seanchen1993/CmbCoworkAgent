# R01-A4 / root serial

2026-10-11 · baseline ee412814 · integration / codex/devclaw-bot-integration。

当前：已读最新入口与 A3 源码、冻结 Run/状态/Runtime 约束；实际 Git clean，只有 root，无相关命令，原三服务同 ID healthy、定时配置 PAUSED。本次只做内部持久队列和单次领取，不接模型或实际执行，不创建代理。

任务单 tasks/R01-A4.md v1。下一实现 V4 与应用/存储，再 Java8 新编和实际 MySQL 升级、重验、并发与恢复测试。当前没有测试通过声明或活动句柄；保留所有历史记录、旧 local 和原开发数据库。

主体与测试已写：单队列表/同事务 A3 判定复用/入队独立命令空间、原始内部回执/当前状态另读/Group maxRuns/指定节点单次领取30秒且不续租/过期 outcome_unknown 不重发/仅 pending 可取消。旧契约 HTTP/Runtime/POM/V1～V3未动。测试使用共享有限 A3 seed，仅测试 helpers 可见性调整，无新生产 seam。迁移消费者只追加当前 V4/17表计数及严格目录/index/history校验。一次生成 patch 使用相对路径被 apply_patch 拒绝，未落到 d12a；改绝对路径后成功。

唯一 Java8 build 15986/b86e56 已启动，尚待退出；新 mjs 格式检查/写格式 a05d6f exit0。不在活跃 build 时重建。下一取回实际结果再真实数据库；无模型或工具执行。

Java8 新编15986/921574 exit0：40main/18test、49JUnit零 fail/error/skip、1884Ajv/Java零差异/class52/34原libs/V4包内字节审计；jar06b4dff390530e6e7c13de4921fa23ab2fecce114514862a90b05d2f111a8dc7。Node d3b623 44/44 exit0。下一真实队列 DB 空库与 V3数据升级、独立双JVM，不称单元测试为数据库验收。

F03 ed803b exit0 全24/漂移/消费通过。唯一94016/26c6db队列真库测试启动，结果待；不用旧生产 dev 数据和秘密，无其它活跃句柄。之后受影响旧DB/Task/A3同事务判定回归。

第一版94016/08a28d实际exit0，两真实库：f2eb2483/9e6c8a80:32999空库、5ac3dce4/d8332a5d:33000真实V3升级；全部V3数据/history字节保留、各30拒绝/2rollback/2commit-after unknown读取原记录/两个独立JVM入队及领取相同/重开/离线/过期unknown。两项目精确removed、原三same healthy、active0。

审查补充：在线入队后离线领取需QUEUED→WAITING_NODE持久状态/CAS，版本改为实际递增而非固定1/2/3（attempt仍唯一fence1）；增加late-offline/cancel CAS及双不同actor竞争Group最后一个容量的真库验证。发现旧DatabaseCommand诊断版本仍2，更新当前4；有限旧framing helper迁移计数同步4。A3判定只提取与dedent，不改条件。以上代码变化后重新build/队列真库，不沿用早前通过结果。

补充后73757/d70c3a真实fresh Java8 40main/18test、49JUnit/1884parity零/class52/112类/34libs/V4资源审计exit0；jara4785992b49bfeba8cc0e30f26208d27aea3f7b68f50c2ce71f5e5b5e91961bf。Node f096de 44/44 exit0。冻结Schema/生成契约/旧HTTP/TaskStore/Runtime/POM/V1～V3真实diff为空(9e80e2)，diffcheck0。唯一最终队列DB78062/97a6c6运行，之后旧DB/A3/Task/lifecycle，当前不接受。无新代理/定时恢复。

最终队列78062/309f29 exit0：40561c90/f70101ab:33001空库、f52b352c/300be651:33002真实V3升级，旧全部V3数据/history不变；各30拒绝、queued后offline明确waiting/CAS、初始回执不变与Task变化阻断领取、权限/撤权/能力版本/租约过期/仅pending取消、2rollback/2提交后unknown读回、双JVM相同入队与claim attempt/lease、不同actor竞争Group最后容量恰1winner、重开11队列行。所有精确removed，原三samehealthy、active0。伙伴 d71b69 30/30 exit0。下一受影响旧DB/A3/Task/lifecycle真库，未final接受。

旧DB首次5511/324ba2 exit1：V4 migrate4/noop0/17表目录、store/reload与真实timeout1023ms通过，history负例期望仍只追加V2/V3而未加V4，PROBE_ASSERTION。项目4dcaa99d/20f270b6:33003已精确回收，结果明确。修正测试expected追加原V4整行（不修改生产、不削弱坏history不变/完整恢复断言），重新编译测试后复验；旧F01～A3任务对象实际deepEqual保持(8b25e1)。

修正后58707/95d814 exit0，main无需重编，18test实际重新编译、49JUnit/1884parity零/112类class52/34libs/V4资源审计；jar760492bf79da50649d4c3c685159e886354270638cf92feecf6f4d239bf8d949。没有生产源码变化，不声称此次40main重新编译。唯一旧DB复跑23441/7cb819，结果待。

旧DB23441/a3d23c exit0：dcb6e1d6/fab39e54:33004、dbddcae7/85716086:33005，两库 migrate4/noop0、17表全部columns/indexes/零FK、Unicode与大字节重开、5坏history四条原始字节不变与显式恢复、权限三拒绝/坏密码/stale/offline/真实SQLTimeout1022/1020ms，精确removed。静态检查也在执行Task前发现其独立HttpHistoryFixture快照仍只读三行，已显式追加V4列校验/整行hash与mutation deepEqual；这是测试夹具同步，不修改生产。DB命令已closed后才下一测试重编。

最新39362/67218b main uptodate/18test真重编、49JUnit/1884parity零、V4资源/class52/34libs exit0，jarfe9adaaf190b2c22cdbbaf15fef070f16baf0acb1866dd6b06cfc250e4ee9a6d。A3实体判定去空白逐字等同基线（2bbd5b）；首次审计regex转义错误仅忽略空白失败，实际更正后通过，未改条件。A3真库82492/011749 exit0：bb394cf5/3063f8b5:33006、ef1ec6c8/b4409f72:33007，空库/实际V2升级各32拒绝/2rollback/commit后unknown读回/双JVM CAS恰1winner/重开；旧数据/history保留、两精确removed、原三samehealthy、active0。新mjs格式check通过（40d9e6同命令后rg错路径exit2，不将整体当通过）；接下来Task HTTP及生命周期。

Task94027/74e159仍唯一活跃：首c8046302/5d6e0797:33008、生产Java66107:63655；841b3b四行history整hash不变/恢复与13启动负例通过，c6692d全部30拒绝/4重放/四Task HTTP、双JVM71143/71197双方scope握手CAS恰1commit已通过。整套双库、失回包恢复与清理尚待，不提前计通过。4b155c新mjs格式单独exit0，b12c37旧任务对象完整不变/live1。

94027/6aff55首库整个HTTP/双并发/4rollback/真实commit后TCP0字节断连、原始回执/持久游标在新进程恢复与oldSix均过且精确removed。次24305d90/63429709:33009、Java73197:64073真实V1数据升级migrate3已通过（原九facts保留）；9f584b次库30拒绝/4重放/四HTTP/当前Group权限/Unicode与最大text已过，最后race/恢复/精确清理仍待。没有重编活跃测试产物，不派下一工作或自动恢复。

Task94027/abbd0b实际exit0，两库完整各30拒绝/4不可变重放/2双JVM有scope握手race/4rollback/真实提交后TCP0字节失回包+新JVM原bytes/cursor恢复、原6与新4HTTP/Unicode最大text；首13启动拒绝覆盖4行history完整恢复，次真实V1数据升级原九facts不变。两个精确removed、原三samehealthy、24starts/sends/active0。只剩受影响HTTP生命周期及终末资源/源码审计，暂不接受或派下一工作。

HTTP生命周期1042/aad82f exit0 三case：注入aa88bb22/parent80149/Java80256:64442；afterHTTP SIGTERM7182c58e/80350/80443:64447；秘密前SIGTERMa8d39123/80534，后者0starts/sends。真实PID/listener/项目/私有文件全部absent，原三samehealthy。所有句柄闭合、05edbc语法/diffcheck0、8ad4d6冻结源/旧HTTP/TaskStore/Runtime/POM/V1～V3 diff仍空；最终只读资源与Git审计后才保存accepted。

终末源码/资源审查：新application/store/SQL/runner已实际逐项阅读，Group→Run→Task/Bot→grant/node锁序；enqueue scope先锁、定位历史Group无行锁再授权/锁Run，避免回执反向锁序；状态/CAS/单attempt和unknown占位、只读引用/无秘密、不借原Thread/模型/工具保持边界。84a1c0只原MySQL693a/ES4f0e/S39332同IDhealthy/127端口、三dev卷和devnetwork；2bef96无相关进程；bffe5d runtime只dev、旧local e54d3fb0 clean，定时实际PAUSED。当前只有root，未派代理。临时测试项目均精确removed可重新生成，原dev数据/权限/凭据保留未读未改。

最终17532/7dbc41 Node44/F03全24/漂移/消费 exit0；a5753f旧F01～A3任务对象deepEqual/allLive0。代码23文件以常规本地commit保存 a3b402d65b1330cbb35546ec431e50d7ccc4d666（7571ac）。Hook inventory6cc378发现托管hook但commit已执行；随即5fc46f/3ee3d8/2ec316读完pre/post和295行helper、确认用户可执行hook不存在，托管hook仅本地 staged code snapshot/commit事件，不push/网络/部署，已有快照属于用户工具保留，不盲目删除或重放。当前仅 docs 未提交，下一保存 accepted docs 检查点。不再派下一工作或恢复自动；下一可信节点与专用Thread再接已有引擎，实际调用未交付。

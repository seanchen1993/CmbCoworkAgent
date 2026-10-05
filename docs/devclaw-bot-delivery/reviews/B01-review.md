# B01 主代理检查记录

## A1 初始检查（2026-10-05，进行中）

准确baseline0e33703aaa411133af0cf4c25970721a41906a89；原6.1-sol/xhigh唯一worker/本地工作树未重建。B00已独立接受/merge1ba44e2f，不重做。

主代理读实际50c9400a六个允许文件：POM固定开发依赖、CompatibilityProbe四组真实运行断言、JUnit四测试、Classworlds隔离builder、精确target ignore、本人attempt。Boot明确非Web/排除DataSource和Flyway，无服务监听/真实数据库/DTO/业务。仅A1草稿读审，不是已通过实证。

worker唯一build67208，Node22 `deploy/dev/service/build.mjs`，600s界，加载50c9400a；workerstage确认真实Corretto1.8.0_482/Maven3.9.6。主代理不启动并行builder/不凭声明accept；准确结果/停写freeze后独立构建。

R1已发：owner.json首次readFile早于metadata校验，要求第一次读取前检查regular/非symlink/uid/nlink1/0600。仅小helper修正，保留当前build loadedSHA结果。

R2证据要求已发：冻结前明确检查自有class major52和fatjar BOOT-INF/lib全部固定版本、单logging provider/无旧binding及桥接环；不可只凭POM或真实JDK运行推断每个产物事实。四JUnit和打包运行都须给出准确命令/exit、代码快照、资源/句柄。现阶段不进行完整F03 parity（A2负责）。

04:36进展：worker67208实际exit0/BUILD SUCCESS，4tests/0failures/errors/skipped、fatjar四组真实Java8 verified。主代理已读6d778944：readPrivate先检查regular/uid/nlink1/0600后read，R1代码已修；新增jar实际库/ownclass52/Surefire计数/audit临时目录精确finally，R2代码齐备。worker audit-only exit0（2自有class52、34库），不是主代理独立复验。旧build加载50c，新helper完整复验/freeze/main独立仍待。

范围限制：实际Jackson-YAML2.18.3/SnakeYaml1.30作为transitive存在，仅JSON/Boot上下文已测，不宣称YAML解析兼容，无当前linkage错误实证、不擅自调版本。A2继续只离线JSON契约；未承诺所有可选编码器/内部平台/生产维护。

## A1独立通过（2026-10-05 04:40 UTC）

冻结codeb6c147c7131f8d41e37bb73bbe9b1f1bc2d229e6/report0b22599fd7223ec510b11313a747d40479568392；main实际clean/scope7files/diffcheck通过、读取全部增量。POM repackage execution加明确id与Boot父执行合并，避免重复repackage；其他核心版本/Java源未改变。

主代理准确命令 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node deploy/dev/service/build.mjs`（cwd实施树）18334 **exit0**：Corretto1.8.0_482/Maven3.9.6、4tests/failures0/errors0/skipped0；fatjar四组运行verified、webfalse/databasefalse。真实audit 2自有class52、**35** BOOT-INF库，早先34口述已更正；核心固定版本/一个SLF4J2 provider、无旧binding/桥接通过。jar SHA08eea59ae44001ce811f3187c7604c5c7330997aed10ac264cefbb95eaf1a8c0，tree SHA2b437c98f8c4d2271394cc8e9b9b2c6242d85d7755191f1001c5464a3b601c4b，匹配worker最终证据。R1代码修复和正常启动通过；R2已独立读到实际产物事实，不仅POM。

仅接受A1局部兼容，不宣称整个B01/六API/数据库/YAML/生产支持完成。下一正常合并接受片，然后集成树新target进行全新编译和相同运行检查，再签发A2。旧src/F03/F05/B00/锁未改，不机械重做不相关回归。

集成完成69f326ce。主代理从集成树执行同一准确build.mjs命令86029 exit0，**全新编译**main1源码/test1源码（不是缓存class跳过编译），4tests0skip、fatjar/class52/35libs通过。新jar9f5ac2cd537272a89a0469841f6094bf06d85b60f2647abfa381233ebbe5c921，tree仍2b437c98f8c4d2271394cc8e9b9b2c6242d85d7755191f1001c5464a3b601c4b；JAR时间戳导致不同SHA不冒充源漂移，源码已正常merge/未改。A1 accepted/merged完整，无构建句柄；下一只A2a可达DTO，不一步抢先业务API。

## A2a早期检查（2026-10-05 15:04 UTC，未验收）

用户手动接续并显式改high，旧xhigh停止/额度允许后保留同实施树；原A1/B00不重做。新B01-A02/high唯一worker从7c25bf47派单，起点report-only e8b13615已实际核对；定时任务保持PAUSED。

主代理只读尚未冻结的Java生成器/单BotContracts.java/5项typed消费测试/builder增量。六operation通过OpenAPI参数、request/response引用推导，闭包25、封闭POJO/enum/List/Long、原Schema约束明确留A2b；builder只check不重生，递归检查所有own class52，保留A1四组+五消费套件。当前只观察源码，未运行独立builder/未接受。

A2a-R1：refinement追踪parent property alias缺循环保护，受控ErrorCode自引用可陷while。已交worker小修正；当前源码已加局部seen/recursive refinement拒绝，指定该路径负例待worker补齐及主代理独立实跑。worker口头11个Node tests/--check exit0是worker证据且早于循环负例，不算主代理通过或冻结结果。要求Java长构建前保存实际SHA/结果/句柄检查点；保留所有未提交实现，不覆盖/清空。

下一A2b离线Schema/Java-Ajv一致性任务单仅draft，依赖A2a主代理接受/合入，不并行派发。主代理用既有Ajv只读实际观察Id终结换行拒绝及闰秒允许等边界，已记draft供后续双方实跑，未宣称Java已兼容。

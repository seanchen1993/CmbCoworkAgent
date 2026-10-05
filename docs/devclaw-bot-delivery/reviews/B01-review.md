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

## A2a独立接受（2026-10-05 15:10 UTC，集成待做）

Frozen code03cc2f24766438614c0378cc7975fad5d07cd3c5/final report720177d809cbea85b2a4b58c2043dfb9580eb9ec；03cc..720排除本人报告diff exit0，workerclean/停写/闭合85039与30262。主代理完整读九文件允许增量与380行generated DTO，核对参考来源、有限keywords/未知失败、check-only、Long/typed lists、wire enums、optional、省略/required-null明确非边界验证。package仅四script/README窄追加，原A1源码/pom/版本/冻结源/TS/src/锁/F05/B00无diff。

主代理独立命令（cwd实施树，Node22准确路径）及实际结果：`--test tests/bot/service/java-generator.spec.mjs` chunkebd169 exit0 **12/12、0skip**；`tests/bot/check-contracts.mjs` session45195 exit0 **24/24**并原TS生成check/tsc消费；`deploy/dev/service/build.mjs` session20746 exit0：真实Corretto1.8.0_482/Maven3.9.6，实际JUnit5消费+4兼容=**9/0fail/errors/skip**，fatjar真实probeverified、webfalse/databasefalse，实际25ownclass52/35libs/固定版本与单provider。Jar SHA14a686bdfb6a7e2f4a85940502973f6baab022999e01d065b53c265cca7a246a；tree SHA2b437c98f8c4d2271394cc8e9b9b2c6242d85d7755191f1001c5464a3b601c4b与A1同。工作树依然clean，两个session闭合。

R1本次独立test9实际39ms非零拒绝，已关闭。main本次首次build缓存编译class复用但JUnit/probe/audit实际运行，不声称全新编译；正常merge后集成树新增源码须实际编译再次核对。不以worker自测代替独立结果、不接受wholeB01或运行时Schema边界。下一集成复验，然后A2b。

集成7bd0ce8d；实际diff冻结720177d8..merge仅coorddocs差异，代码相同。主代理集成完整build77272 exit0，**实际全新编译2主源码/2测试源码**，九JUnit0skip、真实JDK8 probe、全部25ownclass52/35libs，Jar SHA e2b168ca8dc01007c6f69eefdffd90e54306a7f646250bcf1a250ec57c8b4a58/tree同2b437c98。新JAR时间戳与worker不同不当源漂移。A2a accepted/merged完成，无主代理句柄。下一A2b原Schema/Java-Ajv一致性ready，仍未实现/不提前进入HTTP/DB业务。

## A2b实施起点与精度风险（2026-10-05 15:25 UTC，未验收）

原high代理完成停写、两树8589e084 clean且无Java/Maven进程后，正式followup同B01-A02/A2b，无替代代理。主代理实际Git/报告核对小起点b2c45bf4，只本人报告变化；尚无A2b交付或独立通过。主代理不竞争builder。

主代理只读Node22原 `tests/bot/schema-support.mjs` 的Version validator，准确命令 `node --input-type=module -e` 导入validator，对原字节JSON.parse逐项验证，chunk1e8c6f exit0：1/1.0/1e0 true；1.0000000000000001、0.99999999999999999、9007199254740990.5、9007199254740991.1被JS Number舍入后也是true；9007199254740992 false。这是原Node数值解析的已观察限制，不是数学非整数合法，也不代表Java已测。

已给worker精确证据：上述原字节非整数须进入严格parser/typed boundary拒绝测试，不得先Double/cast丢精度；同组Schema数据值parity仍逐项实跑原Ajv，不能伪称原Ajv拒绝或吞掉共有case mismatch。不修改冻结源/旧Node支持文件。交付必须区分严格原字节边界和基于JS数据值的Schema语义一致性，不能宣称所有原字节在Node/Java全链路等价。此项是安全验收要求而非新产品范围。

15:34UTC早期只读七文件草稿（c80a70c4，尚未主代理实跑）：prepare原源闭包/mapping、固定resource摘要、仅可信classpath/清除defaultloaders、strictRead原A1实际BigInteger/BigDecimal/UTF8/重复键/有界策略、Schema先行/DTO数学整数规范化、独立Java和原Ajv逐例结论路径。POM仅resource/testResource，不改固定版本；new code尚未接受。请求worker补public六operation四请求/全部状态响应/参数真实typed消费，避免单独definition parity旁路mapping；建议纠正503合成ErrorResponse为DEPENDENCY_UNAVAILABLE，OUTCOME_UNKNOWN条件测试用声明409写操作，未提前实现HTTP业务分发。

实际worker失败检查点已核对Git/报告code c80a70c4/report368404c0：build16171 exit1，新BoundaryTest5项1fail/0error/skip；生成1107共用fixtures，Java336valid/771invalid，独立worker compare74923a exit1恰10差异（Id/UtcDateTime各五种终结换行，Ajvfalse/Java true）。原字节精确非整数四例及其他1097一致仅失败轮证据，不冒充main通过/最终通过。已要求保持原JSON和依赖不变，通过有限source pattern的RegularExpressionFactory末尾锚适配，避免转义字面量改义，并全量重新跑；旧句柄闭合，无第二main builder。A2b仍实施中，不派B1。

15:45UTC增量检查：f2c0461b的有限pattern策略在worker第二build40823 exit1遇到networknt全$defs预编译不可达Digest.pattern，6新JUnit/0fail/4errors/skip；此轮未写新parity，旧target不算该轮结果。main批准先验原资源hash，再仅投影闭包25原definition节点/$id/$schema到内存，不改选中规则/source；read cd896a74实际代码符合该窄适配。compile策略不扩大到Task/Run。新增unique runId匹配阻止跨轮旧结果。

worker报告第三完整build26599/cd896a74 exit0，真实3main/3test源码Java8编译，15JUnit/0fail/errors/skip、1107/326valid/781invalid/0mismatch；public4requests/6success/42errorstatus/10parameters，28ownclass52/35libs/probe。main当前只读代码/消息，不称独立通过。当前还在补bounded response写出/序列化前selector和DTO类检查、jar内原资源exact字节与Node防stale负例，必须最终freeze新快照再main全套；第三轮通过不继承给后续改动。

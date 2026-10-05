# B01 主代理检查记录

## A1 初始检查（2026-10-05，进行中）

准确baseline0e33703aaa411133af0cf4c25970721a41906a89；原6.1-sol/xhigh唯一worker/本地工作树未重建。B00已独立接受/merge1ba44e2f，不重做。

主代理读实际50c9400a六个允许文件：POM固定开发依赖、CompatibilityProbe四组真实运行断言、JUnit四测试、Classworlds隔离builder、精确target ignore、本人attempt。Boot明确非Web/排除DataSource和Flyway，无服务监听/真实数据库/DTO/业务。仅A1草稿读审，不是已通过实证。

worker唯一build67208，Node22 `deploy/dev/service/build.mjs`，600s界，加载50c9400a；workerstage确认真实Corretto1.8.0_482/Maven3.9.6。主代理不启动并行builder/不凭声明accept；准确结果/停写freeze后独立构建。

R1已发：owner.json首次readFile早于metadata校验，要求第一次读取前检查regular/非symlink/uid/nlink1/0600。仅小helper修正，保留当前build loadedSHA结果。

R2证据要求已发：冻结前明确检查自有class major52和fatjar BOOT-INF/lib全部固定版本、单logging provider/无旧binding及桥接环；不可只凭POM或真实JDK运行推断每个产物事实。四JUnit和打包运行都须给出准确命令/exit、代码快照、资源/句柄。现阶段不进行完整F03 parity（A2负责）。

04:36进展：worker67208实际exit0/BUILD SUCCESS，4tests/0failures/errors/skipped、fatjar四组真实Java8 verified。主代理已读6d778944：readPrivate先检查regular/uid/nlink1/0600后read，R1代码已修；新增jar实际库/ownclass52/Surefire计数/audit临时目录精确finally，R2代码齐备。worker audit-only exit0（2自有class52、34库），不是主代理独立复验。旧build加载50c，新helper完整复验/freeze/main独立仍待。

范围限制：实际Jackson-YAML2.18.3/SnakeYaml1.30作为transitive存在，仅JSON/Boot上下文已测，不宣称YAML解析兼容，无当前linkage错误实证、不擅自调版本。A2继续只离线JSON契约；未承诺所有可选编码器/内部平台/生产维护。

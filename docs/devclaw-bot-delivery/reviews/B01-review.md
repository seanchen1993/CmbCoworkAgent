# B01 主代理检查记录

## A1 初始检查（2026-10-05，进行中）

准确baseline0e33703aaa411133af0cf4c25970721a41906a89；原6.1-sol/xhigh唯一worker/本地工作树未重建。B00已独立接受/merge1ba44e2f，不重做。

主代理读实际50c9400a六个允许文件：POM固定开发依赖、CompatibilityProbe四组真实运行断言、JUnit四测试、Classworlds隔离builder、精确target ignore、本人attempt。Boot明确非Web/排除DataSource和Flyway，无服务监听/真实数据库/DTO/业务。仅A1草稿读审，不是已通过实证。

worker唯一build67208，Node22 `deploy/dev/service/build.mjs`，600s界，加载50c9400a；workerstage确认真实Corretto1.8.0_482/Maven3.9.6。主代理不启动并行builder/不凭声明accept；准确结果/停写freeze后独立构建。

R1已发：owner.json首次readFile早于metadata校验，要求第一次读取前检查regular/非symlink/uid/nlink1/0600。仅小helper修正，保留当前build loadedSHA结果。

R2证据要求已发：冻结前明确检查自有class major52和fatjar BOOT-INF/lib全部固定版本、单logging provider/无旧binding及桥接环；不可只凭POM或真实JDK运行推断每个产物事实。四JUnit和打包运行都须给出准确命令/exit、代码快照、资源/句柄。现阶段不进行完整F03 parity（A2负责）。

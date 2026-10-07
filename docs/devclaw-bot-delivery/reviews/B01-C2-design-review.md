# B01-C2 设计审查：本地六接口 HTTP 适配

2026-10-07 · v1 · 设计通过，实施进行中；不是代码或测试验收

## 实际证据

唯一实施代理仍是原 `/root/b01_contracts_high`，gpt-6.1-sol/high、B01-A02。实际设计提交 `436a7c209ed2c4f137c45b05c311b2ca78c8a2b2` 仅本人 A02 新增43行；主代理0f75fe完整读实际patch，worker clean，基线269664b1..HEAD除A02字节相同、diffcheck通过。代理实际completed停写；80e729提升只读进程检查exit1空。无HTTP源码、构建、秘密读取、数据库/HTTP资源或测试交付。原C1/B1已接受，不重做其实现。

主代理另实际读27fbfe原Operation、ContractBoundary和TransactionObserver，六selector/固定路径/原response验证与构造器seam足够。子代理javap仅证明固定版本API存在，不证明实际HTTP超时/安全性能。额度中断与同代理恢复保留state/HANDOFF，未购买/reset或恢复自动触发。

## 批准的分层

封闭LocalHttpMain启动→原DB config/readiness→显式Tomcat/MVC装配；raw gate→原始有界body→原BotApplication，返回原ApplicationResponse status/bytes。LocalIdentityRegistry只实现已有可信policy/context，不修改公网契约或用成员/body定义当前操作者。固定Boot/JDK8/34库及全部旧只读边界不变，无SpringApplication/自动扫描/配置中心或新SDK。

默认8worker/queue16/maxConnections32/accept backlog32/可识别op最多4活动入口可按设计落实；不将backlog和maxConnections混写成全部OS连接绝对数量。未知入口用原通用400/404，普通已识别op只其冻结声明状态；不能默许框架HEAD/OPTIONS/405/415/500/HTML/cookie/CORS。header idle不是slow-drip绝对时限，body5s与单次最多额外2s须真实TCP验证。

## 实施澄清（与任务v1一同遵守）

1. **先验证再绑定。** 原DatabaseReadiness.requireReady与完整config/identity验证必须在调用可能构造/绑定connector的factory/getWebServer之前，不只在WebServer.start之前。显式context不消费环境或外部配置；无法约束先给证据，不自动开启兼容配置。失败证明实际无listener，不能只信stderr或ready文案。
2. **分离控制通道。** 生产main只接完整有界、严格UTF8/duplicate/trailing/unknown校验的stdin快照至EOF，没有运行期控制/故障命令。test-only main若需barrier控制，先读有界的一帧config并用相同LocalLaunchConfig验证该帧，后续只固定test控制词；不将控制流尾部当生产config合法，也不让生产observer经HTTP/env/配置开启。控制读取、取消和finally各有界。
3. **原始路由不让框架替代。** raw gate先于MVC，任何normalization/decoded alias不授予合法入口；ID只一次严格UTF8解码后原参数校验，固定文本段不接受编码别名。合法编码colon/unreserved Id与含普通dot仍需通过；encoded slash/pathparams/dotsegments/query（含裸?）等真实rawTCP拒绝。Tomcat前置parser拒绝单列，安全关闭不冒充契约JSON结果。
4. **真实信任与收尾。** Node每个secret读取、spawn、stdin发送与bearer出站前检查当前signal/真实owned DB、uid/inode/nlink/文件与own child PID+实际127 listener，ready自报不能替代。既有helper只复用不降低。生产只NONE observer；test构造器观察用于真实TCP重叠/rollback/lost-response。finally先关自己Java并证明PID/listener不存在，再精确owner资源/fixture清理，原dev不改/不迁移/不升权。
5. **测试不得借位。** 每个普通拒绝原Ajv与完整九表SQLfacts；原body上限、Unicode/NUL/surrogate、回执原bytes、当前授权与CAS均经真实HTTP。双HTTP JVM必须实际barrier证明重叠，unknown commit需真正TCP丢响应+重启原ID对账。startup、idle/slow-drip、容量恢复、secret哨兵和新HTTP fault/SIGTERM不能用旧C1/B1或MockMvc结果代替。

## C2-R1 增量审查：批准窄hook，实际证明待完成

主代理5de3a2实际固定9.0.83 bytecode与[同版本官方源码](https://github.com/apache/tomcat/blob/9.0.83/java/org/apache/coyote/http11/Http11Processor.java)确认：CL与chunked TE并存时，容器在Valve前移除CL并关闭keepalive。后置getHeaders不足以证明原始共存拒绝；这不是已完成的安全测试。f3ef24/33cb63确认public Request.getInputBuffer与Http11InputBuffer.getByteBuffer存在；[官方InputBuffer源码](https://github.com/apache/tomcat/blob/9.0.83/java/org/apache/coyote/http11/Http11InputBuffer.java)同时证明头名/值会原地归一化，因此buffer不是未经修改的wire副本。

同child实际核parseHeaders当前位置即头结束、nextRequest仅compact/reset后，main又独立读pinned源码对应行为，已direct批准窄实现：仅body前只读duplicate的[0,position)当前头窗口，明确≤8192/32，与Coyote method/rawURI/query/protocol核当前requestline/窗口尾完整终止，不改变原position/limit/内容、不扫描limit余下body/pipeline或旧请求。固定新http适配内完成，不反射/复制第三方processor/额外proxy/升级依赖、不放宽或skip。原值折叠可能覆盖CRLF，不能假称物理行扫描证明所有wire obs-fold；实际fold/OWS/case/CL+TE/duplicate、absolute-form与合法encoded Id、body伪头/keepalive/pipeline必须实测。不确定形态fail-closed，源码/API说明不代替真实TCP，R1仍open到main读代码/独立验证通过。

## 下发与接受门槛

### HEAD拒绝的传输语义澄清

主代理806174独立核固定9.0.83实际javap及[同版本官方prepareResponse源码](https://raw.githubusercontent.com/apache/tomcat/9.0.83/java/org/apache/coyote/http11/Http11Processor.java)842–846：HEAD不论status均使用VOID_FILTER省略实体。准许单列rejected-method/no-body传输验证：HEAD必须实际400/Connection close/wirebody0/无HTML-cookie-CORS/九表完整facts不变；不是自动GET/HEAD成功或新API，不声称ErrorResponse bytes经wire/Ajv。不改原method/processor，也不按HEAD声明Content-Length强算不存在的实体。仅此有依据HEAD特例；六合法方法普通错误仍非空原契约JSON/Ajv，OPTIONS不豁免，parser-framing另列。当前只是设计认可，真实HEAD测试仍待。

保存本审查和main协调记录→对原已停止clean worker正常merge docs→actualHEAD/clean/源码字节核对→formal followup同一high原代理，才能写任务v1允许的新类/新http harness与测试。第一实现检查点先保存装配/身份/raw边界及对应unit/metadata测试和实际构建结果；后续全部HTTP探针、生命周期及原回归仍在同C2授权，不开第二写者。

八入口按tasks/B01-C2.md完整执行；保留原26Node/25JUnit/24F03/1107parity/34库/class52/原源和artifact。自测仅待审查，最后真实code/report SHA、clean/无运行未知句柄并停写，主代理完整实际diff和独立真实验收、正常集成且实际freshcompile复验后才接受。无UI/Runtime/招乎/model/repo/B02/B03/outbox sender/新API、sudo/重建/prune/推送/部署/内网/付费；定时PAUSED。

# R01-A5 本地节点认证与专用任务 Thread 验收

2026-10-11 · root 串行 · 基线 e1f9b1d4

节点配置使用独立 dcn1_ 随机256位凭据，只保留 SHA256 摘要。Session 由 registry 签发并绑定 registry/当前entry；适配器只接受 Session，不接受 node/space/owner 请求字段，每次 observe/claim 复核过期/撤销/轮换，并复用旧应用事务的当前身份/授权/版本检查。可信本地配置的 replace 全量原子换代，错误配置不改旧entry，成功换代旧Session全部失效。不把凭据校验等同于授权，不把claim等同于执行。

App本地一个 bot_task_threads 表，无FK。space/task/stage/node唯一；owner/group/workspaceRef漂移拒绝。创建新Thread和绑定同SQLite IMMEDIATE事务，复用原底层行创建/incarnation；重开、丢失commit返回或双进程竞争只找回原Thread。Thread被删、同id重建、目录/模式/个人记忆标志/额外个人配置/marker改变均拒绝，不自动换Thread。显式本地目录仅保存在本地Thread metadata，返回冻结六字段ThreadBinding不含路径。原个人Thread创建默认行为保持，不读取个人设置。

实际验证：

- Java8 42main/19test新编，55JUnit/1884 Java-Ajv parity零；34libs、class52、V1～V4原字节打包审计通过（89351/9a1449）。jar 2c7efcc23e2bafde6aec6ed6abb820ec0abbaca90188756a4c667e1e379d1616；后续未重编/改变。
- 新SQLite最终10项，包含双独立App进程、两连接/重开、触发器回滚、真实commit后失回执、调用者事务不被回滚；伙伴原30项共40通过（7ab6b4）。原Thread4文件13项通过（35246/ec0e98）。主进程最终tsc通过（46379/ce2732）；新文件格式通过。
- 补充strict检查先发现新两处类型问题，已修；最终新源/测试零错误（a1a306）。只有未经修改的旧sqlite-durable-file两条sql.js声明缺失7016基线问题；核其原字节不变后按精确文件/行/编号分离，不宣称全仓strict通过，不改依赖/加any stub。
- Node服务44、F03全24/生成漂移/类型消费通过（61614/bff7da）。冻结schema/生成Java/DTO、V1～V4、POM/原HTTP/A3A4应用服务/原Runtime与执行入口未修改。
- 86717/e93e80 两个真实MySQL5.7隔离库，空库和实际V3升级旧表/history原字节保持；每库36拒绝含5认证拒绝、不同真实节点不可冒领；认证心跳/重复claim同attempt/lease、原并发/回滚/失回执/unknown不重跑全过。新测试资源精确移除，active0，原三sameID healthy且不读原秘密。

本轮界限：这是内部本地准备能力，未在启动配置/HTTP/WSS/IPC注册，没有把两端连接起来。没有实际 startAgentRun/model/tools、Run事件完成/续租、共享文件沙箱、群绑定/UI/真实招乎，也不承诺exactly-once工具。配置凭据期限/撤销在调用准入边界检查，不撤回已执行副作用。专用Thread不替代真正start的当前服务端复核、文件/工具隔离和本地执行互斥。

下一有限接续建议：复用 AgentRunService 实现只读需求执行薄适配，先明确完整启动输入/当前授权、受限工具、租约/停止和结果结算，再本地假模型验证；不重写原Runtime、不自动外推云端或真实IM。定时续跑保持PAUSED。

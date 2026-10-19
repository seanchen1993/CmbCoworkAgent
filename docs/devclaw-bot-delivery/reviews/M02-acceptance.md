# M02 独立审查与验收

2026-10-19，**accepted，已本地合入，未推送**。root 设计、审查和独立验收；唯一产品实施者 `/root/service_conversation_sol`，`gpt-6.1-sol / xhigh`。后续沿用用户确认规则：复杂任务 xhigh，简单改动 high。

- 产品基准：M01 检查点 `e80f741c7d85b9184ee82b8dd4a8b23f5be6c68b`；设计提交 `3d26ccfc0a4053f5800252e66eb25a8be356d314`。
- 首冻结候选 `6bfabefc8c1d37b871fab618746e5c65eb4574ea`；最后竞态修正候选 `96e6e1429def5bb47ea838704b4f46bd76291787`。
- 正常合并提交 `1007a11bc21a0803b19b7ee8e6b41471eb821924`；目标分支 `codex/devclaw-bot-integration`，工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`。
- 产品树与最终候选相同，beta 和候选均为目标祖先。Java、公共 contracts、deploy 与 M01 基准无差异。候选 33 文件，4517+/56-，不包括 root 交付文档。
- [任务设计](../tasks/M02-service-conversation.md)、[实施记录与完整命令](../attempts/M02-sol-xhigh.md)。

## 已交付功能

beta Bot 工作区新增当前服务专家会话：明确选择模型、显式启用授权本机、新建/选择任务、一次发送自动创建服务 Task 并派发 Run、同任务补充、停止、阅读结果及重开恢复。运行中补充先显示“下一轮分析采用”，前序终态后才追加服务消息，避免改变当前执行冻结版本。结果为“分析完成”，不等同业务验收。

窄 API、SQLite journal 和既有单 worker 接入 Java 控制服务。先持久完整身份、原 command/version/deadline 和模型绑定再写服务，回包丢失延续原命令，不另起执行掩盖未知状态。真实模型配置由 main registry 解析，最终 resolver 再核对非密钥 hash 并用同一快照构建。展示不用普通聊天 Thread，不进入 local Bot、个人记忆或文件/浏览器执行入口。

## 审查中修正的问题

1. 旧请求重放捕获 FORBIDDEN 范围过大：改为局部 nullable 查询，远端拒绝直接传播，成功缓存拒读负例通过。
2. 模型检查与异步构建之间的配置漂移：最终 resolver 核对 hash，同快照构建；已保存结果重交不要求模型仍存在。
3. 延后补充首次准备 enqueue 才冻结期限，已发送命令/期限固定。HTTP OUTCOME_UNKNOWN 按原命令恢复，与模型执行未知不重跑区分。
4. Java claim 拒绝 RUNNING：通过当前节点 inspect 原 ticket 恢复；result_ready 只重交，reserved/running 保持未知。重复启用复用有效 grant，避免递增 grantVersion 破坏冻结执行。
5. 模型拒绝用 Java 既有 EXECUTION_FAILED 结算，本地保留 MODEL_* 原因。inspect 核对完整绑定、结果身份与不可变性。
6. UI 保留展开历史、终态停轮询、隔离迟到回包；连接变更开始/结束及失败都清空旧缓存。启用确认准确说明明确模型的真实执行能力。
7. 最终发现迟到 enqueue 回执可能把已观察到的未知/终态降回 queued。early hook 复现六场景，修复前一过五失败；现在仅仍处 enqueue 才推进，保留已有状态、notice、version、result。未知前序后的补充保持 blocked，message 0、enqueue 1。

## 验证证据

全部 Node 命令使用已安装 Node 22。集合有重叠，不相加当作全仓测试总数。

| 验证 | 结果及日志 |
| --- | --- |
| root 最终核心 | service-conversation/runtime、worker、controller/client、executor、task-thread-store、expert-controller，共 **85/85**，退出 0；`/tmp/m02-root-core-accepted.log`。含真实 SQLite、受限 DeepAgent、未知不重跑与迟到回执六场景。 |
| root IPC | **17/17**，顶层窗口/精确参数/拒绝可信身份和 RunSpec 输入/变更失败失效；`/tmp/m02-root-ipc-final.log`。 |
| root 独立 SQLite 探针 | 真正重开、请求幂等/冲突、跨身份拒绝、**105 条历史无漏重**、pending 8、7 类 claim 错配、EXPLAIN command 索引；`/tmp/m02-root-store-final.log`。 |
| root 实际 Electron/React | 正常发送、同 Task 补充、精确停止、重挂载不重发、41 条展开历史、迟到 read/send 隔离、终态停轮询，local Bot 调用 0；`/tmp/m02-root-ui-final.log`。目视复核实际构建 CSS 截图 `/tmp/m02-service-conversation.png`。 |
| root 真实服务旅程 | Java HTTP + 隔离 MySQL + SQLite + 单 worker + 现有 DeepAgent fake，退出 0；`/tmp/m02-root-http.log`。首轮/补充、early claim、模型漂移拒绝、模型删除后重交原 result_ready、重开不重跑及旧开发 fake；共 fake 模型 4、工具 0。 |
| root 契约 | **24/24**，`/tmp/m02-root-contracts.log`；本片公共 contracts/Java 未改。 |
| 实施者完整回归 | 本地 Bot **530/530**、IPC+Bot **32/32**、桌面/IM **26 入口**、实际 Partner 面板通过；命令和对应日志见 attempt。 |
| 实施者 Java 构建 | **69 JUnit、1884 parity 零差异**，Java8 打包/产物审计通过；`/tmp/m02-java-build.log`，该产物用于真实旅程。 |
| root 集成树 | `tsc --noEmit -p tsconfig.node.json --composite false` 与 Web 同参数均 0；`electron-vite build --mode m02-isolated` main/preload/renderer 完整 0；`/tmp/m02-root-target-main.log`、`/tmp/m02-root-target-web.log`、`/tmp/m02-root-target-build.log`。 |

真实 HTTP、UI、IPC、SQLite 探针对应首冻结候选 6bfabefc。最后 96e6e142 仅保护主进程迟到 enqueue 回执并新增六场景；root 对最终候选复验完整 85 核心，在合入后验证类型与构建，未重复无关数据库套件。修复前失败与初轮失败记录在 attempt，未当作通过结果。

## 性能与资源

本片不涉及 ES。journal 使用 scope/conversation/task 与 command 索引，稳定游标每页 40，多取一条判断后页；恢复批次 8、单泵串行；inspect 并发最多 2，HTTP client 总在途最多 8，单 worker/单 graph。终态停止 UI 轮询，自动结果更新只查已加载非终态请求，手动刷新保留展开范围。以上为结构及 fixture 验证，未测生产大数据耗时。

root 隔离项目 devclaw-bot-test-9a6357aaf14a9ac4 和实施者最终 devclaw-bot-test-748763931d357b2f 均精确回收。专用 daemon 75050694-6599-4820-af0e-28384728124e 中，原 B00 MySQL 693a1c3 曾为测试守卫临时启动，结束后同容器/卷已恢复原停止；原 ES/S3 同 ID healthy，用户 Partner MySQL bdf4f0d 始终保持原停止。测试容器/卷/网络剩余 0；`/tmp/m02-root-db-restore.log`、`/tmp/m02-root-resource-audit.log`。未读原凭据、未启动用户 App profile、未删除用户数据。

## 明确边界

当前单专家、本机历史、文本分析已完成。真实配置模型能力已接线，但验证全部为 fake 注入，付费模型调用 0，未实测真实 provider 推理。多专家目录、跨设备历史、正式成果版本/确认/退回、群协作收束、自动知识采纳仍属后续。预览启动器既有 WIP 未在本片修复。未推送、部署或恢复已暂停自动任务。

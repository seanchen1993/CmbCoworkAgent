# R01-A6 独立验收

accepted，代码a07dd89b：所有核心验证、最后App修改后demo重跑/终末资源与保存完成。基线23e07d7c。Java由同原gpt-6.1-sol/high代理、App由root在隔离文件范围并行实施，root读取实际diff并独立验证。原13任务记录原样保留（94a664）。

## 交付

- 认证Session start/renew/settle/getResult，当前身份/Group成员/执行与工作区授权、冻结Task/Group/BotVersion/node/grant、attempt/lease/fence和时间复核。single attempt starting→running→succeeded/failed，超期unknown不得重执行/迁移，unknown占容量；终态释放容量。
- V5一张结果表无FK，与Run终态同事务保存。相同结果重交返回原结果；冲突拒绝。固定failed安全码，不持久异常/凭据/堆栈，不自动完成Task阶段。旧V1–V4/POM/公共契约/生成DTO和原runtime.ts无修改。
- App专用Thread当前metadata/incarnation验证、SQLite单attempt日志/重开保留未知与结果回执恢复、既有本地Thread互斥。服务端admission尚未返回时的停止请求也保留；续租失败/期限超时Abort。
- 现有AgentRunService新增可信input-only profile，不初始化不得fallback个人执行体；实际复用现有createDeepAgent图，不新增引擎。固定专家版本与需求文本/有界显式澄清；零工具、技能、Hook、MCP、子代理、个人身份/记忆与旧历史，明确模型/目录映射不取默认。
- 可重复`npm run demo:bot-requirement`与说明local-requirement-demo.md。固定测试管道+本地假模型，不称生产WSS/真实模型推理或招乎收发已完成。

## root实证

- 64728/0d8a61 JDK8 build复验57JUnit/1884parity零/class52/原34libs/5迁移打包exact，jar27f5e40191f8064a28970c5b8e68a74229529f24a0e4eabc4e56a287d55c6728；main为子77143真实43/20新编后的up-to-date，root未虚报fresh编译。
- 79256d Node46、a671f6 F03全24/drift/types通过；78077/9bb5b4最终伙伴30+Thread10+实际graph16=56过，63844/6f9a6f项目+新tests类型诊断0；新文件formatter95a2e4与diffcheck通过。早期graph步限制/错误包装和fixture类型失败均在root报告保留并更正，不隐瞒或用mock成功替代。
- 原IMbridge16/windowSurface4/standard architecture/desktop entry、原Thread/skills/refusal六文件21、finalsystemprompt均实际exit0。源码旧AgentRunService默认执行路径不变，IPC只增注册，无个人入口替换。
- 12991/138676两个真MySQL5.7：populatedV4→V5旧17表/四history exact字节保留；40拒绝、start/renew/settle rollback/commit失回执恢复、当前ACL/grant/Task变化、expired unknown与容量、2独立JVM start/settle同结果与新JVM读回。两精确回收、children0、原三samehealthy，未读原秘密。
- 62994/012f1c两个真库：消息scope/目标/frozenVersion/50/60000/artifact/schema与作者核对5拒绝；真实澄清及2JVM并发start/settle/renew/read。两精确回收。
- 1547/ac2669两个真库：5migrations/noop0，18表完整列/索引零FK，Unicode与bytes重开；5坏history保持全facts/显式恢复，3schema权限拒绝、坏密码/offline/stale拒绝、真实queryTimeout1046/1018ms。两精确回收。
- 5652/c4e9f9真实Java+MySQL+SQLite+现有DeepAgent+FakeChatModel完整旅程通过；最后admission早停修复后42108/751baf再次实际exit0：澄清实际进入输入，modelCalls1/tools0/resultPersisted、专用Thread、SQLite重开/同结果重交不重跑，owned9e133c5c6173250b/8c10ab2a…33032及SQLite目录精确回收。
- 67206a终末实际audit：无Java/Maven/probe进程、代理completed停写；只原MySQL693a1c3fd9c1/ES4f0ed4ed0cf3/S39332987a1451 sameID healthy/回环端口，原三volume/dev-private network保留，无test资源。旧local e54d3fb0 clean；formatter/diffcheck与jar原样，实际automation PAUSED。35be83代码正常本地提交a07dd89b，39允许产品文件，无push/deploy。

## 限制

没有真实招乎/群绑定/UI、生产节点WSS/公共RunSpec完整协议、附件/源码读取、正式PRD审批/阶段流转、云Runtime、长期记忆维护或unknown协调恢复。provider取消仍依赖AbortSignal支持；图结束和零工具profile不构成外部副作用exactly-once保证。测试管道内随机Session认证不是上线节点连接。自动任务保持PAUSED，不进入后续产品路线或推送/部署/付费。

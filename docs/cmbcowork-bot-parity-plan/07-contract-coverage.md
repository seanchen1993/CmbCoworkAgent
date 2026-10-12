# RPC 与工具覆盖检查

当前核心对这 210 项的处理见 [core-scope.json](core-scope.json) 的 rpc_scope_mapping。核心行为、条件能力、延期表面及内部/待观察接口分别处理；关联到核心需求不等于必须公开原 RPC，尤其不得照搬旧 revealSecret 接口。

## 1. 覆盖口径

从两张方法表提取 **210 个接口**，逐项关联到需求或显式差异。这里的完整仅指这两张表没有未分类条目；不是宣称穷尽原版全部后台 API，也不表示每个实现已验证。静态数据见 [rpc-coverage.json](rpc-coverage.json)。

状态说明：mapped=有对应建设需求；needs_observation=公开状态/交互待观察；internal=诊断/内部机制；reconstruction_or_unverified=重建扩展或官方待核实；internal_or_shared=共用框架接口；superseded_or_unverified=与当前公开契约有冲突。

接口名与内部协议不必照搬。需要保留的是用户可观察行为、状态、权限和恢复语义。表中附加核实点作为相关需求的子检查，不能因主需求已实现就自动算通过。

## Coordinator：89 项

| 接口 | 需求 | 分类 | 补充说明 |
| --- | --- | --- | --- |
| [getAgentTranscriptWindow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:93) | MSG-06, MSG-21 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentThread](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:94) | MSG-06, MSG-21 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentTranscriptTail](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:95) | MSG-06, MSG-21 | mapped | 实现等价行为；不要求沿用原接口名 |
| [openAgentTail](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:96) | MSG-06, MSG-21 | mapped | 实现等价行为；不要求沿用原接口名 |
| [sendPrompt](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:97) | MSG-02, MSG-03, MSG-04, OPS-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [promptAcceptanceStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:98) | MSG-02, MSG-03, MSG-04, OPS-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [respondToWidget](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:99) | MSG-11, MSG-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [resolveAutoReviewApproval](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:100) | MSG-12, APR-01, APR-04, APR-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [resolveLocalToolPermission](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:101) | MSG-13, DEV-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [dismissWidget](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:102) | MSG-11, MSG-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [submitSecret](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:103) | MSG-14, APR-10, APR-12 | mapped | 实现等价行为；不要求沿用原接口名 |
| [reactToMessage](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:104) | MSG-07 | mapped | 实现等价行为；不要求沿用原接口名 |
| [listAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:105) | BOT-13, MSG-20 | mapped | 实现等价行为；不要求沿用原接口名 |
| [countAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:106) | BOT-13, MSG-20 | mapped | 实现等价行为；不要求沿用原接口名 |
| [searchAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:107) | BOT-13, MSG-20 | mapped | 实现等价行为；不要求沿用原接口名 |
| [searchMedia](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:108) | BOT-13, MSG-20 | mapped | 实现等价行为；不要求沿用原接口名 |
| [createAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:109) | BOT-01, BOT-04 | mapped | 创建及首次启动；kickstart 的具体欢迎/初始化路径需真机冻结 |
| [createGroup](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:110) | COL-05, COL-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setGroupMembers](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:111) | COL-05, COL-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [updateAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:112) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [deleteAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:113) | BOT-11, BOT-12, BOT-14 | mapped | 实现等价行为；不要求沿用原接口名 |
| [duplicateAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:114) | BOT-09, BOT-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [kickstartAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:115) | BOT-01, BOT-04 | mapped | 创建及首次启动；kickstart 的具体欢迎/初始化路径需真机冻结 |
| [requestDiskSaverAudit](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:116) | CPU-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [broadcastToAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:117) | OBS-03 | needs_observation | 仅协议不证明当前公开可用 |
| [getCloudAgentInfo](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:118) | COL-12, OBS-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getListenerIntegrations](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:119) | AUT-10, AUT-11, AUT-12, AUT-13, AUT-14, PLG-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getListenerConnectUrl](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:120) | AUT-10, AUT-11, AUT-12, AUT-13, AUT-14, PLG-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setAgentUnread](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:121) | BOT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setAgentHiddenFromSidebar](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:122) | BOT-07 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setAgentNotificationsEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:123) | UI-04 | mapped | 通知开关与是否报告中间进展分开核实，不影响后台执行 |
| [setAgentNotifyOnUpdates](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:124) | UI-04 | mapped | 通知开关与是否报告中间进展分开核实，不影响后台执行 |
| [setAgentAvatarBytes](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:125) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentAvatar](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:126) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentWorkflows](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:127) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [createAgentWorkflow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:128) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [updateAgentWorkflow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:129) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [setAgentWorkflowEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:130) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [deleteAgentWorkflow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:131) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [runAgentWorkflowNow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:132) | SKL-01, SKL-02, SKL-09 | mapped | 旧源码 workflow 命名对应技能流程，不能与定时 automation 混为一张表 |
| [importAgentWorkflowText](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:133) | SKL-01, SKL-02 | mapped | 文本、URL 与本地技能迁移分别校验依赖、内容和权限 |
| [importAgentWorkflowUrl](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:134) | SKL-01, SKL-02 | mapped | 文本、URL 与本地技能迁移分别校验依赖、内容和权限 |
| [portAgentLocalSkills](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:135) | SKL-01, SKL-02 | mapped | 文本、URL 与本地技能迁移分别校验依赖、内容和权限 |
| [getConversationOutline](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:136) | MSG-21 | needs_observation | 对话提纲/定位入口需按实际原版界面核实，不等同于已经看到公开 UI |
| [skillsCatalog](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:137) | SKL-01, PLG-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [syncPluginSkills](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:138) | SKL-01, PLG-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getPluginSyncStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:139) | SKL-01, PLG-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [listRoutedMcpTools](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:140) | PLG-05, PLG-06, APR-14 | mapped | 实现等价行为；不要求沿用原接口名 |
| [executeRoutedMcpTool](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:141) | PLG-05, PLG-06, APR-14 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getSkillPublishTargets](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:142) | OBS-05 | needs_observation | 确认发布目标、权限及版本 |
| [publishSkill](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:143) | OBS-05 | needs_observation | 确认发布目标、权限及版本 |
| [resyncPublishedSkill](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:144) | OBS-05 | needs_observation | 确认发布目标、权限及版本 |
| [unpublishSkill](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:145) | OBS-05 | needs_observation | 确认发布目标、权限及版本 |
| [getSubagents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:146) | COL-11, OBS-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAsyncTasks](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:147) | COL-11, OBS-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getForeverBoxStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:148) | CPU-01, CPU-09, CPU-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [ensureForeverBox](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:149) | CPU-01, CPU-09, CPU-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [handBackForeverBox](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:150) | CPU-07 | mapped | 实现等价行为；不要求沿用原接口名 |
| [startTeachRecording](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:151) | SKL-04, SKL-05, SKL-06, SKL-07, SKL-08, SKL-09, SKL-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [stopTeachRecording](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:152) | SKL-04, SKL-05, SKL-06, SKL-07, SKL-08, SKL-09, SKL-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getTeachRecordingStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:153) | SKL-04, SKL-05, SKL-06, SKL-07, SKL-08, SKL-09, SKL-10 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getTrays](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:154) | MSG-19 | mapped | 实现等价行为；不要求沿用原接口名 |
| [dismissTray](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:155) | MSG-19 | mapped | 实现等价行为；不要求沿用原接口名 |
| [clearTrays](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:156) | MSG-19 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentChannels](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:157) | TEAM-12, OBS-07 | needs_observation | 0.18 的 Bot channel 协议与当前 Team Bot Slack 接入分别核实 |
| [connectChannel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:158) | TEAM-12, OBS-07 | needs_observation | 0.18 的 Bot channel 协议与当前 Team Bot Slack 接入分别核实 |
| [disconnectChannel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:159) | TEAM-12, OBS-07 | needs_observation | 0.18 的 Bot channel 协议与当前 Team Bot Slack 接入分别核实 |
| [refreshChannel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:160) | TEAM-12, OBS-07 | needs_observation | 0.18 的 Bot channel 协议与当前 Team Bot Slack 接入分别核实 |
| [getBoxSecretsStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:161) | MSG-14, APR-10, APR-12 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAgentAutomations](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:162) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [listAllAutomations](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:163) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [isAgentNetworkEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:164) | OBS-02 | needs_observation | 功能开关不是功能已发布的证据 |
| [isGlobalSearchEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:165) | MSG-20 | mapped | 实现等价行为；不要求沿用原接口名 |
| [isEgressTunnelAvailable](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:166) | DEV-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getSharingState](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:167) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [createRoomFromAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:168) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [createRoomInvite](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:169) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [joinSharedRoom](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:170) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [respondToRoomJoinRequest](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:171) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [createSharedRoom](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:172) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [addOwnAgentToSharedRoom](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:173) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [removeOwnAgentFromSharedRoom](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:174) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [setSharedRoomTyping](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:175) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [leaveSharedRoom](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:176) | OBS-01 | needs_observation | 跨用户房间不能直接复用 Team Bot 私聊数据模型 |
| [setAgentAutomationEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:177) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [createAgentAutomation](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:178) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [updateAgentAutomation](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:179) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [deleteAgentAutomation](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:180) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [runAgentAutomationNow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:181) | AUT-01, AUT-02, AUT-03, AUT-04, AUT-05, AUT-06, AUT-07, AUT-08 | mapped | 实现等价行为；不要求沿用原接口名 |

## Main：121 项

| 接口 | 需求 | 分类 | 补充说明 |
| --- | --- | --- | --- |
| [openExternal](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:5) | FIL-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [submitFeedback](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:6) | UI-12, VOC-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getDesktopEnvironment](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:7) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [getWindowState](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:8) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [minimizeWindow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:9) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [toggleMaximizeWindow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:10) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [closeWindow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:11) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [resizeWindowWidth](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:12) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [setTitleBarOverlayTone](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:13) | UI-01, UI-07 | mapped | 复用 Electron 窗口；平台特有标题栏和关闭行为需要对照 |
| [getThemeState](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:14) | UI-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setThemePreference](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:15) | UI-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getEgressTunnelEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:16) | DEV-04, DEV-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setEgressTunnelEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:17) | DEV-04, DEV-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getEgressTunnelStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:18) | DEV-04, DEV-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getWebauthnProxyEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:19) | DEV-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setWebauthnProxyEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:20) | DEV-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getUpdateStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:21) | UI-11, OPS-09 | mapped | 更新渠道、空闲安装、强制最低版本均纳入 |
| [checkForUpdates](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:22) | UI-11, OPS-09 | mapped | 更新渠道、空闲安装、强制最低版本均纳入 |
| [setUpdateTrack](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:23) | UI-11, OPS-09 | mapped | 更新渠道、空闲安装、强制最低版本均纳入 |
| [quitAndInstallUpdate](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:24) | UI-11, OPS-09 | mapped | 更新渠道、空闲安装、强制最低版本均纳入 |
| [setAutoUpdateWhenIdleOptIn](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:25) | UI-11, OPS-09 | mapped | 更新渠道、空闲安装、强制最低版本均纳入 |
| [getBoxMigrationStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:26) | CPU-11, CPU-12, CPU-13 | mapped | 实现等价行为；不要求沿用原接口名 |
| [markDeepLinksReady](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:27) | MOB-12, UI-01 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getOnboardingSeen](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:28) | ACC-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setOnboardingSeen](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:29) | ACC-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getTimeZone](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:30) | AUT-03, UI-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setTimeZoneOverride](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:31) | AUT-03, UI-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAutoReviewInstructions](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:32) | APR-01, APR-03, ADM-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setAutoReviewInstructions](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:33) | APR-01, APR-03, ADM-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getLocalToolPermission](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:34) | DEV-01, DEV-02, DEV-03, APR-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getLocalToolPermissionCeiling](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:35) | DEV-01, DEV-02, DEV-03, APR-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setLocalToolPermission](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:36) | DEV-01, DEV-02, DEV-03, APR-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [recordLocalToolApproval](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:37) | DEV-01, DEV-02, DEV-03, APR-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [clearLocalToolApprovals](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:38) | DEV-01, DEV-02, DEV-03, APR-15 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getSidebarCollapsed](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:39) | UI-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setSidebarCollapsed](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:40) | UI-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [pickAvatarSource](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:41) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [pickAvatarFile](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:42) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [generateAgentAvatarImage](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:43) | BOT-02 | mapped | 实现等价行为；不要求沿用原接口名 |
| [resolveAttachmentMedia](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:44) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [readAttachmentText](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:45) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [readAttachmentBytes](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:46) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [stageAttachmentBytes](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:47) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [downloadAttachment](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:48) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [commitStagedAttachments](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:49) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [discardStagedAttachment](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:50) | FIL-01, FIL-02, FIL-03, FIL-04, FIL-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [forceRecreateComputer](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:51) | CPU-11, CPU-12, CPU-13 | mapped | 实现等价行为；不要求沿用原接口名 |
| [updateComputer](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:52) | CPU-11, CPU-12, CPU-13 | mapped | 实现等价行为；不要求沿用原接口名 |
| [forceReconnectGateway](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:53) | UI-09, CPU-09 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getExperimentsSnapshot](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:54) | UI-12, OPS-08 | internal | 诊断/开发开关，按管理员或开发模式约束；不作为普通用户必须出现的产品入口 |
| [applyFeatureFlagOverride](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:55) | UI-12, OPS-08 | internal | 诊断/开发开关，按管理员或开发模式约束；不作为普通用户必须出现的产品入口 |
| [refreshFeatureFlags](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:56) | UI-12, OPS-08 | internal | 诊断/开发开关，按管理员或开发模式约束；不作为普通用户必须出现的产品入口 |
| [startRpcTraceWindow](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:57) | UI-12, OPS-08 | internal | 诊断/开发开关，按管理员或开发模式约束；不作为普通用户必须出现的产品入口 |
| [getAgentDefaultModel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:58) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [setAgentDefaultModel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:59) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [getComputerUseModel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:60) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [setComputerUseModel](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:61) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [getHostPinnedAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:62) | BOT-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setHostPinnedAgents](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:63) | BOT-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getHostSidebarSections](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:64) | BOT-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setHostSidebarSections](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:65) | BOT-06 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getAvailableModels](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:66) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [getInferenceRouter](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:67) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [setInferenceRouter](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:68) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [getBoxRuntime](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:69) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [setBoxRuntime](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:70) | ACC-09, DEV-08 | reconstruction_or_unverified | 含重建项目模型路由/本地 Docker 扩展；不能据此声称官方有相同设置。当前原版的模型/Local Bot 路径另核实 |
| [transcribeAudio](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:71) | VOC-01 | mapped | 只能证明听写接口，实时通话另建 |
| [getCursorAuthStatus](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:72) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [loginCursor](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:73) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [cancelCursorLogin](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:74) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [logoutCursor](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:75) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [updateCursorAccountName](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:76) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [getCursorAvatar](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:77) | ACC-01, ACC-03, ACC-04 | mapped | 映射 Cmb 身份与资料，不调用假的官方订阅身份 |
| [getCursorWeeklyUsage](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:78) | ADM-20, ACC-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getCursorUsageSummary](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:79) | ADM-20, ACC-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getCursorPrReviewPreferences](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:80) | ACC-09 | internal_or_shared | 共用账户偏好接口；需检查真实 UI/调用者，不能因名称存在把整个 Cursor PR Review 列为 Bot 功能 |
| [getCursorPrivacyModeEnabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:81) | APR-14, ADM-22 | mapped | 继承账户隐私属性并影响授权/placement；不是跨成员数据读取许可 |
| [getSandAccess](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:82) | ACC-05, ACC-08 | mapped | 映射 Cmb 开通/用量/停用；商业购买属于显式适配 |
| [getSandAccessFresh](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:83) | ACC-05, ACC-08 | mapped | 映射 Cmb 开通/用量/停用；商业购买属于显式适配 |
| [invokeCursorDashboardAction](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:84) | ACC-05, ACC-08 | mapped | 映射 Cmb 开通/用量/停用；商业购买属于显式适配 |
| [cancelCursorSandTrial](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:85) | ACC-05, ACC-08 | mapped | 映射 Cmb 开通/用量/停用；商业购买属于显式适配 |
| [reportAgentLoad](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:86) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportAccessBlocked](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:87) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportAgentsUnreachable](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:88) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportRecoveryAction](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:89) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportRebuildLifecycle](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:90) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportReconciliation](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:91) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportBoxVisibility](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:92) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportSendLatency](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:93) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportSendAck](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:94) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportReactionAck](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:95) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportRenderTtfr](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:96) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportRenderStream](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:97) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportVncSession](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:98) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportVncLiveness](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:99) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportOpenComputer](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:100) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportUpdatePrompt](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:101) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportSigninGate](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:102) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportOnboardingStep](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:103) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [reportClientFailure](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:104) | OPS-08, UI-12 | internal | 实现 Cmb 自有诊断/遥测，不连接原版私有采集服务 |
| [openCloudAgent](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:105) | COL-12, OBS-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getLinkMetadata](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:106) | FIL-08 | mapped | 实现等价行为；不要求沿用原接口名 |
| [listSecrets](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:107) | APR-10, APR-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [revealSecret](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:108) | APR-11 | superseded_or_unverified | 旧接口与当前只写秘密帮助冲突；当前产品不暴露读取旧值，按版本差异处理 |
| [upsertSecrets](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:109) | APR-10, APR-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [removeSecrets](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:110) | APR-10, APR-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [getMcpState](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:111) | PLG-01, PLG-09 | mapped | 包含团队热门排序与图标降级，不只列工具名 |
| [getEffectivePlugins](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:112) | PLG-01, PLG-09 | mapped | 包含团队热门排序与图标降级，不只列工具名 |
| [getMcpCatalog](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:113) | PLG-01, PLG-09 | mapped | 包含团队热门排序与图标降级，不只列工具名 |
| [getMcpTeamPopularity](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:114) | PLG-01, PLG-09 | mapped | 包含团队热门排序与图标降级，不只列工具名 |
| [getMcpPluginLogo](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:115) | PLG-01, PLG-09 | mapped | 包含团队热门排序与图标降级，不只列工具名 |
| [installEntry](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:116) | PLG-01, PLG-08, PLG-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [updatePluginInstall](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:117) | PLG-01, PLG-08, PLG-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [removeMcpServer](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:118) | PLG-01, PLG-08, PLG-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [uninstallPlugin](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:119) | PLG-01, PLG-08, PLG-11 | mapped | 实现等价行为；不要求沿用原接口名 |
| [authenticateMcpServer](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:120) | PLG-02, PLG-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [renameMcpAccount](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:121) | PLG-02, PLG-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [removeMcpAccount](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:122) | PLG-02, PLG-04 | mapped | 实现等价行为；不要求沿用原接口名 |
| [setMcpCustomInstructions](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:123) | PLG-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [listMcpServerTools](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:124) | PLG-05 | mapped | 实现等价行为；不要求沿用原接口名 |
| [toggleMcpToolDisabled](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:125) | PLG-05 | mapped | 实现等价行为；不要求沿用原接口名 |

## 4. 实际工具组装比总枚举更重要

依据 GR17 的 `buildTurnTools`，以下是需要保留的约束。`packages/agent/tools/all-tools.ts` 包含其他产品共用工具，不能据此把所有工具当作 Grok Bot 已提供功能。

| 工具族 | 读到的运行条件 | Cmb 实现归属 |
| --- | --- | --- |
| 子任务与并行待办 | 主 Bot、配置与功能开关；子任务权限继承有边界 | M02 / COL-11、COL-12 |
| 向用户/同级 Bot 发消息、表情、创建/改 Bot | 主 Bot；同级消息异步，不能等待轮询回复；工具没有删除 Bot 能力 | M01/M05 / BOT、COL |
| 状态更新 | 主 Bot 且未覆盖系统提示的条件分支 | M02/M06 / MEM、MSG-10 |
| 用户本机 Shell/读取/后台等待 | 非 box-scoped 子任务，并附本地工具 scope | M19 / DEV-01～03 |
| 云端电脑 Shell/读取/后台等待 | 远程电脑可用；后台等待和传文件还有子任务范围检查 | M04/M11 / CPU-05、FIL、DEV |
| 网页搜索/抓取 | 非 box-scoped 子任务，受实际 provider 能力约束 | M02/M09 / CPU-04、PLG |
| 图像生成 | 主 Bot 且有实际 provider；协议存在不保证账号可用 | M02 / OBS-08 |
| 云端代码代理 | 非 box-scoped，并检查团队是否禁用 | M02/M15 / COL-12、ADM-04 |
| 低层电脑操作 | Computer-use 专项子任务、电脑有桌面且可用 | M02/M04 / CPU-04、CPU-07 |
| 语义浏览器操作 | Browser-use 专项子任务、电脑有桌面且可用 | M02/M04 / CPU-04、CPU-07 |
| 截图和请求用户接管 | 主 Bot、电脑有桌面且可用 | M04/M10 / CPU-06～08 |
| 复制到/从用户本机 | 电脑可用及本地授权；不是直接放开任意文件路径 | M11/M19 / DEV-03 |
| MCP 搜索/调用 | 有当轮 MCP 投影或动态注册表；仅有 factory 不算服务可用 | M09 / PLG-05～10 |
| 插件管理、子任务检查/追问/停止 | 主 Bot，并有真实管理控制器 | M02/M09 / COL-11、PLG |
| 共享房间 | 最后按房间 allowlist 过滤；可收紧为仅发文字 | M05 / OBS-01 |
| 动态工具发现 | 主 Bot、非 shared-room、非 box-scoped 且开关开启 | M02/M09 / PLG-10 |

Cmb 建议保留“主 Bot 负责目标与协作，ComputerWorker/BrowserWorker 负责限定屏幕/页面执行”的分工，用现有 worker 能力和 ComputerPort 实现；向模型暴露的工具集由运行上下文生成，不能用一条提示词要求模型自觉不用其他工具。每次执行仍须经过网关的权限和控制权校验。

Bot 同级优先消息在原实现只用于一对一、可中断非用户工作；群聊忽略该优先标记。Cmb 的调度应保留这个边界，不让任意 peer 消息打断用户主任务。用户删除 Bot 与模型工具权限也应分别处理。

还需在实施中将本表的每个方法沿处理函数、持久化、副作用、UI 回调追到最终行为，记录是否完整、待补或受开关限制。当前表已完成静态范围追踪；没有把这个后续实现审计伪装成已完成。

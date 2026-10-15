# Astra：专家优先首版（2026-10-15）

用户指定 `gpt-6-astra` 只读设计，代理 `/root/astra_mvp_expert_design` 已完成；root审核并负责实现。本记录为设计，不是验收。

## 采纳方案

1. 主界面只保留专家、任务、本地状态；新专家默认支持人工确认的长期记忆。创建不授权/启用节点；“启用本机”明确确认后内部复用 observe → authorize → enable。旧连接、Group绑定与原始ID折叠至高级。
2. 专家等于已有Bot，记忆键 `(spaceId,botId)`，复用当前maintainer读写权限。不新增专家实体/权限平台。新记忆仅manual，暂不把task/result私有来源直接提升为跨团队共享专家知识。保存处明确共享范围。
3. V7增加专家记忆三表、Group采用专家记忆的无正文标志表、Run的memory_scope。旧行默认group；新建专家的可恢复创建链显式采用bot记忆，旧Group须明确切换，不复制/删除原资料。采用需当前Group admin和Bot maintainer、当前单专家与预期版本匹配。
4. scope在enqueue持久化、内容在首次start冻结；复用既有snapshot表。旧Run按group，bot快照显式scope/botId；start/renew/settle/inspect不依据最新采用开关改变历史。保留revision变化终态MEMORY_CHANGED及不自动重跑。统一Group→Bot锁序，专家写只锁Bot、不再回头锁Group。
5. 默认目录在getCmbCoworkAgentDataRoot下，按服务/身份/space/Bot稳定标识hash隔离。metadata.json、memory-cache.json和runtime/；私有权限、拒绝symlink、原子替换。已有显式工作区不覆盖。目录不是源码授权，当前零工具。
6. MySQL唯一权威；有界JSON缓存用于App维护检索，可丢弃重建。缓存不进入执行输入，离线不显示未验证权限的缓存正文、不写回排队、不离线运行。全量替换避免停用遗漏。100存储/10活跃/512字符约束下不引入向量库/ES/新SQLite库。

## 必验

同专家跨已采用容器复用、不同专家/空间隔离；当前维护者与重放权限；manual来源闭合；旧Group不自动迁移与旧queued/running/history保持；新Run固定scope/快照与在途变更；创建/采用失回执恢复；目录稳定/隔离/symlink拒绝；主流程无选目录/Group/版本术语且不自动启用；真实模拟模型闭环保持零工具。旧A8断言保留为兼容回归，不删断言冒充通过。

## 本轮不做

自动学习、旧团队资料自动提升、源码读取、真实模型/招乎、内网网关合并、云Runtime、向量检索和新权限平台。无须为上述最小方案再次阻塞用户征询；自动分享旧资料、扩权或真实调用才需要新决定。原启动脚本生命周期WIP另记，不顺手重构。

## 实施后只读复核

Astra再次只读源码，确认scope冻结、旧SQLite指纹兼容、双scope校验、Bot父锁及缓存不参与执行的设计一致。发现一个阻断：公共getBot本身要求maintainer，不能在Group管理员连接时用它取名称；建议私有采用状态接口在当前Group管理员/单专家绑定检查后只返回adopted、botName、canManage，不扩大公共Bot权限。并要求记忆维护读取失败不阻断独立授权的任务结果刷新。root已按这两条修正并新增对应测试，测试结果另见attempt/acceptance；Astra未运行测试，不冒充其独立执行结果。

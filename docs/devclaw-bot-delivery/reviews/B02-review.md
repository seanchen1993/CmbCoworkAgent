# B02 最小任务切片审查

2026-10-07；范围只限 tasks/B02.md v1 四接口。待完整候选、主代理独立验证及集成；以下小步不等同最终验收。

- 已读 a61ba5c2 生成器/双来源离线边界和 3d3f81b4 消费测试；原六操作断言保留，新闭包仅 Task/Stage/Event，不扩 Run/Upload。
- worker50816 构建 exit0/closed、32JUnit和1884 Java/Ajv零差异；main c7bb12 实际六XML确认32/零失败。首10658的三旧假设失败如实保留，未掩盖。主代理完整独立构建尚待。
- 已读816da293的Task应用、SQL存储、HTTP必要窄扩、固定V1/V2 readiness、V2增量与测试。阶段保存在Task payload；无阶段表/引擎、Runtime或执行派发。
- 草稿重复事件表已按主代理建议删除，活动直接写已有事务Outbox三nullable列，旧记录保持NULL；V1不改、无FK。
- 草稿旧操作回执授权传null JDBC的问题已窄修为真实同事务Connection；新旧commandId双向409与撤权403仍须真库验证。
- Task写锁顺序是command_scope→空间head→Group→Task，snapshot/head在同一事务，游标分页推进扫描水位并按当前Group权限过滤；实际并发/重启/回滚及V1升级证据未齐，不提前接受。
- 后续按任务单做两隔离数据库 task-check、受影响生命周期及主代理独立验收；不重演无关B01完整矩阵，不自动进入后续路线。定时续跑仍PAUSED。

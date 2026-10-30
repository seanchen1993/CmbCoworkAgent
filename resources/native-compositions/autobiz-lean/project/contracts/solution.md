# 设计与实施方案契约

从已确认的定义与本阶段真实设计形成最小交付闭环。Solution.json={feature,design:设计正文,designLock:锁对象,plan:计划根对象,batches:{BNNN:批次对象}}，字段为原生对象。文档或单批次JSON文本≤20000 UTF-8字节，整个产物≤131072字节。下文plan.json/批次文件指对应plan/batches逻辑对象，不要求创建散文件。业务范围、来源与UI范围继承上游，不另写旧state/checkpoint。

根plan.json字段：featureId、implementationScope、taskSetStatus="finalized"、status="todo"；batchPolicy={strategy:"minimal_closed_delivery_v2",maxTasks:3}；taskValidationPolicy={mode:"defer_to_test_stages",orchestration:"inline",codeGate:"review_only",maxTestStageRepairAttempts:3}；batches与parallelBatchPipeline。根没有tasks/version/taskDetailVersion，初稿不预填运行时间或完成证据。

batches每项包含id=BNNN、path=plans/BNNN/plan.json、title、executionLane、workspaceRef、specRoots、deps、taskIds、deliveryKind、status。任务ID=TNNN且全任务唯一；deps是批次ID数组，引用存在、无环、依赖排前。taskIds与对应批次任务顺序完全一致。

每份批次计划含featureId、batchId、title、executionLane、status="todo"、deliveryKind、taskCount、completedTaskCount=0、completionEvidenceIds=[]、tasks。根条目与批次各共同字段一致，taskCount为真实tasks长度。

每个任务含id、title、goal、status="todo"、executionMode、workspaceRef、deps、specRefs、designRefs、apiIds、dataIds、decisionIds、scope、implementationPoints、testPoints、verificationIntent、acceptanceCriteria、completionPolicy、validationBoundary、nonGoals。证据数组初始空、blockers如实、expectedFiles是计划生产文件（非完成证据）。goal/verificationIntent/validationBoundary为明确文本，implementationPoints/testPoints/nonGoals为字符串数组。deps为任务ID数组；跨批依赖同时映射到根批deps，不允许未定义或环。

格式与执行范围：executionMode为code/verified_existing/external_dependency；executionLane为backend/frontend；deliveryKind为single_task/atomic_group；code的completionPolicy=all_required_validations_pass。external_dependency须externalDependency={system,owner,trackingRefs:[...]}及completionPolicy=external_dependency_recorded，其他模式不含externalDependency。本切片执行器只支持backend_only、backend、code和uiRequired:false，最多8批每批≤3任务。超出能力要明确阻断并保留实际需求；inline不是executionMode，不能自造枚举。

单任务默认single_task，根/批不写atomicGroupId/batchRationale且任务不写atomicGroup。2—3个任务只有不可分交付闭环才用atomic_group；根/批同一AG加三位数字（例如AG001），batchRationale≥10字符，每任务atomicGroup={id:同ID,rationale:≥10字符}。同批不能混仓/混lane，不能靠分批绕过真正原子闭环。

scope必含modules/entrypoints/pages/dataObjects字符串数组，无适用项=[]。paths非空时声明workspaceRoots。default仓使用workspaceRoots:{default:"."}，paths为仓内相对路径；多仓只用包已声明且已配置授权的ID，workspaceRoots只有该ID对应仓内相对根，paths为仓库ID:相对路径，不重复根前缀。绝对路径/..不是授权。backend任务scope.pages=[]，不伪造UI引用。

specRefs含实际REQ和逐个SCN完整路径，不用范围或裸编号。覆盖已确认范围全部场景。designRefs从真实design.md的实际决策/章节取得，apiIds/dataIds/decisionIds与锁中定义一致。acceptanceCriteria为非空对象数组，每项{id:"AC-T001-01",text:可观察结果,scenarioRefs:[完整SCN路径]}，id属于当前任务且唯一（后缀2—3位数字）；scenarioRefs非空且必须已在本任务specRefs，不能混REQ。测试要覆盖验收、边界与失败情况，不写以后补测。

parallelBatchPipeline通过包内tools/solution-pipeline.py从实际Solution.json确定性派生后写回根索引。其schemaVersion=autobiz.parallel.pipeline.v1、deliveryStages=[prepare,implement,review,test]；每批REVIEW-BNNN属于review，每个非external_dependency任务UTEST-TNNN属于所属批test；唯一合并后验证V-E2E，finalization={mode:"evidence_aggregate_only",forbidPostMergeDuplicateExecution:true}。planRevision以原规范化投影计算，不能对整个bundle哈希或填占位。helper不补业务事实、验证、执行或批准；原业务规则仍检查完整上下游。

设计正文必须含 Context / 输入上下文、Code Evidence、Spec Traceability、API Decisions、Data Decisions、Technical Design、Risks / Open Questions 七章。逐REQ/SCN覆盖，证据指真实代码或明确新项目假设；验证思路必须可证伪。API-NNN/DATA-NNN/D-NNN定义独占表格首列且唯一，DEC-NNN来自提案。x-auto-no-http-api: true/false和x-auto-no-sql: true/false各独占一行，与实际定义一致，不以空声明删真实接口/数据。不得残留模板指导、待确认/读码差异单元。tools/design-lock.py以{feature,lockedAt,design}输入，输出designLock对象；改正文后重算真实UTF-8哈希。重大争议交用户决定，未知项如实标识；Host对整个方案版本批准。

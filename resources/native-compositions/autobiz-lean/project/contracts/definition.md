# 需求与验收定义契约

Definition.json直接包含{feature,baselineSha256,requirementIds,requirementCoverage,baselineDecisions,decisionCoverage,requirements:[已接受基线要求文本],prd:PRD正文,scope:范围对象,ui:UI对象,sourceContext?:来源对象,sourceTexts?:{快照相对路径:文本},proposal:提案正文,specs:{能力名:规格正文}}。JSON字段是原生对象，不要双重序列化。整个产物≤131072 UTF-8字节；每段文档正文仍≤20000字节。下文旧文件名指这些对应字段，并不要求另建文件。

先读已由Host接受的RequestBaseline.json。baselineSha256是该文件完整原始UTF-8字节SHA，requirementIds和requirements分别逐项等于基线requirements的id和text；不能重排、改写或同步删掉基线要求。requirementCoverage是以全部USR-NNN为键的对象，每个值是实际规格引用数组，至少含一个完整REQ及一个SCN引用，例如specs/order-query/spec.md#REQ-001与#SCN-001。引用必须真实存在且不重复。这只证明结构追踪，不能用无关场景填表冒充语义覆盖。若基线错误，返回基线修订并重新接受，不能在本阶段改上游。

PRD逐条保留requirements原文及“来源：Definition.json.requirements”，包含“## 当前实现范围”“## 外部资料与实现约束”。范围来源与需要裁定的事项必须真实确认，不能只删除待确认标记。

baselineDecisions必须逐项完整等于基线decisions，包括ID、原文、关联requirementIds和顺序，不能因没有复制到需求正文就丢失已确认的范围或澄清。decisionCoverage以全部DECISION-NNN为键，值为实际规格引用数组；引用不重复，且必须属于该决定关联需求的requirementCoverage并集。每个关联需求都须在本决定的引用中同时覆盖其至少一个REQ及SCN。无基线决定时两字段分别为[]和{}。批次作者、独立评审、测试及最终E2E须保留这些决定原文与映射；结构追踪不替代语义覆盖审查。

IMPLEMENTATION_SCOPE.json={featureId,implementationScope,source}，scope为full_stack/backend_only/frontend_only，source为真实决策来源。当前Code只执行backend_only；不能因执行能力限制更改需求范围。

外部资料确实不存在时，来源章节正文只写“无”，不创建source-context。存在资料时用完整表头 | ID | 类型 | 名称 | 地址/路径 | 约束范围 | 状态 |，SRC-NNN任务内唯一。source-context={version:1,sources:[{id,name,availability,readStatus,freshness,path}]}。availability仅live/snapshot_only/never_provided；readStatus仅complete/partial/unreadable；freshness仅current/stale/unknown。有资料时path指向sourceTexts中实际sources/SRC-NNN/<ASCII文件名>快照，ID集合与PRD完全一致，不能把URL/本机路径当快照。never_provided不编造path/快照，登记unreadable/unknown并请求提供、解除依赖或等待；警告不等于资料已读或依赖解除。快照必须获准可分发，不保存凭据，不截断后宣称完整。

UI_CONTEXT顶层：version:1、featureId、布尔uiRequired、decisionStatus、pages/interactions/visualSources/capabilities四个对象数组。decisionStatus仅defaulted/confirmed/locked；本阶段实际确认范围并完成全部规格引用后用locked。可选decisionSource仅user_confirmed/prd_inferred/default_false/legacy_import，按事实填写；checkpoint字段不是Host批准凭据。

- 无UI：真实notApplicableReason，四数组可空，不能以没有前端代码推断无UI。
- pages：pageId=PAGE-NNN，name/goal非空；可选routeHint非空、states字符串数组。
- interactions：interactionId=UIX-NNN，pageId已定义，summary非空；可选stateRefs/specRefs字符串数组。
- visualSources：sourceId=VIS-NNN，type为high_fidelity_html/standard_html/design_link/prototype_link/image/other，path真实；可选route为spec-driven-ui/absolute-html/standard-html/missing-html、布尔required、真实contentSha256/bundleSha256。不能填none或占位哈希。
- capabilities：capabilityId为kebab-case；pageRefs和interactionRefs必为字符串数组；可选uiRequired、visualSourceRefs、specRefs。规格locked时每项specRefs同时含实际REQ与SCN完整路径。本阶段只填实际已完成规格中的引用。

各类ID唯一、引用可解析。有UI时pages/interactions/capabilities至少一项非空；locked时至少一个capability未声明uiRequired=false。无UI不能有uiRequired=true的capability。required视觉来源的声明哈希必须真实；锁定后应被capability引用。任何来源缺口、范围冲突或业务不确定性均须明示，不能为过检查删需求。

proposal的 ## Capabilities 用 - kebab-case: 说明 列能力，与specs键完全对应。## Decision Log用 ### DEC-NNN: 名称 定义真实决策。每份规格用 ### Requirement REQ-NNN: 名称 及其下 #### Scenario SCN-NNN: 名称，全任务唯一，覆盖角色、权限、正常/边界/失败与可观察预期。UI specRefs使用 specs/<能力>/spec.md#REQ-NNN 和 #SCN-NNN（逻辑引用，不要求另建散文件）。

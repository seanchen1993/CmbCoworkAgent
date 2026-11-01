# 需求基线契约

RequestBaseline.json是需求整理成果，经Host真实resultApproval接受后作为后续固定输入。它不是由模型自报的确认凭据。整个文件≤131072 UTF-8字节。

对象只有feature、request、requirements、decisions四个字段。

- request={protocol:"devclaw.project-goal/v1",projectId,text,bytes,sha256}。projectId取当前Host阶段上下文；text取最初用户任务的完整原始正文，保留换行和空白，不包含其后追加的CMBDEVCLAW-SKILL-USE-V1执行包装或后续澄清消息。bytes和sha256按原文真实UTF-8字节计算。允许将眼前原文逐字复制到工作区临时文件用于计算，副本只是计算媒介；不得用模型改写摘要、截断文本或自造文件替代Host原始来源，也不得扫描应用内部数据库、运行快照或请求日志寻找来源。真实后续澄清写入decisions，不拼入request.text。Host只向检查器注入独立的protocol/projectId/bytes/sha256，检查器据此验证全文真实性。
- requirements是1—128项对象数组，每项{id:"USR-001",text:"完整、可理解的需求",sourceQuote:"原始请求中的真实原文片段"}。ID全局唯一，text非空且≤4000 UTF-8字节，sourceQuote必须是request.text中非空的逐字片段。按稳定顺序保留已确认要求，不为了可实现性删掉性能、权限、失败路径等困难约束。引用真实只证明来源存在，不能证明提炼完整。
- decisions是对象数组，可为空。每项{id:"DECISION-001",text:"实际范围/澄清决定及未决情况",requirementIds:["USR-001"]}。ID唯一，引用实际需求ID；不得用这张表伪造用户回答。需要裁定时先取得真实反馈，供用户在Host接受界面复核。

不增加confirmed/approved字段。原始目标与基线需要修改时，通过明确的基线修订和真实接受处理，保留来源；后续阶段不能在检查失败时顺便重写它。基线确认后Definition.requirementIds和requirements须逐项等于本文件的ID和text，baselineDecisions完整镜像decisions，并以decisionCoverage映射关联需求的真实REQ/SCN，同时绑定本文件原始字节SHA。语义遗漏依靠用户基线接受及后续业务审查，不能声称结构检查已证明任意需求完整性。

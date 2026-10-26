# 原生设计回检方法

以下专业检查依据原 skills/references/review-protocol-design.md。输入材料从Host固定的
PRD/SPECS/DESIGN bundle中取得；缺少规格、proposal或design即阻断。执行和审批属于Host。

逐项核查技术选择是否合理、规格是否完全覆盖（逐REQ/SCN）、验证思路是否可证伪、
引用与事实是否相符（Code Evidence与真实代码一致，REQ/SCN/DEC在上游定义）。
不要因未列实现步骤或测试命令而拒绝设计，这些在代码实现阶段才有可靠上下文。

仅报告有证据的Critical/Major Findings；无证据的问题列入Open Questions。
总评ACCEPT不能替代逐项处理。发现问题后先验证原文，再修复或请求用户作业务取舍。
不要为消除问题删除必要需求范围。人工批准由Host绑定最终成果版本，不由模型自报。

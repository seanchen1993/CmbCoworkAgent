---
name: autobiz-native-code
description: 通过原生workflow、真实业务动作和受控工作树执行已确认计划。
---

本阶段读取本任务真实 NORMALIZED_REQUIREMENTS.json、PRD.bundle.json、SPECS.bundle.json、DESIGN.bundle.json、PLAN.bundle.json。Code只支持backend_only与code类型任务。default指当前项目Git仓库；其他workspaceRef必须由保存包的executionResources.workspaces声明，并通过原配置入口绑定已批准的Git目录。不能把模型输入的绝对路径当授权，未声明仓库在任何代码写入前拒绝。外部依赖或不支持生产编译类型必须报告具体阻断，禁止删除计划需求以通过。

从保存的包资源读取 workflows/native-code.workflow.js 的完整原文，通过当前任务已有 workflow 工具 start 执行原文，不改写脚本、不以agent假称完成workflow。args.rulesProvider取当前devclaw.project-actions.lock.json中code.business的真实ref，移除actionId后传入。该ref是依赖身份，不能自行安装、批准、替换digest或填占位。

本阶段在已冻结声明 executionMode=workflow 下运行。workflow start 返回 launched/runId 时，当前模型轮应结束，不循环轮询、不重新 start、不提前写 CODE_RESULT。原 Host 会等待该工作流真实物理结算，在同一阶段、同一会话及原来源下提交结果通知，再由结果模型轮核对实际结果并完成本阶段产物；通知文本不是成功证明。用户输入在原输入请求中提交，结果不明时保留原 runId 核对，不改用其他会话或新工作流冒充续接。

每个仓库按计划依赖串行执行，批次与任务的workspaceRef必须相同，同仓后续批次复用原工作树。仓间依赖表示实现顺序，不授予跨仓文件访问，不承诺并行合并列车或跨仓原子提交。各仓封存后分别请求原生合并确认，最终编译/E2E由verificationResource在该仓实际integrationCommit执行一次；任何仓失败或未知，整个Code均不能报告成功。跨仓系统级联调需要明确的测试资产与授权执行能力，不能用单仓测试冒充。

Git工作区必须已有授权且洁净；Host产物的忽略/跟踪策略由用户明确配置。不能自动添加.gitignore、提交用户原有改动或强行清理工作树。脚本内部阶段是实现→生产编译→独立评审→独立测试→封存→原生人工合并确认→最终E2E。业务命令执行由真实action记录，UI或模型文字不能代替回执。结果不明必须核对原run/原resource，不能另建run/worktree重派相同副作用。

只有原workflow返回已完成且报告成功，才写 CODE_RESULT.json={"feature":"实际feature","runId":"原workflow返回的实际runId"}。失败、等待确认、取消、未知、测试失败不能写成功选择。保持原runId以便通过公共inspect核对。Host 的后续阶段使用 native.project-runtime 的 inspect-workflow-evidence 只读核验本项目已接受阶段的原工作流；不能用后续阶段自己的 thread 查询冒充 Code 的原记录。检查器会读取原run脚本digest、原平台action回执、实际Git资源状态和当前计划，不信任手写测试结果。

合并确认和Host成果接受是两个独立决策：合并由worktree公共接口请求人工确认；CODE_RESULT检查通过后Host还会要求本阶段成果接受。不得把其中一个确认冒充另一个。

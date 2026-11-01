# 第二阶段验证记录：页面、MCP、子任务

状态：三项能力完成，两位全新 medium agent 的运行隔离与界面贯通回检均通过；集中回归发现的失败已修，冻结后联合复跑 11 文件 119/119 通过，无剩余阻断。本文不代表第三阶段集中真实模型验收完成。

## 方案审查与范围

[具体方案](mods-capabilities-phase2-plan-2026-11-01.md) 已由 architecture_review、delivery_review 两位 agent 独立通读并通过，之后才开始实现。

本次能力面向普通本地父聊天。平台复用既有 Function 授权、MCP 来源选择与配置、原生子任务执行器和只读查看；无 AutoBiz 业务分支，无第二套项目模式创建、配置、需求或执行页面，无多模态新增。应用与锁文件根版本保持 2.0.0；没有构建打包或触发 Actions。

## 已接通的链路

- `ui.place({id})` 创建真实瞬态 `Placed` 行，经现有安全绘图与动作机制交互；按宿主真实消息锚点放置，后续消息接在它后面。不同插件隔离，同插件同 id 更新原位置；关闭、撤权、源变与成功压缩提交清理。普通 turn 结束不误清，不写模型上下文、聊天转录或持久历史。
- `mcp.list/connect/call/status/disconnect` 使用当前明确选择、摘要匹配的宿主管理来源，每来源独立连接、不初始化全局池；连接令牌限定调用者，过期不回退全局。取消和断开核对真实 transport 清理，未确认保留 unknown。原 Claw 设置显示实际状态并提供取消/断开及配置入口，查询不自动连接。
- `agent.status/messages/stop` 沿原 `agent.register/spawn` 管理真实子任务。main-only 归属绑定来源/版本、父子线程 incarnation、目录与运行实例；运行结束仍释放 runtime/checkpointer/ACL/lease，保留可读的真实 checkpoint 证据。停止请求不等于任务已停止，重启不自动恢复。
- `ui.view` 仅真实且已校验的用户界面动作可请求，复用原只读分栏；不改变原聊天输入目标和草稿。导航回执为请求已接受，不冒称 renderer 已绘制，也不宣称上游完整输入重定向兼容。

## 已确认的边界

1. 新增 MCP 主动连接本轮开放 stdio；HTTP/SSE 明确拒绝新 connect，既有已配置服务的原调用链保留。插件不能提交 URL/command/env/headers 或获取原始凭据。隐式 all 不等于新连接授权。
2. Placed 没有任意 DOM/CSS、项目/worker/child 挂载、跨聊天滚动或持久恢复；`ui.scroll` 不冒充支持 Placed。页面、侧栏、工具栏等继续沿用已有入口。
3. 子任务查看是保留 checkpoint 的文字和工具记录投影，压缩前历史可能不在当前 checkpoint；有缺失明确标 partial/unavailable，不以结果摘要补造。单条过大或不能精确投影时明确计数并推进游标，后续仍可读。
4. 本阶段的真实宿主/协议验证与受控模型、IPC 界面夹具分开记录。第三阶段再集中执行真实模型创作、派生与组合验收，不把夹具结果当真实业务完成。

## 联调验证

已完成：

| 检查 | 结果 |
| --- | --- |
| checkpoint 原文分页与既有读取回归 | 39/39；包含真实 worker、inline/external 总量超过 1 MiB、跨页工具原文、超大单条后继续、过期 checkpoint 拒绝 |
| 创造者按需发现、三能力组合类型检查、SDK 目录与实际曝光一致 | 原 41 项通过；另补真实 MCP query 示例的类型校验，新跨能力文件 18/18；含完整响应小于 8K 的限制 |
| 权限分组和用途说明 | 15/15；只改已有批准说明，不新增批准入口 |
| 原生流式消息识别 | checkpoint/transcript 22/22；实际 AIMessageChunk/HumanMessageChunk/ToolMessageChunk 持久化后仍可读取，不丢助手正文 |
| 页面主链及原绘图回归 | C 的 7 文件 47/47；浏览器 5 段通过，真实 Virtuoso/完整 renderer CSS，375px 控件可达 |
| MCP 主链 | A 最终 23/23，加真实 stdio→原权限/Hook 链 1/1；浏览器通过取消、断开、精确来源导航、无重挂账号/incarnation 切换与迟到响应 |
| 子任务主链 | B 核心 81/81；原生宿主+受控 HTTP provider+实际 read_file+真实 checkpoint worker 集成 1/1；只读界面与双 child 迟到隔离通过 |
| 独立 runtime medium 回检 | 75/75，通过；发现并修复旧 development-agent-lifetime 夹具遗漏 DB mock 的 3 项回归，未放松生产检查；作者再跑相关原测试 33/33 |
| 独立 UX medium 回检 | 三套新浏览器全过；4 文件 30/30；原项目 native-feature-original-flow 两段通过；实际核对 375px 截图与主接线，无阻断 |
| 候选预检连续性补修 | 集中回归发现空 Placed 清理误发界面通知；只修空集合不通知，保留原断言，development-manager 全 42 项与 Placed 9 项合计 51/51 通过；medium 再审并独立复跑 Placed 9/9 通过 |
| 试用子任务查看的跨调用授权 | 真实 authorized-real 生命周期新增 3 项；相关 14/14，medium 独立 11/11。原 SDK 临时授权仍按调用失效，仅 native viewer 私有资源保留受控守卫；停用、源变、能力收窄后拒绝 |
| 原按钮跨重绘语义 | 相关 36/36，medium 独立 11/11；已接受的普通回调照常完成，旧画面的 ui.view 仍拒绝，未放宽原动作入场校验 |
| 创造者 MCP 未安装试用 | 真实 stage→approve→settled、编译、QuickJS、stdio，持久安装授权为 0；跨次状态读取、原设置查询与断开、停止清理及真实 PID 退出均通过；作者和 medium 各重跑该文件 2/2。来源解析与线程宿主为受控夹具，未额外扩大为试用 mcp.call 完整权限链验收 |
| 创造者卡片未安装试用 | 直接用实际 query 示例成包，经真实 compiler/typechecker/SDK scan→预检零展示→精确批准/轮次结算→用户指令放卡/真实 QuickJS 正文→停止清理；安装授权为空。与 Ask 校验回归共 12/12，medium 独立同 12/12 |
| 最终 Node/Web typecheck | 两项分别 exit 0，记录在 output/mods-capabilities-phase2/typecheck-*-final.log |
| 定向 lint | A/B/C 与 root 所改文件分别检查，无 ESLint errors；既有巨文件格式 warning 未通过全文件重排掩盖 |

## 原项目、模板及宽回归口径

原项目四个关键文件 `HarnessBoardView.tsx`、`NativeFeatureReview.tsx`、`native-harness.ts`、`service.ts` 的 SHA256 均与第一阶段基线一致。复核记录在 `output/mods-capabilities-phase2/original-project-files-after.json`。原入口及 Feature 浏览器回归由独立 UX agent 重跑通过。

已按仓库规范启动一次 `npm test`；该脚本进入旧 AutoBiz 五阶段整套业务夹具。为遵守用户“验证衔接，不再重跑整套业务实现”的任务标准，主动停止该重业务段，不宣称全量 npm test 通过，也不将主动停止计为平台失败。之后改跑 `parallel` 项目的 Mods/MCP/shared Mods、checkpoint、相关 DB 与权限说明集中回归，首轮为 622 文件通过、8 文件失败、9 文件跳过（7153 项通过、12 项失败、10 项跳过），日志为 `output/mods-capabilities-phase2/scoped-regression.log`。

首轮在修复前启动。发现的失败包括候选空卡片通知、按钮跨重绘、试用查看的临时授权、实际 MCP 示例、增加 Placed 后的精确组件匹配次数，以及 generic/Ask 两种布局约束的错误码断言。均已逐项修复或补全准确断言，未放宽生产校验。冻结后用独立进程将全部 8 个失败文件和相关新试用用例联合重跑：11 文件、119/119 通过，日志 `output/mods-capabilities-phase2/final-failed-files-recheck.log`。没有为单个修复再次重跑旧业务实现。

上述 `output/` 证据路径均相对于 `C:\ai\CmbCoworkAgent-mods-v2`，D 盘同步的是阅读文档。后续真实模型从零创作、派生与调整组合，以及开发者底座整理继续按第三阶段安排。

本轮为平台能力更新，D 盘项目模板不需要重做业务文件，仍通过原项目入口使用。`autobiz-lean-project.zip` 保持 SHA256 `13fa86aeec3d4771bfedf5a7c0ff1956d7de9cf812455aa4b163a463abac5999`；同步的只是本阶段说明与验收文档，不注入 AutoBiz 平台适配。

已同步 `D:\王博闻\AutoBiz-项目模式模板` 的第二阶段方案、验收、创作与试用说明及后续路线，并更新“先读我”的入口说明。更新前的两份通用指南保存在“参考文档”，插件目录及两份 ZIP 均未重写。

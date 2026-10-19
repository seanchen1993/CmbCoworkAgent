# M04 主对话与任务会话验收

状态：implementation_in_progress，尚未验收。2026-10-19。设计基线`247f1ec4`，设计检查点`9869da48`；原6.1-sol/xhigh为唯一产品写者，root独立审查和复验后才能集成。任务约定见`../tasks/M04-task-conversations.md`。

## 根本变化与检查重点

主对话处理交流、明确交办和向已有任务转达；具体任务拥有独立会话。任务回复为正常消息，不强制需求文档/成果版本/退回表单；完成与继续处理保持同一Task。专家自己的职责配置保留。主对话、任务会话与beta共用左侧导航、页头和聊天视觉；不接个人执行器或未实现附件能力。

以下是待验收条件，不是通过证据：

- 主对话普通问答不增加可见Task；一次明确交办得到真实任务卡和独立会话，主对话可继续使用。已有Task补充只生成一条关联消息和一次执行；目标歧义澄清。
- main/task角色、当前权限、白名单、来源Run和一次消费均核验；非法JSON/不在白名单/跨scope/伪造来源不得产生副作用。模型回复声称成功不替代命令回执。
- freeze包含本任务先前assistant和用户内容；主对话只读必要摘要和本会话，不混入其他任务/其他Bot定向消息。输入预算明确拒绝或保留可验证摘要，不静默截断。
- 原命令先持久，HTTP已提交回包丢失、本地写失败、物理重开均恢复原命令，不再次推理/创建Task。旧Run按旧profile恢复，unknown不重跑。
- 主对话停止与模型刚完成/协调待发的竞争要尊重停止意图；尚未提交的协调不继续交办，已提交/未知则恢复真实回执，不谎称已撤销。非法协调输出失败后下一轮仍可继续，不让坏JSON污染后续历史。
- 完成与补充/转达/claim/settle竞争不能误关闭；完成不依赖模型或节点在线。继续处理受控重开同Task且幂等，普通enqueue不能绕过completed。
- 原M03内容/意见/待处理动作保留，新流程不产生DeliveryVersion；同服务端口变化不丢会话，其他服务实例不能借同名身份读取旧数据。
- 左侧主会话与任务条目可切换/搜索，聊天结果只出现一次，草稿切换/IME/停止/失败提示合理。宽窄窗、长标题/文本、滚动和暗色核对；不得用孤立组件截图替代真实Bots导航验收。
- 新上下文SQL批读，列表摘要和选中会话正文分页；40+任务、100+消息验证请求次数/最大批次/字节量。当前旧read每条inspect、旧requirementMessages逐ID读的性能问题已交实施者针对新路径消除；无ES改动。

## 当前证据与环境

root已读基线UI与持久执行路径，确认割裂来自独立service页头/模型表单/820px正文/280px右任务栏，与beta的68px页头、960px聊天列及输入视觉不同。已下发共用样式和纯视图、避免个人Thread/附件fallback的约束。

root只读preview status返回running/database healthy/App running，Java27495端口61613、既有profile保留。只读SQLite确认2个除URL外身份完全相同的旧scope：60439无任务、61613有1个任务，两者均绑定custom:cheap；2个请求均succeeded、pending为0。升级前仍需重新核对是否有在途工作，不能沿用此时空闲结论。Mac仍锁屏，已请求用户方便时解锁；目前没有本轮原生界面验证。未关闭用户预览，未操作模型凭据或调用模型。

早期检查：实施者Java第二轮builder日志为73 JUnit、1884 parity零差异、jar `ded41dd9`；root只读核实日志。首轮3处编译错误已修，详见attempt，随后代码仍在变更，不代表当前完整快照验收。root独立纯协议探针通过4个合法对象、9个拒绝场景（含重复key/Unicode别名、错来源/目标/上下文、代码围栏、额外字段和篡改digest）；首次探针tsx CJS具名导入错误修正为default import后通过，非产品问题。此为早期检查，冻结候选须正式复验。

尚无M04整体验收/候选提交/合并结论。首轮builder已释放，隔离MySQL测试尚未启动；root已准备精确原B00容器启动/恢复helper `/tmp/m04-root-db-support.mjs`，没有执行资源动作。自动任务保持PAUSED，不push/deploy。

## 早期审查跟踪（冻结候选后须复验）

- 旧M03任务尚未adopt时不能使主对话freeze失败；经原请求人/Bot验证读取兼容摘要，真正操作再受控接入。现有completed TASK-1应先正常显示历史，再显式继续同Task。
- append等待目标摘要的await之后、HTTP开始之前必须再次核对停止意图；remoteStarted已持久后仅恢复原回执，不声称撤销。
- 搜索结果和分页列表不能成为已选Task标题/完成状态的唯一来源；选中会话摘要独立、有界读取。单一刷新调度网络失败后应继续恢复，防重叠和旧回包覆盖。
- 完成/继续/协调的历史回执重放与freeze仍须核验当前Bot绑定和Group权限。
- 旧scope迁移应使用可核验的历史非空Run作依据，不能因最新消息尚未入队就误判冲突，也不能静默遗留本地待发消息；真实预览切换前仍检查空闲。
- UI需展示全BotsWorkspace，保留明确新任务入口、按会话草稿和稳定请求ID，验证协议失败可继续；当前首版接线尚未获截图或交互通过证据。

root早期执行：`expert-conversation.spec.ts`的6条SQLite/fake-client闭环与丢回执重开测试通过，日志`/tmp/m04-root-early-conversation-tests.log`；9份原有service-conversation/runtime、text-delivery、executor、worker/prompt/controller/config/client共105条通过，日志`/tmp/m04-root-early-regression.log`。早期`check-contracts.mjs`为15通过/10失败：新增`x-internal-lifecycles`未注册strict Ajv关键字；已交回修正，不能记为契约通过。实施者报告Node/Web类型与隔离全App构建checkpoint通过，root已读取日志；这些均在实现继续变化时完成，最终仍以冻结候选复验为准。

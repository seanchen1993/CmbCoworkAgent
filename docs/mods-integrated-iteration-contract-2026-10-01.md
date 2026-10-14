# Mods 四方向统一迭代契约

工作区 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`，不在 UAT 开发。
用户要求四方向一起设计、实现、验收，不按中间批次停止。本文件为整体评审稿；
评审通过后实现，交付报告另记录真实结果，不以设计代替完成证明。

## 统一目标与不变量

用户在真实 Autobiz 项目中选择组件、模型及流程，保存后核对变化，应用到当前本地对话；
执行读取变更、检视、真实测试、汇报，或显式选择修复后复检。原本地 Plugin/Harness 用户
保留项目上下文和原生命周期。升级可以看到受影响引用并修复，不暗中替换活动副本。

所有路径共享真实来源身份、完整包授权摘要、组件投影、线程绑定、模型解析、运行租约和
最终证据。保存不应用；运行中不切换；未经批准的新包不能修复成已授权；取消或撤权不发布
迟到结果。组件为本工程显式扩展，不宣称是 Claude 官方组件格式或所有内核均可替换。

## 本地 Plugin/Harness 适配与规则

- 只扩展宿主 v2 Flow 到本地 normal 模式的合法 Plugin/Harness 项目、Feature 会话。
  workflow/controller、remote、IM、调度会话保留原限制。结构绑定由 DB 和原 Harness helper
  解出，非法结构、失效 Feature、纯扁平伪造字段均拒绝，不能从渲染器接收运行上下文。
- 新适配器固定 plugin/root/workspace、project/feature、adapter 版本、阶段、工具和输入策略；
  子 runtime 复用标准 runtime factory，收紧 readonly 角色，不能被 Harness 合并覆盖。
  运行期间检查稳定绑定与来源，标题变化不失效，避免轮询重建昂贵上下文。
- 子运行统一标准 prompt 和 Skill 生命周期；PostSkillUse 在子运行结束，传统 Stop 只在父
  finalize 执行一次。使用原完成处理器，禁止重复 Mods gate、自动重跑和重复阶段提交。
  Stop 拦截/要求继续时流程不能报成功；父 HookScope 汇总子运行已激活来源并激活绑定插件，
  子运行各自去重。后续最终检查重新捕获证据。禁止重复是针对宿主 gate/stage 提交；项目
  原有 Stop 的副作用遵循原契约，无法替任意脚本保证事务幂等，已到目标时不再次提交阶段。
- Claw 可选 `completionRules: [{pluginId,name,digest,policy}]`；policy 仅 report/check，
  maxRepairs=0，不含阶段写入开关。每条引用必须是已选择且已批准的整包能力。
- 同来源有效项目规则与附加规则 scope/target/feature 必须一致；项目 off/default 不制造范围
  冲突，以附加规则为基准。checks 合并，时间/token 配额取较小值，check 不因 report 降级；
  有任何附加规则时，项目 repair 收紧为 check/maxRepairs=0，避免 report 新增检查获得修复权。
  UI 明示同来源合并后取严格规则，report 加到项目 check 的检查也必须通过。项目 off 可增加附加 check，
  但不能因此获得阶段推进权。旧项目规则缺省语义、无 Claw 线程保持不变。
- UI 区分项目必需规则与 Claw 附加规则；有效规则进入运行快照和证据指纹。规则变化撤销旧
  完成证据，按真实线程是否不合规收窄失效范围，禁止再次整工作区误关会话。

## 使用、升级和模型

- 应用前以已保存版本与当前活动副本比较能力、组件、配置字段、模型、Skill/MCP、Flow、规则。
  不默认显示配置值；预览不加载 guest、不执行工具。应用主进程再次检查配置版本、binding
  revision、来源和规则；预览期间变化必须重新核对，不能将旧预览当新授权。
- 升级修复只能选择同真实来源的已批准新版；逐项校验组件、依赖、动作归属和 schema。
  保留可兼容输入及草稿；删除组件/新增必填/不兼容配置明示待处理，不静默丢字段或扩大为整包。
- 绑定 Flow 的引用也要核对。修复生成新的 Flow 副本并保存取得真实 revision/digest，随后
  放入 Claw 草稿；第二步冲突保留可见副本，不暗中应用或覆盖其他组合的 Flow。
- 模型编辑用默认/Claw 角色/固定型号互斥模式，切换清除另一种显式引用；旧双字段保留原
  固定型号优先并提示。保持实际解析顺序：固定型号 > Claw 角色 > Agent 配置 > Claw 默认
  > 应用默认。执行记录表示步骤绑定，不冒充 hook 后供应商最终路由。
- 结果按真实证据区分 Agent、动作、人工确认、原生测试与应用规则。无有效原生测试回执时
  明确“未执行原生项目测试”；失效、跳过、历史 PASS 不计入当前通过。活动副本仍可运行时，
  不因模板列表暂空而提示先保存。

## Autobiz 与真实检查

- 实际上游目录 `C:\ai\autobiz_kanban`，已核对固定 commit
  `8db1ec937d6ed3d271cb9dc540310d6633c91e70`。生成独立可导入的 native 组件包，保留来源信息，
  上游源码不原地改动。组件显式入口不得互相静态导入；公共实现可以通过 wrapper 引用。
- 提供只检视、检视+测试、修复+复检三个宿主 Flow 预设，可换另一汇报插件与模型；与现有
  Claw 来源选择和批准复用同一 UI，不预写 grant。默认不修改 checkpoint、不自动推进阶段。
- 真实检视用读取仓库的 Agent；只读步骤使用具有实际只读执行策略的角色，不只靠提示词。
  不把新模板称为完整复制上游 reviewer/utest 的内联流程。
- 原生检查增加显式受限 Python unittest 配置，固定可验证参数结构，不接受任意 shell 文本。
  复用原 execute、审批、取消、运行回执和源码/配置指纹，不伪造 npm 工程，不由目录猜运行器。
  配置变化使已有回执失效；已有 npm 检查保持兼容。
- 上游隔离基线已有 168 项中 5 failure、1 error，保存原日志，不改断言掩盖。最终验收既展示
  全套原结果，也使用原始有效测试进行故障注入→真实读写修复→原测试通过；用户源码不被注入。

## 高价值 Function 兼容

重新核验当前发布安装包及内嵌声明；2026-09-30 读取 npm latest 为 2.1.285，下载先做 SRI
校验，不能使用中断的未完整包。10 月 1 日复核 latest 已为 2.1.286，完成固定包完整校验、
声明提取及原版 10 项探针，新增 prompt.compose/asUser 如实登记为本轮未支持。
对提取实现只作契约参考，不复制第三方实现进产品。

- `skill.prompt`：统一完整正文读取→来源固定→扩展→内容保护→分页/注入交付。显式选择、
  模型 read_file、Flow Skill/子 Agent 使用同一正文快照；分页不对片段反复扩展，来源改变
  不混用新旧正文，越权、撤权、取消不降级为返回原文。普通非 Skill 文件无额外完整扫描。
- `tool.describe`：核验上游实际为描述与延迟展示契约，工具 identity/provider/schema 不可被
  描述 hook 改写；接入模型真正收到的工具目录，并复核工具搜索路径。不能仅注册空事件。
  无对应延迟能力的路径明确拒绝该变换并标出支持边界，不将描述文本支持宣传为任意 schema 改写。
- `prompt.read/fill`：当前可编辑 composer 的线程/owner/版本桥接，支持文本和合法 UTF-16
  cursor，不传附件内容或凭据。read 为调用插件记录 thread/owner/版本 lease；之后 fill 使用
  最近 read 的 lease，不能在收到 fill 时刷新版本掩盖用户新输入。未 read 的 fill 在调用开始
  捕获 lease，最终写入 CAS；cursor 为 0..text.length 的 UTF-16 整数偏移。用户继续输入、切线程、弹窗、卸载、
  撤权均不能覆盖新草稿；fill 不触发发送。`prompt.edit` 等更广编辑事件按真实接入证据登记，
  不用 read/fill 假称所有草稿 API 完成。
- `model.complete` effort：校验官方枚举并映射支持它的既有供应商配置，不静默丢弃不支持值。
  独立 options.signal 仅取消对应调用，复用现有 guest call cancel，不能取消兄弟请求/整个
  对话；父取消/撤权仍优先，预取消零 provider 调用，费用/资源清理和结果协议保持准确。
- 上述边界更新兼容矩阵和作者说明；旧 legacy-v1 与 result-v1 不混淆。完整终端、多环境 MCP
  隔离、任意副作用恢复、远端/定时流程仍是原先明确后置范围，不捆绑此次四方向。

## 文件职责与验证

- 架构 agent：Harness adapter、scope、native-host、skill-turn、manager 规则合并、
  新 shared claw-completion 与对应回归。
- 体验 agent：Claw/Flow UI、shared change/upgrade、Claw parser/IPC、规则表单与对应测试。
- Autobiz agent：包生成、示例、预设、受限 Python 检查规划与测试、隔离上游基线和验收。
- 主 agent：安装包核验、Skill/工具/模型兼容、草稿桥接、跨域集成、最终测试与文档。
  共同大文件按具体区段先沟通，不覆盖他人变更。

两位 agent 独立审本契约后实施，并交叉检查最终代码。各域先跑定向反例；统一冻结后再运行
完整 Node/Web typecheck、build、真实 Electron（包含四方向完整旅程和旧 Plugin/Harness）、
浏览器交互、全量 Vitest 与九条原始独立链。重型验证串行避免资源争用。
性能在相同 fixture/运行条件对照解析、编辑、启动与检查开销；不把受控 HTTP 模型当线上
推理质量证明。基线失败逐项对比，新增失败必须处理，测试不绿如实记录。

最终一次性交付：可导入包、三预设、逐步用户说明与截图、作者迁移说明、兼容矩阵、双评审
记录、功能/回归/E2E/性能证据。四方向中间进度仅作更新，不当作完成交付。

## 交付资料入口

- [用户实操](mods-integrated-hands-on-2026-10-01.md)
- [作者接口与迁移](mods-integrated-authoring-2026-10-01.md)
- [架构评审](mods-integrated-architecture-review-2026-10-01.md)
- [体验评审](mods-integrated-experience-review-2026-10-01.md)
- [286 原版审计](mods-claude-2.1.286-audit-2026-10-01.md)
- [Autobiz 专项验证](mods-autobiz-integrated-verification-2026-10-01.md)

最终运行结果另见统一交付报告；这里的计划与测试脚本不构成验收通过证明。

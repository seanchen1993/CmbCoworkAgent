# 组件选择质量评审

目录：`C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本记录只覆盖本轮组件选择，
不代表任意旧插件可以自动拆分，也不声明 Claude 上游提供本工程的可视化 Flow。

## 设计结论

通过 `mods-component-selection-contract-2026-09-30.md`。关键前提是按作者声明的独立入口
构建选集，不以隐藏动作目录代替实际运行约束。旧包保留整包和旧摘要；组件包固定全包授权
摘要，运行选集另有摘要。依赖须用户明确加入；强制 check/repair 规则要求 all 模式，
即使 selected 列出当前全部组件也不能替代整包模式。

原实现 `claw.actions` 只映射整包注册的命令，不能独立控制初始化、Hook、站点或 provider。
本轮契约通过同一个运行投影贯通所有入口，并禁止组件入口间的静态导入，避免未选入口的
顶层代码经 import 提前执行。组件仍共享包的 grant/guest，不是新的隔离或权限单位。

## 本评审承担的实现

- `claw-components.ts`：版本、显式组件声明、入口格式、ID、依赖循环/缺失、选集与配置键
  解析。`resolveClawComponents` 不自动扩充依赖、不为旧包伪造组件；schema 由主进程验证。
- `ClawCapability.components` 缺省维持历史整包，all 的 ids 规范化为空；活动副本与模板
  继续独立，原 revision/bindingRevision CAS 不变。
- Claw IPC 在保存和应用时检查完整来源身份、组件依赖、配置 schema，以及所绑定 Flow
  的每个启用 Action 是否属于所选组件。配置错误不回显用户参数内容。
- 编辑页展示整包/指定组件、依赖与主动加入操作；只编辑选中组件。配置复用已有参数表单，
  保留 false、0、空字符串、未知字段及不完整 JSON/数字草稿。无效草稿阻断保存，移除插件
  或切换组合需明确确认；目录刷新不覆盖草稿，摘要不匹配时不能用新 schema 编辑旧配置。
- 侧栏展示实际活动副本的组件 IDs；旧包标记整包。保存、应用与实际聊天/流程运行仍分离。

## 验证记录

- 首轮 49 项通过：`output/mods-components-quality-tests.log`，覆盖 shared 12、旧 Action 13、
  Claw IPC 14、ClawStore 10。新增反例包括缺依赖、循环、配置遗漏/排除、Flow 动作未选、
  旧包无选集字段、模板编辑不改活动配置、副本重启与旧 CAS。
- 真实 React 浏览器 4 组通过：`output/mods-components-browser/report.json`。覆盖依赖主动
  加入、参数真实编辑与保存应用、未完成数字/JSON 阻断、拒绝移除保留草稿、摘要变化、旧包
  整包和 800px 无横向溢出。IPC 在此由 fixture 控制，不替代宿主安全测试。
- 已目视使用现有生产 CSS 的 `output/mods-components-browser/components-800.png`；组件
  配置分组及依赖说明清晰。最终当前生产 CSS/实际运行截图由 Electron 验证补充。
- 范围 lint 首轮零错误，Web 类型检查通过：`output/mods-components-quality-lint.log`、
  `output/mods-components-web-types.log`。最终交叉检视、构建及全量由根任务统一汇总。
- 存量真实 React 浏览器 20 组通过：`output/mods-components-old-browser.log`，包括普通
  导航零 Flow IPC、100 事件最多两次详情请求、20 次侧栏切换单 controller、模型角色与
  绑定副本、Skill/MCP 来源和旧 Action 表单。64 步骤本机编辑 p95 为 13.3ms。
- 最后范围 lint 零错误；49 项窄测复测通过。架构评审者独立检查本评审负责的 shared、
  Claw 编辑页及 IPC，结论通过，无新增阻断。

## 对 loader 与运行接线的独立复核

只读代码交叉复核通过：`loader.ts`、`component-projection.ts`、`component-audit.ts`、
`host-call.ts`、`v2/manager.ts` 及 `flows/native-host.ts`，未发现新增生产阻断。

- 全部声明组件和客户端源码参与完整包摘要；业务投影由同次捕获的 bundle 组装，不在
  投影时重读源码。直接、经公共 helper 或省略扩展名导入其他组件入口均经过真实路径检查。
- 有效组件按依赖拓扑去重，配置只交给自身 register；投影配置摘要规范化，不能替代全包
  grant 摘要。所选动作、客户端和环境声明来自同一集合，目录过滤之外也真正约束 guest。
- manager 加载 projection.code/options，保留 compiled/projection/原 grant 的分离。
  审计通过真实 grant 对象的 WeakMap 附加有效集合和摘要，验证线程与存活状态；不是
  guest 自报组件。完成证据配置、Flow executionPlan 同步包含该选集身份。
- 强制规则使用真实线程绑定，并对 selected 模式一致拒绝；无 configSchema 的组件不接受
  任意非空配置，由 manager 的 clawSelectionIssues 在 IPC 持久化之前和运行前共同检查。
- 已读取 `component-loader.test.ts` 的真实 QuickJS、源码更新、选集摘要和客户端反例。
  根任务报告旧 loader 24 + 新组件 11 项通过，最终新增示例测试与完整结果以根任务为准。

重要边界：首次授权/兼容检查沿用独立的全包注册探针，可能执行全部组件的顶层及 register
代码，但不调用业务 Hook；“只加载所选组件”特指应用组合后的业务实例。来源目录发现仍不
执行 guest。作者组件必须能通过全包注册检查，不能宣传为未选组件在所有阶段绝不运行。

## 后续验收门槛

宿主实现须有真实 QuickJS/Electron 证据：未选入口顶层和 register 零执行、依赖只注册一次、
配置传入正确组件、未选命令/动作/站点/provider 无旁路、应用/撤权使旧实例和迟到结果失效，
强制完成规则不能排除。还须保留旧 Plugin/Harness、v1/v2 Flow、审批、内容保护及性能回归。
本文不会用浏览器 fixture 的保存结果推断实际 guest 已受限。

## 全量回归发现与失效范围修复

首次全量运行发现 15 个失败，其中 11 个与历史基线相同，新增 4 个确为本轮回归：
application-completion-policy 的两条 kanban-mode/kanban-target ownership 交接，以及
autobiz-completion.integration 的 stage off→check 和只读项目验收。对照证据为
`output/mods-components-baseline-comparison.json`，不能将这 4 个归入历史失败。

根因是 setCompletionPolicy 新增无条件 invalidate(workspace)，导致普通整包尚在执行的
旧命令及检查上下文被销毁。修复由架构评审者实施，本评审独立只读复核通过：保留原有
completionChecks.abort 与 freshness.changed；仅当新规则为 check/repair 且真实线程
绑定缺少该包或为 selected 模式时，关闭对应线程实例，不增加整个 workspace epoch。
whole/all、off/report 的原命令语义不变，其他项目也不受影响。

额外检查了实例尚在加载但尚无首个 snapshot 的窗口：判定依据是可信线程 Claw 选择，
而非已加载 snapshots。新增直接 beforeLoad barrier 测试停在 guest create 之前；恢复后
不允许 session.start 写入。另有绑定读取异常时关闭该实例并继续处理其他线程的反例，
避免一个坏绑定打断全部撤权处理。这里区分了“初始化未完成”和“首个 snapshot 未建立”，
不把后者混同于已有 session.start 发布暂停测试。

修前原两文件 4 失败/41 通过；修后首批原两文件加组件、completion manager、native host、
Flow manager 共 6 文件 155/155 通过：`output/mods-components-policy-regression-after.log`。
旧断言保持原样，没有放宽。最终补充批次 2 文件 34/34 通过（组件 15、application 19）：
`output/mods-components-policy-regression-final.log`，包含上述零快照及坏绑定反例；本评审
已核对源码和日志。失效范围修复质量复核通过，生产重新冻结，最终构建由根任务汇总。

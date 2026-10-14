# Flow 参数表单：独立质量评审

评审者：composition_quality_review。初始为独立只读方案评审；双审通过后承担 renderer 实现。

结论：**方案通过，草稿生命周期与完整来源身份约束已纳入主契约并落实。**
实现后由 architecture agent 交叉检视 renderer 通过；本评审者独立检视其宿主 configSchema
实现通过。最终构建、类型与 Electron 验收由根任务统一执行，以下不将待执行检查计为通过。

## 已核实的现有缺口

1. **P1：无效 JSON 可以绕过已保存版本的运行守卫。** FlowEditor 的 jsonDrafts 保留
   无效文本，但不更新父 definition。FlowsPanel 的 dirty 只比较 definition 与 baseline，
   运行/到聊天按钮又不检查 editorValid。因此只把已保存步骤的 JSON 改为 `{` 时，保存
   按钮禁用，而运行旧版本仍可能启用；打开其他流程、复制、去 Mods 的未保存提示也遗漏。
   现有 browser 用例先添加了动作、修改有效值再制造错误，definition 已 dirty，未覆盖该反例。
2. FlowEditor 只以 draft.id 为 key，同一流程重新打开不会重置局部 JSON 草稿。切换步骤
   类型会替换 definition，但局部 `${step.id}:config` 可以残留；例如 action → MCP 后
   隐藏的无效 config 仍可能参与 invalidJson，或切回后旧文本与实际对象不一致。
3. 现有 MCP 参数说明按 provider.id / toolName / schemaDigest 找目录项，未比 provider
   的 digest。action 选择框只以 pluginId:actionId 作 value。同名来源更新时不能复用这些
   简化键给旧步骤套用新 schema，也不能让用户误以为已重新选择了最新版。

## 必须收敛的实现契约

- 同一编辑会话使用一份参数草稿真相，包括有效对象、原始 JSON 文本、原始数字文本、
  编辑模式、dirty 与错误。未解析的 `-`、`1e`、空数字、溢出值不得回退旧对象后保存。
  数字解析要求完整有限数；integer 另要求安全整数。不用 Number(空串) 将缺失变零。
- FlowEditor 向父组件报告 `{dirty, valid}`；父级 dirty 为 definitionDirty 或 rawDraftDirty。
  保存、运行、到聊天的 disabled 与 handler 都检查该状态，防键盘/调用竞态遗漏。
  切流程、复制、新建、去 Mods 统一守卫。复制不得偷偷复制上一份有效值；未解析草稿须
  先修正或明确放弃。错误步骤即使折叠也要有位置提示和入口。
- 显式打开/放弃/新建使用独立 editorSessionKey；成功保存也重置到返回的最新 baseline。
  后台目录刷新与运行状态更新不得重置 editorSessionKey，不覆盖正在输入的草稿。
  同一流程内切步骤、移动步骤、切表单/JSON 保留草稿。更换类型与删除步骤属于显式
  丢弃该步骤专属参数的操作，必要时提示；放弃后同时清理对应局部状态，不能留下幽灵错误。
- 来源切换保留原对象及无法解析的文本；不能依 schema 投影对象或删除未知属性。
  对旧值类型不匹配，不用 String/Boolean/Number 自动转换；标明并保留高级 JSON 修复入口。
  可选属性用是否存在的明确控件，Object.hasOwn 区分缺失与 false/0/空字符串。
  枚举值必须保留原类型（含数值和布尔），不可用 option 字符串直接写回。
- schema 身份要求全字段精确匹配：action 的 pluginId/plugin/actionId/digest；MCP 的
  provider.id/name/digest + toolName/schemaDigest。未找到、不可用或目录失效时保留 JSON
  与身份，提示刷新/重新选择，不自动迁移。schema.default/examples 只是说明，不自动写入。
- 根级引用/组合/联合、不明确的类型及复杂属性不推导成简单控件。允许简单控件与只读
  未覆盖字段提示共存，但始终保留完整 JSON；切换到表单不能丢嵌套对象、数组、null、未知键。
  inputFrom 可能在执行时补齐 required 字段，编辑器不能因固定输入缺失它们就误判不可保存；
  标注“运行时合并后校验”，真正输入/配置约束由宿主继续验证。
- 输出路径建议仅枚举前置有效步骤、精确摘要声明中的明确 object 路径；JSON Pointer 必须
  正确转义 `~` / `/`，深度/数量有界。没有声明时仍提供完整输出和高级指针，不猜 MCP 的
  output schema，不向用户宣称逐字段映射。更换来源后保留旧路径并标注待核对。
- 编辑器不新增自动 IPC、MCP 连接、插件运行或模型请求。schema 控件说明可 memo，路径
  枚举只在选中来源变化时生成；只挂载当前步骤表单，所有草稿存活在父编辑会话。
  64 步骤和最大允许 schema/参数体积需检查渲染与输入性能，禁止每字符扫描远端目录。

应用级导航/窗口关闭的全局草稿恢复不是本轮自动承诺。若无法完整拦截，说明明确限定为
DIY 页面内切换与已接入的“去 Mods”入口；不能写成所有导航都已防丢失。

## 实施接口建议

- 新 ParameterObjectEditor 接收完整 value、schema、title、稳定 fieldKey、共享 draft 状态，
  通过 onChange 返回完整对象，通过 onDraftChange 更新未解析文本/错误；不自行联网。
- FlowEditor 采用 onEditorStateChange({dirty,valid})，保留 onChange(definition)。
  parent 负责 editorSessionKey 与 baseline 切换；仅切步骤不会更换 key。
- 实际可访问名称：`动作输入参数` / `动作配置参数` 区域（MCP 复用动作输入区域）；
  模式按钮 `动作输入：表单` / `动作输入：JSON`，配置同理。高级 textarea 保留旧标签
  `动作输入` / `动作配置`；字段为 `动作输入 · {title或key}`，存在性控件
  `设置 动作输入 · {title或key}`。路径选择 `输出来源路径`，折叠项 `高级输出路径`，
  高级输入保持 `输出字段路径（JSON Pointer，可留空）`。
  browser 用 region 定位，避免重复的 input/config 标签冲突。

## 最小回归矩阵

1. 已保存 baseline 仅新增无效 JSON/数字，立即不能保存、运行、到聊天；所有切换确认有效。
2. false / 0 / 空字符串 / 缺失往返 form → JSON → form → save 完整保留；typed enum 同样。
3. 未知键、嵌套对象、null、数组、不匹配类型不被表单改写；输入和 config 互不覆盖。
4. A→B→A 步骤、表单/JSON、同来源新版、相同 schemaDigest 但 provider digest 改变、
   目录刷新失败/迟到、同一流程放弃重开、成功保存后的 baseline 重新同步。
5. inputFrom 完整输出/object path/高级指针、`~` 与 `/` 键、无声明、常量同名覆盖；
   required 将由前步补齐的配置能保存，真实执行仍由宿主校验实际合并结果。
6. configSchema 的缺失/合法/错误配置、清单摘要变化、旧包授权与旧动作运行保持兼容。
7. 实际 Autobiz prepare-review 的 feature/path 控件、浅/暗色及窄屏截图；64 步骤编辑
   不触发额外目录 IPC，输入无明显卡顿。旧 Flow/跨插件/传统 Plugin 真流程继续回归。

## 已完成实现与验证记录

- 新增 FlowParameterEditor 和纯 helper，完整对象为真相，额外保留原始 JSON/数字草稿。
  未完成数字在来源 schema 失效后仍保留独立错误，不会因为找不到控件而静默保存旧数值。
- FlowsPanel 将局部 dirty/valid 纳入保存、运行、到聊天和页面内切换守卫；显式放弃/成功
  保存使用独立 session key。输入来源从完整对象或已声明对象路径选择；MCP 提供
  `/structuredContent` 的已知结果容器提示，仍要求实际结果是对象，不宣称推导 schema。
- Guide 改为先使用表单与对象路径，复杂配置使用高级 JSON。MCP 的目录仍须用户显式加载。
- 本 agent fresh 单测 20 项通过：`output/mods-flow-forms-unit.log`；6 个 renderer/helper
  文件定向 lint 通过：`output/mods-flow-forms-renderer-lint.log`。
- 根任务执行专项真实浏览器 6 组通过；已读取 `output/mods-flow-forms-browser/report.json`，
  errors 为空，覆盖无损、无效草稿、模式切换、inputFrom、旧摘要和窄屏。已目视
  `output/mods-flow-forms-browser/forms-800.png`，页面无横向挤出，参数组/模式/存在性控件清晰。
  浅/暗图分别为同目录 forms-light.png / forms-dark.png。性能新增测量及最后路径文案改动
  后的 fresh 浏览器复跑由根任务补充，不能据之前 6 组报告代替。
- 独立检视宿主：configSchema 仅明确提供时进目录；raw manifest 覆盖摘要；prepare 阶段
  不因 inputFrom 跳过 config，runAction 比较当前可信声明且 guest 前重验；伪造目录 schema
  无法弱化校验。原配置未知值保留，不填默认值，不回显敏感配置到错误。

保留边界：未增加全局应用导航/关闭窗口的草稿恢复；复杂 schema 由高级 JSON 和宿主完整
校验负责；禁用步骤里的未完成参数仍要求修正或明确删除，避免草稿被静默丢弃。

## 根任务最终复查发现的禁用步骤回归

初版参数错误汇总对禁用步骤仍校验 schema 的 required/type，会阻止运行原先可运行的
已保存流程。根任务以真实 React 路线复现失败，证据为
`output/mods-flow-forms-disabled-before.log`。这是存量行为回归，不能按产品选择忽略。

已做局部修复：先校验未解析 JSON、独立数字错误及历史 numbers 原始文本（即使没有
numberErrors 字段），之后禁用节点跳过运行 schema 语义。FlowEditor 汇总与参数组件
使用同一个 step.enabled 门控，既不丢草稿，也不强迫用户填写不执行的步骤。
新增单测覆盖 disabled input={}、类型不符、无效 JSON、无 numberErrors 的未完成数字、
source schema 消失及恢复启用检查；20 项 fresh 全通过。局部四文件 lint 通过，记录在
`output/mods-flow-forms-disabled-lint.log`。根任务负责最后真实浏览器前后对照与重新构建。

代码事实基于 FlowEditor.tsx、FlowsPanel.tsx、FlowParameterEditor.tsx、flow-parameter-form.ts、
claw-actions.ts、tool-schema.ts、action-config.ts、manager.ts 和 native-host.ts。

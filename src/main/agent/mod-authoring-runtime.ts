import { getModDevelopmentService } from "../mods/devtools/development-service"
import { createModAuthoringTool } from "./tools/mod-authoring-tool"
import { createModCompositionTool } from "./tools/mod-composition-tool"

/** Native creator mode, not a keyword match or a user skill installed on this computer. */
export function createModAuthoringRuntimeTools(scope: {
  threadId?: string
  workspace: string
  agentId?: string
  projectMode: boolean
  signal?: AbortSignal
}) {
  if (
    scope.projectMode ||
    (scope.agentId && scope.agentId !== "main") ||
    !scope.threadId ||
    !getModDevelopmentService()?.isCreatorMode(scope.threadId, scope.workspace)
  )
    return []
  return [
    createModAuthoringTool({
      threadId: scope.threadId,
      workspace: scope.workspace,
      signal: scope.signal
    }),
    createModCompositionTool({
      threadId: scope.threadId,
      workspace: scope.workspace,
      signal: scope.signal
    })
  ] as const
}

const guidance = `

## 当前对话：创造者模式（Mods / Sparks）
用户已在当前本地工作区的这段聊天选择“创造者模式”。用户直接描述想要的效果，你负责创建、修改或组合实际功能并申请应用。灵件是本应用可组合的 TypeScript 扩展，可提供命令、工具、事件处理、界面/页面和流程动作。把用户说的“灵件”“Mods”“Sparks”按此含义理解。

先根据需求选择最短的实现路径：复用已经具备的功能，组合已有 Mods，或编写缺少的部分。由你处理组件、组合和执行步骤等技术选择，不要求用户先去“添加功能”“常用搭配”“执行步骤”逐项配置。只问确实影响效果的缺失信息；能从当前聊天和能力目录确定的参数自行确定。

本轮提供原生工具 mod_authoring 和 mod_composition。无需用户安装个人技能或提供本应用源码路径。编写新功能先用 mod_authoring 的 action="catalog" 读取随当前应用内置的 SDK、包结构、示例和交付指引；再按需用 catalogSection="types"/"events"/"sdk" 分页获取精确类型与支持范围。不要猜接口或依赖另一版本的文档。

首批一句话创作的保证范围以 catalogSection="support" 返回的 creator-s1 支持表为准，包含接点、动作、配置与复用边界。超出范围先保留已有运行版、草稿与组合，说明具体限制和可验证替代方案；不要静默删功能、关闭其它 Mod 或虚构能力。现有高级 SDK/项目工具不等于任意需求都能自动生成。当前请求的修复、操作和时间预算跨工具重建共用，不能自动新开请求规避；达到预算或结果未知时停止并准确说明已保存和未完成部分。

组合已有 Mods 时，先用 mod_composition 的 action="list" 按 query 搜索真实来源摘要、当前选择、可用模型/技能/MCP/已保存步骤及 catalogToken；需要配置时再用 details 取得所选 Mod 的 schema。按用户目标用 stage 提交 capabilities 和必要选择；同一轮的提交会累积，默认保留已有设置、深合并对象，数组整体替换，删除字段用 removeConfigPaths。只有用户明确要求替换或移除时才使用 replace/removePluginIds。可用 save 保存当前或待应用组合，用 apply_saved 套用真实名称和版本。undo 恢复上次选择，cancel 取消尚未应用的排队操作，均不回放外部动作。不得假造来源或代批权限，不要求用户去管理页逐项配置。stage/undo/apply_saved 后结束本轮，宿主等待轮末和空闲后应用；用 status 核对实际结果，queued 不能当成 active。

新功能按需用 scaffold 选起点并编写实际 TypeScript；优先用 submit 一次提交完整 files、当前 revision 和名称，由宿主检查并请求试用。失败先读返回的具体诊断与已保存版本，保留用户需求，在同轮最多修复两次源码后重新 submit，不让用户反复点击修复或复制错误。session.start 等中间件必须返回有效结果，普通初始化要在末尾 return next(event)，不能只 async ($) 执行代码后返回 undefined；看到 MODS_RETURN_UNDEFINED 应修复对应回调，不要盲改命令名。真实网络、文件或进程不要放进受限启动预检，使用已授权后的界面操作或实际事件。需要分步调试时仍可 save/check/request_trial。同一聊天修改先 list/read，保留已有功能，在同一个开发组件中更新，不为每句需求新建占位。undo_trial 会将前一版源码保存成新版本并重新校验，首次创作则在轮末停止；它不会撤销文件、网络或进程效果。源码和试用由宿主管理，不得覆盖应用安装目录。

request_trial 只提交排队请求，须本轮结束且用户在界面确认后才可能生效。说明等待批准/排队/生效/失败的真实状态，不循环等待或重复提交，不代替用户安装、批准或撤销现有授权。需要文件、进程、网络、模型时，按 catalog 的 authorizedTrialCapabilities 申请当前源码与目标的真实试用，实际动作仍经过原宿主权限。静态检查或批准不代表动作已执行。

当前聊天的源码会保留；重启后用 read/list 核对原草稿，再用 resume_trial 请求恢复，重新确认所需权限，不需要为了留在本聊天使用就正式安装。用户明确要求在其他聊天复用时，调用 request_reuse 准备精确源码和目标组合的方案，宿主用一张原生卡片请用户确认后自动编排原有安装、授权、保存组合和应用。模型不能批准该卡片，不能把 preparing/needs-approval 当成功，也不能重复执行 unknown 的安装。

需要独立项目插件时，使用 project_scaffold/read/save/compile/doctor/test/dev/pack；dev 仅准备隔离目录，pack 不自动安装。已有插件先 inspect_plugin/read_plugin_asset，保留来源并明确适配范围。试用后核对真实可观察效果，不把检查或管理页面操作当作制作结果。

交付时用用户能理解的话说明做了什么、应用到哪段聊天、当前实际状态和如何看到效果。生成、检查、排队和生效要分别核对，不把检查通过称为效果已验证。已获准范围内的修改由宿主自动更新；用户只需描述下一次修改。切回普通模式只结束创作入口，已生效功能由独立的停止操作管理。

这段指引只适用于当前已开启的制作会话。工具若报告会话、工作区或轮次改变，先停止并核对当前状态；不得借其它工具绕过该范围或权限。
`

/** Called before adding caller-supplied tools; only an actually admitted native tool enables it. */
export function modAuthoringRuntimePrompt(tools: readonly { name?: string }[]): string | null {
  const authoring = tools.some((tool) => tool.name === "mod_authoring")
  const composition = tools.some((tool) => tool.name === "mod_composition")
  if (authoring && composition) return guidance
  if (!authoring && !composition) return null
  const available = authoring
    ? '当前只提供 mod_authoring，可以生成或修改源码。先用 action="catalog" 及 catalogSection="support" 核对真实范围；未提供组合工具，不要尝试调用组合动作。'
    : '当前只提供 mod_composition，可以检索、组合、配置、命名保存或套用已有功能。先用 list/details 核对真实来源；未提供源码制作工具，无法为缺失能力生成源码。'
  return `\n\n## 当前对话：创造者模式（受限工具）\n${available}\n\n按用户目标完成可支持部分，保留其他已启用功能和已有成果。说明具体缺口，不假造工具或要求用户逐项手配。必要授权继续使用原确认，排队不代表生效。操作或修复预算耗尽、用户停止或结果未知时停止自动推进，保留草稿和真实状态，不自动重放副作用。`
}

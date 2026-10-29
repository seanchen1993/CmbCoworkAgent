import { getModDevelopmentService } from "../mods/devtools/development-service"
import { createModAuthoringTool } from "./tools/mod-authoring-tool"
import { createModCompositionTool } from "./tools/mod-composition-tool"
import { createModConfigurationTool } from "./tools/mod-configuration-tool"
import { createModBusinessTool } from "./tools/mod-business-tool"

export async function modAuthoringPlanningPrompt(
  threadId: string,
  workspace: string,
  signal: AbortSignal
) {
  return getModDevelopmentService()?.planningPrompt?.(threadId, workspace, signal) ?? null
}

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
    }),
    createModConfigurationTool({
      threadId: scope.threadId,
      workspace: scope.workspace,
      signal: scope.signal
    }),
    createModBusinessTool({
      threadId: scope.threadId,
      workspace: scope.workspace,
      signal: scope.signal
    })
  ] as const
}

const nativeProjectRouting = `
先按真实源码选择创作入口，不能按插件名称或历史实现推定：
- mod_authoring.project_list/project_read 中已有 composition/source.json：这是原生可组合项目，继续 project_read/project_patch/project_compile/project_request_trial。不再 inspect_raw、首次模块化或寻找旧 Python 适配器。
- 原生项目新增执行或校验能力：先 project_actions(query=需要的能力或插件名称，不带id) 检查已有且已授权的动作与契约，满足需求则直接复用。project_actions(id) 只列该草稿已声明的依赖；localActionId 是已有需求的 usedBy，不是新动作的搜索词。缺少时用 catalog(catalogSection="project-dependencies") 发现可复用源码，匹配需求的来源直接 dependency_prepare(sourceId)，由 Host 固定完整源码、检查并准备原生复用方案，然后结束本轮。准备方案不会安装、授权或执行，不必先请用户决定技术方案；实际安装等待原生确认。定制源码才用 save/check/request_reuse；dependency_save 是精确摘要复制的分步入口。确认后重新查询已授权动作的真实身份与契约，再绑定流程。不能猜动作名、重复安装或把安装当执行。
- 仅当真实来源是 mods/business/manifest.json 时，使用 mod_business 的 inspect/preview/transform_workflow；仅未模块化原始插件才使用 inspect_raw/request_modularization。业务清单的旧适配器说明不能覆盖原生组合的 Host 状态所有权。
大型原生项目只读取 composition/source.json 与本次必要的 Skill/契约文件。修改组合声明优先 project_patch(id,revision,sourceDigest,sourcePatch,files)：sourcePatch 是固定作用于 composition/source.json 的 JSON Pointer 操作，只支持 add/replace/remove/test。追加阶段用 add /modules/-；替换时先 test 目标模块的 id，再 replace 对应位置；新增资源用 add /resources/-，配置也只修改对应字段。不必转写整份声明，也不能同时提交该文件全文。files 只提交新增或修改的 Skill/资源；仅修改声明时可省略。project_patch 保留所有遗漏资源，无需为了保留 Hooks、知识和原 workflow 而逐个抄写。新增 workflow、知识或测试样例资源时，在同一次 project_patch 用 sourcePatch 声明精确 resources 路径并提交对应 files；不能先存未声明资源再补声明。生成的 runtime/action-lock/native skills 不作为编辑源。分页内容依 nextCursor 读完整后才判断源码有缺陷，不能因截断而误修原 workflow。源码验证使用 project_compile/project_doctor/project_test；不能执行临时脚本时继续原生检查，不为此要求额外权限或改用文件工具绕过。缺少测试运行配置时在插件声明必填配置，由项目使用入口填写，不把这个缺项当成无法创建可配置插件。
`

const guidance = `

## 当前对话：创造者模式（Mods / Sparks）
用户已在当前本地工作区的这段聊天选择“创造者模式”。用户直接描述想要的效果，你负责创建、修改或组合实际功能并申请应用。灵件是本应用可组合的 TypeScript 扩展，可提供命令、工具、事件处理、界面/页面和流程动作。把用户说的“灵件”“Mods”“Sparks”按此含义理解。

先根据需求选择最短的实现路径：复用已经具备的功能，组合已有 Mods，或编写缺少的部分。由你处理组件、组合和执行步骤等技术选择，不要求用户先去“添加功能”“常用搭配”“执行步骤”逐项配置。只问确实影响效果的缺失信息；能从当前聊天和能力目录确定的参数自行确定。

本轮提供原生工具 mod_authoring、mod_composition 和 mod_configuration。无需用户安装个人技能或提供本应用源码路径。编写新功能先用 mod_authoring 的 action="catalog" 读取随当前应用内置的 SDK、包结构、示例和交付指引；再按需用 catalogSection="types"/"events"/"sdk" 分页获取精确类型与支持范围。不要猜接口或依赖另一版本的文档。

首批一句话创作的保证范围以 catalogSection="support" 返回的 creator-s1 支持表为准，包含接点、动作、配置与复用边界。超出范围先保留已有运行版、草稿与组合，说明具体限制和可验证替代方案；不要静默删功能、关闭其它 Mod 或虚构能力。现有高级 SDK/项目工具不等于任意需求都能自动生成。当前请求的修复、操作和时间预算跨工具重建共用，不能自动新开请求规避；达到预算或结果未知时停止并准确说明已保存和未完成部分。

组合已有 Mods 时，先用 mod_composition 的 action="list" 按 query 搜索真实来源摘要、当前选择、可用模型/技能/MCP/已保存步骤及 catalogToken；需要配置时再用 details 取得所选 Mod 的 schema。按用户目标用 stage 提交 capabilities 和必要选择；同一轮的提交会累积，默认保留已有设置、深合并对象，数组整体替换，删除字段用 removeConfigPaths。只有用户明确要求替换或移除时才使用 replace/removePluginIds。可用 save 保存当前或待应用组合，用 apply_saved 套用真实名称和版本。undo 恢复上次选择，cancel 取消尚未应用的排队操作，均不回放外部动作。不得假造来源或代批权限，不要求用户去管理页逐项配置。stage/undo/apply_saved 后结束本轮，宿主等待轮末和空闲后应用；用 status 核对实际结果，queued 不能当成 active。

插件用户配置使用可用的 mod_configuration：inspect 读取真实 schema、当前版本与脱敏状态，set/reset 调整普通字段，apply 请求原宿主在安全点应用。目录/文件及敏感字段通过 request_input 展示原生配置卡片，由用户在可信界面选择或填写；不得让用户把密钥发到聊天，也不得把组件 configSchema 当作插件 userConfig。save 发现试用依赖时会组织正式复用确认，needs-reuse/needs-approval 不表示组合已经保存；原事务完成后宿主核对精确来源再保存，不重复安装或绕过确认。

新功能按需用 scaffold 选起点并编写实际 TypeScript；优先用 submit 一次提交完整 files、当前 revision 和名称，由宿主检查并请求试用。失败先读返回的具体诊断与已保存版本，保留用户需求，在同轮最多修复两次源码后重新 submit，不让用户反复点击修复或复制错误。session.start 等中间件必须返回有效结果，普通初始化要在末尾 return next(event)，不能只 async ($) 执行代码后返回 undefined；看到 MODS_RETURN_UNDEFINED 应修复对应回调，不要盲改命令名。真实网络、文件或进程不要放进受限启动预检，使用已授权后的界面操作或实际事件。需要分步调试时仍可 save/check/request_trial。同一聊天修改先 list/read，保留已有功能，在同一个开发组件中更新，不为每句需求新建占位。undo_trial 会将前一版源码保存成新版本并重新校验，首次创作则在轮末停止；它不会撤销文件、网络或进程效果。源码和试用由宿主管理，不得覆盖应用安装目录。

request_trial 只提交排队请求，须本轮结束且用户在界面确认后才可能生效。说明等待批准/排队/生效/失败的真实状态，不循环等待或重复提交，不代替用户安装、批准或撤销现有授权。需要文件、进程、网络、模型时，按 catalog 的 authorizedTrialCapabilities 申请当前源码与目标的真实试用，实际动作仍经过原宿主权限。静态检查或批准不代表动作已执行。

当前聊天的源码会保留；重启后用 read/list 核对原草稿，再用 resume_trial 请求恢复，重新确认所需权限，不需要为了留在本聊天使用就正式安装。用户明确要求在其他聊天复用时，调用 request_reuse 准备精确源码和目标组合的方案，宿主用一张原生卡片请用户确认后自动编排原有安装、授权、保存组合和应用。模型不能批准该卡片，不能把 preparing/needs-approval 当成功，也不能重复执行 unknown 的安装。

需要标准宿主项目插件时，使用 project_scaffold/read/save/compile/doctor/test/dev/pack。用 project_list 找回同一聊天持久草稿；修正后通过 project_request_trial(id,revision,goal) 在当前聊天展示原生真实试用卡，用户确认创建后由原项目运行器从起点执行实际阶段并校验产物。dev 仅准备隔离目录，pack 不自动安装；重启只恢复源码，不恢复权限或执行，也不回退原任务。仅真实来源尚无原生组合源码或业务 Mods 清单、且仍为 Python/Legacy 插件时，先 inspect_plugin/read_plugin_asset，保留来源与原适配器，不能把原脚本放进纯函数编译器或声称已自动转换。试用后核对真实可观察效果，不把检查、目录准备或项目创建称为阶段已执行。

制作阶段调试控制界面时，复用公共 $.platform 总线发现 native.project-stage-debug/stages@1.0.0，通过 inspect 分页读取真实快照、候选与分支，prepare 准备方案，review 仅请求原生复核导航。可参考应用示例“阶段调试工作台”，自行组合 Pane、表格和按钮；Mod 在原创造控制会话运行，隔离执行分支不加载 Mods。原生入口仍要求重新准备、明确确认创建及批准执行。固定候选的历史结果不能代替当前候选验收；文件摘要比较也不代表业务通过。不得编造公共 create/start/approve 动作或省略配置、知识、Hooks 和外部副作用的适配。

交付时用用户能理解的话说明做了什么、应用到哪段聊天、当前实际状态和如何看到效果。生成、检查、排队和生效要分别核对，不把检查通过称为效果已验证。已获准范围内的修改由宿主自动更新；用户只需描述下一次修改。切回普通模式只结束创作入口，已生效功能由独立的停止操作管理。

这段指引只适用于当前已开启的制作会话。工具若报告会话、工作区或轮次改变，先停止并核对当前状态；不得借其它工具绕过该范围或权限。
`

/** Called before adding caller-supplied tools; only an actually admitted native tool enables it. */
export function modAuthoringRuntimePrompt(tools: readonly { name?: string }[]): string | null {
  const authoring = tools.some((tool) => tool.name === "mod_authoring")
  const composition = tools.some((tool) => tool.name === "mod_composition")
  const configuration = tools.some((tool) => tool.name === "mod_configuration")
  const business = tools.some((tool) => tool.name === "mod_business")
  const businessGuide =
    "\n\n本轮提供原生 mod_business，可直接在当前聊天创作真实业务 Mods（阶段 Skill、声明式检查、资源和常驻扩展）并组装成独立插件，无需用户去管理页手配。先 catalog/inspect 读取真实已安装来源、精确内核及模块声明，再 read_asset 理解原 Hooks、知识配置和产物规则。先核对 catalog.kernel.runtime.adapter：host-linear-v1 使用原 Host 阶段执行器、宿主状态和真实检查；旧业务清单来源省略 runtime 时保留其已声明的兼容适配器，不代表原生组合也需要此适配器或任意内核已经适配。Host 模块在 host 字段声明 stage/actions/artifacts/checks/environment，阶段 Skill 使用真实 skill.entry，每阶段保留实际检查与输入依赖，不使用旧 checkpoint、Python board 上下文入口或默默丢弃 validators/guards。仅来源实际使用旧业务适配器时，保留它的原脚本检查、知识和插件状态，不能改成 Host 声明绕过原规则；原生组合则保留已有 action 检查、知识提供器、配置和执行资源，不改换状态所有者。catalog 的 bundledExamples 是随应用提供的真实 SDK 源码模板；需要知识上下文或 knowledge-sync 时，用 example(exampleId:autobiz-knowledge,cursor) 逐页读取 extensions 和所有实现文件，再以实际已安装来源的 inspectionId 保存独立草稿，无需预先手装示例插件，也不得自动安装。新增 Mod 用 save 保存独立 kernelRef 草稿，文件只在各自命名空间，不放进纯函数编译器，不改来源内核。preview 通过原组装器合并选定来源与草稿，保留原知识/上下文/检查和动态规则；缺失资源或能力须修复或明确阻断，不得删检查来通过。需要观察业务效果时，对已检查的精确候选调用 request_trial(previewId,goal)，结束本轮，等待用户在当前聊天确认隔离试用；不先安装候选。Host 候选复用原 project_request_trial 的配置、源码确认和 Host 运行路径，完整保留所声明资源；旧业务适配器候选通过原生入口配置参数、确认精确源码权限并选择实际业务上下文后，从起点调用来源原项目运行器。不要把 Host 原生组合送入旧 board 试用或制造来源并未声明的配置。status 返回原运行观察和已保存反馈；用户反馈后核对 status，再修改候选并创建新的隔离试用，不复用旧目录或批准。不把准备完成、启动或模型自检称为业务验收通过。request_review 只物化并检查冻结包，在当前聊天展示原生安装/导出确认，结束本轮后由用户确认。安装不代表授权、真实业务执行或项目验收；停止和物理收尾结果分开核对，未知结果不重放。重启只恢复源码和可读记录，不恢复旧确认；unknown 不自动重放。已安装同名插件的新版本只生成 exportOnly 更新包：导出ZIP后通过原安装插件入口确认更新，保留原UUID和配置，权限变化重新确认；不得声称独立安装器已覆盖更新。阶段调试使用下述受控 Host 快照入口；不删除业务 Hooks 或外部依赖来绕过支持范围。"
  const workflowGuide =
    "\n\n制作与试用使用同一原创作会话的‘创作工作区’：制作→试用→验收→保存。仅原始插件同时没有 composition/source.json 和业务 Mods 清单时，先 mod_business.inspect_raw(pluginId)，用 read_raw_asset 理解真实源码，再 request_modularization 准备可核对迁移方案；结束本轮由用户原生确认。确认后 status.modularization.inspectionId 才是可用于 inspect/preview 的新来源，不修改已安装原插件。遇阻断应保留知识、Hooks、上下文、配置及检查并补齐映射，不凭空假造成功。Host 的 project_list/project_read 返回匹配原请求的 trial.journey，业务 mod_business.status 返回 trial.journey：核对候选版本、阶段原生检查、产物、人工批准和执行会话归属。不同阶段会话属于原执行器隔离，不要求用户逐个猜成功；模型终止、completed、单个会话结束均不能代替整轮验收。反馈送回原创作会话，再保存新候选从起点试用，未知操作不重放。用户在工作区‘保存’页为当前Host候选指定独立新名称与版本，再显式确认安装或导出；业务组装候选用原安装/导出确认。保存源码、包检查、安装和整轮业务验收分别说明，不将改名的新包说成已经重跑通过。阶段调试使用 mod_authoring.project_stage_debug_list 读取真实阶段进入快照；用户要求局部调试时，保留契约与共享知识，仅修改目标或后续未共享的 Skill 正文，project_save 后用 project_stage_debug_prepare(id,revision,snapshotId,debugMode:stage或downstream)准备，结束本轮交给创作工作区原生确认。创建和启动不能由模型代批。仅支持受控文件阶段；带用户配置、外部知识提供器、Hooks、MCP、公开动作、Git或未知副作用时明确诊断，不能删除这些行为来获得调试通过。原运行和原产物保留，新分支没有旧授权或旧通过收据；单阶段检查通过不代表整轮通过。"
  const finish = (prompt: string) =>
    (authoring ? nativeProjectRouting : "") +
    (business ? prompt + businessGuide + workflowGuide : prompt)
  if (authoring && composition)
    return finish(
      configuration
        ? guidance
        : guidance
            .replace(
              "mod_authoring、mod_composition 和 mod_configuration",
              "mod_authoring 和 mod_composition"
            )
            .replace(
              /插件用户配置使用可用的 mod_configuration：[^\n]*?userConfig。/,
              "本轮未提供插件用户配置工具，不要调用或声称已经修改插件 userConfig。"
            )
    )
  if (!authoring && !composition && !configuration) return business ? businessGuide : null
  const available = authoring
    ? '当前只提供 mod_authoring，可以生成或修改源码。先用 action="catalog" 及 catalogSection="support" 核对真实范围；未提供组合工具，不要尝试调用组合动作。'
    : composition
      ? "当前只提供 mod_composition，可以检索、组合、配置、命名保存或套用已有功能。先用 list/details 核对真实来源；未提供源码制作工具，无法为缺失能力生成源码。"
      : "当前未提供源码制作和组合工具，不能生成源码或更改功能选择。"
  const config = configuration
    ? "另有 mod_configuration 可编辑原插件 userConfig：inspect 核对精确身份与版本；set/reset 仅修改普通字段，目录、文件和敏感字段通过 request_input 让用户在原生卡片选择或填写，不把秘密放进聊天。参数在项目中共享，pending 不代表生效。"
    : "本轮未提供插件用户配置工具，不要声称已修改插件 userConfig。"
  return finish(
    `\n\n## 当前对话：创造者模式（受限工具）\n${available}\n${config}\n\n按用户目标完成可支持部分，保留其他已启用功能和已有成果。说明具体缺口，不假造工具或要求用户逐项手配。必要授权继续使用原确认，排队不代表生效。操作或修复预算耗尽、用户停止或结果未知时停止自动推进，保留草稿和真实状态，不自动重放副作用。`
  )
}

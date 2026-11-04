import { describeFunctionDisplayRouting } from "../v2/display-routing"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "../../../shared/mods/v2/compatibility-catalog"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import {
  DEVELOPMENT_CAPABILITIES,
  DEVELOPMENT_REAL_CAPABILITIES,
  DEVELOPMENT_EVENT_CAPABILITIES
} from "../v2/development-session"
import { functionAuthoringDeclarations } from "./authoring-declarations"
import { CREATOR_S1_SUPPORT } from "./creator-support"
import { AUTHORING_TEMPLATE_KINDS } from "../../../shared/mods/authoring"
import { PROJECT_DEPENDENCY_AUTHORING } from "./development-dependency-catalog"
import ts from "typescript"
import { developerWorkbenchDiscovery } from "./developer-workbench-discovery"

/** Extract exact fragments from the same declarations used by the isolated compiler. */
function targetedDeclarations(source: string, events: string[], methods: string[], exports: string[] = []) {
  const file = ts.createSourceFile("devclaw-mods.d.ts", source, ts.ScriptTarget.Latest, true)
  const named = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.FunctionDeclaration>()
  const index = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isFunctionDeclaration(node) && node.name)
      named.set(node.name!.text, node)
    ts.forEachChild(node, index)
  }
  index(file)
  const snippets: ts.Node[] = []
  for (const name of exports) {
    const declaration = named.get(name)
    if (declaration && ts.isFunctionDeclaration(declaration)) snippets.push(declaration)
  }
  const on = named.get("On")
  if (on && ts.isInterfaceDeclaration(on)) {
    for (const member of on.members) {
      if (ts.isCallSignatureDeclaration(member)) {
        const literals: string[] = []
        const visit = (node: ts.Node) => {
          if (ts.isStringLiteral(node)) literals.push(node.text)
          ts.forEachChild(node, visit)
        }
        if (member.parameters[0]?.type) visit(member.parameters[0].type)
        if (events.some((event) => literals.includes(event))) snippets.push(member)
      } else if (events.includes("platform.action") && member.name?.getText(file) === "capability")
        snippets.push(member)
    }
  }
  const base = named.get("SDKBase")
  if (base && ts.isInterfaceDeclaration(base)) {
    for (const method of methods) {
      const [family, name] = method.split(".")
      const property = base.members.find((member) => member.name?.getText(file) === family)
      if (!property || !ts.isPropertySignature(property) || !property.type) continue
      const type = ts.isTypeReferenceNode(property.type)
        ? named.get(property.type.typeName.getText(file)) : property.type
      if (type && (ts.isTypeLiteralNode(type) || ts.isInterfaceDeclaration(type))) {
        for (const member of type.members)
          if (member.name?.getText(file) === name) snippets.push(member)
      }
    }
  }
  const dependencies = new Set<ts.Node>()
  const omitted = new Set(["SDK", "SDKBase", "On", "Register"])
  const collect = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const name = ts.isTypeReferenceNode(node) ? node.typeName.getText(file)
        : node.expression.getText(file)
      const declaration = named.get(name)
      if (declaration && !omitted.has(name) && !dependencies.has(declaration)) {
        dependencies.add(declaration)
        ts.forEachChild(declaration, collect)
      }
    }
    ts.forEachChild(node, collect)
  }
  snippets.forEach(collect)
  return {
    signatures: snippets.map((node) => node.getText(file)),
    types: [...dependencies].map((node) => node.getText(file))
  }
}

export const DEVELOPMENT_COUNTER_EXAMPLE = `import type { Register } from "devclaw-mods"
export const register: Register = (on) => {
  let calls = 0
  on("tool.call", async ($, event, next) => {
    calls += 1
    $.ui.invalidate("ui.render")
    return next(event)
  })
  on("ui.render", { component: "AbovePrompt" }, ($, event) => {
    const { Text } = $.ui.resolve(event)
    return Text({ children: "工具调用：" + calls })
  })
}
`

export const DEVELOPMENT_LAYOUT_EXAMPLE = `const { Box, Text, Button } = $.ui.resolve(event)
return Box({ flexDirection:"column", width:"100%", minWidth:0, rowGap:1, children:[
  Box({ flexWrap:"wrap", columnGap:1, alignItems:"center", children:[
    Box({ minWidth:0, flexGrow:1, flexShrink:1, children:[
      Text({ children:"当前内容", wrap:"wrap" })
    ] }),
    Button({ key:"refresh", label:"刷新", onPress:()=>$.ui.invalidate("ui.render") })
  ] })
] })`

export const DEVELOPMENT_SURFACE_EXAMPLE = `on.capability({
  apiVersion:"devclaw.capability/v1",id:"notes-view",version:"1.0.0",title:"笔记界面",
  scope:"conversation",stateSchema:{type:"object"},
  presentation:{type:"surface",apiVersion:"devclaw.surface/v2",interaction:"query",
    id:"notes",title:"笔记",placement:"sidebar",paneId:"notes",openAction:"open"},
  actions:[{id:"open",title:"查看笔记",inputSchema:{type:"object"},outputSchema:{type:"object"},
    requiredPermissions:["ui.open"],cancellable:true,idempotency:"keyed"}]
}, {act:async($,event)=>{await $.ui.open({id:"notes",title:"笔记"});return {}}})
on("ui.render",{component:"Pane",requestId:"notes"},($,event)=>{
  const {Text}=$.ui.resolve(event);return Text({children:"插件自己的笔记内容"})
})`

export const DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE = `import type { Register } from "devclaw-mods"
export const register: Register = (on) => {
  on("classic.PreSkillUse", { skill_name: "review" }, ($, event, next) => {
    $.ui.log("准备使用技能：" + event.skill_name)
    return next(event)
  })
  on("classic.PostSkillUse", { skill_name: "review" }, ($, event, next) => {
    $.ui.log("技能完成检查：" + event.skill_name)
    return next(event)
  })
}
`

export const DEVELOPMENT_PLACED_EXAMPLE = `on("session.start",async($,event,next)=>{
  await $.command.register({name:"show-checklist",description:"在聊天中显示检查卡片"})
  return next(event)
})
on("command.run",{command:"show-checklist"},async($)=>{
  const result=await $.ui.place({id:"checklist"})
  return {text:result.isPlaced ? "检查卡片已放入当前聊天。" : result.requestId
    ? "检查卡片已准备，返回当前聊天后显示。" : "当前无法放置检查卡片："+result.reason}
})
on("ui.render",{component:"Placed"},($,event,next)=>{
  if(event.props.plugin!==$.plugin.name||event.props.id!=="checklist") return next(event)
  const {Box,Text,Button}=$.ui.resolve(event)
  return Box({flexDirection:"column",gap:1,children:[
    Text({children:"这是一张可交互的插件卡片"}),
    Button({key:"refresh",label:"刷新",onPress:()=>$.ui.invalidate("ui.render")})
  ]})
})`

/** The same declarations go to the model and the actual isolated type checker. */
export function developmentCatalog() {
  return {
    contract: "cmb-desktop-authoring-v2",
    support: CREATOR_S1_SUPPORT,
    hostDisplay: describeFunctionDisplayRouting(),
    authoringTemplates: [...AUTHORING_TEMPLATE_KINDS],
    projectDependencies: PROJECT_DEPENDENCY_AUTHORING,
    draftWorkflow: {
      newDraft: "首次 revision=0。",
      scaffold: { saved: false, next: "result.files 完整数组传 submit.files。" },
      edit: "修改用 read(id).revision。",
      submitValid: "check.valid=true 后结束本轮等原生确认，勿重复提交。"
    },
    types: functionAuthoringDeclarations("result-v1"),
    events: FUNCTION_COMPATIBILITY_EVENT_NAMES.map((name) => ({
      name,
      ...getFunctionEventSupport(name)
    })),
    sdkMethods: [...FUNCTION_SDK_METHODS],
    runtimeExports: ["atom", "derive", "memberOf", "read", "update"],
    trialCapabilities: [...DEVELOPMENT_CAPABILITIES],
    authorizedTrialCapabilities: DEVELOPMENT_REAL_CAPABILITIES.filter(
      (value) => !value.startsWith("event:")
    ),
    trialEventEnvelope: [...DEVELOPMENT_EVENT_CAPABILITIES],
    trialEventConsent:
      "这组固定事件范围随 SDK 一起由用户确认；加载后逐项校验实际注册，拒绝通配符和范围外事件。",
    authorizedTrialEventConsent:
      "真实试用另按源码中的 literal 事件逐项申请已接通的事件（见 events 目录），不授予完整目录、动态或通配范围。",
    examples: {
      toolCounter: DEVELOPMENT_COUNTER_EXAMPLE,
      skillLifecycle: DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE
    },
    deliveryGuidance: [
      CREATOR_S1_SUPPORT.authoringConstraints.usageMetrics,
      "技能生命周期用 classic.PreSkillUse/PostSkillUse（本应用扩展），matcher 用 skill_name；从 events/types 读取宿主固定身份与结果。Pre block 阻止激活，Post block 请求修订、preventContinuation 才终止。普通 Mod 不能吞掉必需业务 Hooks，原脚本不自动迁移；真实试用须新确认。",
      "状态扩展用 scaffold(kind:state-extension)→save/check/request_trial，生成真实Mod、迁移计划和未执行测试。未确认原图、绑定writer并实测前仅hold，显示‘可执行决策骨架，未迁移状态’。inspect_raw.stateControl保原工具/Hooks/配置/知识；Host authority无需强迁。",
      "创造者模式按自然语言需求选择复用、组合或编写；不要让用户先配置添加功能、常用搭配或执行步骤。连续修改先 list/read 更新当前开发组件，保留已有功能。",
      "SDK路径确定、事件literal。包内唯一具名/const函数可接SDK/on，形参只读、闭包不逃逸。原生ui.render根保留词法回调，helper不继承。逐方法检查；动态/外部调用、方法传递、SDK返回/存储未验证。32轮/256边，不增授权。",
      "组合用 mod_composition list 搜索摘要，details 按需读取配置 schema；stage 同轮累积并深合并配置，可引用真实模型、技能、MCP 和已保存步骤。save/apply_saved 保存套用命名组合，undo/cancel 撤销选择或取消排队。提交后结束本轮，再核对真实回执。",
      "用户参数用userConfig及原生表单，缺必填项不能执行。升级可用userConfigSchema连续rename/remove迁移，须原生确认、失败保旧值；精确声明查询config.set。导出不含本机保存值、凭据或授权。",
      "快捷指令用灵件专属名称。MODS_COMMAND_CONFLICT须改本草稿指令名和说明再试用，不得关闭其他插件绕过。",
      "先list，按最新trials.phase/error回答；needs-approval仅快照，failed是加载失败。先读原因、修复再申请，勿循环轮询/重试。",
      "优先 submit；失败按诊断修复，有效即结束本轮等确认。当前聊天恢复用 resume_trial，跨聊天复用用 request_reuse；安装仍须原生确认。",
      "交付说明触发、效果和必要设置，省略内部技术细节。",
      "说明实际聊天与生效状态；切回普通模式不停止试用。",
      "明确触发条件，例如 edit_file 完成后触发，不等于发送普通消息后触发。注册的命令写明参数示例。",
      "文件/网络/模型/进程/业务能力可直接申请真实试用，无需先安装。确认绑定当前源码和目标，执行沿原权限；静态检查、隔离预览和批准不是实际结果。",
      "session.start仅登记指令/无副作用界面；文件/网络/模型/长期任务放生效后的用户动作。候选禁止外部效果，失败保留旧可用版。",
      "动作后读取或platform.read/status核实，不凭模型说明标完成。未知结果先读、不重放；新增权限须确认。",
      "工作流发现native.workflow/runs@1.0.0；read/subscribe/poll观察原运行器，target仅current。截断用inspect偏移；agentIndex空禁猜；cancel沿原确认并等真实清理。",
      "result-v1 tool.call返回{result}，保留next的ref以保原结果；追加说明用context字符串数组，通知await $.ui.toast(text)。",
      "制作轮中断后可在新的制作轮对未修改的草稿重新 request_trial；仍须等待新轮完成，不能报告已经生效。"
    ],
    package: {
      "plugin.json": {
        name: "my-component",
        version: "0.1.0",
        description: "组件说明",
        mods: "mods/manifest.json"
      },
      "mods/manifest.json": {
        apiVersion: "cmb.mods/v2",
        id: "my-component",
        entry: "main.ts"
      },
      "mods/main.ts": DEVELOPMENT_COUNTER_EXAMPLE
    },
    limitations: [
      "桌面适配子集；条件与宿主边界见定向查询，非全上游等价。",
      "旧本地试用接受 trialCapabilities；超出该范围且属于 authorizedTrialCapabilities 时，需用户批准精确源码摘要和当前目标后真实验证。其他方法不可用，不得绕过宿主授权。",
      "关闭制作面板不会停止已生效任务；停止试用、撤权、删除和退出应用会清理所属资源。普通定时器退出后不运行，重启不恢复试用授权或自动重放动作。",
      "轮次结束并且真实任务结算后才应用；request_trial 返回排队状态，不是生效证明。",
      "模块局部变量在重新加载后重置；状态需显式使用宿主接口。",
      "仅改当前草稿。"
    ]
  }
}

/** Targeted discovery stays within the normal tool-result budget instead of dumping the SDK. */
export function developmentCatalogPage(
  section: "overview" | "types" | "events" | "sdk" | "support" = "overview",
  cursor = 0,
  query?: string
) {
  const catalog = developmentCatalog()
  if (query !== undefined) {
    if (!query.trim() || query.length > 120) throw Error("DEVELOPMENT_CATALOG_QUERY")
    if (!["overview", "types", "events", "sdk"].includes(section))
      throw Error("DEVELOPMENT_CATALOG_QUERY_SECTION")
    const exact = query.trim()
    const workbench = section === "events" ? undefined : developerWorkbenchDiscovery(exact, cursor)
    if (workbench) return { contract: catalog.contract, section, ...workbench }
    const registration = exact === "on.capability"
    const events = section === "sdk" && !registration ? [] : catalog.events.filter((event) =>
      event.name === (registration ? "platform.action" : exact))
    const methods = section === "events" || registration ? []
      : catalog.sdkMethods.filter((method) => method === exact)
    const exports = section === "events" || registration ? [] :
      catalog.runtimeExports.filter(name => name === exact)
    const declarations = targetedDeclarations(catalog.types, events.map((event) => event.name), methods, exports)
    const text = [...declarations.signatures, ...declarations.types].join("\n\n")
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
      throw Error("DEVELOPMENT_CATALOG_CURSOR")
    const end = Math.min(cursor + 4500, text.length)
    return {
      contract: catalog.contract, section, query: exact, cursor,
      scope: "static-authoring-contract", grantsAuthority: false,
      ...((exact.startsWith("agent.") || exact === "ui.view") && cursor === 0 ? {
        usageExample: "const task=await $.agent.spawn({prompt:'核对指定任务',description:'核对'}); const status=await $.agent.status({agentId:task.agentId}); const page=await $.agent.messages({agentId:task.agentId,limit:50}); /* nextCursor 只用于同一任务；记录变化时从第一页重新读取。真实按钮回调中 await $.ui.view({agentId:task.agentId})；停止用 $.agent.stop。 */",
        agentScope: "status/messages/stop/view仅普通本地父聊天、本源码摘要创建的真实子任务；spawn原权限核模型/工具/目录。messages按保留checkpoint分页，非完整转录，skippedMessages标缺项。重启无活跃控制器为unknown，不重跑。ui.view仅真实用户控件动作；默认只读，显式mode:interactive经原生激活ack后暂停父输入，向目标子任务入队，返回恢复父草稿。requested非已激活，isDelivered非已处理。agent.list列出不授予读取权。"
      } : {}),
      ...(exact.startsWith("mcp.") && cursor === 0 ? {
        usageExample: "const catalog=await $.mcp.list(); const source=catalog.sources[0]; if(source){const connection=await $.mcp.connect(source.sourceId); if(connection.isConnected){const state=await $.mcp.status({server:connection.server}); /* Use only this lease's advertised real tool name with $.mcp.call. */ await $.mcp.disconnect({server:connection.server});}}",
        mcpScope: "仅当前普通聊天Claw明确选择的id+配置摘要。宿主管理stdio/Streamable HTTP/SSE命令、URL和认证，插件只传sourceId；远程同源、禁重定向/自动协议回退/工具重放。项目或子会话缺等价选择证明仍拒绝。server是本组件独占opaque句柄；跨来源/过期不回退全局。list/status/disconnect为桌面扩展，读取不初始化。取消关闭该连接；unknown表示本机回收未确认，不代表远程任务停止，不能自动重连。撤权/来源或选择变更/重载清理。"
      } : {}),
      ...(exact === "http.fetch" && cursor === 0 ? {
        networkGuide: "请求用户实际能访问的完整HTTP/HTTPS地址，保留端口和路径；不要将服务监听地址当访问地址。本机开发服务通常使用localhost或127.0.0.1及真实端口，不猜端口。授权仅允许请求，不证明服务可达。失败显示error.message中的安全诊断；不得自动重放有副作用请求或关闭TLS证书校验。当前传输不自动继承浏览器登录态或代理。HTTP 4xx/5xx是响应，须检查status/ok，不能当网络断开。"
      } : {}),
      ...(exact === "config.set" && cursor === 0 ? {
        migrationExample: "userConfigSchema:{version:1,migrations:[{fromVersion:0,toVersion:1,changes:[{kind:'rename',from:'oldLabel',to:'label'}]}]}, cmbCompatibility:{modelProtocol:'result-v1',userConfigMigrations:'v1'}。删除用{kind:'remove',key:'字段名'}；后续逐版本连续迁移，原生确认，失败保留旧值，不执行迁移脚本。"
      } : {}),
      ...(exact === "ui.resolve" && cursor === 0 ? {
        usageExample: DEVELOPMENT_LAYOUT_EXAMPLE,
        layoutScope: "同一桌面声明树用于面板、页面、侧栏和工具栏；只影响插件内容，外层授权/关闭控件保留。间距8px单位，尺寸为字符/行或0..100%。仅白名单样式、有界局部定位和hover，无raw CSS/DOM。精确属性与条件见UiBoxProps/UiTextProps。"
      } : {}),
      ...(exact === "ui.render" && cursor === 0 ? {
        placementGuide: "ChatHeader：固定在当前聊天页顶部，滚动消息不移动；AbovePrompt：固定在输入框上方。两者独立滚动，props.maxRows/bodyColumns 是可用尺寸，勿重复按 scroll.offset 裁剪完整 DOM 表单。多字段/长报告用 Pane 或 capability surface placement:sidebar/page；侧栏与聊天并列，不是聊天消息。Placed 随消息滚动。固定指聊天区域，不覆盖窗口标题栏/原生审批。空树不占位。",
        usageExample: 'on("ui.render", {component:"ChatHeader"}, ($,event)=>$.ui.resolve(event).Text({children:"工作台状态"}))',
        renderSites: catalog.support.sites
      } : {}),
      ...(exact === "ui.place" && cursor === 0 ? {
        usageExample: DEVELOPMENT_PLACED_EXAMPLE,
        placedScope: "启动只登记显示命令，试用生效后运行show-checklist才放卡；候选不能改活跃聊天。id为1..64字母数字_-，同来源id更新原位置；仅普通父聊天。props.id/plugin只读，pass画空。不入模型/转录，重启不恢复；真实压缩提交、关闭、撤权/来源替换清理。isPlaced表示surface附着；false带requestId等待本进程界面，无requestId未登记。真实用户动作可ui.scroll到自己有效requestId，虚拟列表实际挂载可见才回执。"
      } : {}),
      events, sdkMethods: methods, runtimeExports: exports,
      ...(registration ? { registration: "on.capability", event: "platform.action" } : {}),
      ...(registration && cursor === 0 ? {
        usageExample: DEVELOPMENT_SURFACE_EXAMPLE,
        surfaceScope: "登记不等于打开。来源批准后，在原聊天的插件界面入口显式打开；openAction只初始化自己的Pane，关闭由宿主清理。v2交互仅允许只读查询与局部UI，不执行模型/网络/进程/写入或任务控制；有业务动作使用原v1队列及真实权限。placement仍在当前聊天内，不替换项目模式或全局设置。"
      } : {}),
      matched: events.length + methods.length + exports.length > 0,
      declarationAvailable: declarations.signatures.length > 0,
      content: text.slice(cursor, end), totalCharacters: text.length,
      complete: end === text.length,
      ...(end < text.length ? { nextCursor: end } : {}),
      declarationScope:
        "同一 result-v1 作者声明的精确签名及引用数据类型片段，并非完整独立 d.ts。SDK<Owner> 由宿主提供；按 SDK 方法继续 query。运行时支持不保证存在作者重载；无签名不编造。",
      discovery:
        "query 精确匹配事件名或 SDK 方法；默认 overview 同时匹配两类。完整类型仍用 catalogSection=types 分页；有 nextCursor 时继续同一 query。静态发现不含已安装动作或授权。"
    }
  }
  if (section === "support") {
    const capabilities = catalog.support.conditionalCapabilities
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > capabilities.length)
      throw Error("DEVELOPMENT_CATALOG_CURSOR")
    const page = (size: number) => ({
      contract: catalog.contract,
      section,
      cursor,
      content: {
        ...catalog.support,
        // Shared authoring contracts appear once, with an explicit discoverable reference on
        // later pages. Repeating them beside every growing capability breaks bounded discovery.
        authoringConstraints: cursor === 0 ? catalog.support.authoringConstraints : undefined,
        ...(cursor === 0 ? {} : {
          authoringConstraintsDiscovery: { section: "support" as const, cursor: 0 }
        }),
        conditionalCapabilities: capabilities.slice(cursor, cursor + size)
      },
      ...(cursor + size < capabilities.length ? { nextCursor: cursor + size } : {})
    })
    let size = Math.min(2, capabilities.length - cursor)
    while (size > 1 && JSON.stringify(page(size)).length >= 7980) size--
    const result = page(size)
    if (JSON.stringify(result).length >= 7980) throw Error("DEVELOPMENT_SUPPORT_PAGE_LIMIT")
    return result
  }
  if (section === "overview")
    return {
      contract: catalog.contract,
      hostDisplay: catalog.hostDisplay,
      supportProfile: {
        id: catalog.support.id,
        section: "support",
        scope: catalog.support.scope,
        conditionalCapabilities: catalog.support.conditionalCapabilities.map(
          ({ id, availability, nextDiscovery }) => ({ id, availability, nextDiscovery })
        )
      },
      trialCapabilities: catalog.trialCapabilities,
      runtimeExports: catalog.runtimeExports,
      authorizedTrialCapabilities: catalog.authorizedTrialCapabilities,
      trialEventEnvelope: catalog.trialEventEnvelope,
      trialEventConsent: catalog.trialEventConsent,
      authorizedTrialEventConsent: catalog.authorizedTrialEventConsent,
      package: catalog.package,
      examples: { skillLifecycle: catalog.examples.skillLifecycle },
      authoringTemplates: catalog.authoringTemplates,
      draftWorkflow: catalog.draftWorkflow,
      deliveryGuidance: catalog.deliveryGuidance,
      limitations: catalog.limitations,
      discovery:
        "query精查；types按nextCursor分页。native.code/native.editor/native.workspace查工作台公共协议，非新SDK命名空间。project-dependencies查未安装执行/校验Mod；sourceId→dependency_prepare，assetPath读源码，project_read仅草稿。"
    }
  const value =
    section === "types" ? catalog.types : section === "events" ? catalog.events : catalog.sdkMethods
  const size = section === "types" ? 6000 : section === "events" ? 12 : 60
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > value.length)
    throw Error("DEVELOPMENT_CATALOG_CURSOR")
  return {
    contract: catalog.contract,
    section,
    cursor,
    content: value.slice(cursor, cursor + size),
    ...(section === "types" ? { discovery: "可用 catalogSection=events/sdk 配合 query 精确事件名或SDK方法定向读取；此处保持完整类型原样分页。" } : {}),
    ...(cursor + size < value.length ? { nextCursor: cursor + size } : {})
  }
}

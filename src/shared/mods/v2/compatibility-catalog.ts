/** Exact host adapters only; a matching event name does not establish tool equivalence. */
export const FUNCTION_NATIVE_TOOL_COMPATIBILITY: Readonly<Record<string,
  { support: "bounded" | "unsupported"; note: string }>> = {
  Read: { support: "bounded", note: "通过 read_file 适配，行偏移按原版转换。" },
  Write: { support: "bounded", note: "通过 write_file 适配，仍需实际文件权限。" },
  Edit: { support: "bounded", note: "通过 edit_file 适配，仍需实际文件权限。" },
  Bash: { support: "bounded", note: "通过 execute 适配，不代表所有 shell 参数和平台可用。" },
  Grep: { support: "unsupported", note: "没有原版 Grep 的等价宿主；本机 grep 的字面量搜索不能当作原版正则搜索。" },
  Glob: { support: "unsupported", note: "没有原版 Glob 的等价宿主参数与结果适配。" },
  MultiEdit: { support: "unsupported", note: "没有原版 MultiEdit 的等价宿主执行适配。" }
}

export const FUNCTION_LOCAL_TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "execute", "ls", "glob", "grep",
  "request_user_input", "task_output"
] as const

/** Production event providers. "bounded" means an adapter exists, never full upstream parity. */
const bounded = new Set([
  "config.list",
  "config.set",
  "config.describe",
  "session.measure",
  "session.append",
  "prompt.submit",
  "prompt.read",
  "prompt.fill",
  "prompt.edit",
  "prompt.suggest",
  "prompt.compose",
  "prompt.section",
  "prompt.context",
  "prompt.attachment",
  "prompt.mention",
  "tool.describe",
  "skill.prompt",
  "agent.spawn",
  "agent.register",
  "session.send",
  "session.receive",
  "process.run",
  "process.spawn",
  "settings.read",
  "env.get",
  "http.fetch",
  "clock.after",
  "clock.every",
  "session.root",
  "session.version",
  "fs.ancestors",
  "tool.call",
  "tool.check",
  "ui.render",
  "ui.resolve",
  "ui.press",
  "ui.input",
  "ui.select",
  "ui.message",
  "ui.fault",
  "ui.scroll",
  "ui.focus",
  "agent.offer",
  "command.run",
  "command.describe",
  "session.start",
  "session.end",
  "session.compact",
  "turn.start",
  "turn.step",
  "turn.complete",
  "engine.create",
  "model.complete",
  "model.classify",
  "model.fork",
  "mcp.call",
  "session.cwd",
  "session.model",
  "session.turns",
  "session.id",
  "session.messages",
  "session.repo",
  "session.surface",
  "session.surfaces",
  "session.authorize",
  "session.usage",
  "turn.abort",
  "tool.list",
  "tool.register",
  "command.list",
  "command.register",
  "agent.list",
  "ui.toast",
  "ui.status",
  "ui.log",
  "ui.notice",
  "ui.invalidate",
  "ui.copy",
  "ui.selection",
  "ui.panes",
  "ui.open",
  "ui.close",
  "platform.action",
  "fs.read",
  "fs.write",
  "fs.list",
  "fs.exists",
  "fs.stat",
  "store.get",
  "store.set",
  "store.delete",
  "store.keys",
  "state.get",
  "state.set",
  "clock.now",
  "clock.sleep",
  "completion.check",
  "classic.PreToolUse",
  "classic.PreSkillUse",
  "classic.PostSkillUse",
  "classic.PostToolUse",
  "classic.PostToolUseFailure",
  "classic.PostToolBatch",
  "classic.Notification",
  "classic.UserPromptSubmit",
  "classic.UserPromptExpansion",
  "classic.SessionStart",
  "classic.SessionEnd",
  "classic.Stop",
  "classic.StopFailure",
  "classic.SubagentStart",
  "classic.SubagentStop",
  "classic.PreCompact",
  "classic.PostCompact",
  "classic.Setup",
  "classic.InstructionsLoaded"
])

const metadata = new Set([
  "classic.PermissionDenied",
  "classic.PreModelSwitch",
  "classic.PostModelSwitch",
  "classic.PermissionRequest",
  "classic.TaskCreated",
  "classic.TaskCompleted",
  "classic.Elicitation",
  "classic.ElicitationResult",
  "classic.ConfigChange",
  "classic.WorktreeCreate",
  "classic.WorktreeRemove",
  "classic.CwdChanged",
  "classic.FileChanged",
  "classic.DirectoryAdded",
  "classic.MessageDisplay"
])

const unavailable = new Set([
  "mcp.connect",
  "telemetry.log",
  "telemetry.mark",
  "attribution.text",
  "session.attach",
  "session.detach",
  "plugin.register",
  "audio.play",
  "audio.speak",
  "ui.blit",
  "env.set",
  "classic.TeammateIdle"
])

export const FUNCTION_COMPATIBILITY_EVENT_NAMES = [...bounded, ...metadata, ...unavailable]

export function getFunctionEventSupport(
  name: string
): { availability: "bounded" | "metadata" | "unavailable"; note: string } | undefined {
  if (name === "classic.PreSkillUse" || name === "classic.PostSkillUse")
    return {
      availability: "bounded",
      note: "本应用扩展：真实技能激活前/完成后事件，skill_name 等身份由宿主固定。Pre 的 block 阻止激活；Post 的 block 请求修订，preventContinuation 才终止；Post 非阻断上下文仅观察。普通 Mod 出错可恢复，不能吞掉原必需业务 Hooks、伪造完成或绕过来源与权限检查。需精确事件与源码的新确认，不代表自动迁移原脚本。"
    }
  if (name === "platform.action")
    return {
      availability: "bounded",
      note: "通过 on.capability 登记的版本化能力动作；宿主验证声明、来源、当前目标、输入及双方权限后执行。发现和登记不会启动任务，普通事件名称不能替代有效能力声明。"
    }
  if (["config.list", "config.set", "config.describe"].includes(name))
    return {
      availability: "bounded",
      note: "读取和修改真实 Git 设置与可公开的插件参数。原生参数表单支持敏感值、列表和文件/目录；敏感值不进入配置查询。保存与应用分别显示，需要启动操作时明确重载当前组合。"
    }
  if (name === "prompt.submit")
    return {
      availability: "bounded",
      note: "普通文字发送与运行中引导；组件也可以提交纯文字新任务，忙时排队，沿用当前模型和权限。按钮、任务完成通知和定时回调可提交；组件命令中不能直接提交。含附件、显式技能、目标控制和内部通知仍沿用原入口。"
    }
  if (name === "session.end") return {
    availability: "bounded",
    note: "删除已运行的对话或退出应用时通知一次，先完成原退出脚本，再由全部组件共用1.5秒。未启动组件不自动运行；切换页面、重载和撤权不算对话结束。记录ID不代表删除后还能恢复。"
  }
  if (name === "session.append") return {
    availability: "bounded",
    note: "已接入发送内容、模型回答和工具返回的真实消息保存流程，可由组件调整正文并供后续任务使用。沿用当前任务的权限和内容保护，不能任意替换以前保存的记录。不同界面的实时反馈仍需继续验证，不代表原版全部功能。"
  }
  if (name === "mcp.connect") return {
    availability: "unavailable",
    note: "当前主版本尚未开放组件主动连接服务。已经配置好的 MCP 工具仍可通过原 mcp.call 和 DIY 流程使用；新连接接口待后续完整验证后开放。"
  }
  if (["turn.step", "process.spawn"].includes(name)) return {
    availability: "bounded",
    note: "实际输出逐段传递，回答自身时间累计、进程输出逐段重新计时；等待实际下游和SDK不扣自身时间。恢复保留未交付输出，不重复模型或进程；总期限、用户取消和真实清理继续有效。"
  }
  if (["clock.after", "clock.every"].includes(name)) return {
    availability: "bounded",
    note: "后台定时任务在创建操作结束后继续。周期回调偶尔失败会记录错误，下周期重新检查；明确取消、重载、撤权或退出后停止。一次任务失败不重复，后台回调沿用原权限，不自动开启聊天。"
  }
  if (name === "prompt.context")
    return {
      availability: "bounded",
      note: "控制实际可确认的 AGENTS.md 规范，支持同一运行内真实来源复用、主动刷新及 SDK 试算；Harness 不伪造文件来源。沿用 DevClaw 系统提示位置，不跨任务复用。"
    }
  if (name === "prompt.mention")
    return {
      availability: "bounded",
      note: "处理本次桌面发送中的项目文本 @ 引用，沿用目录、文件权限和附件额度。草稿刷新恢复后，实际发送时仍重新检查并读取最新正文；不能跨任务沿用旧许可。安装组件或登记事件不授予任意文件读取权限。"
    }
  if (name === "prompt.attachment")
    return {
      availability: "bounded",
      note: "处理实际输出风格提醒正文，宿主保留包装；支持真实来源复用、主动刷新及 SDK 试算。项目文件引用先由 prompt.mention 处理，读取正文后再经过附件处理；媒体仍沿原入口，不跨任务复用。"
    }
  if (name === "prompt.edit")
    return {
      availability: "bounded",
      note: "真实桌面文字输入、光标、粘贴和输入法提交；发送前验证当前版本。支持文字装饰，附件和技能选项不进入编辑事件。"
    }
  if (name === "prompt.suggest")
    return {
      availability: "bounded",
      note: "已批准组件通过 SDK 提供下一步建议，经过其他组件处理后在空闲空白输入框显示；Tab 或 → 接受后仍需用户发送。没有自动生成建议的默认模型入口。"
    }
  if (["ui.copy", "ui.selection", "ui.panes"].includes(name))
    return {
      availability: "bounded",
      note: "已有实际桌面适配：复制使用真实剪贴板回执；选择限定当前聊天和插件结果；面板状态来自该组件当前绘制。没有终端或远程界面适配。"
    }
  if (name === "ui.fault")
    return {
      availability: "bounded",
      note: "桌面面板及已有聊天位置的 Client 出错后通知所属组件，并重画一次备用内容；恢复中新组件再次出错只通知。撤权、旧问题失效和内容保护拒绝不会冒充组件故障。"
    }
  if (name === "ui.render")
    return {
      availability: "bounded",
      note: "可以在已有聊天位置包装、移动和组合原有正文、工具详情及问答控件；next 保留真正原界面。问答只保留一套真实选项和提交，布局不改变工具执行、审批或回答身份。新版本需要重新批准组件；独立 Client 不能嵌入原生位置。"
    }
  if (name === "ui.resolve")
    return {
      availability: "bounded",
      note: "可以跨插件替换桌面的十种元素构造方法，包括 Markdown，支持透明 Fragment。定义方法的插件沿用自己的权限，按钮和 Markdown 链接仍执行原绘制插件的动作；整个原绘制插件不参与替换。Client Markdown 仅显示，使用独立指针路径。链接和文件预览以当前受保护画面及本机只读权限为准。初始化、等待、重载和容量受本机边界约束，其他界面和任意原版构造器尚未全部对齐。"
    }
  if (bounded.has(name))
    return { availability: "bounded", note: "已有生产适配器；仍受本机权限、会话和界面边界约束。" }
  if (metadata.has(name))
    return { availability: "metadata", note: "仅有事件结构定义，尚未接入实际业务触发点。" }
  if (unavailable.has(name))
    return {
      availability: "unavailable",
      note: "此事件尚无生产提供者，不能依靠它执行实际业务。"
    }
  return undefined
}

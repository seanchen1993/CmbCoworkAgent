/** User guidance is attached to known events, never guessed from an author's matcher. */
export function functionEventUsage(event: string): { when: string; effect: string; range: string } {
  if (event === "session.start") return {
    when: "组件首次启动，或明确重新加载当前组合时",
    effect: "按当前参数准备组件，也可以请模型做一次独立分析供后续命令使用。",
    range: "普通保存不会偷偷请求模型。分析使用新组合的规则；失败需修正后明确重试。"
  }
  if (event === "session.measure") return {
    when: "主助手任务保存最终状态后，真实用量发生变化时",
    effect: "让组件自动更新用量提示；只通知实际数字，不能修改回答或账单。",
    range: "提供当前模型窗口及已返回的输入量。本地没有 Claude 账户额度和美元费用，组件不会看到编造的统计。"
  }
  if (event === "ui.copy") return {
    when: "组件复制文字时",
    effect: "多个组件可接力整理或拒绝复制内容，只有真的写入剪贴板才返回成功。",
    range: "当前桌面聊天；不会读取剪贴板或其他应用。没有实际界面时明确返回未复制。"
  }
  if (event === "ui.selection") return {
    when: "组件使用你选中的聊天文字时",
    effect: "选中文字，再点组件按钮或运行命令，组件便可整理、检视或复制这段内容。",
    range: "只读当前聊天及插件结果。新选择替换旧选择；Escape、命令或任务结束后清除，设置页不可读。"
  }
  if (event === "ui.panes") return {
    when: "组件查询自己的面板时",
    effect: "知道自己的面板是否已显示、折叠或获得焦点，按实际界面调整交互。",
    range: "只列该组件自己的已打开面板；查询不会重画面板或打开新面板。"
  }
  if (event === "prompt.edit") return {
    when: "编辑聊天输入框时",
    effect: "按自己的规则整理、拒绝或标记输入文字；发送前会检查最新内容。",
    range: "只处理文字与光标。输入法完成后统一检查；附件、技能选择和原来的任务队列继续沿用。"
  }
  if (event === "prompt.suggest") return {
    when: "组件主动提供下一步建议时",
    effect: "在空白且空闲的输入框显示建议，按 Tab 或 → 接受，检查后自己发送。",
    range: "组件需先提供建议内容；不会自动替你发消息。正在输入、任务运行或过期建议不显示。"
  }
  if (event === "prompt.context") return {
    when: "准备项目规范时",
    effect: "选择、调整这次给助手的项目规范，也能加入自己的背景说明。",
    range: "已确认来源的 AGENTS.md 文件；插件提供的规范只有文字时，不显示虚构文件来源。"
  }
  if (event === "prompt.attachment") return {
    when: "准备附加提醒时",
    effect: "调整或移除输出风格提醒，保留原任务和工具结果。",
    range: "目前接入输出风格提醒；不会把上传的图片、音频或任意文件当作可改写文字。"
  }
  if (event === "prompt.submit")
    return {
      when: "发送任务或组件安排后续工作时",
      effect: "整理任务文字、补充仅供助手参考的信息，或说明为什么暂不接收。",
      range: "普通模式的纯文字发送和运行中引导；组件按钮、完成通知和定时回调也可提交纯文字新任务，忙时排队，沿用当前模型和权限。含附件、技能选项、目标控制和内部消息沿用原处理。"
    }
  if (event === "turn.step")
    return {
      when: "助手每次思考时",
      effect: "按规则选择已配置的模型，或处理助手的回答。",
      range: "主助手及已接入的子助手；子助手不会改变主对话的模型选择。回答可逐段显示，等待模型不扣组件处理时间。"
    }
  if (event === "process.spawn") return {
    when: "组件启动并读取命令进程时",
    effect: "边收到输出边整理，不必等进程结束。",
    range: "每段分别计算组件处理时间，等待下一段不扣时间。取消和原权限检查保留，组件异常不会重新启动进程。"
  }
  if (event === "prompt.compose" || event === "prompt.section")
    return {
      when: "准备工作规则时",
      effect: "调整助手这次要遵守的工作说明。",
      range: "主助手、已接入子助手和独立分析各用自己的说明。"
    }
  if (event === "turn.complete" || event === "completion.check")
    return {
      when: "任务准备结束时",
      effect: "执行作者提供的结束规则，例如代码检视和交付检查。",
      range: "具体是否检查代码取决于组件内容；选择组件不会自动产生检视能力。"
    }
  if (event.startsWith("model."))
    return {
      when: "组件请模型单独分析时",
      effect: "让独立分析也经过已批准的规则。",
      range: "只使用这次分析自己的内容，分开计算额度。等待模型不消耗规则自身处理时间，仍有总等待和取消限制。"
    }
  if (event === "tool.call" || event === "tool.check")
    return {
      when: "助手使用工具时",
      effect: "检查或处理实际工具调用，例如运行命令、读取文件。",
      range: "仍需通过原有权限检查。"
    }
  if (event.startsWith("command."))
    return {
      when: "使用组件提供的命令时",
      effect: "在聊天中输入作者说明的命令来触发。",
      range: "命令名称与参数查看该组件的使用说明。"
    }
  return {
    when: "对应功能触发时",
    effect: "执行组件作者为这个入口编写的规则。",
    range: "查看下方支持范围；未知入口不能据此认定会生效。"
  }
}

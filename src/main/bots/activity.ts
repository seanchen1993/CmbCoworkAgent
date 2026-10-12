import type { BotActivity } from "../../shared/bot-types"

/** Tool identifiers remain in audit events; user-facing progress describes the action. */
export function botToolActivity(name: string): BotActivity {
  if (name === "send_message") return { kind: "tool", description: "正在发送工作进展" }
  if (name === "write_todos") return { kind: "tool", description: "正在更新任务进度" }
  if (name === "read_task_history") return { kind: "tool", description: "正在查阅任务原始记录" }
  if (name === "create_bot") return { kind: "collaboration", description: "准备创建协作 Bot" }
  if (name === "update_bot") return { kind: "collaboration", description: "准备调整 Bot 职责" }
  if (name === "read_bot") return { kind: "collaboration", description: "正在查看 Bot 职责" }
  if (name === "dispatch_task") return { kind: "collaboration", description: "正在分派子任务" }
  if (name === "check_task") return { kind: "collaboration", description: "正在查看子任务进展" }
  if (name === "message_task") return { kind: "collaboration", description: "正在向子任务补充要求" }
  if (name === "stop_task") return { kind: "collaboration", description: "正在停止指定子任务" }
  if (name === "execute") return { kind: "tool", description: "正在执行项目命令" }
  if (name.includes("connector")) return { kind: "tool", description: "正在使用连接器" }
  if (name === "project_read") return { kind: "file", description: "正在阅读项目文件" }
  if (name === "read_global_instructions") return { kind: "file", description: "正在读取工作规则" }
  if (name === "project_view") return { kind: "file", description: "正在查看项目文档与图像" }
  if (name === "project_list") return { kind: "file", description: "正在查看项目目录" }
  if (name === "project_edit") return { kind: "file", description: "正在准备代码变更" }
  if (name === "project_publish") return { kind: "file", description: "正在交付项目文件" }
  if (name === "browser") return { kind: "browser", description: "正在操作浏览器" }
  if (name === "native_computer") return { kind: "browser", description: "正在操作工作应用" }
  if (name === "request_computer_help")
    return { kind: "browser", description: "等待你协助操作电脑" }
  if (name === "message_bot") return { kind: "collaboration", description: "正在安排协作任务" }
  if (name === "list_groups") return { kind: "collaboration", description: "正在查找所属群聊" }
  if (name === "post_to_group") return { kind: "collaboration", description: "准备向群聊交付成果" }
  if (name === "await_bot_result") return { kind: "collaboration", description: "等待协作结果" }
  if (name === "read_file") return { kind: "file", description: "正在阅读文件" }
  if (name === "list_skill_files") return { kind: "file", description: "正在查看技能附属文件" }
  if (name === "read_skill_file") return { kind: "file", description: "正在阅读技能资料" }
  if (name === "copy_skill_file") return { kind: "file", description: "准备复制技能脚本或模板" }
  if (name === "upload_file") return { kind: "file", description: "准备向网站上传文件" }
  if (name === "download_file") return { kind: "file", description: "正在下载文件" }
  if (name === "create_presentation") return { kind: "file", description: "正在制作演示文稿" }
  if (name === "deliver_file") return { kind: "file", description: "正在整理交付文件" }
  if (name === "list_files") return { kind: "file", description: "正在查找资料" }
  if (name === "list_routines" || name === "read_routine" || name === "list_routine_runs")
    return { kind: "routine", description: "正在查看例程" }
  if (name === "update_routine") return { kind: "routine", description: "正在更新例程" }
  if (name === "delete_routine") return { kind: "routine", description: "准备确认例程删除" }
  if (name.includes("routine")) return { kind: "routine", description: "正在安排例程" }
  if (name.includes("memory") || name.includes("skill"))
    return { kind: "memory", description: "正在整理项目经验" }
  if (name === "ask_user" || name === "request_user_input" || name === "request_user_form")
    return { kind: "tool", description: "准备向你确认信息" }
  if (name === "request_secret" || name === "fill_secret")
    return { kind: "browser", description: "等待安全输入授权" }
  if (name === "list_secrets") return { kind: "tool", description: "正在查找可用凭据" }
  return { kind: "tool", description: "正在处理任务" }
}

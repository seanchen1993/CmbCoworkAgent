import type { On, SDK } from "claude-code"
import { analysisRequest, emptyDraft, readDraft, validateDraft } from "./request"
import { demoDraft } from "./demo"

export function register(on: On) {
  let draft = emptyDraft()
  let previousDraft: ReturnType<typeof emptyDraft> | undefined
  let pending = false
  let expanded = true
  let help = false
  let showFocus = false
  let showCommands = false
  let currentDirectory = ""
  let status = "选择源码目录 → 补齐代码并联调 → 在聊天查看改动和验证结果。"

  const open = ($: SDK) => {
    expanded = true
    $.ui.invalidate("ui.render")
  }

  on("session.start", async ($, event, next) => {
    draft = readDraft(await $.store.get("draft"))
    currentDirectory = await $.session.cwd()
    await $.command.register({
      name: "api-workbench",
      description: "展开聊天顶部的联调工作台",
      immediate: true
    })
    return next(event)
  })

  on("command.run", { command: "api-workbench" }, ($) => {
    open($)
    return { text: "工作台已在聊天顶部展开。填写源码目录、页面与文档后点击“补齐代码并联调”。" }
  })

  on("ui.render", { component: "ChatHeader" }, ($, event) => {
    const { Box, Text, Input, Button } = $.ui.resolve(event)
    const redraw = () => $.ui.invalidate("ui.render")
    const field = (name: keyof typeof draft, label: string, placeholder: string, rows = 1) =>
      Input({
        key: name,
        label,
        placeholder,
        rows,
        value: draft[name],
        submitLabel: "",
        onInput: (value) => {
          draft[name] = value
        },
        onSubmit: (value) => {
          draft[name] = value
        }
      })
    const useDemo = async () => {
      if (pending) return
      currentDirectory = await $.session.cwd()
      previousDraft ??= { ...draft }
      draft = demoDraft(currentDirectory)
      expanded = true
      status =
        "已填入半成品示例参数，请确认源码目录是解压的 frontend-api-starter。点击补齐后助手会读取源码并启动服务。"
      redraw()
    }
    const controls = [
      Button({
        key: "analyze",
        label: pending ? "正在提交，请勿重复点击…" : "补齐代码并联调",
        variant: "primary",
        onPress: async () => {
          if (pending) return
          pending = true
          try {
            const input = validateDraft(draft)
            currentDirectory = await $.session.cwd()
            await $.store.set("draft", { ...input })
            status = "正在交给当前聊天；已有任务时会排队。执行情况见下方聊天。"
            // The public receipt is not proof of task start or completion.
            // Release the UI action lease before the queued task acquires its own lease.
            void $.prompt
              .submit({ text: analysisRequest(input, currentDirectory), asUser: true })
              .then(
                (result) => {
                  pending = false
                  status =
                    typeof result.drop === "string"
                      ? "收到提示：" + result.drop + "。请先查看聊天中的任务状态，避免重复提交。"
                      : "提交已处理。请在下方聊天查看执行进度和报告；右侧浏览器显示被测页面。"
                  redraw()
                },
                (error) => {
                  pending = false
                  status =
                    "提交过程出现问题：" +
                    String(error) +
                    "。输入已保留。请先查看聊天中的任务状态，避免重复提交。"
                  redraw()
                }
              )
          } catch (error) {
            pending = false
            expanded = true
            status = String(error)
          }
          redraw()
        }
      }),
      Button({ key: "demo", label: "填入演示案例", onPress: useDemo }),
      ...(previousDraft
        ? [
            Button({
              key: "restore-draft",
              label: "恢复原输入",
              onPress: () => {
                if (pending || !previousDraft) return
                draft = previousDraft
                previousDraft = undefined
                status = "已恢复填入演示前的输入。"
                redraw()
              }
            })
          ]
        : [])
    ]
    return Box({
      flexDirection: "column",
      gap: 0.5,
      padding: 1,
      minWidth: 0,
      borderStyle: "single",
      borderColor: "promptBorder",
      backgroundColor: "inverseText",
      children: [
        Box({
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
          children: [
            Text({ children: "前后端联调工作台", bold: true, color: "text" }),
            Text({ children: "使用当前聊天模型", size: "caption", dimColor: true }),
            Button({
              key: "toggle-config",
              label: expanded ? "收起配置" : "展开配置",
              onPress: () => {
                expanded = !expanded
                redraw()
              }
            }),
            Button({
              key: "help",
              label: help ? "收起说明" : "使用说明",
              onPress: () => {
                help = !help
                redraw()
              }
            })
          ]
        }),
        ...(expanded
          ? [
              Box({
                flexDirection: "row",
                alignItems: "center",
                gap: 1,
                minWidth: 0,
                children: [
                  field("projectRoot", "源码目录", "解压后的 Vue 项目根目录"),
                  Button({
                    key: "use-cwd",
                    label: "使用当前目录",
                    onPress: async () => {
                      if (pending) return
                      currentDirectory = await $.session.cwd()
                      draft.projectRoot = currentDirectory
                      status = "已填入当前目录；填写路径不会切换聊天工作目录或扩大权限。"
                      redraw()
                    }
                  })
                ]
              }),
              field("url", "页面地址", "启动后的访问地址，例如 http://localhost:5173/"),
              field("document", "接口文档", "正文、URL 或本地文件路径（长文档建议填路径）", 2),
              Box({
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 1,
                children: [
                  Button({
                    key: "toggle-focus",
                    label: showFocus
                      ? "收起需求"
                      : draft.focus
                        ? "补充需求 · 已填写"
                        : "补充需求（可选）",
                    onPress: () => {
                      showFocus = !showFocus
                      redraw()
                    }
                  }),
                  Button({
                    key: "toggle-commands",
                    label: showCommands ? "收起命令" : "运行命令（可选）",
                    onPress: () => {
                      showCommands = !showCommands
                      redraw()
                    }
                  })
                ]
              }),
              ...(showFocus
                ? [field("focus", "本次需求", "例如：补齐订单接口，验证筛选、翻页和错误状态", 2)]
                : []),
              ...(showCommands
                ? [
                    field("startCommand", "启动命令", "留空则从项目 package 脚本识别"),
                    field("checkCommand", "检查命令", "留空则运行项目现有检查")
                  ]
                : [])
            ]
          : [Text({ children: draft.url || "尚未填写页面地址", size: "caption", dimColor: true })]),
        Box({ flexDirection: "row", flexWrap: "wrap", gap: 1, children: controls }),
        Text({ children: status, size: "caption", color: "text" }),
        ...(help
          ? [
              Text({
                children:
                  "当前聊天目录：" + currentDirectory + "。填写路径不会自动切换目录或授权。",
                size: "caption",
                dimColor: true
              }),
              Text({
                children:
                  "① 解压源码项目，在该目录开始聊天并启用此灵件；开启内置浏览器控制，首次配置后按提示重启。② 填源码目录、页面和文档；材料包可点填入演示。③ 点击补齐：助手修改前端、运行检查和服务，用内置浏览器验证并修复。\n这是会修改源码的开发任务，请使用可编辑的项目副本。原工具授权仍然有效，填写目录不会扩大权限。契约、后端和验收测试保持只读。进度和证据见聊天，提交成功不代表验收通过。\n用聊天的停止按钮停止任务；再次点击前先看已有任务，避免重复排队。恢复输入不会自动执行；已完成的文件保留，可继续开发。收起配置可留出阅读空间；长文档建议填本地路径。",
                size: "caption",
                dimColor: true
              })
            ]
          : [])
      ]
    })
  })
}

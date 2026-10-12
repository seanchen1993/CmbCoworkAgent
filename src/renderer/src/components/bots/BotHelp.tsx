import { botHostApi } from "@/lib/bot-api"
import { BotShellResourceReview } from "./BotShellResourceReview"
import { useEffect, useRef, useState } from "react"
import { Check, Copy, Download, Settings, Keyboard, RotateCw, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { botDiagnosticInfo, botDiagnosticText } from "@/lib/bot-diagnostics"
import type { BotHostStatus } from "../../../../shared/bot-api"

const guides = [
  [
    "如何开始？",
    "先在应用设置中配置模型，点击新建 Bot 即可开始对话。名称、职责、模型和项目目录可在 Bot 设置中修改；访问外部系统时，选择已配置的连接器。"
  ],
  [
    "如何交办和协作？",
    "在对话中说明目标、范围和交付要求。任务执行期间可以补充要求或停止任务；创建群聊并指定参与 Bot 后，可在同一讨论中分工。需要固定执行的工作，可以保存为例程。"
  ],
  [
    "如何登录网站或接管浏览器？",
    "打开当前 Bot 的电脑面板，点击接管后操作网页，完成登录或人工步骤，再归还控制权。Bot 使用专用浏览器环境，同一用户的 Bot 可复用站点登录状态；你的日常浏览器资料不会自动导入。"
  ],
  [
    "工作浏览器会一直运行吗？",
    "工作浏览器闲置时会自动关闭，需要时重新打开，恢复已保存的页面和登录状态。接管、示范、下载和待处理任务期间保持运行；未保存的网页内容不会保留。"
  ],
  [
    "如何恢复或重置工作浏览器？",
    "在工作区的“备份与恢复”中选择“工作浏览器恢复与重置”。先完成运行中的任务并归还控制权，再保存恢复点。恢复和重置前会保存当前状态；该功能只处理 Bot 的专用浏览器，任务记录和项目文件不回滚。恢复点含登录数据，仅供原电脑使用。"
  ],
  [
    "如何找回修改前的共享文件？",
    "在“备份与恢复”中选择“共享工作文件恢复与重置”。可以保存恢复点，也可以恢复以前的文件；恢复和重置前会另存当前文件，原目录可从“查看保留的原文件”打开。这个入口只处理默认共享目录，自选项目需另行备份。"
  ],
  [
    "关掉窗口后还会继续吗？",
    "本机 Bot 后台独立运行，关闭工作区或窗口后，已接收的任务仍可继续。电脑休眠、关机或退出系统时无法执行。恢复后如显示“需要核对现场”，请先查看操作记录，再决定如何继续。"
  ],
  [
    "为什么有时需要确认？",
    "审批卡展示即将执行的具体操作。批准仅用于该项操作；拒绝会把结果反馈给 Bot。自动审核可在 Bot 的审批规则中配置，安全凭据通过专用输入卡填写。"
  ],
  [
    "安装的工具和临时文件会保留吗？",
    "安装工具仍需具体命令审批。后续命令需要的工具、依赖和成果请放在已授权项目目录；每条命令提供的 HOME 和临时目录不作为持久保存位置。恢复点以实际范围为准；自选项目、系统软件及含链接的依赖目录需另行处理。"
  ],
  [
    "浏览器打不开或任务停住了怎么办？",
    "macOS 本机浏览器需要安装 Google Chrome，Windows 使用 Microsoft Edge。检查后台连接、模型配置和网络；等待处理的任务请查看审批、提问或电脑接管状态。先查看任务记录和错误提示，避免重新发起可能已经完成的操作。"
  ],
  [
    "能看扫描 PDF 和图表吗？",
    "可以上传 PDF，或让 Bot 查看项目目录中的文档，并说明需要检查的页码或图表。扫描页和图像需要支持视觉的模型；小字可以要求局部放大。加密 PDF 需先解密，文件不能超过 25 MiB。"
  ],
  [
    "如何保存成果和工作方法？",
    "文件面板可查看、预览和下载成果。可将验证过的操作保存为技能，或录制示范再进行试跑；备份入口可保存 Bot 数据和附件，项目源码与外部系统数据需另外备份。"
  ]
] as const

export function BotHelp({
  host,
  disconnected,
  close,
  refresh,
  openSettings,
  openKeyboard
}: {
  host: BotHostStatus | null
  disconnected: boolean
  close(): void
  refresh(): Promise<void>
  openSettings(): void
  openKeyboard(): void
}) {
  const [version, setVersion] = useState(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined
  )
  const [channel, setChannel] = useState<string | null>(null)
  const [copied, setCopied] = useState<"version" | "feedback" | null>(null)
  const [copyGeneration, setCopyGeneration] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const [restartMessage, setRestartMessage] = useState<{ text: string; error: boolean } | null>(
    null
  )
  const restartPending = useRef(false)
  const restart = async () => {
    if (!host || restartPending.current) return
    restartPending.current = true
    setRestarting(true)
    setRestartMessage(null)
    try {
      await botHostApi.restart({ hostId: host.hostId })
      setRestartMessage({ text: "后台已重新连接。", error: false })
    } catch (error) {
      setRestartMessage({
        text: error instanceof Error ? error.message : "重启未完成，请刷新状态后重试。",
        error: true
      })
    } finally {
      await refresh().catch(() => {})
      restartPending.current = false
      setRestarting(false)
    }
  }
  useEffect(() => {
    let active = true
    void window.electron?.ipcRenderer
      .invoke("get-version")
      .then((value) => {
        if (active && typeof value === "string") setVersion(value)
      })
      .catch(() => {})
    void window.api.update
      ?.getStatus()
      .then((value) => {
        if (active) setChannel(value.source?.channel ?? null)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(null), 1600)
    return () => window.clearTimeout(timeout)
  }, [copied, copyGeneration])
  const info = botDiagnosticInfo({
    version,
    channel,
    host,
    disconnected,
    platform: window.electron?.process.platform,
    versions: window.electron?.process.versions
  })
  const copy = async (kind: "version" | "feedback") => {
    try {
      await navigator.clipboard.writeText(
        (kind === "feedback" ? "问题描述：\n复现步骤：\n期望结果：\n实际结果：\n\n" : "") +
          botDiagnosticText(info)
      )
      setCopied(kind)
      setCopyGeneration((generation) => generation + 1)
    } catch {
      toast.error("复制失败，请重试")
    }
  }
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(info, null, 2)], { type: "application/json" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "cmbdevclaw-bot-diagnostics.json"
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex h-[85vh] max-h-[42rem] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Bot 帮助与信息</DialogTitle>
          <DialogDescription>使用说明、运行状态与问题反馈。</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="guide" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="grid w-full shrink-0 grid-cols-2">
            <TabsTrigger value="guide">使用指南</TabsTrigger>
            <TabsTrigger value="about">关于与反馈</TabsTrigger>
          </TabsList>
          <TabsContent
            value="guide"
            className="min-h-0 flex-1 flex-col gap-4 pt-2 data-[state=active]:flex"
          >
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="divide-y rounded-xl border px-4">
                {guides.map(([title, body], index) => (
                  <details key={title} open={index === 0} className="group py-3">
                    <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {title}
                    </summary>
                    <p className="pt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
                  </details>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onClick={openSettings}>
                <Settings size={14} />
                打开应用设置
              </Button>
              <Button size="sm" variant="ghost" onClick={openKeyboard}>
                <Keyboard size={14} />
                查看快捷键
              </Button>
            </div>
          </TabsContent>
          <TabsContent
            value="about"
            className="min-h-0 flex-1 flex-col gap-4 pt-2 data-[state=active]:flex"
          >
            <div
              role="region"
              aria-label="运行诊断信息"
              tabIndex={0}
              className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
                {Object.entries(info).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-all font-mono text-xs leading-5">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                反馈时可附上复现步骤和基础诊断信息。诊断文件只包含上方版本与运行状态。
              </p>
              {botHostApi && (
                <section className="space-y-2.5 rounded-xl border p-4" aria-label="后台维护">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">重新连接后台</h3>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        仅在空闲时重启，保留 Bot、对话和文件。
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!host || restarting}
                      onClick={() => void restart()}
                    >
                      {restarting ? (
                        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <RotateCw size={14} />
                      )}
                      {restarting ? "正在重启…" : "重启后台"}
                    </Button>
                  </div>
                  {restartMessage && (
                    <p
                      role={restartMessage.error ? "alert" : "status"}
                      className={
                        restartMessage.error
                          ? "text-xs leading-relaxed text-destructive"
                          : "text-xs leading-relaxed text-muted-foreground"
                      }
                    >
                      {restartMessage.text}
                    </p>
                  )}
                </section>
              )}
              <BotShellResourceReview />
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onClick={() => void copy("version")}>
                {copied === "version" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "version" ? "已复制" : "复制版本信息"}
              </Button>
              <Button size="sm" variant="outline" onClick={download}>
                <Download size={14} />
                下载诊断信息
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copy("feedback")}>
                {copied === "feedback" ? "已复制反馈模板" : "复制反馈模板"}
              </Button>
            </div>
            <span role="status" className="sr-only">
              {copied ? "已复制到剪贴板" : ""}
            </span>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

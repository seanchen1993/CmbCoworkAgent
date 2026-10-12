import {
  ArrowUpRight,
  FileText,
  FolderSearch,
  Loader2,
  Monitor,
  Plus,
  Settings
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { BotAvatar } from "./BotAvatar"
import { BotPrimaryGuide } from "./BotPrimaryGuide"

export function BotWelcome({
  loading,
  disconnected,
  botCount,
  create,
  settings,
  help,
  showBots,
  primary
}: {
  loading: boolean
  disconnected: boolean
  botCount: number
  create(): void
  settings(): void
  help(): void
  showBots(): void
  /** Present only when the current Host has confirmed that no primary Bot exists. */
  primary?(mode: "create" | "choose"): void
}) {
  if (primary && !loading)
    return (
      <BotPrimaryGuide
        botCount={botCount}
        disabled={disconnected}
        create={() => primary("create")}
        choose={() => primary("choose")}
        footer={
          <>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="ghost" onClick={settings}>
                <Settings size={15} />
                模型与应用设置
              </Button>
              <Button variant="ghost" onClick={help}>
                使用帮助
              </Button>
            </div>
            <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
              任务在这台电脑的后台运行，电脑休眠或关机时无法继续。网站登录与连接器授权按实际使用单独完成。
            </p>
          </>
        }
      />
    )
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10 text-center">
      <BotAvatar agentId="cmb-welcome" size="xl" state="happy" isFollowingPointer />
      <div className="space-y-2">
        <h2 className="text-xl font-medium">
          {loading
            ? "正在连接 Bot 工作区"
            : botCount
              ? "选择一个 Bot，继续工作"
              : "创建你的第一个 Bot"}
        </h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          为 Bot 指定长期职责，再交办具体目标。它可以独立处理任务，也可以与其他 Bot 分工协作。
        </p>
      </div>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          {disconnected ? "连接暂不可用，可在上方重试。" : "正在读取已有 Bot 和任务…"}
        </p>
      ) : botCount ? (
        <Button variant="outline" onClick={showBots}>
          查看已有 Bot
        </Button>
      ) : (
        <ol
          aria-label="Bot 使用步骤"
          className="grid w-full max-w-2xl gap-3 text-left lg:grid-cols-3"
        >
          {[
            ["配置模型", "使用应用中已有的模型，或在设置中添加你自己的模型服务。"],
            ["指定职责", "设置名称、工作要求和项目目录；连接器按实际需要选择。"],
            ["交办任务", "说明目标和交付要求。用到网页时，再准备浏览器并登录。"]
          ].map(([title, detail], index) => (
            <li key={title} className="rounded-xl border bg-card p-4">
              <span className="mb-3 flex size-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                {index + 1}
              </span>
              <h3 className="mb-1 text-sm font-medium">{title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={create} disabled={loading || disconnected}>
          <Plus size={16} />
          创建 Bot
        </Button>
        <Button variant="outline" onClick={settings}>
          <Settings size={15} />
          模型与应用设置
        </Button>
        <Button variant="ghost" onClick={help}>
          使用帮助
        </Button>
      </div>
      <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
        任务在这台电脑的后台运行，电脑休眠或关机时无法继续。网站登录与连接器授权按实际使用单独完成。
      </p>
    </section>
  )
}

export function BotFirstTask({
  hasProject,
  connectorCount,
  disabled,
  suggest,
  computer,
  settings
}: {
  hasProject: boolean
  connectorCount: number
  disabled: boolean
  suggest(text: string): void
  computer(): void
  settings(): void
}) {
  const suggestions = [
    {
      title: "整理材料",
      detail: "提炼要点、待决问题和下一步",
      icon: FileText,
      prompt:
        "请根据我提供的材料，整理主要结论、待决问题和下一步建议。材料不足时先告诉我需要补充什么。"
    },
    ...(hasProject
      ? [
          {
            title: "了解项目",
            detail: "阅读说明，梳理结构和验证方法",
            icon: FolderSearch,
            prompt:
              "请先阅读项目中的 AGENTS.md、README 和相关配置，梳理项目结构、主要模块及已有测试方式，给出一份附文件依据的简要说明。先不要修改文件或安装依赖。"
          }
        ]
      : [])
  ]
  return (
    <section aria-label="交办第一项任务" className="w-full max-w-lg space-y-3 text-left">
      <div className="grid gap-2 sm:grid-cols-2">
        {suggestions.map(({ title, detail, icon: Icon, prompt }) => (
          <button
            key={title}
            type="button"
            disabled={disabled}
            onClick={() => suggest(prompt)}
            className="group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <strong className="block text-sm font-medium">{title}</strong>
              <span className="text-xs leading-relaxed text-muted-foreground">{detail}</span>
            </span>
            <ArrowUpRight size={14} className="mt-0.5 text-muted-foreground" />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={computer} disabled={disabled}>
          <Monitor size={14} />
          准备工作浏览器
        </Button>
        <Button size="sm" variant="ghost" onClick={settings}>
          <Settings size={14} />
          检查 Bot 配置
        </Button>
      </div>
      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
        <span className="block">
          选择任务后会填入草稿，可修改后发送；浏览器首次打开时才会启动。
        </span>
        <span className="block">
          {connectorCount
            ? "已选择 " + connectorCount + " 个连接器，实际可用性与授权将在使用时检查。"
            : "尚未选择连接器；可先处理材料或项目文件，需要时再添加。"}
        </span>
      </div>
    </section>
  )
}

import { useState } from "react"
import { ArrowRight, BookOpen, Check, Copy, GitBranch, Layers3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAppStore } from "@/lib/store"

function CommandExample({ command, children }: { command: string; children: string }) {
  const [feedback, setFeedback] = useState("")
  return (
    <div className="space-y-2 rounded-xl border bg-background p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 select-text break-all text-xs">{command}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label={`复制 ${command}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command)
              setFeedback("已复制，回到聊天框粘贴后发送。")
            } catch {
              setFeedback("暂时无法复制，请选中上方命令手动复制。")
            }
          }}
        >
          <Copy className="mr-1.5 size-3.5" aria-hidden="true" />
          复制
        </Button>
      </div>
      {feedback && (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
    </div>
  )
}

export function ModsGuide() {
  return (
    <header className="space-y-5 rounded-2xl border bg-card p-5 sm:p-6" data-mods-guide>
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Layers3 className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[11px] font-medium tracking-widest text-muted-foreground">
            DEVCLAW SPARKS
          </p>
          <h2 className="text-xl font-semibold tracking-tight">给助手添加你需要的功能</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            日常任务直接在普通聊天中描述并发送。想改变助手功能时，切到创造者模式说明需求，核对后确认应用。
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          创建、修改或组合功能，可以先用创造者模式描述；安装现成插件和手动配置保留在高级入口。
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">高级：手动管理任务方案</summary>
          <Button
            size="sm"
            variant="outline"
            onClick={() => useAppStore.getState().setShowCustomizeView(true, "flows")}
          >
            <GitBranch className="mr-2 size-3.5" aria-hidden="true" />
            打开任务方案编辑器
            <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
          </Button>
        </details>
      </div>
      <details className="group rounded-xl border bg-muted/20">
        <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BookOpen
            className="mr-2 inline size-4 align-text-bottom text-muted-foreground"
            aria-hidden="true"
          />
          使用指南
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            描述需求、确认应用和查看结果
          </span>
        </summary>
        <div className="border-t p-4">
          <Tabs defaultValue="start">
            <TabsList className="mb-3 flex h-auto w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="start">快速上手</TabsTrigger>
              <TabsTrigger value="autobiz">代码检查示例</TabsTrigger>
              <TabsTrigger value="help">常见问题</TabsTrigger>
            </TabsList>
            <TabsContent value="start" className="space-y-4 text-sm">
              <p className="leading-relaxed text-muted-foreground">
                在普通聊天里描述要完成什么，点击“发送消息”，再看聊天回复和“任务进展”。
                想制作或调整功能时，在输入框切到创造者模式，直接说明想增加、修改或组合什么。
              </p>
              <ol className="list-decimal space-y-2 pl-5 text-muted-foreground marker:text-foreground">
                <li>进入创造者模式；尚未选择本地项目时，先按提示选择目录。</li>
                <li>用一句话说明需求并发送，助手会准备对应修改或组合。</li>
                <li>需要新增权限时，核对页面显示的用途、权限和版本，再确认应用到这段聊天。</li>
                <li>
                  在聊天里实际使用并核对结果；要在其他聊天复用时，再说明“保存并在其他聊天复用”，确认对应保存卡片。
                </li>
              </ol>
              <details className="rounded-xl border p-3">
                <summary className="cursor-pointer font-medium">
                  高级：安装现成插件并使用命令
                </summary>
                <div className="mt-3 space-y-4">
                  <h3 className="font-medium">安装后怎么用？</h3>
                  <ol className="list-decimal space-y-2 pl-5 text-muted-foreground marker:text-foreground">
                    <li>选择一个示例插件，或导入完整的 ZIP 压缩包、插件文件夹。</li>
                    <li>打开本应用的功能开关，为聊天选择项目目录，再打开当前项目的功能开关。</li>
                    <li>
                      在插件卡片查看它要读取什么、执行什么，再点“授权以上能力”。更新插件后需重新核对。
                    </li>
                    <li>回到聊天框，输入插件命令；按提示批准本次操作，然后查看返回结果。</li>
                  </ol>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CommandExample command="/claw-info">
                      安装并授权内置示例后，用这个命令查看正在使用的项目目录和聊天。
                    </CommandExample>
                    <CommandExample command="/claw-files">
                      安装并授权内置示例后，用这个命令列出项目文件。
                    </CommandExample>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    粘贴命令并发送后才开始执行。需要读取文件或运行命令时，按页面提示确认。
                  </p>
                </div>
              </details>
            </TabsContent>
            <TabsContent value="autobiz" className="space-y-4 text-sm">
              <div className="space-y-2">
                <h3 className="font-medium">让助手先检查，再交给你确认</h3>
                <p className="leading-relaxed text-muted-foreground">
                  在普通聊天中说明要检查的文件、关注的问题和是否允许修改，再点击“发送消息”。在聊天或“任务进展”核对意见；涉及实际操作时，按原有提示确认。
                </p>
                <div className="rounded-xl border bg-background p-3 text-xs leading-relaxed">
                  例如：“检查购物车文件的空列表处理，先给出发现和修改建议，暂不修改文件。”检查意见不等于测试通过。
                </div>
                <details className="rounded-xl border p-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-medium">
                    高级：手动选用固定任务方案
                  </summary>
                  <p className="mt-2 leading-relaxed">
                    先在任务方案编辑器保存安排，再到“任务进展 → 高级设置 →
                    高级：为下一条消息使用预设任务”明确选用，填写目标后点击“发送消息”。仅保存方案不会执行，普通发送不会自动运行已保存方案。
                  </p>
                </details>
              </div>
              <div className="space-y-3 border-t pt-4">
                <h3 className="font-medium">需要更严格的代码检查？</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  以下命令需要单独安装代码检查示例插件，并配置可用模型。示例在源码目录
                  examples/mods-review-agent，可用“从文件夹安装”导入。它检查 Git 已跟踪文件的改动。
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <CommandExample command="/claw-review concise working">
                    简短检查：查看尚未加入 Git 暂存区的改动，找明显的逻辑问题。
                  </CommandExample>
                  <CommandExample command="/claw-review strict staged">
                    严格检查：查看 Git 暂存区的改动，包括逻辑、权限和出错后的处理。
                  </CommandExample>
                </div>
                <CommandExample command="/claw-review-status">
                  发送检查命令后，用它查看进度和意见。此示例只检查改动，不修改文件。
                </CommandExample>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  “简短”关注明显问题，“严格”检查更多失败情况。到运行记录查看所用模型和实际结果。
                </p>
              </div>
            </TabsContent>
            <TabsContent value="help" className="space-y-2 text-sm">
              {[
                [
                  "灵件和插件是什么关系？",
                  "插件是安装包；灵件是其中可添加到聊天的小功能，例如显示用量或增加命令。这里管理它们的使用权限。卸载会移除整个插件。"
                ],
                [
                  "已经安装，为什么命令还不能用？",
                  "先看插件卡片的提示，再核对本应用开关、聊天的项目目录、项目开关和授权。更新插件后可能需要重新授权。"
                ],
                [
                  "关闭或撤权后会怎样？",
                  "相关灵件停止运行，后台资源会清理。已经完成的文件修改不会自动撤销；历史记录保留。"
                ],
                [
                  "任务完成后，在哪里看结果？",
                  "先看聊天回复和原任务卡，也可打开“任务进展”查看当前任务与结果。技术记录在排查详情中展开；代码检查示例也可发送 /claw-review-status 查询。"
                ]
              ].map(([question, answer]) => (
                <details key={question} className="rounded-lg border bg-background px-3 py-2.5">
                  <summary className="cursor-pointer font-medium">{question}</summary>
                  <p className="pt-2 text-xs leading-relaxed text-muted-foreground">{answer}</p>
                </details>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </details>
    </header>
  )
}

export function ModsSetupProgress({
  installed,
  globalEnabled,
  globalLoaded,
  readFailed = false,
  workspace,
  authorized
}: {
  installed: boolean
  globalEnabled: boolean
  globalLoaded: boolean
  readFailed?: boolean
  workspace: { enabled: boolean } | null
  authorized: boolean
}) {
  const steps = [installed, globalLoaded && globalEnabled, Boolean(workspace?.enabled), authorized]
  const next = readFailed
    ? "配置读取失败，请点击下方“重新读取”。"
    : !globalLoaded
      ? "正在读取配置…"
      : !installed
        ? "日常任务可直接回到普通聊天描述并发送；想添加功能可先进入创造者模式。需要安装现成插件时，再从这里选择。"
        : !globalEnabled
          ? "打开下方本应用的功能开关，再设置当前项目。"
          : !workspace
            ? "先在聊天中选择项目目录，再回这里开启项目功能。"
            : !workspace.enabled
              ? "打开下方项目开关，让灵件在这个项目中生效。"
              : !authorized
                ? "在下方插件卡片查看所需权限，确认后授权，再回到聊天使用。"
                : "设置已完成。按插件说明回到聊天使用，在“任务进展”核对状态和结果；手动任务方案位于高级设置。"
  return (
    <div className="rounded-xl border bg-muted/20 p-4" data-mods-setup>
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="插件设置进度">
        {["安装插件", "打开总开关", "开启当前项目", "确认插件权限"].map((label, index) => (
          <li key={label} className="flex items-center gap-2 text-xs">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full ${steps[index] ? "bg-primary/10 text-primary" : "border text-muted-foreground"}`}
            >
              {steps[index] ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span>
              {label}
              <span className="sr-only">{steps[index] ? "：已完成" : "：待完成"}</span>
            </span>
          </li>
        ))}
      </ol>
      <p role="status" className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
        {next}
      </p>
    </div>
  )
}

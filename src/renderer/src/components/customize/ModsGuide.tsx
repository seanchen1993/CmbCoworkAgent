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
            可以添加现成插件，也可以描述你想要的小功能。先核对并试用，满意后再保存使用。
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          想增加功能，在这里挑选；想搭配几个插件，去“助手组合”；想固定做事顺序，去“按步骤执行”。
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => useAppStore.getState().setShowCustomizeView(true, "flows")}
        >
          <GitBranch className="mr-2 size-3.5" aria-hidden="true" />
          管理执行步骤
          <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <details className="group rounded-xl border bg-muted/20">
        <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BookOpen
            className="mr-2 inline size-4 align-text-bottom text-muted-foreground"
            aria-hidden="true"
          />
          使用指南
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            安装、启用和查看结果
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
                想让助手按固定顺序做事：先为聊天选择项目目录，打开本应用和当前项目的功能开关，
                再到“按步骤执行”选择现成流程、保存并运行。这个用法无需先安装插件。
              </p>
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
            </TabsContent>
            <TabsContent value="autobiz" className="space-y-4 text-sm">
              <div className="space-y-2">
                <h3 className="font-medium">让助手先检查，再交给你确认</h3>
                <p className="leading-relaxed text-muted-foreground">
                  先打开带项目目录的聊天，再进入“按步骤执行”。从模板创建流程，写清每一步要做什么，保存后运行；执行记录会显示进度和结果。
                </p>
                <div className="rounded-xl border bg-background p-3 text-xs leading-relaxed">
                  例如：完成修改 → 运行测试 → 检查代码 →
                  人工确认。测试不通过时可回到修复步骤，通过检查后再继续。
                </div>
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
                  "先看聊天回复，再到“当前助手 → 运行过程”查看步骤进度和结果。代码检查示例也可发送 /claw-review-status 查询。"
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
        ? "先选择要添加的插件。只想体验固定步骤时，无需安装插件：打开本应用和项目的功能开关，再去“按步骤执行”。"
        : !globalEnabled
          ? "打开下方本应用的功能开关，再设置当前项目。"
          : !workspace
            ? "先在聊天中选择项目目录，再回这里开启项目功能。"
            : !workspace.enabled
              ? "打开下方项目开关，让灵件在这个项目中生效。"
              : !authorized
                ? "在下方插件卡片查看所需权限，确认后授权，再回到聊天使用。"
                : "设置已完成。按插件说明回到聊天使用；需要固定顺序时，打开“按步骤执行”。"
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

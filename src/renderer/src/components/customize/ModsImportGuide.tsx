import { useState } from "react"
import { Download, FileCode2, PackageOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MODS_STARTER_FILES } from "../../../../shared/mods/v2/starter-template"

export function ModsImportGuide() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <details className="rounded-xl border bg-card" data-mods-import-guide>
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
        <PackageOpen className="size-4 text-muted-foreground" aria-hidden="true" />
        安装下载好的插件
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          安装方法与开发示例
        </span>
      </summary>
      <div className="space-y-4 border-t p-4 text-sm">
        <p className="leading-relaxed text-muted-foreground">
          在“插件 → 我已添加”展开“从文件添加插件”，上传 ZIP 或选择完整插件目录。 AutoBiz
          等项目插件可直接安装，保留原有技能与流程；单个脚本文件无法安装。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <pre
            className="overflow-auto rounded-lg bg-muted/50 p-4 text-xs leading-7"
            aria-label="灵件包目录结构"
          >
            {
              "my-claw/\n├─ plugin.json          插件名称和版本\n└─ hooks/\n   ├─ hooks.json        声明加载的模块\n   └─ register.ts       你的命令和行为"
            }
          </pre>
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center gap-2 font-medium">
              <FileCode2 className="size-4 text-primary" aria-hidden="true" />
              自己写插件：先试一个简单命令
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              模板只增加 /my-claw-info 命令，返回当前项目路径。安装、开启并授权后，
              在聊天中发送它，就能确认自己的灵件已生效。
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  const { default: JSZip } = await import("jszip")
                  const zip = new JSZip()
                  for (const [name, text] of Object.entries(MODS_STARTER_FILES))
                    zip.file(name, text)
                  const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }))
                  const link = document.createElement("a")
                  link.href = url
                  link.download = "my-claw.zip"
                  document.body.append(link)
                  link.click()
                  link.remove()
                  setTimeout(() => URL.revokeObjectURL(url), 1000)
                } catch {
                  setError("模板下载失败，请重试。")
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Download className="mr-2 size-4" aria-hidden="true" />
              {busy ? "正在准备下载…" : "下载插件示例（ZIP）"}
            </Button>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
        <ol className="grid gap-3 text-xs leading-relaxed sm:grid-cols-3">
          <li>
            <strong>1. 安装你的包</strong>
            <p className="mt-1 text-muted-foreground">
              把完整目录打包为 ZIP，保留上方结构。修改代码后，需要重新安装并核对权限。
            </p>
          </li>
          <li>
            <strong>2. 开启并授权</strong>
            <p className="mt-1 text-muted-foreground">
              回到“我已添加”，点击插件卡片的“启用”。按提示确认能力、使用范围与计费说明；需要参数时填写配置。
            </p>
          </li>
          <li>
            <strong>3. 选择使用方式</strong>
            <p className="mt-1 text-muted-foreground">
              点击“去使用”进入对应聊天或项目。聊天命令需补充需求后发送，自动检查按原规则触发。
            </p>
          </li>
        </ol>
        <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          Claude 社区插件请保留原目录结构。卡片“管理”中可查看配置、兼容性、权限与项目流程。
          命令或面板能否作为组合步骤，以页面提供的选项为准。
        </p>
      </div>
    </details>
  )
}

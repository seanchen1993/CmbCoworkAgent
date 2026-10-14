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
          已有插件压缩包，点“上传插件（ZIP）”；已有解压后的完整目录，点“从文件夹安装”。 AutoBiz
          等项目插件可以直接安装，不需要手动转换；安装后先启用，再新建项目。
          只有单个代码文件不能安装。下面的模板适合想自己写插件的人。
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
              项目与技能插件：在卡片上点击“启用插件”。灵件：打开灵件和项目开关，再核对并确认权限。
            </p>
          </li>
          <li>
            <strong>3. 选择使用方式</strong>
            <p className="mt-1 text-muted-foreground">
              按插件说明使用：命令在聊天框发送；自动运行的功能会在对应场景生效。
              想搭配多个插件，去“助手组合”；想固定执行顺序，去“按步骤执行”。
            </p>
          </li>
        </ol>
        <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          Claude
          社区插件请保留原目录结构。含灵件模块时，可在权限区检查社区兼容性并授权试用；其他插件可点“设置使用”，查看技能、工具和检查规则。
          原有技能和项目流程仍从原入口使用。插件里的命令或面板不一定能作为流程步骤，以页面提供的选项为准。
        </p>
      </div>
    </details>
  )
}

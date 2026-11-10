import { createRoot } from "react-dom/client"
import { UniversalUploadDialog } from "../../src/renderer/src/components/customize/MarketPanel/UniversalUploadDialog"
import { PluginFileEditorDialog } from "../../src/renderer/src/components/customize/PluginFileEditorDialog"
import { MarketDetailView } from "../../src/renderer/src/components/customize/MarketPanel/MarketDetailView"
import type { PluginMetadata } from "../../src/renderer/src/types"

const root = createRoot(document.getElementById("root")!)
const uploads: Array<{ userId?: string; extraJson?: string }> = []
const writes: string[] = []
let allowed = true
let generation = 0
let detailAccess: "owner" | "whitelist" | undefined
const downloads: boolean[] = []
Object.assign(window, {
  marketSourceUploads: uploads,
  marketSourceWrites: writes,
  marketSourceDownloads: downloads,
  api: {
    models: { getUserInfo: async () => ({ sapId: "admin-account", userName: "管理员" }) },
    plugins: {
      marketSourceAccess: async () => detailAccess,
      listFiles: async () =>
        allowed
          ? {
              success: true,
              pluginEditable: true,
              files: [{ path: "C:/plugin/SKILL.md", relativePath: "SKILL.md", editable: true }]
            }
          : { success: false, error: "该市场资源受保护" },
      readFile: async () => ({
        success: true,
        content: "# 原始技能描述\n授权用户可在线编辑。",
        editable: true
      }),
      writeFile: async (_id: string, _path: string, text: string) => {
        writes.push(text)
        return { success: true }
      }
    }
  }
})

function renderSourceForm(type: "skill" | "plugin" | "mcp", extraJson?: string): void {
  root.render(
    <UniversalUploadDialog
      key={++generation}
      open
      onOpenChange={() => undefined}
      resourceType={type}
      isUpdate
      isAdminModeActive
      existingItem={{
        name: "source-example",
        chinese_name: "原文授权示例",
        description: "白名单交互回归",
        category: "其他",
        version: "1.0.0",
        guidance: "安装后使用",
        user_id: "uploader / 上传者 / 技术部",
        extra_json:
          extraJson ??
          JSON.stringify({
            sourceAccessUserIds: ["12345678"],
            grayUserIds: ["87654321"],
            custom: "keep",
            skills: ["example"]
          })
      }}
      onUpload={async (
        _file,
        _name,
        _description,
        _category,
        _version,
        _guidance,
        _cn,
        userId,
        extraJson
      ) => {
        uploads.push({ userId, extraJson })
        return { success: true }
      }}
      onSuccess={() => root.render(<p>保存成功</p>)}
    />
  )
}

function renderSourceEditor(access: "owner" | "whitelist" | undefined): void {
  allowed = Boolean(access)
  const plugin = {
    id: "source-plugin",
    name: "市场插件",
    origin: "market",
    sourceAccess: access
  } as PluginMetadata
  root.render(
    <PluginFileEditorDialog
      key={++generation}
      open
      plugin={plugin}
      onOpenChange={() => undefined}
    />
  )
}

function renderSourceDetail(access?: "owner" | "whitelist"): void {
  detailAccess = access
  const noop = () => undefined
  root.render(<MarketDetailView
    key={++generation}
    activeTab="plugin"
    selectedItem={{ name: "source-example", description: "授权原文下载", filename: "source.zip", created_at: "2026-11-10" }}
    canManageSelectedItem={access === "owner"}
    detailFilePanel={<p>插件详情</p>}
    canViewSkillUserDetail={false}
    selectedSkillCallCount={null}
    selectedSkillUserCount={null}
    selectedSkillUsageRows={[]}
    skillUsageLoading={false}
    selectedSkillTraces={[]}
    skillTracesLoading={false}
    skillTracesError={null}
    selectedUploaderProfile={null}
    downloadingItems={new Set()}
    updatingItems={new Set()}
    getItemKey={(item) => item.name}
    getMarketTypeLabel={() => "插件"}
    formatMarketVersionLabel={() => "1.0.0"}
    isAutoOptimizedMarketItem={() => false}
    onUpdateInstall={noop}
    onDownload={(_item, raw) => downloads.push(Boolean(raw))}
    onUninstall={noop}
    onUpdate={noop}
    onDelete={noop}
    onOpenSkillTraceDialog={noop}
  />)
}

Object.assign(window, { renderSourceForm, renderSourceEditor, renderSourceDetail })
renderSourceForm("skill")

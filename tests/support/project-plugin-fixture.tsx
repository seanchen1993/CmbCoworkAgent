import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MarketItemCard } from "../../src/renderer/src/components/customize/MarketPanel/MarketPanel"
import { KnowledgePreviewPanel } from "../../src/renderer/src/components/harness-board/KnowledgePreviewPanel"
import { findInstalledPluginForMarketItem } from "../../src/renderer/src/lib/market-plugin-identity"
import type { MarketItem } from "../../src/renderer/src/api/market"
import type { PluginMetadata } from "../../src/renderer/src/types"

const item = {
  name: "项目模式示例",
  id: "market-project",
  filename: "internal-project.zip",
  type: "plugin",
  version: "1.5.5",
  description: "由其他用户上传的项目模式插件",
  project_mode_supported: true,
  ip: "10.0.0.1",
  canDelete: false
} as MarketItem
const installed = {
  id: "local-project",
  name: "internal-project",
  path: "C:/plugins/internal-project",
  marketplace: { name: item.name, id: item.id }
} as PluginMetadata
const preview = {
  adapterId: installed.id,
  adapterName: item.name,
  configured: true,
  exists: true,
  path: "C:/plugins/internal-project/knowledge",
  previewGrant: "expired",
  previewGrantExpiresAt: Date.now() - 1,
  files: [{ path: "/AGENTS.md", is_dir: false }]
}
const counters = { refresh: 0, reinstall: 0, reads: 0 }
Object.assign(window, {
  projectPluginCounters: counters,
  api: {
    harnessBoard: {
      getKnowledgePreview: async () => {
        counters.refresh++
        return { ...preview, previewGrant: "renewed", previewGrantExpiresAt: Date.now() + 300_000 }
      }
    },
    workspace: {
      readFilePreview: async (request: { source: { externalGrant?: string } }) => {
        if (request.source.externalGrant !== "renewed") throw new Error("Missing renewed grant")
        counters.reads++
        return {
          success: true,
          content: "# 公共系统约束\n\n约束正文可以正常预览。",
          contentBytes: 90,
          size: 90,
          modified_at: "",
          offset: 0,
          nextOffset: null,
          hasMore: false,
          hasPrevious: false,
          truncated: false,
          lineCount: 3
        }
      },
      cancelFilePreview: async () => undefined,
      releaseFilePreview: async () => undefined
    }
  }
})
localStorage.setItem("localIp", "10.0.0.1")

export function Fixture() {
  const [plugins, setPlugins] = useState<PluginMetadata[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>("/AGENTS.md")
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="mb-4 text-xl font-semibold">项目模式插件安装与公共系统约束</h1>
      <section className="mb-6 max-w-3xl" style={{ height: 220 }}>
        <MarketItemCard
          item={item}
          marketTypeLabel="插件"
          showProjectModeTag
          isInstalled={Boolean(findInstalledPluginForMarketItem(plugins, item))}
          onDownload={() => setPlugins(JSON.parse(JSON.stringify([installed])))}
          onUpdateInstall={() => {
            counters.reinstall++
          }}
          onUninstall={() => setPlugins([])}
          onOpenDetail={() => undefined}
          onDelete={() => undefined}
          onUpdate={() => undefined}
        />
      </section>
      <KnowledgePreviewPanel
        preview={preview}
        loading={false}
        selectedPath={selectedPath}
        onSelectPath={setSelectedPath}
        onRefresh={() => undefined}
      />
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)

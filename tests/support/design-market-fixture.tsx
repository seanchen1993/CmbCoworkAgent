import React, { useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { DesignSystemInfo } from "../../src/shared/design-system"
import type { DesignCreationSelection } from "../../src/renderer/src/components/design/types"
import { DesignCreationPage } from "../../src/renderer/src/components/design/DesignCreationPage"
import {
  DesignSystemLibraryDialog,
  type DesignSystemLibraryMode
} from "../../src/renderer/src/components/design/DesignSystemLibraryDialog"
import { DesignTemplateDialog } from "../../src/renderer/src/components/design/DesignTemplateDialog"
import { DesignMarketOverlay } from "../../src/renderer/src/components/design/market/DesignMarketOverlay"
import { DesignMarketPanel } from "../../src/renderer/src/components/design/market/DesignMarketPanel"
import type { DesignPageTemplate } from "../../src/renderer/src/components/design/use-design-template-selection"

function Fixture() {
  const [actorId, setActorId] = useState("linan")
  const [surface, setSurface] = useState<"market" | "create" | "editor">("create")
  const [systems, setSystems] = useState<DesignSystemInfo[]>([])
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null)
  const [systemLibrary, setSystemLibrary] = useState<{
    mode: DesignSystemLibraryMode
    id?: string | null
  } | null>(null)
  const [marketOverlay, setMarketOverlay] = useState<{
    open: boolean
    initialSystemId?: string | null
  }>({ open: false })
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [editorDialogOpen, setEditorDialogOpen] = useState(false)
  const [editorTemplate, setEditorTemplate] = useState<DesignPageTemplate | null>(null)
  const [createdSelection, setCreatedSelection] = useState<DesignCreationSelection | null>(null)

  const refresh = useCallback(async () => {
    const list = await window.api.design.listSystems()
    setSystems(list)
    setCatalogRevision((prev) => prev + 1)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const switchActor = async (next: string) => {
    await (window as any).fixtureSetActor(next)
    setActorId(next)
    await refresh()
  }

  const orderedSystems = systems.filter(
    (s) => (!s.removedFromPicker && s.isLatest !== false) || s.id === selectedSystemId
  )
  const selectedSystem = systems.find((s) => s.id === selectedSystemId) ?? null

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs">
        <span>测试账号：</span>
        <select
          aria-label="切换测试账号"
          value={actorId}
          onChange={(e) => void switchActor(e.target.value)}
        >
          <option value="linan">林安（系统作者）</option>
          <option value="chenlu">陈璐（模板作者）</option>
        </select>
        <button type="button" onClick={() => setSurface("create")}>
          进入新建设计
        </button>
        <button type="button" onClick={() => setSurface("market")}>
          进入独立市场
        </button>
        <button type="button" onClick={() => setSurface("editor")}>
          进入编辑器模板弹窗
        </button>
        <button type="button" onClick={() => void refresh()}>
          刷新本地资产
        </button>
        <select
          aria-label="测试直接切换系统版本"
          value={selectedSystemId || ""}
          onChange={(e) => setSelectedSystemId(e.target.value || null)}
        >
          <option value="">不使用系统</option>
          {systems
            .filter((s) => !s.removedFromPicker)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} {s.marketVersion ? `v${s.marketVersion}` : `v${s.version || 1}`}
              </option>
            ))}
        </select>
      </div>

      {surface === "market" && (
        <div className="h-[880px]">
          <DesignMarketPanel
            key={actorId}
            mode="standalone"
            onAssetsChanged={() => void refresh()}
            onOpenNewDesign={(sysLocalId) => {
              if (sysLocalId) setSelectedSystemId(sysLocalId)
              setSurface("create")
              void refresh()
            }}
          />
        </div>
      )}

      {surface === "create" && (
        <div className="h-[880px]">
          <DesignCreationPage
            onBack={() => {}}
            workspacePath="/workspace/demo"
            workspaceLoading={false}
            onSelectWorkspace={() => {}}
            designSystemGroups={[{ label: "全部", items: orderedSystems }]}
            selectedDesignSystemId={selectedSystemId}
            onDesignSystemChange={setSelectedSystemId}
            onOpenSystemLibrary={(mode) => setSystemLibrary({ mode, id: selectedSystemId })}
            onBrowseMarket={(systemId) =>
              setMarketOverlay({ open: true, initialSystemId: systemId ?? null })
            }
            catalogRevision={catalogRevision}
            importingSource={null}
            onEnterDesign={(selection) => {
              setCreatedSelection(selection)
              setEditorTemplate(selection.template)
            }}
            onImportUrl={() => {}}
            onImportHtml={() => {}}
            onImportPrototypeZip={() => {}}
          />
        </div>
      )}

      {surface === "editor" && (
        <div className="p-6 space-y-3">
          <button type="button" onClick={() => setEditorDialogOpen(true)}>
            打开关联页面模板
          </button>
          <output data-testid="editor-template">
            {JSON.stringify(editorTemplate)}
          </output>
          {editorDialogOpen && (
            <DesignTemplateDialog
              initial={editorTemplate}
              currentSystem={selectedSystem}
              systems={systems}
              catalogRevision={catalogRevision}
              onConfirm={(tpl) => {
                setEditorTemplate(tpl)
                setEditorDialogOpen(false)
              }}
              onClose={() => setEditorDialogOpen(false)}
              onRestoreFocus={() => {}}
              onBrowseMarket={(systemId) => {
                setEditorDialogOpen(false)
                setMarketOverlay({ open: true, initialSystemId: systemId ?? null })
              }}
            />
          )}
        </div>
      )}

      {systemLibrary && (
        <DesignSystemLibraryDialog
          systems={systems}
          mode={systemLibrary.mode}
          initialId={systemLibrary.id}
          onChanged={refresh}
          onBrowseMarket={() => {
            setSystemLibrary(null)
            setMarketOverlay({ open: true, initialSystemId: null })
          }}
          onSelect={(sys) => setSelectedSystemId(sys?.id ?? null)}
          onClose={() => setSystemLibrary(null)}
        />
      )}

      <DesignMarketOverlay
        open={marketOverlay.open}
        initialSystemId={marketOverlay.initialSystemId}
        selectedLocalSystemId={selectedSystemId}
        onClose={() => {
          setMarketOverlay({ open: false })
          void refresh()
        }}
        onAssetsChanged={() => void refresh()}
      />

      <output data-testid="created-selection">{JSON.stringify(createdSelection)}</output>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)

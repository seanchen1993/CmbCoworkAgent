import React, { useEffect, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import {
  DesignSystemLibraryDialog,
  type DesignSystemLibraryMode
} from "../../src/renderer/src/components/design/DesignSystemLibraryDialog"
import { DesignCreationPage } from "../../src/renderer/src/components/design/DesignCreationPage"
import { DesignGallery } from "../../src/renderer/src/components/design/DesignGallery"
import { BrowserPageConfirmationBar } from "../../src/renderer/src/components/browser/BrowserPageConfirmationBar"
import {
  getBrowserPageConfirmation,
  subscribeBrowserPageConfirmation
} from "../../src/renderer/src/lib/browser-page-confirmation"
import type { DesignSystemInfo } from "../../src/shared/design-system"

function Fixture() {
  const confirmation = useSyncExternalStore(
    subscribeBrowserPageConfirmation,
    getBrowserPageConfirmation
  )
  const [systems, setSystems] = useState<DesignSystemInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<"gallery" | "create">("create")
  const [library, setLibrary] = useState<{
    mode: DesignSystemLibraryMode
    id?: string | null
  } | null>(null)
  const refresh = async () => {
    setSystems(await window.api.design.listSystems())
  }
  useEffect(() => {
    void refresh()
  }, [])
  return (
    <>
      {confirmation && (
        <div data-testid="browser-confirmation">
          <BrowserPageConfirmationBar loading={false} url="https://example.com" />
        </div>
      )}
      {view === "create" ? (
        <DesignCreationPage
          onBack={() => setView("gallery")}
          onEnterDesign={() => {}}
          workspacePath="/workspace"
          workspaceLoading={false}
          onSelectWorkspace={() => {}}
          designSystemGroups={[{ label: "全部", items: systems }]}
          selectedDesignSystemId={selected}
          onDesignSystemChange={setSelected}
          onOpenSystemLibrary={(mode) => setLibrary({ mode, id: selected })}
          importingSource={null}
          onImportUrl={() => {}}
          onImportHtml={() => {}}
          onImportPrototypeZip={() => {}}
        />
      ) : (
        <DesignGallery
          sessionIndex={[]}
          onOpen={() => {}}
          onNew={() => setView("create")}
          onDelete={() => {}}
          workspacePath="/workspace"
          workspaceLoading={false}
          onSelectWorkspace={() => {}}
          onManageSystems={() => setLibrary({ mode: "manage" })}
        />
      )}
      <button type="button" onClick={() => setLibrary({ mode: "inspect", id: selected })}>
        查看本次规范
      </button>
      {library && (
        <DesignSystemLibraryDialog
          systems={systems}
          mode={library.mode}
          initialId={library.id}
          onChanged={refresh}
          onSelect={(system) => setSelected(system?.id || null)}
          onClose={() => setLibrary(null)}
        />
      )}
      <output data-testid="selected-system">{selected || "none"}</output>
    </>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)

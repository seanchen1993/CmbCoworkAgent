import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { DesignSystemInfo } from "../../src/shared/design-system"
import { DesignTemplateSelector } from "../../src/renderer/src/components/design/DesignTemplateSelector"
import { useDesignTemplateSelection } from "../../src/renderer/src/components/design/use-design-template-selection"
import { ProductModeNavigation } from "../../src/renderer/src/components/requirement/ProductModeNavigation"
import { useRequirementStore } from "../../src/renderer/src/components/requirement/requirement-store"

function Picker({
  system,
  systems
}: {
  system: DesignSystemInfo | null
  systems: DesignSystemInfo[]
}) {
  const picker = useDesignTemplateSelection(undefined, system, systems)
  return (
    <>
      <DesignTemplateSelector picker={picker} browserPreview={false} />
      <button disabled={!picker.canConfirm} type="button">
        开始设计
      </button>
      <output data-testid="selection">{JSON.stringify(picker.selection)}</output>
    </>
  )
}
function Fixture() {
  const systems = (window as unknown as { fixtureSystems: DesignSystemInfo[] }).fixtureSystems
  const [id, setId] = useState("")
  const [shown, setShown] = useState(true)
  const [activeTab, setActiveTab] = useState<"requirements" | "design">("design")
  useEffect(() => {
    useRequirementStore.getState().setSystemList(systems)
  }, [systems])
  return (
    <>
      <ProductModeNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      <div hidden={activeTab !== "design"}>
        <label>
          测试当前设计系统
          <select aria-label="测试当前设计系统" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">不使用</option>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} v{s.version || 1}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setShown((v) => !v)}>挂载 / 卸载</button>
        {shown && <Picker system={systems.find((s) => s.id === id) || null} systems={systems} />}
      </div>
    </>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)

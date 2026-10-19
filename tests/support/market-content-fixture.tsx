import { createRoot } from "react-dom/client"
import { SkillDetail } from "../../src/renderer/src/components/customize/SkillsPanel"
import type { SkillMetadata } from "../../src/renderer/src/types"

const root = createRoot(document.getElementById("root")!)
const baseSkill: SkillMetadata = {
  name: "企业分析技能",
  description: "根据企业规范生成分析报告",
  source: "user",
  version: "v1.0.0",
  path: "C:/skills/analysis/SKILL.md",
  metadata: { version: "v1.0.0" }
}

export function renderMarketContentFixture(protectedContent: boolean): void {
  root.render(
    <main style={{ height: "100vh", display: "flex", padding: 24, background: "#f7f8fc" }}>
      <section
        style={{
          display: "flex",
          flex: 1,
          border: "1px solid #d8dce6",
          borderRadius: 12,
          background: "white",
          overflow: "hidden"
        }}
      >
        <SkillDetail
          key={String(protectedContent)}
          skill={{ ...baseSkill, contentOrigin: protectedContent ? "market" : "local" }}
          selectedFilePath={baseSkill.path}
          content={
            "---\nname: 企业分析技能\nversion: v1.0.0\n---\n# 原始技能内容\n\n这是自己上传的原始文件，可以在线编辑。"
          }
          previewKind="text"
          binaryBase64={null}
          binaryMimeType={null}
          isDisabled={false}
          onToggleEnabled={() => undefined}
          canEdit={!protectedContent}
          hideContentPreview={protectedContent}
          onSaveContent={async () => ({ success: true })}
        />
      </section>
    </main>
  )
}

Object.assign(window, { renderMarketContentFixture })
renderMarketContentFixture(true)

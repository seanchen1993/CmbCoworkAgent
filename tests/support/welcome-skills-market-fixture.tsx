import { useState } from "react"
import { createRoot } from "react-dom/client"
import { WelcomeSkills } from "../../src/renderer/src/components/chat/WelcomeSkills"
import type { SkillMetadata } from "../../src/renderer/src/types"

const state = { selected: [] as string[], uploads: 0, deletes: 0, installed: 0, sends: 0 }
Object.assign(window, { welcomeMarketFixture: state })
window.api = {
  models: { getUserInfo: async () => null },
  skills: {
    upload: async () => {
      state.uploads++
      return { success: true }
    },
    delete: async () => {
      state.deletes++
      return true
    }
  }
} as unknown as Window["api"]
const skills: SkillMetadata[] = [
  {
    name: "scheduler-assistant",
    source: "project",
    path: "fixture/scheduler-assistant/SKILL.md",
    description: "本地技能",
    version: "1.0.0"
  }
]
const onInstalled = () => {
  state.installed++
}
export function Fixture() {
  const [visible, setVisible] = useState(true)
  const [draft, setDraft] = useState("尚未发送的草稿")
  return (
    <main>
      <button onClick={() => setVisible(!visible)}>{visible ? "隐藏推荐" : "显示推荐"}</button>
      {visible && (
        <WelcomeSkills
          skills={skills}
          skillsLoading={false}
          enabledSkillsForSlash={skills}
          shouldShowWelcomeSkillTabs
          isLocalSkillDisabled={() => false}
          onSkillsInstalled={onInstalled}
          onUseSkillPrompt={(skill) => {
            state.selected.push(skill.name)
            setDraft((value) => `${value}\n/skill ${skill.name}`)
          }}
          onOpenMarketByCategory={() => {}}
          onOpenOrganizationSkillMarket={() => {}}
          onOpenMarketBySkill={() => {}}
        />
      )}
      <label>
        聊天草稿
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button onClick={() => state.sends++}>发送</button>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)

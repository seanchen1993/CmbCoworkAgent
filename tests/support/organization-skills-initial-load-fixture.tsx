import { useState } from "react"
import { createRoot } from "react-dom/client"
import { SkillsByCategorySection } from "../../src/renderer/src/components/chat/SkillsByCategorySection"
import type { SkillMetadata } from "../../src/renderer/src/types"

export interface OrganizationSkillsBrowserState {
  identityReads: number
  selectedSkills: string[]
  navigation: string[]
  forbiddenCalls: string[]
  sends: number
}

declare global {
  interface Window {
    organizationSkillsFixture: OrganizationSkillsBrowserState
  }
}

const state: OrganizationSkillsBrowserState = {
  identityReads: 0,
  selectedSkills: [],
  navigation: [],
  forbiddenCalls: [],
  sends: 0
}
window.organizationSkillsFixture = state

const forbidden = (name: string) => async () => {
  state.forbiddenCalls.push(name)
  throw new Error(`Unexpected fixture IPC: ${name}`)
}

// Only native identity reads are fixture data. The actual organization/market APIs,
// endpoint resolver, JSON parser, components and browser fetch are not replaced.
window.api = {
  models: {
    getUserInfo: async () => {
      state.identityReads++
      return null
    },
    upsertUserInfo: forbidden("models.upsertUserInfo")
  },
  agent: { invoke: forbidden("agent.invoke") },
  plugins: { install: forbidden("plugins.install") },
  skills: { upload: forbidden("skills.upload") },
  mods: { approve: forbidden("mods.approve"), approveFunction: forbidden("mods.approveFunction") }
} as unknown as Window["api"]

const localSkills: SkillMetadata[] = ["scheduler-assistant", "skill-creator"].map((name) => ({
  name,
  description: "Local browser fixture skill",
  path: `fixture-skills/${name}/SKILL.md`,
  source: "project",
  version: "1.0.0"
}))

export function Fixture() {
  const [draft, setDraft] = useState("这是我尚未发送的聊天草稿")
  const [visible, setVisible] = useState(true)
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-medium">聊天技能初始加载回归</h1>
      <button type="button" className="text-xs underline" onClick={() => setVisible(!visible)}>
        {visible ? "隐藏技能推荐" : "显示技能推荐"}
      </button>
      {visible && (
        <SkillsByCategorySection
          skills={localSkills}
          previewLimit={4}
          onOpenMarketByCategory={(name) => state.navigation.push(`category:${name}`)}
          onOpenOrganizationSkillMarket={(name) => state.navigation.push(`organization:${name}`)}
          onOpenMarketBySkill={(name) => state.navigation.push(`skill:${name}`)}
          onUseSkillPrompt={(skill) => {
            state.selectedSkills.push(skill.name)
            setDraft((current) => `${current}\n/skill ${skill.name}`)
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          state.sends++
        }}
      >
        <label className="block text-sm" htmlFor="organization-skills-draft">
          聊天草稿
        </label>
        <textarea
          id="organization-skills-draft"
          className="composer-textarea h-28 w-full rounded border p-3"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">发送消息</button>
      </form>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)

/* eslint-disable react-refresh/only-export-components -- standalone browser fixture */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ProjectPluginSkillShortcut } from "../../src/renderer/src/components/chat/ProjectPluginSkillShortcut"
import { MarketSkillShortcutAction } from "../../src/renderer/src/components/customize/MarketPanel/MarketSkillShortcutAction"
import { useAppStore } from "../../src/renderer/src/lib/store"
import type { SkillMetadata } from "../../src/renderer/src/types"
import type { MarketSkillShortcutBinding } from "../../src/shared/market-skill-shortcut"

const target = {
  itemId: "fixture-item",
  marketName: "fixture-market-name",
  name: "项目插件开发助手",
  description: "用于编写项目模式插件。",
  skillName: "project-plugin-author"
}
const skill: SkillMetadata = {
  id: target.skillName,
  name: target.skillName,
  description: target.description,
  source: "user",
  version: "1",
  path: "/skills/project-plugin-author/SKILL.md"
}
let binding: MarketSkillShortcutBinding = { revision: "initial", target: null }
let administrator = true
let clipboard = ""
let installed = false
let releaseInstall: (() => void) | null = null

Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: async (text: string) => {
      clipboard = text
    }
  }
})

Object.assign(window, {
  api: {
    marketSkillShortcut: {
      get: async () => ({ ok: true, value: binding }),
      resolve: async () => ({
        ok: true,
        value: installed ? { kind: "available", skill } : { kind: "missing" }
      }),
      install: async () => {
        await new Promise<void>((resolve) => {
          releaseInstall = resolve
        })
        installed = true
        return { ok: true, value: { kind: "available", skill } }
      }
    }
  },
  shortcutFixture: {
    selectThread: (threadId: string) => useAppStore.setState({ currentThreadId: threadId }),
    hasPendingInstall: () => Boolean(releaseInstall),
    finishInstall: () => {
      releaseInstall?.()
      releaseInstall = null
    },
    clearInstalled: () => {
      installed = false
    },
    readClipboard: () => clipboard,
    publish: (enabled: boolean) => {
      binding = { revision: binding.revision + "-next", target: enabled ? target : null }
      window.dispatchEvent(new Event("online"))
    },
    setAdministrator: (allowed: boolean) => {
      administrator = allowed
      useAppStore.setState((state) => ({ accountRevision: state.accountRevision + 1 }))
    }
  }
})
useAppStore.setState({ currentThreadId: "new", mainView: "thread" })

function Composer({ threadId }: { threadId: string }) {
  const [selected, setSelected] = useState<SkillMetadata | null>(null)
  const [sends, setSends] = useState(0)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setSends((count) => count + 1)
      }}
    >
      {threadId === "history" && <p>历史消息</p>}
      <ProjectPluginSkillShortcut
        threadId={threadId}
        disabled={false}
        selectSkill={setSelected}
        requiresReplacement={() => selected !== null}
        openSkillSettings={() => {}}
      />
      <textarea aria-label="消息草稿" />
      <input type="file" aria-label="草稿附件" />
      <output aria-label="技能">{selected?.name ?? ""}</output>
      <output aria-label="发送次数">{sends}</output>
    </form>
  )
}

function Fixture() {
  const threadId = useAppStore((state) => state.currentThreadId) ?? "new"
  useAppStore((state) => state.accountRevision)
  return (
    <>
      <MarketSkillShortcutAction
        itemId={target.itemId}
        marketName={target.marketName}
        canCopy={administrator}
      />
      <Composer key={threadId} threadId={threadId} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)

/* eslint-disable react-refresh/only-export-components -- standalone browser fixture */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Dialog, DialogContent, DialogTitle } from "../../src/renderer/src/components/ui/dialog"
import {
  ProjectPluginDevelopmentGuide,
  ProjectPluginWorkspaceShortcut
} from "../../src/renderer/src/components/customize/ProjectPluginDevelopmentGuide"
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
let catalogLoaded = false
const catalogListeners = new Set<() => void>()
let administrator = true
let clipboard = ""
let installed = false
const drafts = new Map<string, { text?: string; skill?: string; attachment?: string }>()
let releaseInstall: (() => void) | null = null
let recentWorkspace: string | null = "/recent"
let selectedWorkspace: string | null = null
const createdWorkspaces: string[] = []
const fixtureThreadContext = {
  getThreadActions: (threadId: string) => ({
    setDraftSkill: (selection: SkillMetadata) => {
      drafts.set(threadId, { ...drafts.get(threadId), skill: selection.name })
    }
  })
}

Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: async (text: string) => {
      clipboard = text
    }
  }
})

Object.assign(window, {
  fixtureThreadContext,
  api: {
    workspace: { get: async () => recentWorkspace },
    file: {
      selectDirectory: async () => ({
        canceled: !selectedWorkspace,
        filePaths: selectedWorkspace ? [selectedWorkspace] : []
      })
    },
    threads: {
      create: async ({ workspacePath }: { workspacePath: string }) => {
        createdWorkspaces.push(workspacePath)
        return { thread_id: "dev-" + createdWorkspaces.length }
      }
    },
    skills: {
      onMarketCatalogChanged: (callback: () => void) => {
        catalogListeners.add(callback)
        return () => catalogListeners.delete(callback)
      }
    },
    marketSkillShortcut: {
      get: async () => ({
        ok: true,
        value: catalogLoaded ? binding : { revision: binding.revision, target: null }
      }),
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
    selectThread: (threadId: string) => useAppStore.getState().selectThread(threadId),
    openView: (view: string) => useAppStore.getState().setMainView(view),
    hasPendingInstall: () => Boolean(releaseInstall),
    finishInstall: () => {
      releaseInstall?.()
      releaseInstall = null
    },
    clearInstalled: () => {
      installed = false
    },
    readClipboard: () => clipboard,
    setWorkspaces: (recent: string | null, selected: string | null) => {
      recentWorkspace = recent
      selectedWorkspace = selected
    },
    createdWorkspaces: () => createdWorkspaces,
    publish: (enabled: boolean) => {
      binding = { revision: binding.revision + "-next", target: enabled ? target : null }
      window.dispatchEvent(new Event("online"))
    },
    loadCatalog: () => {
      catalogLoaded = true
      for (const listener of catalogListeners) listener()
    },
    setAdministrator: (allowed: boolean) => {
      administrator = allowed
      useAppStore.setState((state) => ({ accountRevision: state.accountRevision + 1 }))
    }
  }
})
useAppStore.setState({ currentThreadId: "new", mainView: "thread" })

function Composer({ threadId }: { threadId: string }) {
  const draft = drafts.get(threadId)
  return (
    <form data-thread={threadId} onSubmit={(event) => event.preventDefault()}>
      <textarea
        aria-label="消息草稿"
        defaultValue={draft?.text ?? ""}
        onChange={(event) =>
          drafts.set(threadId, { ...drafts.get(threadId), text: event.target.value })
        }
      />
      <input
        type="file"
        aria-label="草稿附件"
        onChange={(event) => {
          drafts.set(threadId, {
            ...drafts.get(threadId),
            attachment: event.target.files?.[0]?.name
          })
        }}
      />
      <output aria-label="已附加文件">{draft?.attachment ?? ""}</output>
      <output aria-label="技能">{draft?.skill ?? ""}</output>
    </form>
  )
}

function ProjectForm() {
  const [name, setName] = useState("")
  const [adapterId, setAdapterId] = useState("")
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>新建项目</DialogTitle>
        <input
          aria-label="项目名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="插件选择"
          value={adapterId}
          onChange={(event) => setAdapterId(event.target.value)}
        >
          <option value="">请选择</option>
          <option value="installed-adapter">已有插件</option>
        </select>
        <ProjectPluginDevelopmentGuide entry="project" />
      </DialogContent>
    </Dialog>
  )
}

function Fixture() {
  const threadId = useAppStore((state) => state.currentThreadId) ?? "new"
  const view = useAppStore((state) => String(state.mainView))
  useAppStore((state) => state.accountRevision)
  if (view === "plugins") return <ProjectPluginDevelopmentGuide entry="plugins" />
  if (view === "harness") return <ProjectForm />
  if (view === "market" || view === "other-market") {
    return (
      <MarketSkillShortcutAction
        itemId={view === "market" ? target.itemId : "other"}
        marketName={target.marketName}
        canCopy={administrator}
      />
    )
  }
  if (view === "workspace-plugins") return <ProjectPluginWorkspaceShortcut />
  return <Composer key={threadId} threadId={threadId} />
}

createRoot(document.getElementById("root")!).render(<Fixture />)
